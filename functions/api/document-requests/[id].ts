/**
 * /api/document-requests/:id — one request version.
 *
 * GET    the full internal view (request + lines + closure + routing + history)
 * PUT    edit a DRAFT in place
 * DELETE cancel
 *
 * WHY PUT ONLY TOUCHES DRAFTS
 * ---------------------------
 * Amendments after issue are versioned, not overwritten — a client requirement
 * and a general rule in their programme. So an issued request is immutable
 * here and the only way to change it is POST :id/amend, which writes a new
 * version and leaves the original intact. A PUT that silently branched into
 * "edit or amend depending on status" would put the audit-trail guarantee
 * behind a status check nobody reading the route can see.
 *
 * WHERE SATISFACTION STOPS — read this before wiring anything to ingest
 * --------------------------------------------------------------------
 * Each typed line carries a `closure` array: the CONFIRMED
 * `document_requirements` rows (0080) from this supplier's active documents
 * for that line's requirement. That is the existing registry mechanism showing
 * its work, not a parallel one — a request line resolves to a requirement
 * precisely so the join already exists.
 *
 * It is READ-ONLY, and it deliberately does not move `request_lines.status`.
 * Two things are genuinely missing before a document can CLOSE a line, and
 * neither belongs in a schema-and-API task:
 *
 *   1. ATTRIBUTION. Nothing today records that an arriving document arrived
 *      AGAINST a particular ask. A confirmed link for the right requirement
 *      from the right supplier is strong evidence and it is not the same
 *      statement — a certificate uploaded for an unrelated reason would close
 *      a line nobody sent it for. Attribution needs a hook at the ingest /
 *      review-approval seam, which is the pipeline this task does not touch.
 *   2. THE TRANSITION ITSELF. `accepted` is the fourth of the client's five
 *      states and `received` and `under_review` sit in front of it. A machine
 *      that jumps a line straight to `accepted` erases the review those states
 *      exist to describe. The honest automatic move is `not_started` ->
 *      `received` at arrival, which requires (1).
 *
 * So: the seam is built and queried, the write is not. A follow-up that adds
 * arrival attribution can drive the transition without a migration — the join
 * key (`request_lines.requirement_id`, indexed) is already here.
 */

import { getClientIp } from '../../lib/db';
import { errorToResponse } from '../../lib/permissions';
import {
  assertAssignee,
  auditRequest,
  loadRequest,
  loadRequestDetail,
  requireComposer,
  resolveTenantForRequest,
} from '../../lib/document-requests';
import { sanitizeString } from '../../lib/validation';
import type { Env, User } from '../../lib/types';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const id = context.params.id as string;
    const tenantId = await resolveTenantForRequest(context.env.DB, user, id);
    const request = await loadRequestDetail(context.env.DB, tenantId, id);
    return json({ request });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Get document request error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
};

/**
 * PUT /api/document-requests/:id — edit a draft.
 *
 * Header fields only. Lines are managed through /:id/lines so that adding one
 * to a fifty-line packet is not a whole-set replace.
 */
export const onRequestPut: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireComposer(user);

    const id = context.params.id as string;
    const tenantId = await resolveTenantForRequest(context.env.DB, user, id);
    const existing = await loadRequest(context.env.DB, tenantId, id);

    if (existing.status !== 'draft') {
      return json(
        {
          error:
            `Only a draft can be edited; this request is ${existing.status}. ` +
            `Issued requests are amended (POST /api/document-requests/${id}/amend), ` +
            `which preserves the original.`,
        },
        409,
      );
    }

    const body = (await context.request.json()) as {
      title?: string;
      intro?: string | null;
      due_date?: string | null;
      assigned_to?: string | null;
    };

    const title = body.title === undefined ? existing.title : sanitizeString(body.title);
    if (!title) return json({ error: 'title cannot be empty' }, 400);

    const assignedTo =
      body.assigned_to === undefined ? existing.assigned_to : (body.assigned_to || null);
    await assertAssignee(context.env.DB, tenantId, assignedTo);

    await context.env.DB.prepare(
      `UPDATE document_requests
          SET title = ?, intro = ?, due_date = ?, assigned_to = ?,
              updated_at = datetime('now'), updated_by = ?
        WHERE id = ? AND tenant_id = ?`,
    )
      .bind(
        title,
        body.intro === undefined ? existing.intro : (body.intro ? sanitizeString(body.intro) : null),
        body.due_date === undefined ? existing.due_date : (body.due_date || null),
        assignedTo,
        user.id,
        id,
        tenantId,
      )
      .run();

    await auditRequest(
      context.env.DB,
      user,
      tenantId,
      'document_request_updated',
      id,
      { title },
      getClientIp(context.request),
    );

    const request = await loadRequestDetail(context.env.DB, tenantId, id);
    return json({ request });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Update document request error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
};

/**
 * DELETE /api/document-requests/:id — cancel.
 *
 * A DRAFT is hard-deleted: it was committed to nobody and a tombstone would
 * only be another state every list has to exclude. Same reasoning 0087 gives
 * for detaching applicability.
 *
 * An ISSUED request is soft-cancelled (status = 'cancelled', cancelled_at
 * stamped). It went out; the record that it went out, and that we withdrew it,
 * is the whole point of an audit trail. Its routing row and lines stay.
 */
export const onRequestDelete: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireComposer(user);

    const id = context.params.id as string;
    const tenantId = await resolveTenantForRequest(context.env.DB, user, id);
    const existing = await loadRequest(context.env.DB, tenantId, id);

    if (existing.status === 'draft') {
      // Lines cascade with the request.
      await context.env.DB.prepare(
        'DELETE FROM document_requests WHERE id = ? AND tenant_id = ?',
      )
        .bind(id, tenantId)
        .run();

      await auditRequest(
        context.env.DB,
        user,
        tenantId,
        'document_request_draft_deleted',
        id,
        { title: existing.title },
        getClientIp(context.request),
      );
      return json({ success: true, deleted: true });
    }

    if (existing.status === 'cancelled') {
      return json({ success: true, deleted: false });
    }

    await context.env.DB.prepare(
      `UPDATE document_requests
          SET status = 'cancelled', cancelled_at = datetime('now'),
              updated_at = datetime('now'), updated_by = ?
        WHERE id = ? AND tenant_id = ?`,
    )
      .bind(user.id, id, tenantId)
      .run();

    await auditRequest(
      context.env.DB,
      user,
      tenantId,
      'document_request_cancelled',
      id,
      { title: existing.title, previous_status: existing.status },
      getClientIp(context.request),
    );

    return json({ success: true, deleted: false });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Cancel document request error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
};
