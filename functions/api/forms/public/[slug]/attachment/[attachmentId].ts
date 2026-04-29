/**
 * DELETE /api/forms/public/:slug/attachment/:attachmentId
 *
 * Public, unauthenticated cancellation of a pending attachment. Used
 * when the user clicks "remove" on a file row in the public form
 * renderer before submitting. Required so a user who picks the wrong
 * photo doesn't have to live with it for the whole session — the
 * sweeper would eventually GC it, but a manual delete is the better UX.
 *
 * Body must contain `pending_token` (same value the upload endpoint
 * issued). That makes this safe to expose unauthenticated: only
 * whoever holds the token can delete.
 *
 * Hard requirements:
 *   - The attachment must still be pending (row_id IS NULL).
 *   - form_id must match the slug's form.
 *   - tenant_id must match the slug's form.
 *   - pending_token must match.
 *
 * On success: deletes the R2 object then the D1 row. (R2 first so a
 * D1-success / R2-orphan never happens — a D1-success / R2-still-there
 * is recoverable by the sweeper but the inverse isn't.)
 */

import { logAudit, getClientIp } from '../../../../../lib/db';
import type { Env } from '../../../../../lib/types';
import type { RecordFormRow, RecordRowAttachmentRow } from '../../../../../../shared/types';

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export const onRequestDelete: PagesFunction<Env> = async (context) => {
  try {
    const slug = context.params.slug as string;
    const attachmentId = context.params.attachmentId as string;
    if (!slug || !attachmentId) {
      return jsonResponse({ error: 'Not found' }, 404);
    }

    // Parse the body for the pending_token. Both query string and JSON
    // body are accepted — a `fetch` with method DELETE traditionally
    // doesn't carry a body in some clients, so the query fallback keeps
    // the renderer simple.
    let pendingToken: string | null = null;
    const url = new URL(context.request.url);
    pendingToken = url.searchParams.get('pending_token');
    if (!pendingToken) {
      try {
        const body = (await context.request.json()) as { pending_token?: string };
        if (typeof body?.pending_token === 'string') pendingToken = body.pending_token;
      } catch {
        // ignore — handled below
      }
    }
    if (!pendingToken) {
      return jsonResponse({ error: 'Missing pending_token' }, 400);
    }

    const form = await context.env.DB.prepare(
      `SELECT f.*
       FROM records_forms f
       JOIN records_sheets s ON f.sheet_id = s.id
       WHERE f.public_slug = ?
         AND f.is_public = 1
         AND f.archived = 0
         AND s.archived = 0`,
    )
      .bind(slug)
      .first<RecordFormRow>();
    if (!form) return jsonResponse({ error: 'Not found' }, 404);

    const att = await context.env.DB.prepare(
      `SELECT * FROM records_row_attachments
       WHERE id = ?
         AND form_id = ?
         AND tenant_id = ?
         AND pending_token = ?
         AND row_id IS NULL`,
    )
      .bind(attachmentId, form.id, form.tenant_id, pendingToken)
      .first<RecordRowAttachmentRow>();
    if (!att) {
      // Generic 404 — never confirm whether the id existed for a
      // different form / token / linked state.
      return jsonResponse({ error: 'Not found' }, 404);
    }

    // R2 first (see file header). Tolerate a missing object — that just
    // means a previous cleanup raced us.
    try {
      await context.env.FILES.delete(att.r2_key);
    } catch (err) {
      console.error('Pending attachment R2 delete failed:', err);
    }

    await context.env.DB.prepare('DELETE FROM records_row_attachments WHERE id = ?')
      .bind(attachmentId)
      .run();

    const ip = getClientIp(context.request);
    await logAudit(
      context.env.DB,
      null,
      form.tenant_id,
      'records_form.attachment_cancelled',
      'records_row_attachment',
      attachmentId,
      JSON.stringify({ form_id: form.id, ip }),
      ip,
    );

    return jsonResponse({ success: true }, 200);
  } catch (err) {
    console.error('Public form attachment delete error:', err);
    return jsonResponse({ error: 'Delete failed' }, 500);
  }
};
