/**
 * The module gate on GraphQL — the one surface the middleware cannot reach.
 *
 * `/api/graphql` is in `PUBLIC_ROUTES` and authenticates itself in
 * `functions/lib/graphql/context.ts`, so it never passes through the
 * `moduleGate` handler in `_middleware.ts`. Everything `tests/api/module-gate.
 * test.ts` pins about the REST side is therefore unpinned here unless this
 * file pins it, and a switch that visibly hides a surface while the data stays
 * queryable is worse than no switch — it invites somebody to rely on it.
 *
 * These tests drive the REAL yoga handler (`functions/api/graphql.ts`) rather
 * than calling resolvers directly, because two of the properties only exist
 * end-to-end: that the gate runs BEFORE the resolver body, and that the
 * refusal survives yoga's error masking with its code intact.
 *
 *   1. A DISABLED MODULE'S FIELDS ARE REFUSED, carrying the SAME
 *      `module_disabled` / `module_not_visible` vocabulary the REST 403 does,
 *      so a client can tell "the tenant turned it off" from "your function
 *      does not include it" over either transport.
 *   2. super_admin BYPASSES, consistent with `resolveVisibleModules`.
 *   3. SHARED READ PRIMITIVES STAY OPEN. Documents, users, tenants and the
 *      audit log belong to no module — gating them would break `compliance`
 *      and `fulfillment` for a tenant that has those switched ON.
 *   4. IT FAILS OPEN. Module visibility is a SCOPE control, not a
 *      confidentiality boundary; tenant isolation and the four permission
 *      tiers are the security boundary and are untouched.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { runMigrations, seedTestData, cleanTables, generateTestId } from '../helpers/db';
import { createTestToken } from '../helpers/auth';
import { onRequestPost as graphqlPost } from '../../functions/api/graphql';
import { queryResolvers, queryModules } from '../../functions/lib/graphql/resolvers/queries';
import { mutationResolvers, mutationModules } from '../../functions/lib/graphql/resolvers/mutations';
import { checkModuleAccess } from '../../functions/lib/module-access';
import { MODULES, MODULE_KEYS } from '../../shared/modules';
import type { ModuleKey } from '../../shared/modules';

const db = env.DB;
let seed: Awaited<ReturnType<typeof seedTestData>>;

interface GraphQLResponse {
  data: Record<string, unknown> | null;
  errors?: Array<{ message: string; extensions?: Record<string, unknown> }>;
}

/**
 * POST a document at the real endpoint, the way Pages would. No `user` is
 * planted on `context.data` on purpose: `/api/graphql` is a public route, so
 * the only thing that authenticates the caller is the bearer token the
 * GraphQL context verifies for itself — which is precisely why it misses the
 * middleware gate.
 */
async function gql(
  query: string,
  opts: { token?: string; envOverride?: unknown } = {},
): Promise<GraphQLResponse> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;

  const request = new Request('https://portal.example.com/api/graphql', {
    method: 'POST',
    headers,
    body: JSON.stringify({ query }),
  });

  const ctx = {
    request,
    env: opts.envOverride ?? env,
    data: {},
    params: {},
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
    functionPath: '/api/graphql',
  };

  const res = await graphqlPost(ctx as never);
  return (await res.json()) as GraphQLResponse;
}

/** The mutation that `fulfillment` owns — GraphQL's twin of POST /api/reports/generate. */
const REPORT = 'mutation { generateReport { total data { title } } }';
/** An ungated shared primitive, for the same caller in the same breath. */
const DOCUMENTS = 'query { documents { id title } }';

function tokenFor(userId: string, role: string, tenantId: string | null): Promise<string> {
  return createTestToken(role, { userId, email: `${userId}@test.com`, tenantId });
}

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

