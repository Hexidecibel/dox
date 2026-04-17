/**
 * GET /api/eval/next
 *
 * Returns the next queue item eligible for A/B evaluation by the current
 * user. "Eligible" means:
 *  - both text extraction (ai_fields) and VLM extraction (vlm_extracted_fields)
 *    are populated on the queue row
 *  - VLM extraction did not error out (vlm_error IS NULL)
 *  - the current user hasn't evaluated it yet (no extraction_evaluations row
 *    keyed on (queue_item_id, user_id))
 *
 * The response also includes `a_side` — which real extraction side is
 * presented as "Method A" to the reviewer. This is randomized per request
 * and echoed back by the client on POST; we don't persist it until the
 * reviewer submits, which keeps the GET idempotent and avoids storing
 * state that would leak the blind label back to the UI.
 */

import {
  requireRole,
  errorToResponse,
} from '../../lib/permissions';
import type { Env, User } from '../../lib/types';
import type { ExtractionEvalSide, EvalNextResponse } from '../../../shared/types';

/** Scope predicate used by every query in this endpoint set. */
function eligibleWhereClause(): string {
  return `
    pq.ai_fields IS NOT NULL
    AND pq.ai_fields != '{}'
    AND pq.vlm_extracted_fields IS NOT NULL
    AND pq.vlm_extracted_fields != '{}'
    AND pq.vlm_error IS NULL
  `;
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireRole(user, 'super_admin', 'org_admin', 'user');

    const tenantClause = user.role === 'super_admin' ? '' : 'AND pq.tenant_id = ?';
    const tenantBind: string[] = user.role === 'super_admin' ? [] : [user.tenant_id as string];

    // Total eligible queue items (per current user's tenant scope).
    const totalRow = await context.env.DB.prepare(
      `SELECT COUNT(*) as c
       FROM processing_queue pq
       WHERE ${eligibleWhereClause()} ${tenantClause}`
    )
      .bind(...tenantBind)
      .first<{ c: number }>();
    const total = totalRow?.c ?? 0;

    // Items this user has already evaluated.
    const evaluatedRow = await context.env.DB.prepare(
      `SELECT COUNT(*) as c
       FROM extraction_evaluations ee
       JOIN processing_queue pq ON pq.id = ee.queue_item_id
       WHERE ee.evaluator_user_id = ? AND ${eligibleWhereClause()} ${tenantClause}`
    )
      .bind(user.id, ...tenantBind)
      .first<{ c: number }>();
    const evaluatedByUser = evaluatedRow?.c ?? 0;
    const remaining = Math.max(0, total - evaluatedByUser);

    if (remaining === 0) {
      const body: EvalNextResponse = { item: null, a_side: null, remaining: 0, total };
      return new Response(JSON.stringify(body), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Pick the next unevaluated item, oldest first so reviewers work through
    // a predictable queue. LEFT JOIN + IS NULL is the idiomatic "anti-join".
    const itemQuery = `
      SELECT pq.*, dt.name as document_type_name, dt.slug as document_type_slug,
             t.name as tenant_name, t.slug as tenant_slug,
             u.name as created_by_name, r.name as reviewed_by_name
      FROM processing_queue pq
      LEFT JOIN document_types dt ON pq.document_type_id = dt.id
      LEFT JOIN tenants t ON pq.tenant_id = t.id
      LEFT JOIN users u ON pq.created_by = u.id
      LEFT JOIN users r ON pq.reviewed_by = r.id
      LEFT JOIN extraction_evaluations ee
        ON ee.queue_item_id = pq.id AND ee.evaluator_user_id = ?
      WHERE ee.id IS NULL AND ${eligibleWhereClause()} ${tenantClause}
      ORDER BY pq.created_at ASC
      LIMIT 1
    `;
    const item = await context.env.DB.prepare(itemQuery)
      .bind(user.id, ...tenantBind)
      .first();

    if (!item) {
      // Race — evaluated count matched total between our two queries. Treat
      // as "done" from the client's perspective.
      const body: EvalNextResponse = { item: null, a_side: null, remaining: 0, total };
      return new Response(JSON.stringify(body), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Coin-flip which real method is presented as "Method A". Random bytes
    // from the Workers crypto API — no Math.random to avoid cross-call bias.
    const randByte = crypto.getRandomValues(new Uint8Array(1))[0];
    const a_side: ExtractionEvalSide = randByte < 128 ? 'text' : 'vlm';

    const body: EvalNextResponse = {
      item: item as unknown as EvalNextResponse['item'],
      a_side,
      remaining,
      total,
    };
    return new Response(JSON.stringify(body), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Eval next error:', err);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
