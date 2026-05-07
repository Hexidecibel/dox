/**
 * Phase 3 unit tests for the saved_searches table (migration 0057).
 *
 * These tests drive the table directly via env.DB — no HTTP layer. They
 * cover the schema invariants the migration is responsible for:
 *
 *   - Insert + SELECT round-trips JSON in `query_json` losslessly.
 *   - UNIQUE(user_id, name): same user can't reuse a name; different
 *     users can.
 *   - ON DELETE CASCADE from users: deleting the user wipes their
 *     saved searches.
 *   - `scope` defaults to 'personal'; CHECK rejects anything outside
 *     ('personal', 'shared').
 *   - `created_at` and `updated_at` populate on insert with no value.
 *
 * The endpoint behavior lives in `tests/api/search-saved.test.ts`.
 */

import { env } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';

const db = env.DB;

const TENANT_A = 'ss-tenant-a';
const TENANT_B = 'ss-tenant-b';
const USER_A1 = 'ss-user-a1';
const USER_A2 = 'ss-user-a2';
const USER_B1 = 'ss-user-b1';

async function resetData(): Promise<void> {
  // Order matters — saved_searches FKs cascade off users, but we also
  // bind to tenants which is a non-cascading FK.
  await db.prepare(`DELETE FROM saved_searches WHERE id LIKE 'ss-%'`).run();
  await db
    .prepare(`DELETE FROM users WHERE id IN (?, ?, ?)`)
    .bind(USER_A1, USER_A2, USER_B1)
    .run();
  await db
    .prepare(`DELETE FROM tenants WHERE id IN (?, ?)`)
    .bind(TENANT_A, TENANT_B)
    .run();
}

async function seedBaseline(): Promise<void> {
  await db
    .prepare(
      `INSERT INTO tenants (id, name, slug, active, created_at, updated_at)
       VALUES (?, ?, ?, 1, datetime('now'), datetime('now'))`,
    )
    .bind(TENANT_A, 'SS Tenant A', 'ss-tenant-a')
    .run();
  await db
    .prepare(
      `INSERT INTO tenants (id, name, slug, active, created_at, updated_at)
       VALUES (?, ?, ?, 1, datetime('now'), datetime('now'))`,
    )
    .bind(TENANT_B, 'SS Tenant B', 'ss-tenant-b')
    .run();

  for (const [uid, tid, role] of [
    [USER_A1, TENANT_A, 'org_admin'],
    [USER_A2, TENANT_A, 'user'],
    [USER_B1, TENANT_B, 'user'],
  ] as const) {
    await db
      .prepare(
        `INSERT INTO users (id, email, name, role, tenant_id, password_hash, active, force_password_change)
         VALUES (?, ?, ?, ?, ?, ?, 1, 0)`,
      )
      .bind(uid, `${uid}@test.com`, uid, role, tid, 'fakehash')
      .run();
  }
}

beforeEach(async () => {
  await resetData();
  await seedBaseline();
});

