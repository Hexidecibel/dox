/**
 * /api/request-lines/:id — one line of one request.
 *
 * PUT    move its status, or edit its wording
 * DELETE remove it from a DRAFT
 *
 * WHY STATUS MOVES ON AN ISSUED REQUEST, WHEN NOTHING ELSE DOES
 * ------------------------------------------------------------
 * The versioning rule protects what was ASKED FOR. A line's status is not part
 * of the ask — it is our record of what has come back, and it necessarily
 * changes after issue. Freezing it would make the five states useless: they
 * exist precisely to describe the period between issue and resolution.
 *
 * So an issued request's line may change `status` and `status_note`, and may
 * NOT change `name`, `explanation`, `acceptable_formats`, `criteria` or `tier`
 * — those are what the supplier was told, and changing them is an amendment.
 *
 * NO TRANSITION GRAPH IS ENFORCED. The client specified five states, not a
 * graph, and every plausible edge is legitimate somewhere: `accepted` back to
 * `needs_attention` is exactly what happens when a document is later found
 * deficient. Inventing a graph would block real corrections and would be a
 * decision the client did not make. Every change is stamped
 * (`status_changed_at`/`status_changed_by`) and audited instead, which is what
 * makes the sequence reconstructable.
 *
 * ROLE GATE: status work is the assigned buyer's job, so `user` is allowed
 * alongside org_admin. `reader` is not — a read-only account marking a
 * document accepted would be the role model saying one thing and the data
 * another. Editing wording stays org_admin, because it changes the ask.
 */

import { getClientIp } from '../../lib/db';
import { errorToResponse, BadRequestError, NotFoundError } from '../../lib/permissions';
import {
  auditRequest,
  isLineStatus,
  isLineTier,
  LINE_STATUSES,
  loadRequest,
  requireComposer,
  requireLineWorker,
} from '../../lib/document-requests';
import { sanitizeString } from '../../lib/validation';
import type { RequestLineRow, UpdateRequestLineRequest } from '../../../shared/types';
import type { Env, User } from '../../lib/types';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Load a line inside the caller's tenant.
 *
 * A non-super_admin is pinned to their own tenant before the read, so another
 * tenant's line id is a 404 and not a probe.
 */
async function loadLine(db: D1Database, user: User, lineId: string): Promise<RequestLineRow> {
  const sql =
    user.role === 'super_admin'
      ? 'SELECT * FROM request_lines WHERE id = ?'
      : 'SELECT * FROM request_lines WHERE id = ? AND tenant_id = ?';
  const stmt =
    user.role === 'super_admin'
      ? db.prepare(sql).bind(lineId)
      : db.prepare(sql).bind(lineId, user.tenant_id);
  const row = await stmt.first<RequestLineRow>();
  if (!row) throw new NotFoundError('Request line not found');
  return row;
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const line = await loadLine(context.env.DB, user, context.params.id as string);
    return json({ line });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Get request line error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
};

