/**
 * GET /api/eval/report
 *
 * Aggregate report for the A/B text-vs-VLM evaluation flow. Unblinds the
 * Method A / Method B labels using the stored `a_side` per evaluation and
 * rolls up text_wins / vlm_wins / ties by supplier and by document type.
 *
 * Tenant-scoped for non-super_admins so an org_admin only sees their own
 * evaluators' results.
 */

import { requireRole, errorToResponse } from '../../lib/permissions';
import type { Env, User } from '../../lib/types';
import { aggregateEvaluations, type RawEvaluationRow } from '../../lib/evalAggregate';

export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireRole(user, 'super_admin', 'org_admin', 'user');

    const tenantClause = user.role === 'super_admin' ? '' : 'AND pq.tenant_id = ?';
    const tenantBind: string[] = user.role === 'super_admin' ? [] : [user.tenant_id as string];

    // All evaluations joined with queue-item metadata needed for breakdowns.
    // Supplier lives on the processing_queue row (pq.supplier) as a plain
    // string — the VLM extraction flow doesn't resolve it to suppliers.id,
    // so we use it directly. document_type_name comes from the join.
    const rows = await context.env.DB.prepare(
      `SELECT
         ee.queue_item_id,
         ee.winner,
         ee.a_side,
         ee.comment,
         ee.evaluated_at,
         pq.file_name,
         pq.supplier,
         dt.name AS document_type_name,
         u.name AS evaluator_name
       FROM extraction_evaluations ee
       JOIN processing_queue pq ON pq.id = ee.queue_item_id
       LEFT JOIN document_types dt ON pq.document_type_id = dt.id
       LEFT JOIN users u ON ee.evaluator_user_id = u.id
       WHERE 1=1 ${tenantClause}
       ORDER BY ee.evaluated_at DESC`
    )
      .bind(...tenantBind)
      .all<RawEvaluationRow>();

    // Eligibility counts for the completion state in the UI.
    const eligible = `
      pq.ai_fields IS NOT NULL AND pq.ai_fields != '{}'
      AND pq.vlm_extracted_fields IS NOT NULL AND pq.vlm_extracted_fields != '{}'
      AND pq.vlm_error IS NULL
    `;
    const totalRow = await context.env.DB.prepare(
      `SELECT COUNT(*) as c FROM processing_queue pq WHERE ${eligible} ${tenantClause}`
    )
      .bind(...tenantBind)
      .first<{ c: number }>();
    const total = totalRow?.c ?? 0;
    const evaluatedRow = await context.env.DB.prepare(
      `SELECT COUNT(*) as c FROM extraction_evaluations ee
       JOIN processing_queue pq ON pq.id = ee.queue_item_id
       WHERE ee.evaluator_user_id = ? AND ${eligible} ${tenantClause}`
    )
      .bind(user.id, ...tenantBind)
      .first<{ c: number }>();
    const evaluatedByCurrent = evaluatedRow?.c ?? 0;
    const remaining = Math.max(0, total - evaluatedByCurrent);

    const report = aggregateEvaluations(
      (rows.results ?? []) as RawEvaluationRow[],
      { remaining, total }
    );
    return new Response(JSON.stringify(report), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Eval report error:', err);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
