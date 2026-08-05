import {
  requireRole,
  requireTenantAccess,
  NotFoundError,
  errorToResponse,
} from '../../../lib/permissions';
import { downloadFile } from '../../../lib/r2';
import type { Env, User } from '../../../lib/types';

/**
 * GET /api/queue/:id/file
 * Stream the pending file from R2 for preview.
 * Auth: super_admin, org_admin, user
 */
export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const queueId = context.params.id as string;

    requireRole(user, 'super_admin', 'org_admin', 'user');

    const item = await context.env.DB.prepare(
      'SELECT id, tenant_id, file_r2_key, file_name, mime_type FROM processing_queue WHERE id = ?'
    )
      .bind(queueId)
      .first<{
        id: string;
        tenant_id: string;
        file_r2_key: string;
        file_name: string;
        mime_type: string;
      }>();

    if (!item) {
      throw new NotFoundError('Queue item not found');
    }

    requireTenantAccess(user, item.tenant_id);

    let file = await downloadFile(context.env.FILES, item.file_r2_key);
    let source = 'queue';
    let scoped = false;

    if (!file) {
      // APPROVE MOVES THE FILE; IT DOES NOT DESTROY IT.
      //
      // The approve path (functions/lib/kinds/coa.ts) downloads the staging
      // object, re-uploads the same bytes under a permanent document_versions
      // key, and only then deletes the staging copy. So a 404 here means
      // "this item was approved", NOT "the bytes are gone" — 451 of 457
      // approved prod items still have a live version behind them.
      //
      // Without this fallback every re-extraction, parity replay and accuracy
      // measurement silently sees an empty corpus for anything already
      // approved, and reads it as data loss. That misdiagnosis cost a full
      // session; hence the fallback rather than a comment telling you to
      // resolve the key by hand.
      //
      // Producers write external_ref as `queue-<id>` (single doc) or
      // `queue-<id>-<lot_key>` (per-record/sublot), so the prefix match finds
      // both. Ordering by file_size DESC prefers the FULL original over a
      // page-scoped per-record PDF, which is what a replay wants.
      const fallback = await context.env.DB.prepare(
        `SELECT dv.r2_key, dv.file_name, dv.mime_type, dv.file_size,
                (SELECT COUNT(*) FROM documents d2
                  WHERE d2.external_ref LIKE 'queue-' || ? || '%') AS doc_count
           FROM documents d
           JOIN document_versions dv ON dv.document_id = d.id
          WHERE d.external_ref LIKE 'queue-' || ? || '%'
          ORDER BY dv.file_size DESC, dv.version_number ASC
          LIMIT 1`
      )
        .bind(queueId, queueId)
        .first<{
          r2_key: string;
          file_name: string;
          mime_type: string;
          file_size: number;
          doc_count: number;
        }>();

      if (fallback) {
        file = await downloadFile(context.env.FILES, fallback.r2_key);
        if (file) {
          source = 'document';
          // >1 produced document means the item was split per record, so the
          // bytes we serve are one page-scoped slice, not the original bundle.
          // Callers replaying multi-record extraction must know that.
          scoped = fallback.doc_count > 1;
        }
      }
    }

    if (!file) {
      throw new NotFoundError('File not found in storage');
    }

    return new Response(file.body, {
      headers: {
        'Content-Type': item.mime_type || 'application/octet-stream',
        'Content-Disposition': `inline; filename="${item.file_name}"`,
        'Cache-Control': 'private, max-age=300',
        // Lets a replay harness distinguish original bytes from a page-scoped
        // slice instead of silently grading the wrong thing.
        'X-File-Source': source,
        'X-File-Scoped': scoped ? 'true' : 'false',
      },
    });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;

    console.error('Queue file download error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
