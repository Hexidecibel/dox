/**
 * /api/product-requirements — the per-product exception to a per-product
 * requirement (migration 0123).
 *
 * A requirement with `scope = 'product'` attached to supplier S is owed by
 * every ACTIVE product of S. This table moves ONE product in or out:
 *
 *   exempt  "this packaging SKU owes no nutritionals" — removes an inherited
 *           per-product item for one product. A REASON IS REQUIRED: an
 *           exemption nobody can explain a year later is how an obligation
 *           quietly disappears.
 *   add     makes a per-product requirement owed by one product only, without
 *           attaching it to the whole supplier.
 *
 * Only a PRODUCT-scope requirement may carry a row, and only for a product S
 * actually supplies (either link path). Same role gate and audit posture as
 * /api/supplier-requirements; removal is a hard DELETE with the whole row in
 * the audit record.
 */

import { generateId, logAudit, getClientIp } from '../../lib/db';
import { requireRole, errorToResponse } from '../../lib/permissions';
import { sanitizeString } from '../../lib/validation';
import { resolveWriteTenant, isValidSupplierRequirementTier } from '../../lib/registry-vocab';
import {
  PRODUCT_REQUIREMENT_MODES,
  isProductRequirementMode,
} from '../../../shared/requirementScope';
import {
  PRODUCT_REQUIREMENT_SELECT,
  assertProductRequirementTarget,
} from '../../lib/product-requirements';
import type { Env, User } from '../../lib/types';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * GET /api/product-requirements?supplier_id=&product_id=&requirement_id=
 * Any signed-in user of the tenant may read (the gap report needs it);
 * super_admin passes ?tenant_id=.
 */
export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const url = new URL(context.request.url);
    const tenantId =
      user.role === 'super_admin' ? url.searchParams.get('tenant_id') : user.tenant_id;
    if (!tenantId) return json({ error: 'tenant_id is required' }, 400);

    const conditions = ['pr.tenant_id = ?'];
    const params: string[] = [tenantId];
    for (const key of ['supplier_id', 'product_id', 'requirement_id', 'mode'] as const) {
      const v = url.searchParams.get(key);
      if (v) {
        conditions.push(`pr.${key} = ?`);
        params.push(v);
      }
    }
    const rows = await context.env.DB.prepare(
      `${PRODUCT_REQUIREMENT_SELECT} WHERE ${conditions.join(' AND ')}
        ORDER BY s.name, p.name, r.name`,
    )
      .bind(...params)
      .all();
    return json({ product_requirements: rows.results ?? [] });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('List product requirements error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
};

/**
 * POST /api/product-requirements
 * { supplier_id, product_id, requirement_id, mode: 'add'|'exempt', tier?, reason?, tenant_id? }
 * 409 when the (supplier, product, requirement) row already exists — change it
 * with PUT /api/product-requirements/:id instead.
 */
export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireRole(user, 'super_admin', 'org_admin');
    const body = (await context.request.json()) as {
      supplier_id?: string;
      product_id?: string;
      requirement_id?: string;
      mode?: string;
      tier?: string;
      reason?: string | null;
      tenant_id?: string;
    };

    if (!body.supplier_id || !body.product_id || !body.requirement_id) {
      return json({ error: 'supplier_id, product_id and requirement_id are required' }, 400);
    }
    if (!isProductRequirementMode(body.mode)) {
      return json({ error: `mode must be one of: ${PRODUCT_REQUIREMENT_MODES.join(', ')}` }, 400);
    }
    const tier = body.tier ?? 'required';
    if (!isValidSupplierRequirementTier(tier)) {
      return json({ error: 'tier must be required or recommended' }, 400);
    }
    const reason = body.reason ? sanitizeString(body.reason) : null;
    if (body.mode === 'exempt' && !reason) {
      return json({ error: 'An exemption needs a reason' }, 400);
    }

    const tenantId = resolveWriteTenant(user, body.tenant_id);
    await assertProductRequirementTarget(
      context.env.DB,
      tenantId,
      body.supplier_id,
      body.product_id,
      body.requirement_id,
    );

    const existing = await context.env.DB.prepare(
      `SELECT id FROM product_requirements
        WHERE tenant_id = ? AND supplier_id = ? AND product_id = ? AND requirement_id = ?`,
    )
      .bind(tenantId, body.supplier_id, body.product_id, body.requirement_id)
      .first<{ id: string }>();
    if (existing) {
      return json(
        { error: 'This product already has a row for this requirement', id: existing.id },
        409,
      );
    }

    const id = generateId();
    await context.env.DB.prepare(
      `INSERT INTO product_requirements
         (id, tenant_id, supplier_id, product_id, requirement_id, mode, tier, reason, source, created_by, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'human', ?, ?)`,
    )
      .bind(
        id,
        tenantId,
        body.supplier_id,
        body.product_id,
        body.requirement_id,
        body.mode,
        tier,
        reason,
        user.id,
        user.id,
      )
      .run();

    const row = await context.env.DB.prepare(`${PRODUCT_REQUIREMENT_SELECT} WHERE pr.id = ?`)
      .bind(id)
      .first<Record<string, unknown>>();

    await logAudit(
      context.env.DB,
      user.id,
      tenantId,
      body.mode === 'exempt' ? 'product_requirement.exempted' : 'product_requirement.added',
      'product_requirement',
      id,
      JSON.stringify({
        supplier_id: body.supplier_id,
        supplier_name: row?.supplier_name,
        product_id: body.product_id,
        product_name: row?.product_name,
        requirement_id: body.requirement_id,
        requirement_name: row?.requirement_name,
        mode: body.mode,
        tier,
        reason,
      }),
      getClientIp(context.request),
    );

    return json({ product_requirement: row }, 201);
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Create product requirement error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
};
