/**
 * Update or delete one acceptance limit. See `spec-limits/index.ts` for the
 * scope-resolution rules.
 *
 * WHEN `version` MOVES. Only when the THRESHOLD SEMANTICS move — operator,
 * value_min, value_max, unit — which is the SME's own change rule ("changing a
 * limit value requires a new version") and, since long before this, the rule
 * `bin/lib/specLimitsImport.js` already applied. This endpoint used to bump on
 * every edit, so the same limit reached a different version depending on which
 * door the edit came through, and a notes fix advanced the counter that is
 * supposed to mean "the numbers changed". One rule now, `limitThresholdChanged`
 * in shared/specCheck.ts, imported by both writers.
 *
 * Notes, severity, criticality, active and a watch review-by date do NOT bump:
 * none of them changes what a result is compared against, and the tier and the
 * watch are frozen into `limit_snapshot` in their own right, so holding the
 * version still loses nothing. Neither does a SCOPE move (supplier / document
 * type / product): that changes which documents the limit judges, not what it
 * judges them against, and every verdict already names the limit it came from.
 *
 * A verdict already recorded against this limit keeps its own frozen copy of
 * the numbers it was judged against — including, now, that version — so moving
 * a threshold never rewrites history; the counter is what tells a reader that
 * the limit they are looking at is not the one an older verdict used.
 */

import { logAudit, getClientIp } from '../../lib/db';
import {
  requireRole,
  requireTenantAccess,
  NotFoundError,
  errorToResponse,
} from '../../lib/permissions';
import { sanitizeString } from '../../lib/validation';
import { validateLimitShape, limitThresholdChanged } from '../../../shared/specCheck';
import {
  badRequest,
  num,
  readCriticality,
  readReviewBy,
  validateScope,
  findScopeConflict,
  scopeConflictResponse,
  type LimitBody,
} from './index';
import type { Env, User } from '../../lib/types';

const SEVERITIES = new Set(['warn', 'alert']);

