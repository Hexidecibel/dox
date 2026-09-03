/**
 * Module access — turning the pure resolver in `shared/modules.ts` into an
 * answer about a live request.
 *
 * `shared/modules.ts` decides WHAT a person can see given rows; this file is
 * the only place that fetches those rows, and the only place the enforcement
 * paths (the `_middleware.ts` gate, the GraphQL context, the scheduled jobs)
 * call into. Keeping the two apart is what lets the resolver stay pure enough
 * to unit-test without a database.
 *
 * THIS IS SCOPE, NOT SECURITY — AND THAT DECIDES THE ERROR BEHAVIOUR.
 * A module gate answers "should this person be looking at this at all today".
 * Tenant isolation (`requireTenantAccess`) and the four permission tiers
 * (`requireRole`) are the security boundary and are untouched by anything
 * here. So every read below FAILS OPEN: on a D1 error the caller is treated as
 * seeing everything, and the failure is logged. Failing closed would take a
 * whole portal down to protect a preference — a transient database blip would
 * read to the customer as "the app stopped working", which is a far worse
 * outcome than a surface they do not use staying visible for a minute.
 *
 * TWO READS, MEMOIZED PER REQUEST. The middleware gate runs on every API call,
 * so the reads are skipped entirely when the path maps to no module (which is
 * most of them — see `moduleForApiPath`), and memoized on the request's own
 * `context.data` when they do happen, so a handler asking again is free.
 */

import {
  MODULE_KEYS,
  MODULES,
  moduleForApiPath,
  resolveVisibleModules,
} from '../../shared/modules';
import type { ModuleFunctionRow, ModuleKey, TenantModuleRow } from '../../shared/modules';
import type { User } from './types';

export interface ModuleAccess {
  /**
   * The TENANT ceiling: what this organization has switched on, before the
   * per-function narrowing. Carried separately from `visible` so a denial can
   * say WHICH of the two layers refused — "your company turned Orders off" and
   * "your role does not include Orders" are different support tickets.
   */
  tenantEnabled: ModuleKey[];
  /** What this person sees: the ceiling, narrowed by their functions. */
  visible: ModuleKey[];
  /**
   * The distinct function keys this user holds, from `owner_routes`. Returned
   * so the "why can't I see Orders" answer can name the departments doing the
   * narrowing instead of leaving the user to guess. Empty for super_admin,
   * who is never narrowed and for whom no lookup is done.
   */
  functions: string[];
  /**
   * True when a read failed and we fell open. Surfaced rather than swallowed:
   * an admin looking at a module list that quietly came from a failed query
   * should be able to tell.
   */
  degraded: boolean;
}

/**
 * Anything with a mutable bag on it — in practice a Pages `context.data`,
 * which already carries `user`. Typed structurally so this module does not
 * have to depend on the Pages function types, and so tests can hand it `{}`.
 */
export interface ModuleAccessMemo {
  [key: string]: unknown;
}

const MEMO_KEY = '__moduleAccess';

function allModules(degraded: boolean): ModuleAccess {
  return { tenantEnabled: [...MODULE_KEYS], visible: [...MODULE_KEYS], functions: [], degraded };
}

/**
 * The tenant's `tenant_modules` rows. An absent row is not "off" — it is "the
 * code default", which the resolver applies.
 */
async function readTenantRows(db: D1Database, tenantId: string): Promise<TenantModuleRow[]> {
  const res = await db
    .prepare('SELECT module_key, enabled FROM tenant_modules WHERE tenant_id = ?')
    .bind(tenantId)
    .all<TenantModuleRow>();
  return res.results ?? [];
}

/**
 * Which functions this user holds, and what each of those functions is scoped
 * to.
 *
 * THE LEFT JOIN IS LOAD-BEARING AND MUST STAY A LEFT JOIN. A function that
 * nobody has configured visibility for produces exactly one row with a NULL
 * `module_key`, and that NULL is how the resolver tells an UNCONSTRAINED
 * function from a function that is merely absent. An INNER JOIN would drop
 * those rows, so a user holding one scoped function and one unscoped one would
 * silently lose everything the unscoped one was meant to leave open — the
 * narrowing would come from a JOIN nobody wrote a row for, which is exactly
 * the failure `module_visibility` is shaped to make impossible.
 *
 * Membership comes from `owner_routes` (migration 0091) — the same QA /
 * Insurance / Accounting / Purchasing routes that already decide who receives
 * an alert. One concept, two effects; no second role table. Only routes
 * pointing at a portal USER can match a login: a route holding a bare email
 * (a broker, a site manager) has no account to log in with, which is what
 * `idx_owner_routes_by_user` is partial on.
 */
async function readFunctionRows(
  db: D1Database,
  tenantId: string,
  userId: string,
): Promise<ModuleFunctionRow[]> {
  const res = await db
    .prepare(
      `SELECT r.owner_key AS owner_key, v.module_key AS module_key
         FROM owner_routes r
         LEFT JOIN module_visibility v
                ON v.tenant_id = r.tenant_id AND v.owner_key = r.owner_key
        WHERE r.tenant_id = ? AND r.user_id = ? AND r.active = 1`,
    )
    .bind(tenantId, userId)
    .all<ModuleFunctionRow>();
  return res.results ?? [];
}

