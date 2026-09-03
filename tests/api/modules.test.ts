/**
 * /api/modules — what a tenant uses, and /api/module-access — what one person
 * in it sees.
 *
 * The endpoints are small; what is worth pinning is the shape of the storage
 * decision behind them (migration 0099):
 *
 *   1. THE LIST IS THE CODE VOCABULARY, NOT THE TABLE. A tenant with zero rows
 *      still gets all four modules, each reporting its default. If this ever
 *      started listing rows, a brand-new tenant would open Settings and find
 *      an empty page instead of the thing they came to switch off.
 *   2. ABSENCE IS NOT "OFF". `configured: false` and `enabled: false` are
 *      different states, and collapsing them is how a changed default silently
 *      moves every tenant that never opened the screen.
 *   3. A DECISION IS ATTRIBUTED. Turning a module off is the event somebody
 *      goes looking for months later — "when did Orders disappear" — so it
 *      gets its own audit action rather than a value inside a JSON blob.
 *
 * Handlers are driven directly with hand-rolled contexts; SELF.fetch is not
 * wired in this project's vitest-pool-workers config.
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { runMigrations, seedTestData, cleanTables } from '../helpers/db';
import { onRequestGet as listModules } from '../../functions/api/modules/index';
import { onRequestPut as putModule } from '../../functions/api/modules/[key]';
import { onRequestGet as getAccess } from '../../functions/api/module-access/index';
import { MODULE_KEYS, MODULES } from '../../shared/modules';
import type { ModuleKey } from '../../shared/modules';

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
const orgAdmin2 = () => ({ id: 'user-org-admin-2', role: 'org_admin', tenant_id: seed.tenantId2 });
const regularUser = () => ({ id: 'user-regular', role: 'user', tenant_id: seed.tenantId });
const reader = () => ({ id: 'user-reader', role: 'reader', tenant_id: seed.tenantId });

async function list(user: unknown, qs = '') {
  const res = await listModules(ctx('GET', `/api/modules${qs}`, user));
  return { status: res.status, body: (await res.json()) as any };
}

async function put(user: unknown, key: string, body: unknown) {
  const res = await putModule(ctx('PUT', `/api/modules/${key}`, user, body, { key }));
  return { status: res.status, body: (await res.json()) as any };
}

async function access(user: unknown) {
  const res = await getAccess(ctx('GET', '/api/module-access', user));
  return { status: res.status, body: (await res.json()) as any };
}

/** A route is the membership: holding a function means being routed for it. */
async function addRoute(tenantId: string, label: string, userId: string) {
  await db
    .prepare(
      `INSERT INTO owner_routes (id, tenant_id, owner_key, owner_label, user_id, active)
       VALUES (?, ?, ?, ?, ?, 1)`,
    )
    .bind(`route-${label}-${userId}`, tenantId, label.trim().toLowerCase(), label, userId)
    .run();
}

async function scopeFunction(tenantId: string, label: string, modules: ModuleKey[]) {
  const key = label.trim().toLowerCase();
  await db
    .prepare('INSERT OR IGNORE INTO owner_labels (tenant_id, owner_key, owner_label) VALUES (?, ?, ?)')
    .bind(tenantId, key, label)
    .run();
  for (const m of modules) {
    await db
      .prepare('INSERT OR IGNORE INTO module_visibility (tenant_id, owner_key, module_key) VALUES (?, ?, ?)')
      .bind(tenantId, key, m)
      .run();
  }
}

beforeAll(async () => {
  await runMigrations(db);
}, 30_000);

beforeEach(async () => {
  await cleanTables(db);
  seed = await seedTestData(db);
});

