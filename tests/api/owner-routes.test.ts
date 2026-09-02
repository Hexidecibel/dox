/**
 * /api/owner-routes — the table that makes a free-text owner label
 * addressable.
 *
 * This endpoint is small, but it is the only way a tenant configures who
 * receives renewal alerts, so the things worth pinning are the ones that would
 * silently break routing: a half-configured row pointing at nobody, a route
 * that leaks across tenants, and a label whose spelling drifted.
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { runMigrations, seedTestData, cleanTables } from '../helpers/db';
import { onRequestGet as listRoutes, onRequestPost as createRoute } from '../../functions/api/owner-routes/index';
import { onRequestDelete as deleteRoute } from '../../functions/api/owner-routes/[id]';
import { resolveAlertRouting } from '../../functions/lib/alert-routing';

const db = env.DB;
let seed: Awaited<ReturnType<typeof seedTestData>>;

function ctx(method: string, url: string, user: any, body?: unknown, params: Record<string, string> = {}): any {
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

/**
 * A document carrying an owner label, so the in-use scan has something to find.
 * `renewalDue` decides whether it counts toward `renewal_count` — the subset
 * the renewal run would actually try to alert on.
 */
async function makeDocument(
  title: string,
  owner: string | null,
  opts: { renewalDue?: string; tenantId?: string; status?: string } = {},
): Promise<string> {
  const id = `doc-${Math.random().toString(36).slice(2, 10)}`;
  await db
    .prepare(
      `INSERT INTO documents
         (id, tenant_id, title, current_version, status, created_by, owner,
          renewal_type, renewal_due_date)
       VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      opts.tenantId ?? seed.tenantId,
      title,
      opts.status ?? 'active',
      seed.orgAdminId,
      owner,
      opts.renewalDue ? 'hard_expiry' : null,
      opts.renewalDue ?? null,
    )
    .run();
  return id;
}

const orgAdmin = () => ({ id: 'user-org-admin', role: 'org_admin', tenant_id: seed.tenantId });
const orgAdmin2 = () => ({ id: 'user-org-admin-2', role: 'org_admin', tenant_id: seed.tenantId2 });
const reader = () => ({ id: 'user-reader', role: 'reader', tenant_id: seed.tenantId });

async function post(user: any, body: unknown) {
  const res = await createRoute(ctx('POST', '/api/owner-routes', user, body));
  return { status: res.status, body: (await res.json()) as any };
}

async function get(user: any, qs = '') {
  const res = await listRoutes(ctx('GET', `/api/owner-routes${qs}`, user));
  return { status: res.status, body: (await res.json()) as any };
}

beforeAll(async () => {
  await runMigrations(db);
}, 30_000);

beforeEach(async () => {
  await cleanTables(db);
  seed = await seedTestData(db);
});

describe('POST /api/owner-routes', () => {
  it('creates a route to a portal user', async () => {
    const { status, body } = await post(orgAdmin(), { owner_label: 'QA', user_id: seed.userId });
    expect(status).toBe(201);
    expect(body.route.owner_key).toBe('qa');
    expect(body.route.owner_label).toBe('QA');
    expect(body.route.user_id).toBe(seed.userId);
  });

  it('creates a route to a bare address for an owner with no account', async () => {
    const { status, body } = await post(orgAdmin(), {
      owner_label: 'Insurance', email: 'broker@agency.example',
    });
    expect(status).toBe(201);
    expect(body.route.email).toBe('broker@agency.example');
    expect(body.route.user_id).toBeNull();
  });

  it('REFUSES a row that points at nobody, and one that points at two things', async () => {
    // A routing table that accepts either is how "we configured it" and
    // "alerts arrive" come apart without anyone noticing.
    expect((await post(orgAdmin(), { owner_label: 'QA' })).status).toBe(400);
    expect(
      (await post(orgAdmin(), { owner_label: 'QA', user_id: seed.userId, email: 'a@b.com' })).status,
    ).toBe(400);
  });

  it('requires a label and rejects a blank one', async () => {
    expect((await post(orgAdmin(), { email: 'a@b.com' })).status).toBe(400);
    expect((await post(orgAdmin(), { owner_label: '   ', email: 'a@b.com' })).status).toBe(400);
  });

  it('rejects a malformed address', async () => {
    expect((await post(orgAdmin(), { owner_label: 'QA', email: 'not-an-address' })).status).toBe(400);
  });

  it('refuses to route a label at a user from another tenant', async () => {
    const res = await post(orgAdmin(), { owner_label: 'QA', user_id: seed.orgAdmin2Id });
    expect(res.status).toBe(400);
  });

  it('lets several people share one owner label', async () => {
    await post(orgAdmin(), { owner_label: 'QA', user_id: seed.userId });
    await post(orgAdmin(), { owner_label: 'QA', email: 'qa2@example.com' });
    const r = await resolveAlertRouting(db, {
      tenantId: seed.tenantId, ownerLabel: 'QA', adminFallback: false,
    });
    expect(r.recipients.map((x) => x.email).sort()).toEqual(['qa2@example.com', 'user@test.com']);
  });

  it('re-posting the same recipient re-labels rather than duplicating', async () => {
    await post(orgAdmin(), { owner_label: 'QA', email: 'qa@example.com' });
    const again = await post(orgAdmin(), { owner_label: 'qa', email: 'qa@example.com' });
    expect(again.status).toBe(201);
    const { body } = await get(orgAdmin());
    expect(body.routes).toHaveLength(1);
    expect(body.routes[0].owner_label).toBe('qa');
  });

  it('rejects a reader', async () => {
    expect((await post(reader(), { owner_label: 'QA', email: 'a@b.com' })).status).toBe(403);
  });
});

describe('GET /api/owner-routes', () => {
  it('lists only the caller’s tenant', async () => {
    await post(orgAdmin(), { owner_label: 'QA', email: 'one@example.com' });
    await post(orgAdmin2(), { owner_label: 'QA', email: 'two@example.com' });

    const mine = await get(orgAdmin());
    expect(mine.body.routes.map((r: any) => r.email)).toEqual(['one@example.com']);

    const theirs = await get(orgAdmin2());
    expect(theirs.body.routes.map((r: any) => r.email)).toEqual(['two@example.com']);
  });

  it('filters by label on the normalized key, not the exact spelling', async () => {
    await post(orgAdmin(), { owner_label: 'QA', email: 'qa@example.com' });
    await post(orgAdmin(), { owner_label: 'Accounting', email: 'acct@example.com' });
    const { body } = await get(orgAdmin(), '?owner=%20qa%20');
    expect(body.routes).toHaveLength(1);
    expect(body.routes[0].email).toBe('qa@example.com');
  });
});

describe('DELETE /api/owner-routes/:id', () => {
  it('removes a route, and the label then resolves to NOBODY rather than to admins', async () => {
    const created = await post(orgAdmin(), { owner_label: 'QA', email: 'qa@example.com' });
    const id = created.body.route.id;

    const res = await deleteRoute(ctx('DELETE', `/api/owner-routes/${id}`, orgAdmin(), undefined, { id }));
    expect(res.status).toBe(200);

    const r = await resolveAlertRouting(db, {
      tenantId: seed.tenantId, ownerLabel: 'QA', adminFallback: false,
    });
    expect(r.via).toBe('unrouted');
    expect(r.recipients).toEqual([]);
  });

  it('will not let one tenant delete another tenant’s route', async () => {
    const created = await post(orgAdmin(), { owner_label: 'QA', email: 'qa@example.com' });
    const id = created.body.route.id;
    const res = await deleteRoute(ctx('DELETE', `/api/owner-routes/${id}`, orgAdmin2(), undefined, { id }));
    expect(res.status).toBe(403);

    const { body } = await get(orgAdmin());
    expect(body.routes).toHaveLength(1);
  });

  it('404s on an unknown id', async () => {
    const res = await deleteRoute(ctx('DELETE', '/api/owner-routes/nope', orgAdmin(), undefined, { id: 'nope' }));
    expect(res.status).toBe(404);
  });
});


/**
 * `labels_in_use` is what turns the routing screen from "type a label from
 * memory" into "here is what your documents actually say". The states worth
 * pinning are the ones that would send somebody to configure the wrong thing:
 * a label nobody routed, a spelling that drifted, and another tenant's labels
 * leaking in.
 */
describe('GET /api/owner-routes — labels_in_use', () => {
  it('reports labels found on documents, with their document and renewal counts', async () => {
    await makeDocument('COI 2026', 'Insurance', { renewalDue: '2026-12-01' });
    await makeDocument('Broker letter', 'Insurance');
    await makeDocument('Allergen matrix', 'QA');

    const { body } = await get(orgAdmin());
    const byKey = Object.fromEntries(
      body.labels_in_use.map((l: any) => [l.owner_key, l]),
    );
    expect(byKey.insurance.document_count).toBe(2);
    expect(byKey.insurance.renewal_count).toBe(1);
    expect(byKey.qa.document_count).toBe(1);
    expect(byKey.qa.renewal_count).toBe(0);
  });

  it('marks a label with no route as unrouted, and sorts it first', async () => {
    await makeDocument('COI 2026', 'Insurance', { renewalDue: '2026-12-01' });
    await makeDocument('Allergen matrix', 'QA');
    await post(orgAdmin(), { owner_label: 'QA', email: 'qa@example.com' });

    const { body } = await get(orgAdmin());
    // Insurance has nobody behind it — that is the state the screen leads with.
    expect(body.labels_in_use[0].owner_key).toBe('insurance');
    expect(body.labels_in_use[0].route_count).toBe(0);
    const qa = body.labels_in_use.find((l: any) => l.owner_key === 'qa');
    expect(qa.route_count).toBe(1);
  });

  it('folds drifted spellings onto one key and keeps both spellings visible', async () => {
    await makeDocument('a', 'QA');
    await makeDocument('b', 'qa ');

    const { body } = await get(orgAdmin());
    expect(body.labels_in_use).toHaveLength(1);
    expect(body.labels_in_use[0].owner_key).toBe('qa');
    expect(body.labels_in_use[0].document_count).toBe(2);
    expect(body.labels_in_use[0].spellings.sort()).toEqual(['QA', 'qa ']);
  });

  it('ignores blank owners and non-active documents', async () => {
    await makeDocument('no owner', null);
    await makeDocument('blank owner', '   ');
    await makeDocument('deleted', 'QA', { status: 'deleted' });

    const { body } = await get(orgAdmin());
    expect(body.labels_in_use).toEqual([]);
  });

  it('never leaks another tenant’s labels', async () => {
    await makeDocument('theirs', 'Purchasing', { tenantId: seed.tenantId2 });
    await makeDocument('mine', 'QA');

    const { body } = await get(orgAdmin());
    expect(body.labels_in_use.map((l: any) => l.owner_key)).toEqual(['qa']);
  });

  it('is NOT narrowed by ?owner= — the point is the labels you did not ask about', async () => {
    await makeDocument('a', 'QA');
    await makeDocument('b', 'Insurance');
    await post(orgAdmin(), { owner_label: 'QA', email: 'qa@example.com' });

    const { body } = await get(orgAdmin(), '?owner=QA');
    expect(body.routes).toHaveLength(1);
    expect(body.labels_in_use.map((l: any) => l.owner_key).sort()).toEqual(['insurance', 'qa']);
    // And the route count for the filtered-out label is still correct.
    const qa = body.labels_in_use.find((l: any) => l.owner_key === 'qa');
    expect(qa.route_count).toBe(1);
  });
});
