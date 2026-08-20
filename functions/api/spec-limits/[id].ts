/**
 * Update or delete one acceptance limit. See `spec-limits/index.ts` for the
 * scope-resolution rules.
 *
 * Every edit bumps `version`. A verdict already recorded against this limit
 * keeps its own frozen copy of the numbers it was judged against, so moving a
 * threshold never rewrites history — the counter is what tells a reader that the
 * limit they are looking at is not the one an older verdict used.
 */

import { logAudit, getClientIp } from '../../lib/db';
import {
  requireRole,
  requireTenantAccess,
  NotFoundError,
  errorToResponse,
} from '../../lib/permissions';
import { sanitizeString } from '../../lib/validation';
import { validateLimitShape } from '../../../shared/specCheck';
import { badRequest, num, validateScope, type LimitBody } from './index';
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

    const updates: string[] = [];
    const params: (string | number | null)[] = [];
    const push = (sql: string, value: string | number | null) => {
      updates.push(sql);
      params.push(value);
    };

    if (body.operator !== undefined || body.value_min !== undefined || body.value_max !== undefined) {
      push('operator = ?', operator);
      push('value_min = ?', valueMin);
      push('value_max = ?', valueMax);
    }
    if (body.unit !== undefined) push('unit = ?', body.unit ? sanitizeString(body.unit) : null);
    if (body.severity !== undefined) {
      if (!SEVERITIES.has(String(body.severity))) return badRequest('severity must be warn or alert');
      push('severity = ?', String(body.severity));
    }
    if (body.notes !== undefined) push('notes = ?', body.notes ? sanitizeString(body.notes) : null);
    if (body.active !== undefined) push('active = ?', body.active ? 1 : 0);
    if (body.supplier_id !== undefined) push('supplier_id = ?', body.supplier_id || null);
    if (body.document_type_id !== undefined) push('document_type_id = ?', body.document_type_id || null);
    if (body.product_id !== undefined) push('product_id = ?', body.product_id || null);

    if (updates.length === 0) return badRequest('No fields to update');

    updates.push('version = version + 1', "updated_at = datetime('now')", 'updated_by = ?');
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
        before: { operator: limit.operator, value_min: limit.value_min, value_max: limit.value_max },
        after: { operator, value_min: valueMin, value_max: valueMax },
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
