import { requireRole, errorToResponse } from '../../lib/permissions';
import { isModuleKey } from '../../../shared/modules';
import { readTenantModuleRows, buildModuleSummaries, resolveSettingsTenantId } from '../modules/index';
import type { ModuleKey } from '../../../shared/modules';
import type { Env, User } from '../../lib/types';
import type { ModuleVisibilityFunction } from '../../../shared/types';

/**
 * /api/module-visibility — the function × module grid.
 *
 * "The same role definitions drive both alert routing and what a user sees on
 * login" — one concept, two effects. The functions here are not a new role
 * table: they are the departmental labels `owner_routes` (migration 0091)
 * already carries, and a person's membership is the route that already names
 * them.
 *
 * WHY TWO SOURCES OF LABELS. `owner_labels` (migration 0099) is the declared
 * list — it exists because you cannot configure what Sales sees until Sales
 * has been routed something, and Sales owns no renewals, so Sales would never
 * appear. But routes created AFTER that migration's backfill only exist in
 * `owner_routes`, so the grid unions the two: everything declared, plus
 * everything actually routing today. A label that is only routing is returned
 * with `declared: false`, and the PUT promotes it on the way through.
 *
 * ABSENCE MEANS UNCONSTRAINED. A function with no `module_visibility` rows
 * sees everything the tenant has — `constrained: false` here, and the same
 * rule in the resolver. Narrowing always requires a row somebody wrote.
 */

interface LabelRow {
  owner_key: string;
  owner_label: string;
}

interface RouteGroupRow {
  owner_key: string;
  owner_label: string;
  route_count: number;
}

interface VisibilityRow {
  owner_key: string;
  module_key: string;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Build the grid for one tenant. Exported because the PUT re-reads it to
 * return the single row it just changed, rather than reconstructing the same
 * shape twice and letting the two drift.
 */
export async function loadVisibilityGrid(
  db: D1Database,
  tenantId: string,
): Promise<ModuleVisibilityFunction[]> {
  const [labelsRes, routesRes, visRes] = await Promise.all([
    db
      .prepare(
        'SELECT owner_key, owner_label FROM owner_labels WHERE tenant_id = ? AND active = 1',
      )
      .bind(tenantId)
      .all<LabelRow>(),
    db
      .prepare(
        `SELECT owner_key, MIN(owner_label) AS owner_label, COUNT(*) AS route_count
           FROM owner_routes
          WHERE tenant_id = ? AND active = 1
          GROUP BY owner_key`,
      )
      .bind(tenantId)
      .all<RouteGroupRow>(),
    db
      .prepare('SELECT owner_key, module_key FROM module_visibility WHERE tenant_id = ?')
      .bind(tenantId)
      .all<VisibilityRow>(),
  ]);

  const scoped = new Map<string, ModuleKey[]>();
  for (const row of visRes.results ?? []) {
    // Unknown keys are ignored on the way out, exactly as the resolver ignores
    // them: a row for a module this build does not have cannot narrow anything.
    if (!isModuleKey(row.module_key)) continue;
    const list = scoped.get(row.owner_key) ?? [];
    list.push(row.module_key);
    scoped.set(row.owner_key, list);
  }

  const routeCounts = new Map<string, number>();
  const byKey = new Map<string, ModuleVisibilityFunction>();

  for (const row of labelsRes.results ?? []) {
    byKey.set(row.owner_key, {
      owner_key: row.owner_key,
      owner_label: row.owner_label,
      constrained: false,
      modules: [],
      route_count: 0,
      declared: true,
    });
  }
  for (const row of routesRes.results ?? []) {
    routeCounts.set(row.owner_key, Number(row.route_count) || 0);
    if (!byKey.has(row.owner_key)) {
      byKey.set(row.owner_key, {
        owner_key: row.owner_key,
        owner_label: row.owner_label,
        constrained: false,
        modules: [],
        route_count: 0,
        declared: false,
      });
    }
  }

  for (const fn of byKey.values()) {
    fn.route_count = routeCounts.get(fn.owner_key) ?? 0;
    const modules = scoped.get(fn.owner_key) ?? [];
    fn.constrained = modules.length > 0;
    fn.modules = modules;
  }

  return [...byKey.values()].sort((a, b) => a.owner_label.localeCompare(b.owner_label));
}

/**
 * GET /api/module-visibility
 *
 * Role: super_admin, org_admin.
 */
export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireRole(user, 'super_admin', 'org_admin');

    const url = new URL(context.request.url);
    const tenantId = resolveSettingsTenantId(user, url.searchParams.get('tenant_id'));

    const [moduleRows, functions] = await Promise.all([
      readTenantModuleRows(context.env.DB, tenantId),
      loadVisibilityGrid(context.env.DB, tenantId),
    ]);

    // The modules come back alongside the grid because a checkbox for a module
    // the tenant has switched OFF has to render differently: the function
    // layer can only narrow within the ceiling, never grant past it.
    return json({
      tenant_id: tenantId,
      modules: buildModuleSummaries(moduleRows),
      functions,
    });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('module-visibility list error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
};
