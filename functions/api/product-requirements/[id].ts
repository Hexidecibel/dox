/**
 * /api/product-requirements/:id — change or remove one per-product exception
 * (migration 0123). See index.ts for what the rows mean.
 *
 * Another tenant's row is a 404, never a 403: an id-existence probe across
 * tenants is itself a leak.
 */

import { logAudit, getClientIp } from '../../lib/db';
import { requireRole, NotFoundError, errorToResponse } from '../../lib/permissions';
import { sanitizeString } from '../../lib/validation';
import { isValidSupplierRequirementTier } from '../../lib/registry-vocab';
import { PRODUCT_REQUIREMENT_MODES, isProductRequirementMode } from '../../../shared/requirementScope';
import { PRODUCT_REQUIREMENT_SELECT } from '../../lib/product-requirements';
import type { Env, User } from '../../lib/types';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function loadScoped(
  db: D1Database,
  user: User,
  id: string,
): Promise<Record<string, unknown>> {
  const row = await db
    .prepare(`${PRODUCT_REQUIREMENT_SELECT} WHERE pr.id = ?`)
    .bind(id)
    .first<Record<string, unknown>>();
  if (!row || (user.role !== 'super_admin' && row.tenant_id !== user.tenant_id)) {
    throw new NotFoundError('Product requirement not found');
  }
  return row;
}

/** PUT { mode?, tier?, reason? } */
export const onRequestPut: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireRole(user, 'super_admin', 'org_admin');
    const id = context.params.id as string;
    const before = await loadScoped(context.env.DB, user, id);

    const body = (await context.request.json()) as {
      mode?: string;
      tier?: string;
      reason?: string | null;
    };

    const mode = body.mode ?? (before.mode as string);
    if (!isProductRequirementMode(mode)) {
      return json({ error: `mode must be one of: ${PRODUCT_REQUIREMENT_MODES.join(', ')}` }, 400);
    }
    const tier = body.tier ?? (before.tier as string);
    if (!isValidSupplierRequirementTier(tier)) {
      return json({ error: 'tier must be required or recommended' }, 400);
    }
    const reason =
      body.reason !== undefined
        ? body.reason
          ? sanitizeString(body.reason)
          : null
        : ((before.reason as string | null) ?? null);
    if (mode === 'exempt' && !reason) {
      return json({ error: 'An exemption needs a reason' }, 400);
    }

    await context.env.DB.prepare(
      `UPDATE product_requirements
          SET mode = ?, tier = ?, reason = ?, updated_at = datetime('now'), updated_by = ?
        WHERE id = ?`,
    )
      .bind(mode, tier, reason, user.id, id)
      .run();

    await logAudit(
      context.env.DB,
      user.id,
      before.tenant_id as string,
      'product_requirement.updated',
      'product_requirement',
      id,
      JSON.stringify({
        product_name: before.product_name,
        requirement_name: before.requirement_name,
        supplier_name: before.supplier_name,
        before: { mode: before.mode, tier: before.tier, reason: before.reason },
        after: { mode, tier, reason },
      }),
      getClientIp(context.request),
    );

    const row = await context.env.DB.prepare(`${PRODUCT_REQUIREMENT_SELECT} WHERE pr.id = ?`)
      .bind(id)
      .first();
    return json({ product_requirement: row });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Update product requirement error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
};

/** DELETE — hard delete; the whole row goes into the audit record. */
export const onRequestDelete: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireRole(user, 'super_admin', 'org_admin');
    const id = context.params.id as string;
    const before = await loadScoped(context.env.DB, user, id);

    await context.env.DB.prepare('DELETE FROM product_requirements WHERE id = ?').bind(id).run();

    await logAudit(
      context.env.DB,
      user.id,
      before.tenant_id as string,
      'product_requirement.removed',
      'product_requirement',
      id,
      JSON.stringify(before),
      getClientIp(context.request),
    );
    return json({ success: true });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Delete product requirement error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
};
