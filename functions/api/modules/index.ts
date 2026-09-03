import { requireRole, requireTenantAccess, BadRequestError, errorToResponse } from '../../lib/permissions';
import { MODULE_KEYS, MODULES, isModuleKey } from '../../../shared/modules';
import type { Env, User } from '../../lib/types';
import type { ModuleSummary } from '../../../shared/types';

/**
 * /api/modules — what this tenant uses.
 *
 * The list is always all four modules, never "the rows in the table": the
 * vocabulary comes from `shared/modules.ts` and the table only holds
 * DECISIONS. A tenant that has never opened the screen has zero rows and still
 * gets a complete list, every entry reporting its code default. That is also
 * why a disabled module is listed (greyed) rather than dropped — the caller
 * has to be able to see the thing they would switch back on, and it is what
 * makes the middleware's 403 answerable rather than mysterious.
 *
 * Rows naming a module this build does not know about are ignored on the way
 * out, exactly as the resolver ignores them: there is deliberately no CHECK on
 * `module_key` (migration 0099), so a row left behind by a removed module must
 * not be able to produce a list entry for a surface that no longer exists.
 */

export interface TenantModuleDbRow {
  module_key: string;
  enabled: number;
  updated_at: string | null;
  updated_by: string | null;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Read every stored decision for one tenant, keyed for lookup. */
export async function readTenantModuleRows(
  db: D1Database,
  tenantId: string,
): Promise<Map<string, TenantModuleDbRow>> {
  const res = await db
    .prepare(
      'SELECT module_key, enabled, updated_at, updated_by FROM tenant_modules WHERE tenant_id = ?',
    )
    .bind(tenantId)
    .all<TenantModuleDbRow>();
  const map = new Map<string, TenantModuleDbRow>();
  for (const row of res.results ?? []) {
    if (!isModuleKey(row.module_key)) continue;
    map.set(row.module_key, row);
  }
  return map;
}

/** The code vocabulary joined onto whatever decisions exist. */
export function buildModuleSummaries(rows: Map<string, TenantModuleDbRow>): ModuleSummary[] {
  return MODULE_KEYS.map((key) => {
    const def = MODULES[key];
    const row = rows.get(key);
    return {
      key,
      label: def.label,
      blurb: def.blurb,
      enabled: row ? row.enabled !== 0 : def.defaultEnabled,
      configured: row !== undefined,
      updated_at: row?.updated_at ?? null,
      updated_by: row?.updated_by ?? null,
    };
  });
}

/**
 * Resolve which tenant a settings call is about. super_admin must say which —
 * they have no tenant of their own — and everybody else is pinned to theirs
 * whatever the query string says. Same shape as `/api/owner-routes`.
 */
export function resolveSettingsTenantId(user: User, requested: string | null): string {
  let tenantId = requested;
  if (user.role !== 'super_admin') tenantId = user.tenant_id;
  if (!tenantId) throw new BadRequestError('tenant_id is required');
  requireTenantAccess(user, tenantId);
  return tenantId;
}

/**
 * GET /api/modules
 *
 * Role: super_admin, org_admin. This is the configuration view; the endpoint
 * an ordinary user's nav reads is `/api/module-access`, which answers about
 * THEM rather than about the organization.
 */
export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireRole(user, 'super_admin', 'org_admin');

    const url = new URL(context.request.url);
    const tenantId = resolveSettingsTenantId(user, url.searchParams.get('tenant_id'));

    const rows = await readTenantModuleRows(context.env.DB, tenantId);
    return json({ tenant_id: tenantId, modules: buildModuleSummaries(rows) });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('modules list error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
};
