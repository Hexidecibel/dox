/**
 * The module gate — hidden has to mean unreachable.
 *
 * Gating the nav alone would leave every route and every endpoint reachable by
 * URL, which is not hiding anything. So this file drives the REAL middleware
 * chain (`cors`, `auth`, `moduleGate` as exported from `_middleware.ts`) and
 * pins the properties that decide whether "disabled" means anything:
 *
 *   1. A DISABLED MODULE'S ENDPOINTS RETURN 403 — not 404. The caller is
 *      authenticated and the module is listed, greyed, in Settings; a 404 is
 *      indistinguishable from a missing record and makes every "it just
 *      stopped working" ticket unanswerable.
 *   2. AN API KEY INHERITS THE GATE. A key authenticates as its creating user,
 *      so it arrives at the gate as that user. A key that walked past it would
 *      make "disabled" mean nothing more than "hidden from the nav".
 *   3. IT FAILS OPEN. Module visibility is a SCOPE control, not a
 *      confidentiality boundary — tenant isolation and the four permission
 *      tiers are the security boundary and are untouched. Failing closed on a
 *      transient D1 error would take the whole app down to protect a
 *      preference.
 *   4. MACHINE PATHS SKIP IT, so the background jobs filter themselves. A
 *      module you hid that still emails you every morning is the bug the
 *      customer reports.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { runMigrations, seedTestData, cleanTables, generateTestId } from '../helpers/db';
import { onRequest } from '../../functions/api/_middleware';
import { onRequestPost as runScheduled } from '../../functions/api/expirations/run-scheduled';
import { notifySpecFailures, registerSpecChecks } from '../../functions/lib/spec-register';
import { hashApiKey } from '../../functions/lib/auth';
import { MODULES } from '../../shared/modules';
import type { ModuleKey } from '../../shared/modules';
import type { SpecVerdict } from '../../shared/specCheck';

const db = env.DB;
let seed: Awaited<ReturnType<typeof seedTestData>>;

const RENEWAL_TOKEN = 'test-module-gate-renewal-token';

/** The handler the route would have run if the gate let the request through. */
const REACHED = 'reached-the-handler';

/**
 * Drive `auth` -> `moduleGate` -> handler the way Pages does, with ONE shared
 * `data` bag so the user the auth layer resolves is the user the gate reads.
 * `cors` is skipped: it only decorates headers and would obscure the status.
 */