export const onRequestPut: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireRole(user, 'super_admin', 'org_admin');

    const limit = (await context.env.DB.prepare('SELECT * FROM spec_limits WHERE id = ?')
      .bind(context.params.id as string)
      .first()) as Record<string, unknown> | null;
    if (!limit) throw new NotFoundError('Spec limit not found');
    requireTenantAccess(user, limit.tenant_id as string);

    const body = (await context.request.json()) as LimitBody;

    // Validate the RESULTING shape, not just the submitted fields: changing an
    // operator without its bound would otherwise produce a limit that can never
    // fire, which is worse than no limit because the UI would still list it.
    const operator = body.operator !== undefined ? String(body.operator) : String(limit.operator);
    const valueMin = body.value_min !== undefined ? num(body.value_min) : (limit.value_min as number | null);
    const valueMax = body.value_max !== undefined ? num(body.value_max) : (limit.value_max as number | null);
    const shapeError = validateLimitShape({ operator, value_min: valueMin, value_max: valueMax });
    if (shapeError) return badRequest(shapeError);

    const scopeError = await validateScope(context.env.DB, limit.tenant_id as string, body);
    if (scopeError) return badRequest(scopeError);

    // A PUT may MOVE a limit's scope, so the conflict check runs on the
    // resulting scope, not the submitted fields, and excludes this row.
    const resultingScope = {
      supplier_id:
        body.supplier_id !== undefined ? body.supplier_id || null : (limit.supplier_id as string | null),
      document_type_id:
        body.document_type_id !== undefined
          ? body.document_type_id || null
          : (limit.document_type_id as string | null),
      product_id:
        body.product_id !== undefined ? body.product_id || null : (limit.product_id as string | null),
    };
    const conflict = await findScopeConflict(
      context.env.DB,
      limit.tenant_id as string,
      limit.spec_test_id as string,
      resultingScope,
      limit.id as string
    );
    if (conflict) return scopeConflictResponse(conflict);

    // Review-by is validated against the RESULTING scope, like the conflict
    // check: moving a watch limit off its supplier while it still carries a
    // review-by would leave a tenant-wide limit claiming to be a watch.
    const reviewBy = readReviewBy(body.review_by, resultingScope.supplier_id);
    if (reviewBy && 'error' in reviewBy) return badRequest(reviewBy.error);
    if (!reviewBy && limit.review_by && !resultingScope.supplier_id) {
      return badRequest(
        'This limit has a review-by date, which only a supplier-specific limit can carry — clear review_by in the same request'
      );
    }

    const updates: string[] = [];
    const params: (string | number | null)[] = [];
    const push = (sql: string, value: string | number | null) => {
      updates.push(sql);
      params.push(value);
    };

    // The unit is resolved like the operator and the values: what the row WILL
    // hold, so the version rule below judges the resulting limit rather than the
    // submitted fields.
    const unit =
      body.unit !== undefined
        ? body.unit
          ? sanitizeString(body.unit)
          : null
        : (limit.unit as string | null);

    if (body.operator !== undefined || body.value_min !== undefined || body.value_max !== undefined) {
      push('operator = ?', operator);
      push('value_min = ?', valueMin);
      push('value_max = ?', valueMax);
    }
    if (body.unit !== undefined) push('unit = ?', unit);
    if (body.severity !== undefined) {
      if (!SEVERITIES.has(String(body.severity))) return badRequest('severity must be warn or alert');
      push('severity = ?', String(body.severity));
    }
    // Re-ranking changes no arithmetic, so it does NOT move `version` (see the
    // module header). Verdicts already recorded keep the tier they were filed
    // under in their own frozen snapshot; the new tier applies from the next
    // judgement onward.
    if (body.criticality !== undefined) {
      const criticality = readCriticality(body.criticality);
      if ('error' in criticality) return badRequest(criticality.error);
      push('criticality = ?', criticality.criticality);
    }
    if (body.notes !== undefined) push('notes = ?', body.notes ? sanitizeString(body.notes) : null);
    if (body.active !== undefined) push('active = ?', body.active ? 1 : 0);
    if (body.supplier_id !== undefined) push('supplier_id = ?', body.supplier_id || null);
    if (body.document_type_id !== undefined) push('document_type_id = ?', body.document_type_id || null);
    if (body.product_id !== undefined) push('product_id = ?', body.product_id || null);
    if (reviewBy) push('review_by = ?', reviewBy.review_by);

    if (updates.length === 0) return badRequest('No fields to update');

    const thresholdMoved = limitThresholdChanged(
      {
        operator: limit.operator as string,
        value_min: limit.value_min as number | null,
        value_max: limit.value_max as number | null,
        unit: limit.unit as string | null,
      },
      { operator, value_min: valueMin, value_max: valueMax, unit }
    );
    if (thresholdMoved) updates.push('version = version + 1');
    updates.push("updated_at = datetime('now')", 'updated_by = ?');
    params.push(user.id);

    await context.env.DB.prepare(`UPDATE spec_limits SET ${updates.join(', ')} WHERE id = ?`)
      .bind(...params, limit.id as string)
      .run();

    await logAudit(
      context.env.DB,
      user.id,
      limit.tenant_id as string,
      'spec_limit.updated',
      'spec_limits',
      limit.id as string,
      JSON.stringify({
        before: {
          operator: limit.operator,
          value_min: limit.value_min,
          value_max: limit.value_max,
          unit: limit.unit ?? null,
          criticality: limit.criticality,
          review_by: limit.review_by ?? null,
          version: limit.version ?? null,
        },
        after: {
          operator,
          value_min: valueMin,
          value_max: valueMax,
          unit,
          criticality: body.criticality !== undefined ? body.criticality : limit.criticality,
          review_by: reviewBy ? reviewBy.review_by : (limit.review_by ?? null),
          version: thresholdMoved ? Number(limit.version ?? 1) + 1 : (limit.version ?? null),
        },
        // Said out loud so the audit row answers "was this a new version of the
        // limit?" without a reader having to diff the two blocks above.
        version_bumped: thresholdMoved,
      }),
      getClientIp(context.request)
    );

    const updated = await context.env.DB.prepare('SELECT * FROM spec_limits WHERE id = ?')
      .bind(limit.id as string)
      .first();

    return new Response(JSON.stringify({ specLimit: updated }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Update spec limit error:', err);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

export const onRequestDelete: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireRole(user, 'super_admin', 'org_admin');

    const limit = (await context.env.DB.prepare('SELECT * FROM spec_limits WHERE id = ?')
      .bind(context.params.id as string)
      .first()) as Record<string, unknown> | null;
    if (!limit) throw new NotFoundError('Spec limit not found');
    requireTenantAccess(user, limit.tenant_id as string);

    await context.env.DB.prepare('DELETE FROM spec_limits WHERE id = ?')
      .bind(limit.id as string)
      .run();

    await logAudit(
      context.env.DB,
      user.id,
      limit.tenant_id as string,
      'spec_limit.deleted',
      'spec_limits',
      limit.id as string,
      JSON.stringify({
        spec_test_id: limit.spec_test_id,
        operator: limit.operator,
        value_min: limit.value_min,
        value_max: limit.value_max,
      }),
      getClientIp(context.request)
    );

    return new Response(JSON.stringify({ success: true }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Delete spec limit error:', err);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