describe('saved_searches — round-trip', () => {
  it('preserves all fields including arbitrary JSON in query_json', async () => {
    const queryObj = {
      q: 'darigold cheese',
      filters: { supplier_id: 'sup-1', doc_type: ['coa', 'sds'] },
      sort: 'newest',
      page: 2,
      facets: { date_bucket: 'last_30d' },
    };
    await db
      .prepare(
        `INSERT INTO saved_searches (id, user_id, tenant_id, name, query_json)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .bind('ss-rt-1', USER_A1, TENANT_A, 'My Cheese Search', JSON.stringify(queryObj))
      .run();

    const row = await db
      .prepare(`SELECT * FROM saved_searches WHERE id = ?`)
      .bind('ss-rt-1')
      .first<{
        id: string;
        user_id: string;
        tenant_id: string;
        name: string;
        query_json: string;
        scope: string;
        created_at: string;
        updated_at: string;
      }>();

    expect(row).not.toBeNull();
    expect(row!.user_id).toBe(USER_A1);
    expect(row!.tenant_id).toBe(TENANT_A);
    expect(row!.name).toBe('My Cheese Search');
    expect(JSON.parse(row!.query_json)).toEqual(queryObj);
    expect(row!.scope).toBe('personal');
    expect(row!.created_at).toBeTruthy();
    expect(row!.updated_at).toBeTruthy();
  });

  it('accepts arbitrary JSON shapes — schema is not enforced at DB level', async () => {
    // Empty object, deeply nested, arrays at root, etc.
    const shapes: unknown[] = [
      {},
      { a: 1 },
      [1, 2, 3],
      { deeply: { nested: { thing: ['x', { y: null }] } } },
      'just a string',
      42,
      null,
    ];

    for (let i = 0; i < shapes.length; i++) {
      await db
        .prepare(
          `INSERT INTO saved_searches (id, user_id, tenant_id, name, query_json)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .bind(`ss-shape-${i}`, USER_A1, TENANT_A, `Shape ${i}`, JSON.stringify(shapes[i]))
        .run();
    }

    const result = await db
      .prepare(`SELECT id, query_json FROM saved_searches WHERE id LIKE 'ss-shape-%' ORDER BY id`)
      .all<{ id: string; query_json: string }>();
    const rows = result.results ?? [];
    expect(rows.length).toBe(shapes.length);
    rows.forEach((r, i) => {
      expect(JSON.parse(r.query_json)).toEqual(shapes[i]);
    });
  });
});