async function callChain(
  request: Request,
  opts: { user?: unknown; envOverride?: unknown } = {},
): Promise<{ status: number; body: any }> {
  const [, authFn, gateFn] = onRequest;
  const data: Record<string, unknown> = {};
  if (opts.user) data.user = opts.user;

  const base = {
    request,
    env: opts.envOverride ?? env,
    data,
    params: {},
    waitUntil: () => {},
    passThroughOnException: () => {},
    functionPath: new URL(request.url).pathname,
  };

  const gateCtx: any = {
    ...base,
    next: async () => new Response(JSON.stringify({ ok: REACHED }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  };
  // A pre-set user means "already authenticated"; go straight at the gate so a
  // test does not have to mint a JWT to ask a question about modules.
  const res = opts.user
    ? await gateFn(gateCtx)
    : await authFn({ ...base, next: async () => gateFn(gateCtx) } as any);
  return { status: res.status, body: await res.json().catch(() => null) };
}

function req(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`https://portal.example.com${path}`, { headers });
}

const superAdmin = () => ({ id: 'user-super-admin', role: 'super_admin', tenant_id: null });
const regularUser = () => ({ id: 'user-regular', role: 'user', tenant_id: seed.tenantId });

async function disableModule(tenantId: string, key: ModuleKey) {
  await db
    .prepare('INSERT INTO tenant_modules (tenant_id, module_key, enabled) VALUES (?, ?, 0)')
    .bind(tenantId, key)
    .run();
}

async function addRoute(tenantId: string, label: string, userId: string) {
  await db
    .prepare(
      `INSERT INTO owner_routes (id, tenant_id, owner_key, owner_label, user_id, active)
       VALUES (?, ?, ?, ?, ?, 1)`,
    )
    .bind(generateTestId(), tenantId, label.trim().toLowerCase(), label, userId)
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

afterEach(() => {
  vi.unstubAllGlobals();
});

// ───────────────────────────────────────────────────────────────────────────
describe('the middleware gate', () => {
  it('lets through every path no module owns, without touching the database', async () => {
    await disableModule(seed.tenantId, 'library');
    // `/api/documents` is the load-bearing omission from library's prefixes: a
    // renewal digest, an alert landing page and a COA fulfillment join all read
    // documents, so gating it would break modules that are switched ON.
    for (const path of ['/api/documents', '/api/documents/abc', '/api/search', '/api/users/me']) {
      const res = await callChain(req(path), { user: regularUser() });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(REACHED);
    }
  });

  it('403s a disabled module, naming it, and never 404s', async () => {
    await disableModule(seed.tenantId, 'fulfillment');
    const res = await callChain(req('/api/orders'), { user: regularUser() });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('module_disabled');
    expect(res.body.module).toBe('fulfillment');
    expect(res.body.error).toContain(MODULES.fulfillment.label);
    // A nested path under the module is gated too, or the deep link is the hole.
    expect((await callChain(req('/api/orders/xyz/items'), { user: regularUser() })).status).toBe(403);
  });

  it('distinguishes "the tenant turned it off" from "your function does not include it"', async () => {
    // The two are fixed on different screens by different people, so they must
    // not share a message even though they share a status.
    await addRoute(seed.tenantId, 'QA', seed.userId);
    await scopeFunction(seed.tenantId, 'QA', ['library']);

    const roleFiltered = await callChain(req('/api/orders'), { user: regularUser() });
    expect(roleFiltered.status).toBe(403);
    expect(roleFiltered.body.code).toBe('module_not_visible');

    // ...and library, which the function DOES include, still works.
    expect((await callChain(req('/api/suppliers'), { user: regularUser() })).status).toBe(200);
  });

  it('lets the TENANT ceiling beat a function that was granted the module', async () => {
    await disableModule(seed.tenantId, 'fulfillment');
    await addRoute(seed.tenantId, 'Purchasing', seed.userId);
    await scopeFunction(seed.tenantId, 'Purchasing', ['fulfillment']);

    const res = await callChain(req('/api/orders'), { user: regularUser() });
    expect(res.status).toBe(403);
    // Tenant-off, not role-filtered: the function layer can only narrow within
    // the ceiling, never grant past it. Selling the module turns it back on.
    expect(res.body.code).toBe('module_disabled');
  });

  it('THE LEFT JOIN: one constrained function plus one unconstrained one sees everything', async () => {
    // This is the single easiest thing to get wrong. An INNER JOIN would drop
    // the unconstrained function's row entirely, and this user — who holds a
    // scoped QA route and an unscoped Purchasing one — would silently lose
    // everything Purchasing was meant to leave open.
    await addRoute(seed.tenantId, 'QA', seed.userId);
    await scopeFunction(seed.tenantId, 'QA', ['library']);
    await addRoute(seed.tenantId, 'Purchasing', seed.userId);

    for (const path of ['/api/orders', '/api/records', '/api/expirations', '/api/suppliers']) {
      const res = await callChain(req(path), { user: regularUser() });
      expect(res.status, `${path} should be reachable`).toBe(200);
    }
  });

  it('does not narrow a user by somebody else’s function, or another tenant’s rows', async () => {
    await addRoute(seed.tenantId, 'QA', seed.orgAdminId);
    await scopeFunction(seed.tenantId, 'QA', ['library']);
    // The route names the org_admin, not this user, so this user holds nothing.
    expect((await callChain(req('/api/orders'), { user: regularUser() })).status).toBe(200);

    await disableModule(seed.tenantId2, 'fulfillment');
    expect((await callChain(req('/api/orders'), { user: regularUser() })).status).toBe(200);
  });

  it('super_admin bypasses both layers', async () => {
    await disableModule(seed.tenantId, 'fulfillment');
    const res = await callChain(req('/api/orders?tenant_id=' + seed.tenantId), { user: superAdmin() });
    // They cross tenants by definition, and they are who a customer calls when
    // a module toggle went wrong — the one account that must never be able to
    // lock itself out of the screen holding the toggle.
    expect(res.status).toBe(200);
  });

  it('AN API KEY INHERITS THE GATE', async () => {
    const plaintext = 'dox_sk_moduleGateTestKey';
    await db
      .prepare(
        `INSERT INTO api_keys (id, name, key_hash, key_prefix, user_id, tenant_id, permissions)
         VALUES (?, ?, ?, ?, ?, ?, '["*"]')`,
      )
      .bind(generateTestId(), 'Gate Key', await hashApiKey(plaintext), 'dox_sk_mod', seed.userId, seed.tenantId)
      .run();

    // Works before the toggle...
    expect((await callChain(req('/api/orders', { 'X-API-Key': plaintext }))).status).toBe(200);

    await disableModule(seed.tenantId, 'fulfillment');
    const res = await callChain(req('/api/orders', { 'X-API-Key': plaintext }));
    // ...and is refused after it. This is the difference between hidden and
    // disabled: a key authenticates AS its creating user and is narrowed like
    // that user.
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('module_disabled');
  });

  it('has no user on a public route, so it gates nothing there', async () => {
    // The machine doors — webhooks, the pollers, the token-gated landing pages
    // — reach the gate with nobody to resolve, which is exactly why the
    // scheduled jobs have to filter themselves.
    const res = await callChain(req('/api/expirations/run-scheduled'));
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(REACHED);
  });

  it('FAILS OPEN when the lookup throws, and says so in the log', async () => {
    await disableModule(seed.tenantId, 'fulfillment');
    const errors: string[] = [];
    vi.stubGlobal('console', { ...console, error: (...args: unknown[]) => errors.push(args.join(' ')) });

    const brokenEnv = {
      ...env,
      DB: {
        prepare() {
          throw new Error('D1_ERROR: no such table');
        },
      },
    };
    const res = await callChain(req('/api/orders'), { user: regularUser(), envOverride: brokenEnv });

    // A tenant briefly seeing a surface they do not use is a nuisance; a tenant
    // locked out of their own portal by a D1 blip is an outage.
    expect(res.status).toBe(200);
    expect(errors.join('\n')).toContain('failing OPEN');
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('background jobs filter themselves', () => {
  function scheduledCtx(body: Record<string, unknown>): any {
    return {
      request: new Request('https://portal.example.com/api/expirations/run-scheduled', {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { Authorization: `Bearer ${RENEWAL_TOKEN}` },
      }),
      env: { ...env, RENEWAL_ALERT_TOKEN: RENEWAL_TOKEN, RESEND_API_KEY: 're_test' },
      data: {},
      params: {},
      waitUntil: () => {},
      passThroughOnException: () => {},
      next: async () => new Response(null),
      functionPath: '/api/expirations/run-scheduled',
    };
  }

  it('the renewal run skips a compliance-off tenant and reports the skip', async () => {
    await disableModule(seed.tenantId, 'compliance');

    const res = await runScheduled(scheduledCtx({ as_of: '2026-07-22' }));
    const body = (await res.json()) as any;
    expect(res.status).toBe(200);

    // Both seeded tenants are active; only the other one is still checked.
    expect(body.tenants_skipped_module_off).toBe(1);
    expect(body.tenants_checked).toBe(1);
    expect(body.tenants.map((t: any) => t.tenant_id)).not.toContain(seed.tenantId);
  });

  it('a spec failure is still REGISTERED with compliance off — only the email stops', async () => {
    await disableModule(seed.tenantId, 'compliance');

    const documentId = generateTestId();
    await db
      .prepare(
        `INSERT INTO documents (id, tenant_id, title, current_version, status, created_by)
         VALUES (?, ?, ?, 1, 'active', ?)`,
      )
      .bind(documentId, seed.tenantId, 'Milk COA', seed.orgAdminId)
      .run();

    const verdict: SpecVerdict = {
      scope: 'ai_fields',
      target: { kind: 'field', path: 'coliforms' },
      test_name_raw: 'Coliforms',
      value_raw: '40',
      unit_raw: 'cfu/g',
      verdict: 'out_of_spec',
      source: 'printed',
      limit_text: '<10 cfu/g',
      reason: 'value 40 exceeds printed limit 10',
      message: 'Coliforms came back at 40 cfu/g against a printed limit of <10 cfu/g.',
    };

    const { failures } = await registerSpecChecks(db, { tenantId: seed.tenantId, documentId }, [verdict], []);
    expect(failures).toHaveLength(1);

    // The register is EVIDENCE attached to a document. Gating it would put a
    // hole in a compliance record the moment somebody switched a module off.
    const stored = await db
      .prepare('SELECT COUNT(*) AS n FROM document_spec_checks WHERE document_id = ?')
      .bind(documentId)
      .first<{ n: number }>();
    expect(stored?.n).toBe(1);

    const sent: string[] = [];
    vi.stubGlobal('fetch', async (url: unknown) => {
      if (String(url).includes('resend.com')) sent.push(String(url));
      return new Response('{}', { status: 200 });
    });

    const mailed = await notifySpecFailures(
      db,
      're_test',
      {
        tenantId: seed.tenantId,
        tenantName: 'Test Corp',
        documentId,
        documentTitle: 'Milk COA',
        supplierId: null,
        supplierName: null,
        documentTypeId: null,
      },
      failures,
    );

    expect(mailed).toBe(0);
    expect(sent).toEqual([]);
  });
});