async function seedDocument(tenantId: string, title: string): Promise<string> {
  const id = generateTestId();
  await db
    .prepare(
      `INSERT INTO documents (id, tenant_id, title, current_version, status, created_by)
       VALUES (?, ?, ?, 1, 'active', ?)`,
    )
    .bind(id, tenantId, title, seed.orgAdminId)
    .run();
  return id;
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
describe('the GraphQL module gate', () => {
  it('refuses a tenant-disabled module, and says WHICH module', async () => {
    await disableModule(seed.tenantId, 'fulfillment');
    const token = await tokenFor(seed.userId, 'user', seed.tenantId);

    const res = await gql(REPORT, { token });

    expect(res.errors).toBeDefined();
    const err = res.errors![0];
    // The code must survive yoga's error masking, which flattens anything that
    // is not a GraphQLError down to "Unexpected error." and would take the
    // module name with it.
    expect(err.extensions?.code).toBe('module_disabled');
    expect(err.extensions?.module).toBe('fulfillment');
    expect(err.message).toContain(MODULES.fulfillment.label);
    expect(res.data?.generateReport ?? null).toBeNull();
  });

  it('gives a role-scoped user the OTHER code', async () => {
    // Fulfillment is on for the company; this person's function does not
    // include it. Two different screens fix these two tickets, so they must
    // not share a message even though they share a refusal.
    await addRoute(seed.tenantId, 'QA', seed.userId);
    await scopeFunction(seed.tenantId, 'QA', ['library']);
    const token = await tokenFor(seed.userId, 'user', seed.tenantId);

    const res = await gql(REPORT, { token });

    expect(res.errors?.[0].extensions?.code).toBe('module_not_visible');
    expect(res.errors?.[0].extensions?.module).toBe('fulfillment');
  });

  it('answers a refusal in exactly the words the REST gate would', async () => {
    // The point of routing both transports through `denialForModule`: the
    // middleware's failure mode was layers disagreeing about who can see what,
    // and a GraphQL gate that phrased its own refusals would be a fourth.
    await disableModule(seed.tenantId, 'fulfillment');
    const user = { id: seed.userId, role: 'user', tenant_id: seed.tenantId };
    const token = await tokenFor(seed.userId, 'user', seed.tenantId);

    const rest = await checkModuleAccess(db, user as never, '/api/reports/generate', {});
    const graph = (await gql(REPORT, { token })).errors?.[0];

    expect(rest).not.toBeNull();
    expect(graph?.message).toBe(rest!.message);
    expect(graph?.extensions?.code).toBe(rest!.code);
    expect(graph?.extensions?.module).toBe(rest!.module);
  });

  it('lets the gated field through when the module is on', async () => {
    await seedDocument(seed.tenantId, 'Milk COA');
    const token = await tokenFor(seed.userId, 'user', seed.tenantId);

    const res = await gql(REPORT, { token });

    expect(res.errors).toBeUndefined();
    expect((res.data?.generateReport as { total: number }).total).toBe(1);
  });

  it('super_admin bypasses, with every module switched off', async () => {
    for (const key of MODULE_KEYS) await disableModule(seed.tenantId, key);
    await seedDocument(seed.tenantId, 'Milk COA');
    // They cross tenants by definition and are who a customer calls when a
    // module toggle went wrong — `loadModuleAccess` hands them everything
    // without a lookup, which is where that bypass belongs.
    const token = await tokenFor(seed.superAdminId, 'super_admin', null);

    const res = await gql(REPORT, { token });

    expect(res.errors).toBeUndefined();
    expect((res.data?.generateReport as { total: number }).total).toBe(1);
  });

  it('leaves the SHARED read primitives open with every module off', async () => {
    for (const key of MODULE_KEYS) await disableModule(seed.tenantId, key);
    await seedDocument(seed.tenantId, 'Milk COA');
    const token = await tokenFor(seed.userId, 'user', seed.tenantId);

    // `/api/documents` is the standing precedent: renewal digests, alert
    // landings and COA fulfillment all read documents, so gating them behind
    // `library` would break the modules that are switched ON.
    const res = await gql(DOCUMENTS, { token });
    expect(res.errors).toBeUndefined();
    expect((res.data?.documents as unknown[]).length).toBe(1);

    // Same for identity: a tenant with nothing switched on still has a portal.
    const me = await gql('query { me { id email } }', { token });
    expect(me.errors).toBeUndefined();
    expect((me.data?.me as { id: string }).id).toBe(seed.userId);
  });

  it('FAILS OPEN when the visibility lookup throws, and says so in the log', async () => {
    await disableModule(seed.tenantId, 'fulfillment');
    await seedDocument(seed.tenantId, 'Milk COA');
    const token = await tokenFor(seed.userId, 'user', seed.tenantId);

    const errors: string[] = [];
    vi.stubGlobal('console', { ...console, error: (...args: unknown[]) => errors.push(args.join(' ')) });

    // Break ONLY the two module reads. Breaking the whole binding would fail
    // the user lookup instead and prove nothing about the gate.
    const brokenDb = {
      prepare(sql: string) {
        if (sql.includes('tenant_modules') || sql.includes('owner_routes')) {
          throw new Error('D1_ERROR: no such table');
        }
        return db.prepare(sql);
      },
      batch: (statements: D1PreparedStatement[]) => db.batch(statements),
      exec: (sql: string) => db.exec(sql),
    };

    const res = await gql(REPORT, { token, envOverride: { ...env, DB: brokenDb } });

    // A tenant briefly seeing a surface they do not use is a nuisance; a
    // tenant locked out of their own reports by a D1 blip is an outage.
    expect(res.errors).toBeUndefined();
    expect((res.data?.generateReport as { total: number }).total).toBe(1);
    expect(errors.join('\n')).toContain('failing OPEN');
  });

  it('reports an anonymous caller as unauthenticated, not as a module problem', async () => {
    await disableModule(seed.tenantId, 'fulfillment');

    // NO USER MEANS NO GATE, exactly as in the middleware: there is no answer
    // to "which modules are yours" for nobody, so the resolver's own
    // `requireAuth` answers instead of the gate blaming a toggle.
    const res = await gql(REPORT);

    expect(res.errors).toBeDefined();
    expect(res.errors![0].extensions?.code).not.toBe('module_disabled');
    expect(res.errors![0].extensions?.code).not.toBe('module_not_visible');
  });

  it('declares a module for EVERY resolver, so none can default to open', async () => {
    // `Record<keyof typeof resolvers, ...>` already makes a missing entry a
    // compile error. This pins the same property at runtime so loosening that
    // type breaks a test rather than quietly un-gating the next resolver.
    expect(Object.keys(queryModules).sort()).toEqual(Object.keys(queryResolvers).sort());
    expect(Object.keys(mutationModules).sort()).toEqual(Object.keys(mutationResolvers).sort());
  });
});
