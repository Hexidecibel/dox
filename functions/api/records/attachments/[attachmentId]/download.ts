/**
 * GET /api/records/attachments/:attachmentId/download
 *
 * Authenticated download of a record-row attachment. Tenant-scoped:
 * super_admin can pull any tenant's attachment; everyone else is
 * confined to their own tenant via requireTenantAccess.
 *
 * Mirrors the documents/[id]/download.ts pattern: fetch row → check
 * tenant → stream R2 body with the right Content-Type / Disposition.
 *
 * `?preview=true` returns Content-Disposition: inline so an <img> /
 * <iframe> in the drawer can render the file directly. Otherwise we
 * force a download with the original filename.
 */

import { logAudit, getClientIp } from '../../../../lib/db';
import {
  requireTenantAccess,
  NotFoundError,
  errorToResponse,
} from '../../../../lib/permissions';
import { downloadFile } from '../../../../lib/r2';
import type { Env, User } from '../../../../lib/types';
import type { RecordRowAttachmentRow } from '../../../../../shared/types';

export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const attachmentId = context.params.attachmentId as string;
    const url = new URL(context.request.url);
    const isPreview = url.searchParams.get('preview') === 'true';

    const att = await context.env.DB.prepare(
      `SELECT * FROM records_row_attachments
       WHERE id = ?
         AND row_id IS NOT NULL
         AND pending_token IS NULL`,
    )
      .bind(attachmentId)
      .first<RecordRowAttachmentRow>();
    if (!att) throw new NotFoundError('Attachment not found');

    requireTenantAccess(user, att.tenant_id);

    const r2Object = await downloadFile(context.env.FILES, att.r2_key);
    if (!r2Object) {
      return new Response(
        JSON.stringify({ error: 'File not found in storage' }),
        { status: 404, headers: { 'Content-Type': 'application/json' } },
      );
    }

    await logAudit(
      context.env.DB,
      user.id,
      att.tenant_id,
      'records_attachment_downloaded',
      'records_row_attachment',
      attachmentId,
      JSON.stringify({ row_id: att.row_id, file_name: att.file_name }),
      getClientIp(context.request),
    );

    const disposition = isPreview
      ? 'inline'
      : `attachment; filename="${att.file_name}"`;

    const headers: Record<string, string> = {
      'Content-Type': att.mime_type || 'application/octet-stream',
      'Content-Disposition': disposition,
    };
    if (att.file_size != null) headers['Content-Length'] = String(att.file_size);
    if (att.checksum) headers['ETag'] = `"${att.checksum}"`;

    return new Response(r2Object.body, { headers });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Attachment download error:', err);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