export const onRequestPut: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireLineWorker(user);

    const lineId = context.params.id as string;
    const line = await loadLine(context.env.DB, user, lineId);
    const request = await loadRequest(context.env.DB, line.tenant_id, line.request_id);

    const body = (await context.request.json()) as UpdateRequestLineRequest;

    const wantsWordingChange =
      body.name !== undefined ||
      body.explanation !== undefined ||
      body.acceptable_formats !== undefined ||
      body.criteria !== undefined ||
      body.owner !== undefined ||
      body.tier !== undefined ||
      body.sort_order !== undefined;

    if (wantsWordingChange) {
      // Changing what was asked for is composer work, and only on a draft.
      requireComposer(user);
      if (request.status !== 'draft') {
        return json(
          {
            error:
              `What a line asks for cannot be edited after issue; this request is ` +
              `${request.status}. Amend it (POST /api/document-requests/` +
              `${request.id}/amend) — the original is preserved.`,
          },
          409,
        );
      }
    }

    if (body.status !== undefined && !isLineStatus(body.status)) {
      return json({ error: `status must be one of: ${LINE_STATUSES.join(', ')}` }, 400);
    }
    if (body.tier !== undefined && !isLineTier(body.tier)) {
      return json({ error: 'tier must be one of: required, recommended' }, 400);
    }

    // A free-text line cannot become typed (or vice versa) here: line_kind and
    // requirement_id are the line's identity, and swapping them silently would
    // change what a request asks for while claiming to be a status update.
    // Recompose the line instead.
    if ('line_kind' in (body as Record<string, unknown>) || 'requirement_id' in (body as Record<string, unknown>)) {
      throw new BadRequestError(
        'line_kind and requirement_id are a line\'s identity and cannot be changed. ' +
          'Delete the line and add the intended one.',
      );
    }

    const statusChanged = body.status !== undefined && body.status !== line.status;
    const name = body.name === undefined ? line.name : sanitizeString(body.name);
    if (!name) return json({ error: 'name cannot be empty' }, 400);

    await context.env.DB.prepare(
      `UPDATE request_lines
          SET name = ?, explanation = ?, acceptable_formats = ?, criteria = ?,
              owner = ?, tier = ?, status = ?, status_note = ?, attention_reason = ?,
              status_changed_at = CASE WHEN ? THEN datetime('now') ELSE status_changed_at END,
              status_changed_by = CASE WHEN ? THEN ? ELSE status_changed_by END,
              sort_order = ?, updated_at = datetime('now'), updated_by = ?
        WHERE id = ? AND tenant_id = ?`,
    )
      .bind(
        name,
        body.explanation === undefined ? line.explanation : (body.explanation || null),
        body.acceptable_formats === undefined
          ? line.acceptable_formats
          : (body.acceptable_formats || null),
        body.criteria === undefined ? line.criteria : (body.criteria || null),
        body.owner === undefined ? line.owner : (body.owner || null),
        body.tier === undefined ? line.tier : body.tier,
        body.status === undefined ? line.status : body.status,
        body.status_note === undefined ? line.status_note : (body.status_note || null),
        // The supplier-facing half of the pair. Two columns, two audiences —
        // see migration 0092 for why reusing `status_note` for this would be
        // the leak the allow-list cannot catch.
        body.attention_reason === undefined
          ? line.attention_reason
          : (body.attention_reason || null),
        statusChanged ? 1 : 0,
        statusChanged ? 1 : 0,
        user.id,
        body.sort_order === undefined ? line.sort_order : body.sort_order,
        user.id,
        lineId,
        line.tenant_id,
      )
      .run();

    if (statusChanged) {
      await auditRequest(
        context.env.DB,
        user,
        line.tenant_id,
        'request_line_status_changed',
        line.request_id,
        {
          line_id: lineId,
          line_name: name,
          requirement_id: line.requirement_id,
          from: line.status,
          to: body.status,
          note: body.status_note ?? null,
        },
        getClientIp(context.request),
      );
    }

    const updated = await loadLine(context.env.DB, user, lineId);
    return json({ line: updated });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Update request line error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
};

/**
 * DELETE — draft only. Removing a line from an issued packet is a change to
 * what the supplier was asked for; that is an amendment, which preserves the
 * version that still contains it.
 */
export const onRequestDelete: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireComposer(user);

    const lineId = context.params.id as string;
    const line = await loadLine(context.env.DB, user, lineId);
    const request = await loadRequest(context.env.DB, line.tenant_id, line.request_id);

    if (request.status !== 'draft') {
      return json(
        {
          error:
            `A line cannot be removed after issue; this request is ${request.status}. ` +
            `Amend it (POST /api/document-requests/${request.id}/amend) — the version ` +
            `that contains this line is preserved.`,
        },
        409,
      );
    }

    await context.env.DB.prepare('DELETE FROM request_lines WHERE id = ? AND tenant_id = ?')
      .bind(lineId, line.tenant_id)
      .run();

    await auditRequest(
      context.env.DB,
      user,
      line.tenant_id,
      'request_line_removed',
      line.request_id,
      { line_id: lineId, line_name: line.name, requirement_id: line.requirement_id },
      getClientIp(context.request),
    );

    return json({ success: true });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Delete request line error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
};
