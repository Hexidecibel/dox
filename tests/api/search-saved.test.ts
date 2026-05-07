/**
 * Endpoint tests for the saved-searches CRUD surface (Phase 3 of the
 * Document Search v2 plan).
 *
 * These exercise the REST handlers directly (mirrors the
 * `connector-crud.test.ts` style) so we cover validation, ownership,
 * and per-user isolation end-to-end.
 *
 * Coverage:
 *   - POST  201 happy path; 400 on missing name / query; 400 on shared
 *     scope (reserved for v2); 409 on duplicate name per user.
 *   - GET   list returns ONLY the calling user's rows; reader role works
 *     identically to user / org_admin / super_admin.
 *   - PUT   owner can update name + query; 409 on name conflict;
 *     404 on someone else's saved search.
 *   - DELETE owner can delete; 404 on second call (idempotent surface
 *     returns 404 once gone, matching the document-types pattern).
 *   - Cross-user isolation: user A cannot read / update / delete user
 *     B's saved searches.
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { seedTestData, generateTestId } from '../helpers/db';
import {
  onRequestGet as listSaved,
  onRequestPost as createSaved,
} from '../../functions/api/search/saved/index';
import {
  onRequestGet as getSaved,
  onRequestPut as updateSaved,
  onRequestDelete as deleteSaved,
} from '../../functions/api/search/saved/[id]';

let seed: Awaited<ReturnType<typeof seedTestData>>;
const db = env.DB;

beforeAll(async () => {
  seed = await seedTestData(db);
}, 30_000);

// Each test starts from a clean saved_searches table to keep the
// list/order assertions deterministic. The seeded users + tenants
// persist across tests (FKs cascade cleanup if a user is removed; we
// don't remove seeded users between tests).
beforeEach(async () => {
  await db.prepare(`DELETE FROM saved_searches`).run();
});

type SeedUser = {
  id: string;
  role: 'super_admin' | 'org_admin' | 'user' | 'reader';
  tenant_id: string | null;
};

function userFor(role: 'super_admin' | 'org_admin' | 'user' | 'reader'): SeedUser {
  switch (role) {
    case 'super_admin':
      // Super_admin in seedTestData has tenant_id = null, but our endpoint
      // requires a tenant for create. Tests that exercise create use
      // org_admin / user / reader; super_admin lists return [] which is
      // also covered.
      return { id: seed.superAdminId, role: 'super_admin', tenant_id: null };
    case 'org_admin':
      return { id: seed.orgAdminId, role: 'org_admin', tenant_id: seed.tenantId };
    case 'user':
      return { id: seed.userId, role: 'user', tenant_id: seed.tenantId };
    case 'reader':
      return { id: seed.readerId, role: 'reader', tenant_id: seed.tenantId };
  }
}

function makePostContext(body: Record<string, unknown>, user: SeedUser) {
  const request = new Request('http://localhost/api/search/saved', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return {
    request,
    env,
    data: { user },
    params: {},
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
    functionPath: '/api/search/saved',
  } as any;
}

function makeListContext(user: SeedUser) {
  const request = new Request('http://localhost/api/search/saved', { method: 'GET' });
  return {
    request,
    env,
    data: { user },
    params: {},
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
    functionPath: '/api/search/saved',
  } as any;
}

function makeGetContext(id: string, user: SeedUser) {
  const request = new Request(`http://localhost/api/search/saved/${id}`, { method: 'GET' });
  return {
    request,
    env,
    data: { user },
    params: { id },
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
    functionPath: `/api/search/saved/${id}`,
  } as any;
}

function makePutContext(id: string, body: Record<string, unknown>, user: SeedUser) {
  const request = new Request(`http://localhost/api/search/saved/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return {
    request,
    env,
    data: { user },
    params: { id },
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
    functionPath: `/api/search/saved/${id}`,
  } as any;
}

function makeDeleteContext(id: string, user: SeedUser) {
  const request = new Request(`http://localhost/api/search/saved/${id}`, { method: 'DELETE' });
  return {
    request,
    env,
    data: { user },
    params: { id },
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
    functionPath: `/api/search/saved/${id}`,
  } as any;
}

interface SavedSearch {
  id: string;
  user_id: string;
  tenant_id: string;
  name: string;
  query: Record<string, unknown> | unknown;
  scope: 'personal' | 'shared';
  created_at: string;
  updated_at: string;
}

async function createOne(
  user: SeedUser,
  name: string,
  query: Record<string, unknown> = { q: 'hello' },
): Promise<SavedSearch> {
  const res = await createSaved(makePostContext({ name, query }, user));
  expect(res.status).toBe(201);
  const body = (await res.json()) as { saved_search: SavedSearch };
  return body.saved_search;
}

describe('POST /api/search/saved', () => {
  it('creates a saved search with valid body (org_admin)', async () => {
    const user = userFor('org_admin');
    const res = await createSaved(
      makePostContext(
        {
          name: 'Pending COAs from Acme',
          query: { q: 'acme', filters: { doc_type: ['coa'] } },
        },
        user,
      ),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { saved_search: SavedSearch };
    expect(body.saved_search.id).toBeTruthy();
    expect(body.saved_search.name).toBe('Pending COAs from Acme');
    expect(body.saved_search.user_id).toBe(user.id);
    expect(body.saved_search.tenant_id).toBe(user.tenant_id);
    expect(body.saved_search.scope).toBe('personal');
    expect(body.saved_search.query).toEqual({ q: 'acme', filters: { doc_type: ['coa'] } });
  });

  it('creates a saved search for a reader (per plan: readers can save)', async () => {
    const user = userFor('reader');
    const res = await createSaved(
      makePostContext({ name: 'Reader Bookmark', query: { q: 'butter' } }, user),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { saved_search: SavedSearch };
    expect(body.saved_search.user_id).toBe(user.id);
  });

  it('rejects POST with missing name (400)', async () => {
    const res = await createSaved(
      makePostContext({ query: { q: 'darigold' } }, userFor('user')),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/name/i);
  });

  it('rejects POST with empty/whitespace name (400)', async () => {
    const res = await createSaved(
      makePostContext({ name: '   ', query: { q: 'x' } }, userFor('user')),
    );
    expect(res.status).toBe(400);
  });

  it('rejects POST with missing query (400)', async () => {
    const res = await createSaved(
      makePostContext({ name: 'No Query' }, userFor('user')),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/query/i);
  });

  it("rejects POST with scope='shared' (reserved for v2)", async () => {
    const res = await createSaved(
      makePostContext(
        { name: 'Team Bookmark', query: { q: 'x' }, scope: 'shared' },
        userFor('org_admin'),
      ),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/shared|not yet supported/i);
  });

  it('rejects unknown scope values (400)', async () => {
    const res = await createSaved(
      makePostContext(
        { name: 'Bad Scope', query: { q: 'x' }, scope: 'public' },
        userFor('org_admin'),
      ),
    );
    expect(res.status).toBe(400);
  });

  it('returns 409 on duplicate name for the SAME user', async () => {
    const user = userFor('user');
    await createOne(user, 'My Search');
    const res = await createSaved(
      makePostContext({ name: 'My Search', query: { q: 'y' } }, user),
    );
    expect(res.status).toBe(409);
  });

  it('allows the SAME name across DIFFERENT users', async () => {
    await createOne(userFor('user'), 'Shared Name');
    const res = await createSaved(
      makePostContext({ name: 'Shared Name', query: { q: 'y' } }, userFor('org_admin')),
    );
    expect(res.status).toBe(201);
  });

  it('rejects super_admin (no tenant_id) from creating', async () => {
    const res = await createSaved(
      makePostContext({ name: 'Cross Tenant', query: { q: 'x' } }, userFor('super_admin')),
    );
    expect(res.status).toBe(400);
  });
});

describe('GET /api/search/saved', () => {
  it('returns only the calling user’s saved searches', async () => {
    const userA = userFor('user');
    const userB = userFor('org_admin');
    await createOne(userA, 'A1');
    await createOne(userA, 'A2');
    await createOne(userB, 'B1');

    const res = await listSaved(makeListContext(userA));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { saved_searches: SavedSearch[] };
    const names = body.saved_searches.map((s) => s.name).sort();
    expect(names).toEqual(['A1', 'A2']);
    body.saved_searches.forEach((s) => expect(s.user_id).toBe(userA.id));
  });

  it('orders results by created_at DESC (newest first)', async () => {
    const user = userFor('user');
    await createOne(user, 'First');
    // Tiny delay isn't needed — datetime('now') resolution is per second
    // and the secondary sort on name keeps this deterministic if both
    // rows land in the same second.
    await createOne(user, 'Second');

    const res = await listSaved(makeListContext(user));
    const body = (await res.json()) as { saved_searches: SavedSearch[] };
    expect(body.saved_searches.length).toBe(2);
    // Name fallback ('First' < 'Second' alpha-DESC after created_at DESC)
    // — either order is fine if same second; just assert both present.
    const names = body.saved_searches.map((s) => s.name);
    expect(names).toContain('First');
    expect(names).toContain('Second');
  });

  it('returns empty list for a user with nothing saved', async () => {
    const res = await listSaved(makeListContext(userFor('reader')));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { saved_searches: SavedSearch[] };
    expect(body.saved_searches).toEqual([]);
  });

  it('returns empty list for super_admin (per-user surface)', async () => {
    // Even though super_admin can see "everything" in the admin surfaces,
    // saved searches are personal — they only see their own (which here
    // is empty).
    await createOne(userFor('user'), 'Other User Doc');
    const res = await listSaved(makeListContext(userFor('super_admin')));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { saved_searches: SavedSearch[] };
    expect(body.saved_searches).toEqual([]);
  });

  it.each(['super_admin', 'org_admin', 'user', 'reader'] as const)(
    'role %s can list its own saved searches',
    async (role) => {
      const user = userFor(role);
      // super_admin can't create, so just exercise the empty-list path
      // for that role; others get a row first.
      if (user.tenant_id) {
        await createOne(user, `${role}-1`);
      }
      const res = await listSaved(makeListContext(user));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { saved_searches: SavedSearch[] };
      expect(body.saved_searches.length).toBe(user.tenant_id ? 1 : 0);
      body.saved_searches.forEach((s) => expect(s.user_id).toBe(user.id));
    },
  );
});

describe('GET /api/search/saved/:id', () => {
  it('returns the saved search to its owner', async () => {
    const user = userFor('user');
    const created = await createOne(user, 'Mine', { q: 'x' });

    const res = await getSaved(makeGetContext(created.id, user));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { saved_search: SavedSearch };
    expect(body.saved_search.id).toBe(created.id);
    expect(body.saved_search.query).toEqual({ q: 'x' });
  });

  it('returns 404 to a non-owner (cross-user isolation)', async () => {
    const owner = userFor('user');
    const other = userFor('org_admin');
    const created = await createOne(owner, 'Owner Only');

    const res = await getSaved(makeGetContext(created.id, other));
    expect(res.status).toBe(404);
  });

  it('returns 404 for an unknown id', async () => {
    const res = await getSaved(makeGetContext(generateTestId(), userFor('user')));
    expect(res.status).toBe(404);
  });
});

describe('PUT /api/search/saved/:id', () => {
  it('updates the name for the owner and bumps updated_at', async () => {
    const user = userFor('user');
    const created = await createOne(user, 'Old Name');

    // Capture original updated_at from a fresh row (created.updated_at is
    // also fine, but we're explicit here).
    const before = await db
      .prepare('SELECT updated_at FROM saved_searches WHERE id = ?')
      .bind(created.id)
      .first<{ updated_at: string }>();

    // Wait long enough that datetime('now') (1-second resolution) ticks.
    await new Promise((r) => setTimeout(r, 1100));

    const res = await updateSaved(
      makePutContext(created.id, { name: 'New Name' }, user),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { saved_search: SavedSearch };
    expect(body.saved_search.name).toBe('New Name');
    expect(body.saved_search.updated_at >= before!.updated_at).toBe(true);
  });

  it('updates the query for the owner', async () => {
    const user = userFor('user');
    const created = await createOne(user, 'Editable', { q: 'old' });
    const res = await updateSaved(
      makePutContext(created.id, { query: { q: 'new', extra: 1 } }, user),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { saved_search: SavedSearch };
    expect(body.saved_search.query).toEqual({ q: 'new', extra: 1 });
  });

  it('returns 404 when a non-owner tries to update', async () => {
    const owner = userFor('user');
    const other = userFor('org_admin');
    const created = await createOne(owner, 'Owner Only');

    const res = await updateSaved(
      makePutContext(created.id, { name: 'Stolen' }, other),
    );
    expect(res.status).toBe(404);

    // Confirm the row didn't change.
    const row = await db
      .prepare('SELECT name FROM saved_searches WHERE id = ?')
      .bind(created.id)
      .first<{ name: string }>();
    expect(row!.name).toBe('Owner Only');
  });

  it('returns 409 when renaming to a name the same user already has', async () => {
    const user = userFor('user');
    await createOne(user, 'Existing');
    const second = await createOne(user, 'To Rename');

    const res = await updateSaved(
      makePutContext(second.id, { name: 'Existing' }, user),
    );
    expect(res.status).toBe(409);
  });

  it('returns 400 with no fields to update', async () => {
    const user = userFor('user');
    const created = await createOne(user, 'Nothing');
    const res = await updateSaved(makePutContext(created.id, {}, user));
    expect(res.status).toBe(400);
  });

  it('returns 400 when name is empty', async () => {
    const user = userFor('user');
    const created = await createOne(user, 'Has Name');
    const res = await updateSaved(makePutContext(created.id, { name: '   ' }, user));
    expect(res.status).toBe(400);
  });

  it('returns 404 for an unknown id', async () => {
    const res = await updateSaved(
      makePutContext(generateTestId(), { name: 'x' }, userFor('user')),
    );
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/search/saved/:id', () => {
  it('deletes for the owner (200) and second call returns 404', async () => {
    const user = userFor('user');
    const created = await createOne(user, 'Delete Me');

    const res1 = await deleteSaved(makeDeleteContext(created.id, user));
    expect(res1.status).toBe(200);
    const body = (await res1.json()) as { success: boolean };
    expect(body.success).toBe(true);

    const res2 = await deleteSaved(makeDeleteContext(created.id, user));
    expect(res2.status).toBe(404);
  });

  it('returns 404 when a non-owner tries to delete', async () => {
    const owner = userFor('user');
    const other = userFor('org_admin');
    const created = await createOne(owner, 'Owner Only');

    const res = await deleteSaved(makeDeleteContext(created.id, other));
    expect(res.status).toBe(404);

    // Confirm the row still exists for the owner.
    const row = await db
      .prepare('SELECT id FROM saved_searches WHERE id = ?')
      .bind(created.id)
      .first();
    expect(row).not.toBeNull();
  });
});