describe('saved_searches — unique(user_id, name)', () => {
  it('rejects duplicate name for the SAME user', async () => {
    await db
      .prepare(
        `INSERT INTO saved_searches (id, user_id, tenant_id, name, query_json)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .bind('ss-uniq-1', USER_A1, TENANT_A, 'Pending COAs', '{}')
      .run();

    await expect(
      db
        .prepare(
          `INSERT INTO saved_searches (id, user_id, tenant_id, name, query_json)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .bind('ss-uniq-2', USER_A1, TENANT_A, 'Pending COAs', '{}')
        .run(),
    ).rejects.toThrow(/UNIQUE/i);
  });

  it('allows the SAME name across DIFFERENT users (same tenant)', async () => {
    await db
      .prepare(
        `INSERT INTO saved_searches (id, user_id, tenant_id, name, query_json)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .bind('ss-uniq-a1', USER_A1, TENANT_A, 'Pending COAs', '{}')
      .run();
    await db
      .prepare(
        `INSERT INTO saved_searches (id, user_id, tenant_id, name, query_json)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .bind('ss-uniq-a2', USER_A2, TENANT_A, 'Pending COAs', '{}')
      .run();

    const result = await db
      .prepare(`SELECT id FROM saved_searches WHERE name = ? AND tenant_id = ? ORDER BY id`)
      .bind('Pending COAs', TENANT_A)
      .all();
    expect((result.results ?? []).length).toBe(2);
  });

  it('allows the SAME name across DIFFERENT users (different tenants)', async () => {
    await db
      .prepare(
        `INSERT INTO saved_searches (id, user_id, tenant_id, name, query_json)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .bind('ss-uniq-cross-1', USER_A1, TENANT_A, 'Recent', '{}')
      .run();
    await db
      .prepare(
        `INSERT INTO saved_searches (id, user_id, tenant_id, name, query_json)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .bind('ss-uniq-cross-2', USER_B1, TENANT_B, 'Recent', '{}')
      .run();

    const result = await db
      .prepare(`SELECT id FROM saved_searches WHERE name = ? ORDER BY id`)
      .bind('Recent')
      .all();
    expect((result.results ?? []).length).toBe(2);
  });
});

describe('saved_searches — cascade on user delete', () => {
  it('removes the saved_search when its owning user is deleted', async () => {
    await db
      .prepare(
        `INSERT INTO saved_searches (id, user_id, tenant_id, name, query_json)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .bind('ss-cascade-1', USER_A1, TENANT_A, 'Goes With User', '{}')
      .run();

    // Sanity: row exists.
    let row = await db
      .prepare(`SELECT id FROM saved_searches WHERE id = ?`)
      .bind('ss-cascade-1')
      .first();
    expect(row).not.toBeNull();

    // Delete the user — cascade should drop the saved search.
    await db.prepare(`DELETE FROM users WHERE id = ?`).bind(USER_A1).run();

    row = await db
      .prepare(`SELECT id FROM saved_searches WHERE id = ?`)
      .bind('ss-cascade-1')
      .first();
    expect(row).toBeNull();
  });

  it("does NOT remove a different user's saved_search", async () => {
    await db
      .prepare(
        `INSERT INTO saved_searches (id, user_id, tenant_id, name, query_json)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .bind('ss-cascade-keep', USER_A2, TENANT_A, 'Keeps', '{}')
      .run();

    await db.prepare(`DELETE FROM users WHERE id = ?`).bind(USER_A1).run();

    const row = await db
      .prepare(`SELECT id FROM saved_searches WHERE id = ?`)
      .bind('ss-cascade-keep')
      .first();
    expect(row).not.toBeNull();
  });
});

describe('saved_searches — scope CHECK constraint', () => {
  it("defaults scope to 'personal' when not provided", async () => {
    await db
      .prepare(
        `INSERT INTO saved_searches (id, user_id, tenant_id, name, query_json)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .bind('ss-scope-default', USER_A1, TENANT_A, 'Default Scope', '{}')
      .run();

    const row = await db
      .prepare(`SELECT scope FROM saved_searches WHERE id = ?`)
      .bind('ss-scope-default')
      .first<{ scope: string }>();
    expect(row!.scope).toBe('personal');
  });

  it("accepts explicit 'personal'", async () => {
    await db
      .prepare(
        `INSERT INTO saved_searches (id, user_id, tenant_id, name, query_json, scope)
         VALUES (?, ?, ?, ?, ?, 'personal')`,
      )
      .bind('ss-scope-p', USER_A1, TENANT_A, 'Explicit Personal', '{}')
      .run();

    const row = await db
      .prepare(`SELECT scope FROM saved_searches WHERE id = ?`)
      .bind('ss-scope-p')
      .first<{ scope: string }>();
    expect(row!.scope).toBe('personal');
  });

  it("accepts 'shared' (reserved for v2 — DB allows it; API rejects)", async () => {
    // The CHECK constraint ALLOWS shared so a future migration doesn't
    // need to widen the column. The endpoint is the layer that enforces
    // "personal-only" in v1.
    await db
      .prepare(
        `INSERT INTO saved_searches (id, user_id, tenant_id, name, query_json, scope)
         VALUES (?, ?, ?, ?, ?, 'shared')`,
      )
      .bind('ss-scope-s', USER_A1, TENANT_A, 'Reserved Shared', '{}')
      .run();

    const row = await db
      .prepare(`SELECT scope FROM saved_searches WHERE id = ?`)
      .bind('ss-scope-s')
      .first<{ scope: string }>();
    expect(row!.scope).toBe('shared');
  });

  it("rejects an unknown scope value", async () => {
    await expect(
      db
        .prepare(
          `INSERT INTO saved_searches (id, user_id, tenant_id, name, query_json, scope)
           VALUES (?, ?, ?, ?, ?, 'public')`,
        )
        .bind('ss-scope-bad', USER_A1, TENANT_A, 'Bad Scope', '{}')
        .run(),
    ).rejects.toThrow(/CHECK|constraint/i);
  });
});

describe('saved_searches — timestamps', () => {
  it('populates created_at and updated_at by default on insert', async () => {
    await db
      .prepare(
        `INSERT INTO saved_searches (id, user_id, tenant_id, name, query_json)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .bind('ss-ts-1', USER_A1, TENANT_A, 'Timestamps', '{}')
      .run();

    const row = await db
      .prepare(`SELECT created_at, updated_at FROM saved_searches WHERE id = ?`)
      .bind('ss-ts-1')
      .first<{ created_at: string; updated_at: string }>();
    expect(row!.created_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
    expect(row!.updated_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
  });
});
