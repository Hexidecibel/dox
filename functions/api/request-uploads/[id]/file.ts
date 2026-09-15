/**
 * GET /api/request-uploads/:id/file — the bytes a supplier sent.
 *
 * APPROVAL MOVES THE FILE, SO `r2_key` GOES STALE. The upload door enqueues
 * with `fileR2Key` set to the upload's own object, and the COA approve path
 * (functions/lib/kinds/coa.ts) copies that object under a permanent
 * document_versions key and then deletes the original. So after approval
 * `request_uploads.r2_key` names nothing. Serving only that key would make
 * every approved arrival — the only ones a line can be accepted from — look
 * like data loss at exactly the moment someone needs to read it.
 *
 * Order of preference:
 *   1. the upload's own object, while it still exists
 *   2. the linked document's CURRENT version
 *   3. 410 Gone — we hold a record that a file arrived and no bytes for it
 *
 * `X-File-Source: upload | document` says which, same idea as the queue's own
 * file endpoint. Any tenant user may read, matching the role model's "reader:
 * read-only, download files".
 */

import { downloadFile } from '../../../lib/r2';
import { errorToResponse, NotFoundError } from '../../../lib/permissions';
import { resolveTenantForUpload } from '../../../lib/request-arrivals';
import type { Env, User } from '../../../lib/types';

export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const id = context.params.id as string;
    const db = context.env.DB;
    const tenantId = await resolveTenantForUpload(db, user, id);

    const upload = await db
      .prepare(
        `SELECT id, r2_key, file_name, mime_type, document_id
           FROM request_uploads WHERE id = ? AND tenant_id = ?`,
      )
      .bind(id, tenantId)
      .first<{
        id: string;
        r2_key: string;
        file_name: string;
        mime_type: string;
        document_id: string | null;
      }>();
    if (!upload) throw new NotFoundError('Arrival not found');

    let file = await downloadFile(context.env.FILES, upload.r2_key);
    let source = 'upload';
    let fileName = upload.file_name;
    let mimeType = upload.mime_type;

    if (!file && upload.document_id) {
      const version = await db
        .prepare(
          `SELECT dv.r2_key, dv.file_name, dv.mime_type
             FROM documents d
             JOIN document_versions dv
               ON dv.document_id = d.id AND dv.version_number = d.current_version
            WHERE d.id = ? AND d.tenant_id = ?`,
        )
        .bind(upload.document_id, tenantId)
        .first<{ r2_key: string; file_name: string; mime_type: string }>();
      if (version) {
        file = await downloadFile(context.env.FILES, version.r2_key);
        if (file) {
          source = 'document';
          fileName = version.file_name;
          mimeType = version.mime_type;
        }
      }
    }

    if (!file) {
      return new Response(
        JSON.stringify({
          error:
            'We have the record that this file arrived, but not the file itself. ' +
            'Ask the supplier to send it again.',
        }),
        { status: 410, headers: { 'Content-Type': 'application/json' } },
      );
    }

    const safeName = fileName.replace(/["\\\r\n]/g, '_');
    return new Response(file.body, {
      headers: {
        'Content-Type': mimeType || 'application/octet-stream',
        'Content-Disposition': `inline; filename="${safeName}"`,
        'Cache-Control': 'private, max-age=300',
        'X-File-Source': source,
      },
    });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Request upload file error:', err);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
