/**
 * /api/module-visibility — the function × module grid.
 *
 * The endpoint is a grid editor; the things worth pinning are the two rules
 * that decide what an EMPTY answer means, because both of them fail silently
 * if they are wrong:
 *
 *   1. ABSENCE MEANS UNCONSTRAINED. A function with no rows sees everything
 *      the tenant has. That is deliberately the inverse of `owner_routes`,
 *      where absence means "unrouted, and reported"; both rules are chosen so
 *      the unconfigured case points toward the person seeing MORE, never
 *      silently less.
 *   2. THEREFORE `{constrained: true, modules: []}` MUST BE A 400. Writing it
 *      would store zero rows, which means unconstrained — the exact OPPOSITE
 *      of what an admin who just unchecked the last box intended. "Sales sees
 *      nothing" is a deactivated account, not a role configuration.
 *
 * And the membership is `owner_routes` (migration 0091) — the same
 * departmental routes that already decide who receives an alert. One concept,
 * two effects; no second role table.
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { runMigrations, seedTestData, cleanTables } from '../helpers/db';
import { onRequestGet as getGrid } from '../../functions/api/module-visibility/index';
import { onRequestPut as putScope } from '../../functions/api/module-visibility/[ownerKey]';
import { onRequestPost as createRoute } from '../../functions/api/owner-routes/index';
import { MODULE_KEYS } from '../../shared/modules';

const db = env.DB;
let seed: Awaited<ReturnType<typeof seedTestData>>;

function ctx(method: string, url: string, user: unknown, body?: unknown, params: Record<string, string> = {}): any {
  const init: RequestInit = { method };
  if (body !== undefined) init.body = JSON.stringify(body);
  return {
    request: new Request(`https://portal.example.com${url}`, init),
    env,
    data: { user },
    params,
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
    functionPath: url,
  };
}

const superAdmin = () => ({ id: 'user-super-admin', role: 'super_admin', tenant_id: null });
const orgAdmin = () => ({ id: 'user-org-admin', role: 'org_admin', tenant_id: seed.tenantId });
const regularUser = () => ({ id: 'user-regular', role: 'user', tenant_id: seed.tenantId });

async function grid(user: unknown, qs = '') {
  const res = await getGrid(ctx('GET', `/api/module-visibility${qs}`, user));
  return { status: res.status, body: (await res.json()) as any };
}

/**
 * `paramKey` defaults to `ownerKey`. It is separate because Pages hands the
 * handler the DECODED path segment, so a test for spelling drift has to pass
 * the decoded form the runtime would actually produce.
 */
async function scope(user: unknown, ownerKey: string, body: unknown, paramKey?: string) {
  const res = await putScope(
    ctx('PUT', `/api/module-visibility/${encodeURIComponent(ownerKey)}`, user, body, {
      ownerKey: paramKey ?? ownerKey,
    }),
  );
  return { status: res.status, body: (await res.json()) as any };
}

/** Through the real endpoint, so the grid sees exactly what routing sees. */
async function addRoute(user: unknown, label: string, userId: string) {
  const res = await createRoute(ctx('POST', '/api/owner-routes', user, { owner_label: label, user_id: userId }));
  expect(res.status).toBe(201);
}

async function declareLabel(tenantId: string, key: string, label: string) {
  await db
    .prepare('INSERT OR IGNORE INTO owner_labels (tenant_id, owner_key, owner_label) VALUES (?, ?, ?)')
    .bind(tenantId, key, label)
    .run();
}

async function visibilityRows(tenantId: string, ownerKey: string): Promise<string[]> {
  const res = await db
    .prepare('SELECT module_key FROM module_visibility WHERE tenant_id = ? AND owner_key = ? ORDER BY module_key')
    .bind(tenantId, ownerKey)
    .all<{ module_key: string }>();
  return (res.results ?? []).map((r) => r.module_key);
}

beforeAll(async () => {
  await runMigrations(db);
}, 30_000);

beforeEach(async () => {
  await cleanTables(db);
  seed = await seedTestData(db);
});

