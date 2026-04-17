/**
 * POST /api/eval/:queue_item_id
 *
 * Submit the current user's blind-compare pick for a single queue item.
 * Upserts one row per (queue_item, evaluator) — re-submitting overwrites
 * the previous choice so reviewers can correct mistakes without admin help.
 *
 * The client must send back the `a_side` it received from GET /api/eval/next
 * so we can unblind the A/B labeling later in the report.
 */

import { generateId, logAudit, getClientIp } from '../../lib/db';
import {
  requireRole,
  requireTenantAccess,
  NotFoundError,
  BadRequestError,
  errorToResponse,
} from '../../lib/permissions';
import type { Env, User } from '../../lib/types';
import type {
  EvalSubmitRequest,
  EvalSubmitResponse,
  ExtractionEvalSide,
  ExtractionEvalWinner,
} from '../../../shared/types';

const VALID_WINNERS: readonly ExtractionEvalWinner[] = ['a', 'b', 'tie'];
const VALID_SIDES: readonly ExtractionEvalSide[] = ['text', 'vlm'];

export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const queueId = context.params.id as string;
    requireRole(user, 'super_admin', 'org_admin', 'user');

    const body = (await context.request.json()) as EvalSubmitRequest;

    if (!body || typeof body !== 'object') {
      throw new BadRequestError('Request body required');
    }
    if (!VALID_WINNERS.includes(body.winner)) {
      throw new BadRequestError(`winner must be one of ${VALID_WINNERS.join(', ')}`);
    }
    if (!VALID_SIDES.includes(body.a_side)) {
      throw new BadRequestError(`a_side must be one of ${VALID_SIDES.join(', ')}`);
    }

    // Load queue item so we can tenant-scope and verify both extractions exist.
    const item = await context.env.DB.prepare(
      `SELECT id, tenant_id, ai_fields, vlm_extracted_fields, vlm_error
       FROM processing_queue WHERE id = ?`
    )
      .bind(queueId)
      .first<{
        id: string;
        tenant_id: string;
        ai_fields: string | null;
        vlm_extracted_fields: string | null;
        vlm_error: string | null;
      }>();

    if (!item) throw new NotFoundError('Queue item not found');
    requireTenantAccess(user, item.tenant_id);

    if (!item.ai_fields || !item.vlm_extracted_fields || item.vlm_error) {
      throw new BadRequestError('Queue item is not eligible for A/B evaluation (missing both extractions)');
    }

    const comment = typeof body.comment === 'string' ? body.comment.trim().slice(0, 2000) : null;
    const evaluatedAt = Date.now();
    const id = generateId();

    // Upsert — re-eval overwrites winner/a_side/comment but keeps the row id.
    // The UNIQUE(queue_item_id, evaluator_user_id) constraint makes the ON
    // CONFLICT target explicit.
    await context.env.DB.prepare(
      `INSERT INTO extraction_evaluations
        (id, queue_item_id, evaluator_user_id, winner, a_side, comment, evaluated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(queue_item_id, evaluator_user_id)
       DO UPDATE SET
         winner = excluded.winner,
         a_side = excluded.a_side,
         comment = excluded.comment,
         evaluated_at = excluded.evaluated_at`
    )
      .bind(id, queueId, user.id, body.winner, body.a_side, comment, evaluatedAt)
      .run();

    await logAudit(
      context.env.DB,
      user.id,
      item.tenant_id,
      'extraction_evaluation.submitted',
      'processing_queue',
      queueId,
      JSON.stringify({ winner: body.winner, a_side: body.a_side, has_comment: !!comment }),
      getClientIp(context.request)
    );

    // Re-compute remaining/total for the reviewer's tenant scope — lets the
    // UI update the "Doc N of M" counter without a second round trip.
    const tenantClause = user.role === 'super_admin' ? '' : 'AND pq.tenant_id = ?';
    const tenantBind: string[] = user.role === 'super_admin' ? [] : [user.tenant_id as string];
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
    const evaluated = evaluatedRow?.c ?? 0;
    const remaining = Math.max(0, total - evaluated);

    // Fetch the freshly written row so the response carries a canonical copy.
    const evaluation = await context.env.DB.prepare(
      `SELECT * FROM extraction_evaluations
       WHERE queue_item_id = ? AND evaluator_user_id = ?`
    )
      .bind(queueId, user.id)
      .first();

    const response: EvalSubmitResponse = {
      evaluation: evaluation as unknown as EvalSubmitResponse['evaluation'],
      remaining,
      total,
    };
    return new Response(JSON.stringify(response), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Eval submit error:', err);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
