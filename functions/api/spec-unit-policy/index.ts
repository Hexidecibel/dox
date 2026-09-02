/**
 * Per-tenant unit equivalence for spec checking (migration 0093).
 *
 * ONE SETTING, and it is the only configuration in this feature that can change
 * a verdict rather than add one. With `volume_mass_equivalent` on, a result in
 * CFU/mL is judged against a CFU/g limit (and MPN/mL against MPN/g) as the same
 * number. Off — the default, and what every tenant starts with — those stay
 * `not_checked`, which is the honest answer for a powder.
 *
 * It exists because a fluid-dairy tenant's suppliers print `cfu/mL` on the
 * majority of results while every limit on file is written in CFU/g, so the
 * majority unit matched no limit at all. Their QA lead states his own limits as
 * "≤ 10 CFU/g (CFU/mL for fluid)" — a ~3% density difference against a 20,000
 * CFU ceiling. That is a QA judgement about a product range, which is why it is
 * a setting a named person turns on rather than an assumption in the engine.
 *
 * WHAT IT DOES NOT DO: it is not "ignore units". Percent against CFU/g stays
 * refused, and CFU against MPN stays refused. See shared/specCheck.ts.
 *
 * Auth: super_admin + org_admin, matching /api/spec-limits — the person who
 * owns the limits owns the rule they are compared under. super_admin passes
 * ?tenant_id= / tenant_id; org_admin is scoped to its own tenant.
 *
 * Every change is audit-logged with the new value, because a setting that moves
 * verdicts has to be answerable later: who turned it on, and when.
 */

import { logAudit, getClientIp } from '../../lib/db';
import {
  requireRole,
  requireTenantAccess,
  BadRequestError,
  errorToResponse,
} from '../../lib/permissions';
import type { Env, User } from '../../lib/types';

interface PolicyRow {
  spec_volume_mass_equivalent: number | null;
  spec_unit_policy_updated_at: string | null;
  spec_unit_policy_updated_by: string | null;
}

const SELECT_POLICY = `SELECT spec_volume_mass_equivalent,
                              spec_unit_policy_updated_at,
                              spec_unit_policy_updated_by
                         FROM tenants WHERE id = ?`;

function policyResponse(row: PolicyRow | null, status = 200): Response {
  return new Response(
    JSON.stringify({
      volume_mass_equivalent: Number(row?.spec_volume_mass_equivalent ?? 0) === 1,
      updated_at: row?.spec_unit_policy_updated_at ?? null,
      updated_by: row?.spec_unit_policy_updated_by ?? null,
    }),
    { status, headers: { 'Content-Type': 'application/json' } }
  );
}

/** super_admin may name any tenant; everyone else gets their own. */
function resolveTenantId(user: User, requested: string | null | undefined): string {
  if (user.role === 'super_admin') {
    if (!requested) throw new BadRequestError('tenant_id is required for super_admin');
    return requested;
  }
  return user.tenant_id!;
}

/** GET /api/spec-unit-policy[?tenant_id=Z] */
export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireRole(user, 'super_admin', 'org_admin');

    const url = new URL(context.request.url);
    const tenantId = resolveTenantId(user, url.searchParams.get('tenant_id'));
    requireTenantAccess(user, tenantId);

    const row = await context.env.DB.prepare(SELECT_POLICY).bind(tenantId).first<PolicyRow>();
    return policyResponse(row);
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Get spec unit policy error:', err);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

/**
 * PUT /api/spec-unit-policy
 * Body: { volume_mass_equivalent: boolean, tenant_id? }
 *
 * The boolean is required and must be a boolean: a missing or fuzzy value here
 * would silently mean "off", and a setting this one can flip by accident is
 * worse than one that refuses the request.
 */
export const onRequestPut: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireRole(user, 'super_admin', 'org_admin');

    const body = (await context.request.json()) as {
      volume_mass_equivalent?: unknown;
      tenant_id?: string;
    };

    if (typeof body.volume_mass_equivalent !== 'boolean') {
      throw new BadRequestError('volume_mass_equivalent must be true or false');
    }
    const enabled = body.volume_mass_equivalent;

    const tenantId = resolveTenantId(user, body.tenant_id);
    requireTenantAccess(user, tenantId);

    await context.env.DB.prepare(
      `UPDATE tenants
          SET spec_volume_mass_equivalent = ?,
              spec_unit_policy_updated_at = datetime('now'),
              spec_unit_policy_updated_by = ?
        WHERE id = ?`
    )
      .bind(enabled ? 1 : 0, user.id, tenantId)
      .run();

    const saved = await context.env.DB.prepare(SELECT_POLICY).bind(tenantId).first<PolicyRow>();

    await logAudit(
      context.env.DB,
      user.id,
      tenantId,
      'spec_unit_policy_updated',
      'tenants',
      tenantId,
      JSON.stringify({ volume_mass_equivalent: enabled }),
      getClientIp(context.request)
    );

    return policyResponse(saved);
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Update spec unit policy error:', err);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