/**
 * Resolve one user's module access. Does the two reads; falls open on failure.
 *
 * super_admin never reads anything: they cross tenants by definition, and they
 * are the person a customer calls when a module toggle went wrong, so they are
 * the one account that must never be able to lock itself out of the screen
 * holding the toggle.
 */
export async function loadModuleAccess(db: D1Database, user: User): Promise<ModuleAccess> {
  if (user.role === 'super_admin') return allModules(false);
  if (!user.tenant_id) {
    // A non-super_admin with no tenant cannot have module rows of any kind.
    // Nothing to narrow with, so nothing is narrowed.
    return allModules(false);
  }

  try {
    const [tenantRows, functionRows] = await Promise.all([
      readTenantRows(db, user.tenant_id),
      readFunctionRows(db, user.tenant_id, user.id),
    ]);

    return {
      // The ceiling is the same resolver with the function layer removed,
      // rather than a second copy of the "absent row means default" rule.
      tenantEnabled: resolveVisibleModules({ role: user.role, tenantRows, functionRows: [] }),
      visible: resolveVisibleModules({ role: user.role, tenantRows, functionRows }),
      functions: [...new Set(functionRows.map((r) => r.owner_key))],
      degraded: false,
    };
  } catch (err) {
    console.error(
      '[module-access] visibility lookup failed, failing OPEN:',
      err instanceof Error ? err.message : String(err),
    );
    return allModules(true);
  }
}

/**
 * `loadModuleAccess`, memoized on a per-request bag. The promise itself is
 * cached, not its result, so two concurrent callers in the same request share
 * one pair of queries instead of racing to do both twice.
 */
export function getModuleAccess(
  db: D1Database,
  user: User,
  memo: ModuleAccessMemo,
): Promise<ModuleAccess> {
  const cached = memo[MEMO_KEY] as Promise<ModuleAccess> | undefined;
  if (cached) return cached;
  const pending = loadModuleAccess(db, user);
  memo[MEMO_KEY] = pending;
  return pending;
}

/**
 * Why a request was refused. `module_disabled` and `module_not_visible` share
 * a status and differ only in wording, deliberately: an admin reading a
 * support ticket has to be able to tell "the tenant turned it off" from "your
 * function does not include it", and those are fixed on two different screens.
 */
export interface ModuleDenial {
  module: ModuleKey;
  code: 'module_disabled' | 'module_not_visible';
  message: string;
}

/**
 * The gate itself: does this user get to touch this API path?
 *
 * Returns `null` for "allowed", which covers the common case cheaply — a path
 * no module owns (`moduleForApiPath` returns null for every shared read
 * primitive, `/api/documents` included) never touches the database at all.
 *
 * 403 AND NOT 404 is the caller's job to render, but the reason belongs here:
 * the caller is authenticated and the module is listed, greyed, on the
 * Settings screen. A 404 would be indistinguishable from a genuinely missing
 * record and would make every "it just stopped working" ticket unanswerable.
 */
export async function checkModuleAccess(
  db: D1Database,
  user: User,
  pathname: string,
  memo: ModuleAccessMemo,
): Promise<ModuleDenial | null> {
  const moduleKey = moduleForApiPath(pathname);
  if (!moduleKey) return null;

  const access = await getModuleAccess(db, user, memo);
  if (access.visible.includes(moduleKey)) return null;

  const label = MODULES[moduleKey].label;
  // Off at the tenant means nobody in the organization has it; still inside
  // the ceiling means the person's own functions narrowed them.
  return access.tenantEnabled.includes(moduleKey)
    ? {
        module: moduleKey,
        code: 'module_not_visible',
        message: `${label} is not part of your role's access. An administrator can change this in Settings.`,
      }
    : {
        module: moduleKey,
        code: 'module_disabled',
        message: `${label} is not enabled for this organization`,
      };
}

/**
 * Is one module on for one tenant, with no user in the picture?
 *
 * This is the background-job question. Machine paths (`/api/webhooks/*`,
 * `/api/sources/poll`, `/api/expirations/run-scheduled`) correctly bypass the
 * middleware gate — there is no user to resolve — which is PRECISELY why the
 * jobs have to filter themselves. A module a customer hid that still emails
 * them every morning is the bug they report, and it is worse than the surface
 * having stayed visible, because they cannot even find the screen that would
 * explain where the mail is coming from.
 *
 * Fails open, like everything else here: a tenant keeps getting its alerts if
 * we cannot read the table.
 */
export async function isModuleEnabledForTenant(
  db: D1Database,
  tenantId: string,
  moduleKey: ModuleKey,
): Promise<boolean> {
  try {
    const tenantRows = await readTenantRows(db, tenantId);
    // Any non-super_admin role and no functions: the tenant ceiling alone.
    // There is no person here, so there is nothing to narrow with.
    const enabled = resolveVisibleModules({
      role: 'org_admin',
      tenantRows,
      functionRows: [],
    });
    return enabled.includes(moduleKey);
  } catch (err) {
    console.error(
      '[module-access] tenant module lookup failed, failing OPEN:',
      err instanceof Error ? err.message : String(err),
    );
    return true;
  }
}