// ───────────────────────────────────────────────────────────────────────────
describe('GET /api/module-visibility', () => {
  it('unions declared labels with labels that are only routing today', async () => {
    // Sales was declared but nobody has ever been routed to it — which is the
    // whole reason owner_labels exists: you cannot configure what Sales sees
    // until Sales receives an alert, and Sales owns no renewals.
    await declareLabel(seed.tenantId, 'sales', 'Sales');
    // QA arrived through routing after 0099's backfill, so it exists only in
    // owner_routes. It still has to be configurable.
    await addRoute(orgAdmin(), 'QA', seed.userId);

    const { status, body } = await grid(orgAdmin());
    expect(status).toBe(200);
    const keys = body.functions.map((f: any) => f.owner_key).sort();
    expect(keys).toEqual(['qa', 'sales']);

    const qa = body.functions.find((f: any) => f.owner_key === 'qa');
    expect(qa.declared).toBe(false);
    expect(qa.route_count).toBe(1);
    // No rows: unconstrained, not blind.
    expect(qa.constrained).toBe(false);
    expect(qa.modules).toEqual([]);

    const sales = body.functions.find((f: any) => f.owner_key === 'sales');
    expect(sales.declared).toBe(true);
    expect(sales.route_count).toBe(0);

    // The modules come back too, so a checkbox for a module the TENANT has off
    // can render differently — the function layer never grants past the ceiling.
    expect(body.modules.map((m: any) => m.key)).toEqual([...MODULE_KEYS]);
  });

  it('refuses non-admins and does not cross tenants', async () => {
    await declareLabel(seed.tenantId2, 'purchasing', 'Purchasing');
    expect((await grid(regularUser())).status).toBe(403);

    const crossed = await grid(orgAdmin(), `?tenant_id=${seed.tenantId2}`);
    expect(crossed.body.tenant_id).toBe(seed.tenantId);
    expect(crossed.body.functions).toEqual([]);

    expect((await grid(superAdmin())).status).toBe(400);
    const asSuper = await grid(superAdmin(), `?tenant_id=${seed.tenantId2}`);
    expect(asSuper.body.functions.map((f: any) => f.owner_key)).toEqual(['purchasing']);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('PUT /api/module-visibility/:ownerKey', () => {
  it('scopes a function, and promotes a label that was only routing', async () => {
    await addRoute(orgAdmin(), 'QA', seed.userId);
    const { status, body } = await scope(orgAdmin(), 'QA', {
      constrained: true,
      modules: ['library', 'compliance'],
    });
    expect(status).toBe(200);
    expect(body.function.constrained).toBe(true);
    expect(body.function.modules.sort()).toEqual(['compliance', 'library']);
    // module_visibility carries a composite FK to owner_labels, so the label
    // had to be declared on the way through.
    expect(body.function.declared).toBe(true);
    expect(await visibilityRows(seed.tenantId, 'qa')).toEqual(['compliance', 'library']);
  });

  it('normalizes the key exactly the way routing does', async () => {
    await addRoute(orgAdmin(), 'QA', seed.userId);
    // 'Q A' would be a different department; ' qa ' is the same one.
    const { status } = await scope(orgAdmin(), ' QA ', { constrained: true, modules: ['library'] });
    expect(status).toBe(200);
    expect(await visibilityRows(seed.tenantId, 'qa')).toEqual(['library']);
  });

  it('REJECTS {constrained: true, modules: []} rather than silently unconstraining', async () => {
    await addRoute(orgAdmin(), 'QA', seed.userId);
    await scope(orgAdmin(), 'QA', { constrained: true, modules: ['library'] });

    const res = await scope(orgAdmin(), 'QA', { constrained: true, modules: [] });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/at least one module/i);
    // And the previous scope is untouched — a rejected write changes nothing.
    expect(await visibilityRows(seed.tenantId, 'qa')).toEqual(['library']);
  });

  it('unconstrains by DELETING every row, not by storing all four modules', async () => {
    await addRoute(orgAdmin(), 'QA', seed.userId);
    await scope(orgAdmin(), 'QA', { constrained: true, modules: ['library'] });

    const res = await scope(orgAdmin(), 'QA', { constrained: false });
    expect(res.status).toBe(200);
    expect(res.body.function.constrained).toBe(false);
    // Storing the full set would freeze today's module list into the config,
    // and a module shipped next year would arrive invisible to everyone.
    expect(await visibilityRows(seed.tenantId, 'qa')).toEqual([]);
  });

  it('replaces the scope rather than merging into it', async () => {
    await addRoute(orgAdmin(), 'QA', seed.userId);
    await scope(orgAdmin(), 'QA', { constrained: true, modules: ['library', 'compliance'] });
    await scope(orgAdmin(), 'QA', { constrained: true, modules: ['records'] });
    expect(await visibilityRows(seed.tenantId, 'qa')).toEqual(['records']);
  });

  it('rejects an unknown module instead of dropping it', async () => {
    await addRoute(orgAdmin(), 'QA', seed.userId);
    const res = await scope(orgAdmin(), 'QA', { constrained: true, modules: ['library', 'telepathy'] });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toContain('telepathy');
    // Dropping it silently would store a NARROWER scope than was submitted —
    // the one direction this feature must never move by accident.
    expect(await visibilityRows(seed.tenantId, 'qa')).toEqual([]);
  });

  it('404s for a function this tenant has never heard of', async () => {
    const res = await scope(orgAdmin(), 'sales', { constrained: true, modules: ['library'] });
    expect(res.status).toBe(404);
  });

  it('audits both directions and refuses non-admins', async () => {
    await addRoute(orgAdmin(), 'QA', seed.userId);
    await scope(orgAdmin(), 'QA', { constrained: true, modules: ['library'] });
    await scope(orgAdmin(), 'QA', { constrained: false });

    const rows = await db
      .prepare(
        `SELECT action FROM audit_log
          WHERE tenant_id = ? AND resource_type = 'module_visibility' ORDER BY id`,
      )
      .bind(seed.tenantId)
      .all<{ action: string }>();
    expect((rows.results ?? []).map((r) => r.action)).toEqual([
      'module_visibility.scoped',
      'module_visibility.unscoped',
    ]);

    expect((await scope(regularUser(), 'QA', { constrained: false })).status).toBe(403);
  });
});