// ───────────────────────────────────────────────────────────────────────────
describe('GET /api/modules', () => {
  it('lists every module from code, not from the table', async () => {
    // Migration 0099 inserts zero rows on purpose, so this is the day-one state.
    const { status, body } = await list(orgAdmin());
    expect(status).toBe(200);
    expect(body.modules.map((m: any) => m.key)).toEqual([...MODULE_KEYS]);
    for (const m of body.modules) {
      expect(m.enabled).toBe(MODULES[m.key as ModuleKey].defaultEnabled);
      // Nobody has decided anything yet — and that is a different state from
      // having decided the same value.
      expect(m.configured).toBe(false);
      expect(m.updated_by).toBeNull();
      expect(m.label).toBe(MODULES[m.key as ModuleKey].label);
      expect(m.blurb).toBeTruthy();
    }
  });

  it('still lists a module that is switched off, so it can be switched back on', async () => {
    await put(orgAdmin(), 'fulfillment', { enabled: false });
    const { body } = await list(orgAdmin());
    const row = body.modules.find((m: any) => m.key === 'fulfillment');
    expect(row.enabled).toBe(false);
    expect(row.configured).toBe(true);
    expect(body.modules).toHaveLength(MODULE_KEYS.length);
  });

  it('ignores a stored row naming a module this build does not have', async () => {
    // There is deliberately no CHECK on module_key (0099): a row left behind by
    // a removed module must not be able to produce a list entry for a surface
    // that no longer exists.
    await db
      .prepare('INSERT INTO tenant_modules (tenant_id, module_key, enabled) VALUES (?, ?, 0)')
      .bind(seed.tenantId, 'telepathy')
      .run();
    const { body } = await list(orgAdmin());
    expect(body.modules.map((m: any) => m.key)).toEqual([...MODULE_KEYS]);
  });

  it('pins an org_admin to their own tenant and refuses non-admins', async () => {
    const crossed = await list(orgAdmin(), `?tenant_id=${seed.tenantId2}`);
    expect(crossed.body.tenant_id).toBe(seed.tenantId);

    expect((await list(regularUser())).status).toBe(403);
    expect((await list(reader())).status).toBe(403);
  });

  it('makes super_admin name a tenant, because they have none', async () => {
    expect((await list(superAdmin())).status).toBe(400);
    const scoped = await list(superAdmin(), `?tenant_id=${seed.tenantId}`);
    expect(scoped.status).toBe(200);
    expect(scoped.body.tenant_id).toBe(seed.tenantId);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('PUT /api/modules/:key', () => {
  it('writes a row even when the value matches the default', async () => {
    const { status, body } = await put(orgAdmin(), 'library', { enabled: true });
    expect(status).toBe(200);
    expect(body.module.enabled).toBe(true);
    // The point: "somebody decided this" is now recorded, so a later change to
    // the code default cannot quietly move this tenant.
    expect(body.module.configured).toBe(true);
    expect(body.module.updated_by).toBe('user-org-admin');
  });

  it('audits enable and disable under separate actions', async () => {
    await put(orgAdmin(), 'records', { enabled: false });
    await put(orgAdmin(), 'records', { enabled: true });
    const rows = await db
      .prepare(
        `SELECT action, resource_id FROM audit_log
          WHERE tenant_id = ? AND resource_type = 'module' ORDER BY id`,
      )
      .bind(seed.tenantId)
      .all<{ action: string; resource_id: string }>();
    expect((rows.results ?? []).map((r) => r.action)).toEqual(['module.disabled', 'module.enabled']);
    expect((rows.results ?? [])[0].resource_id).toBe('records');
  });

  it('rejects an unknown key and a non-boolean value', async () => {
    expect((await put(orgAdmin(), 'telepathy', { enabled: false })).status).toBe(400);
    expect((await put(orgAdmin(), 'library', {})).status).toBe(400);
    expect((await put(orgAdmin(), 'library', { enabled: 'no' })).status).toBe(400);
    // Nothing was written by any of those.
    const count = await db
      .prepare('SELECT COUNT(*) AS n FROM tenant_modules WHERE tenant_id = ?')
      .bind(seed.tenantId)
      .first<{ n: number }>();
    expect(count?.n).toBe(0);
  });

  it('refuses a user and a reader, and keeps org_admins inside their tenant', async () => {
    expect((await put(regularUser(), 'library', { enabled: false })).status).toBe(403);
    expect((await put(reader(), 'library', { enabled: false })).status).toBe(403);

    // Naming another tenant does not reach it: the body is ignored for anyone
    // who is not super_admin.
    await put(orgAdmin(), 'library', { enabled: false, tenant_id: seed.tenantId2 });
    const other = await list(orgAdmin2());
    expect(other.body.modules.find((m: any) => m.key === 'library').enabled).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('GET /api/module-access', () => {
  it('answers for the caller, and is open to every authenticated role', async () => {
    // A reader's nav has to be able to ask what its own portal contains.
    const { status, body } = await access(reader());
    expect(status).toBe(200);
    expect(body.visible).toEqual([...MODULE_KEYS]);
    expect(body.tenant_enabled).toEqual([...MODULE_KEYS]);
    expect(body.functions).toEqual([]);
    expect(body.degraded).toBe(false);
  });

  it('reports both layers separately when the tenant switched something off', async () => {
    await put(orgAdmin(), 'fulfillment', { enabled: false });
    const { body } = await access(regularUser());
    expect(body.tenant_enabled).not.toContain('fulfillment');
    expect(body.visible).not.toContain('fulfillment');
  });

  it('narrows by function, and names the functions doing the narrowing', async () => {
    await addRoute(seed.tenantId, 'QA', seed.userId);
    await scopeFunction(seed.tenantId, 'QA', ['library']);

    const { body } = await access(regularUser());
    expect(body.visible).toEqual(['library']);
    // The ceiling is untouched — this is the ROLE layer, and a support answer
    // has to be able to tell the two apart.
    expect(body.tenant_enabled).toEqual([...MODULE_KEYS]);
    expect(body.functions).toEqual(['qa']);
  });

  it('super_admin is never narrowed, by either layer', async () => {
    await put(orgAdmin(), 'fulfillment', { enabled: false });
    const { body } = await access(superAdmin());
    expect(body.visible).toEqual([...MODULE_KEYS]);
  });
});
