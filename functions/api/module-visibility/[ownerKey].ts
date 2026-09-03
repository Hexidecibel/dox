import { logAudit, getClientIp } from '../../lib/db';
import { requireRole, BadRequestError, NotFoundError, errorToResponse } from '../../lib/permissions';
import { normalizeOwnerKey } from '../../lib/alert-routing';
import { isModuleKey } from '../../../shared/modules';
import { resolveSettingsTenantId } from '../modules/index';
import { loadVisibilityGrid } from './index';
import type { ModuleKey } from '../../../shared/modules';
import type { Env, User } from '../../lib/types';

/**
 * PUT /api/module-visibility/:ownerKey — scope one function, or unscope it.
 *
 * Body: { constrained: boolean, modules?: string[] }
 *
 * Role: super_admin, org_admin.
 *
 * `{ constrained: false }` DELETES every row for the function. That is the
 * whole encoding: absence means unconstrained, so "sees everything" is not a
 * row full of every module — it is no rows at all. Storing the full set
 * instead would freeze today's module list into the configuration, and a
 * module shipped next year would arrive invisible to everyone who had ever
 * opened this screen.
 *
 * `{ constrained: true, modules: [] }` IS A 400, AND THAT IS THE POINT.
 * "Sales sees nothing" is a deactivated account, not a role configuration —
 * the way to give somebody no portal is to not give them a portal. Worse, the
 * write would do the OPPOSITE of what the admin who unchecked the last box
 * intended: zero rows means unconstrained, so the person would silently gain
 * access to every module rather than lose it. Rejecting is the only answer
 * that is not a trap; a UI that has just had its last box unchecked should be
 * asking whether the admin meant "unconstrained" instead.
 *
 * The owner key is normalized with the SAME `normalizeOwnerKey` that
 * `owner_routes` uses. There is no SQL-side collation on either table, so both
 * sides must keep going through that one function or 'QA' and 'qa ' become two
 * different departments.
 */

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * `module_visibility` carries a composite FK to `owner_labels`, so a label has
 * to be declared before it can be scoped. A department that is only routing —
 * created after 0099's backfill — is promoted here rather than being refused:
 * the admin is looking at it on the grid, so telling them it does not exist
 * would be a lie about our own bookkeeping. Display spelling comes from the
 * routes that already use it, so the promoted row reads the way the tenant
 * writes it.
 */
async function ensureOwnerLabel(
  db: D1Database,
  tenantId: string,
  ownerKey: string,
  actorId: string,
): Promise<boolean> {
  const existing = await db
    .prepare('SELECT owner_key FROM owner_labels WHERE tenant_id = ? AND owner_key = ?')
    .bind(tenantId, ownerKey)
    .first<{ owner_key: string }>();
  if (existing) return true;

  const route = await db
    .prepare(
      `SELECT MIN(owner_label) AS owner_label
         FROM owner_routes
        WHERE tenant_id = ? AND owner_key = ?`,
    )
    .bind(tenantId, ownerKey)
    .first<{ owner_label: string | null }>();
  if (!route?.owner_label) return false;

  await db
    .prepare(
      `INSERT OR IGNORE INTO owner_labels (tenant_id, owner_key, owner_label, created_by)
       VALUES (?, ?, ?, ?)`,
    )
    .bind(tenantId, ownerKey, route.owner_label, actorId)
    .run();
  return true;
}

export const onRequestPut: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireRole(user, 'super_admin', 'org_admin');

    const ownerKey = normalizeOwnerKey(context.params.ownerKey as string);
    if (!ownerKey) throw new BadRequestError('ownerKey is required');

    const body = (await context.request.json().catch(() => ({}))) as {
      constrained?: unknown;
      modules?: unknown;
      tenant_id?: string;
    };
    if (typeof body.constrained !== 'boolean') {
      throw new BadRequestError('constrained must be a boolean');
    }

    const url = new URL(context.request.url);
    const tenantId = resolveSettingsTenantId(
      user,
      body.tenant_id ?? url.searchParams.get('tenant_id'),
    );

    let modules: ModuleKey[] = [];
    if (body.constrained) {
      const raw = Array.isArray(body.modules) ? body.modules : [];
      const unknown: string[] = [];
      const seen = new Set<ModuleKey>();
      for (const entry of raw) {
        const value = String(entry);
        if (!isModuleKey(value)) {
          unknown.push(value);
          continue;
        }
        seen.add(value);
      }
      // A typo'd key is rejected rather than dropped: silently ignoring it
      // would store a NARROWER scope than the admin submitted, which is the
      // one direction this feature is never allowed to move by accident.
      if (unknown.length > 0) {
        throw new BadRequestError(`Unknown module(s): ${unknown.join(', ')}`);
      }
      modules = [...seen];
      if (modules.length === 0) {
        throw new BadRequestError(
          'A constrained function must be able to see at least one module. ' +
            'To give this function access to everything, send constrained: false; ' +
            'to give a person no portal at all, deactivate their account.',
        );
      }
      const declared = await ensureOwnerLabel(context.env.DB, tenantId, ownerKey, user.id);
      if (!declared) {
        throw new NotFoundError(
          `No function '${ownerKey}' in this tenant. Add an owner route for it first.`,
        );
      }
    }

    // Replace rather than diff: the request states the whole intended scope,
    // and a delete-then-insert of at most four rows is cheaper to reason about
    // than a set difference that could leave a stale row narrowing somebody.
    await context.env.DB.prepare(
      'DELETE FROM module_visibility WHERE tenant_id = ? AND owner_key = ?',
    )
      .bind(tenantId, ownerKey)
      .run();

    for (const moduleKey of modules) {
      await context.env.DB.prepare(
        `INSERT OR IGNORE INTO module_visibility (tenant_id, owner_key, module_key, created_by)
         VALUES (?, ?, ?, ?)`,
      )
        .bind(tenantId, ownerKey, moduleKey, user.id)
        .run();
    }

    await logAudit(
      context.env.DB,
      user.id,
      tenantId,
      body.constrained ? 'module_visibility.scoped' : 'module_visibility.unscoped',
      'module_visibility',
      ownerKey,
      JSON.stringify({ owner_key: ownerKey, constrained: body.constrained, modules }),
      getClientIp(context.request),
    );

    const grid = await loadVisibilityGrid(context.env.DB, tenantId);
    const row = grid.find((f) => f.owner_key === ownerKey) ?? {
      owner_key: ownerKey,
      owner_label: ownerKey,
      constrained: false,
      modules: [],
      route_count: 0,
      declared: false,
    };
    return json({ function: row });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('module-visibility update error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
};
