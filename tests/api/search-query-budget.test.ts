/**
 * What an answer costs, and that it is never answered from stale keys.
 *
 * Statement-count guard: a fake D1 (a counting wrapper around the real one)
 * counts every `prepare` and every round trip, and holds runSearch to the
 * design's budget — ONE round trip for a scope / text search (the page and
 * every facet in one batch), at most FOUR for an identifying search once the
 * search keys are current (two more on the search that brings them up to
 * date). The response's own `stats` must agree with the outside count.
 *
 * Freshness: a metadata edit enqueues a 'document_keys' job (migration 0122's
 * trigger); the next search drains it before it reads keys. When more jobs are
 * pending than one search drains, it says so (`keys_pending`) and falls back
 * to judging the scoped set, so the answer is still right.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { FACET_FIELDS, type FacetField } from '../../shared/searchFields';
import { countingDb, runSearch, type StatementStats } from '../../functions/lib/search/execute';
import type { Clause, SearchQuery } from '../../shared/searchQuery';

const db = env.DB;
const T = 'sqb-tenant';
const USER_ID = 'sqb-user';
const SUP = 'sqb-sup';
const DT = 'sqb-dt';

async function insertDoc(id: string, metadata: Record<string, unknown>) {
  await db.prepare(
    `INSERT INTO documents (id, tenant_id, title, tags, current_version, status, created_by, supplier_id, document_type_id, primary_metadata, created_at, updated_at)
     VALUES (?, ?, ?, '[]', 1, 'active', ?, ?, ?, ?, '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z')`,
  ).bind(id, T, `Doc ${id}`, USER_ID, SUP, DT, JSON.stringify(metadata)).run();
}

beforeAll(async () => {
  await db.prepare(`INSERT OR IGNORE INTO tenants (id, name, slug, active) VALUES (?, 'Budget Co', 'budget-co', 1)`).bind(T).run();
  await db.prepare(
    `INSERT OR IGNORE INTO users (id, email, name, role, tenant_id, password_hash, active, force_password_change)
     VALUES (?, 'sqb@test.com', 'Sqb', 'org_admin', ?, 'x', 1, 0)`,
  ).bind(USER_ID, T).run();
  await db.prepare(`INSERT INTO suppliers (id, tenant_id, name, slug, active) VALUES (?, ?, 'Budget Dairy', 'budget-dairy', 1)`).bind(SUP, T).run();
  await db.prepare(`INSERT INTO document_types (id, tenant_id, name, slug, active) VALUES (?, ?, 'COA', 'coa', 1)`).bind(DT, T).run();
  for (let i = 1; i <= 6; i++) {
    await insertDoc(`sqb-doc-${i}`, { po_number: `K10000${i}`, code_date: `2026-07-0${i}`, lot_number: `4200000${i}` });
  }
}, 60_000);

const q = (clauses: Clause[], text = ''): SearchQuery => ({ v: 1, text, clauses, view: { entity: 'documents' } });
const SCOPE: Clause[] = [
  { id: 'c1', field: 'supplier', op: 'in', values: [SUP], source: 'facet' },
  { id: 'c2', field: 'document_type', op: 'in', values: [DT], source: 'facet' },
  { id: 'c3', field: 'uploaded', op: 'within', values: ['365'], source: 'facet' },
];

async function measured(query: SearchQuery, opts: { interpret?: boolean; repairLimit?: number; facetFields?: FacetField[] } = {}) {
  const outside: StatementStats = { statements: 0, round_trips: 0 };
  const body = await runSearch(countingDb(db, outside), T, {
    query, limit: 20, offset: 0, facets: true, interpret: opts.interpret ?? false,
    ...(opts.facetFields ? { facetFields: opts.facetFields } : {}),
    ...(opts.repairLimit !== undefined ? { repairLimit: opts.repairLimit } : {}),
  });
  // The response reports what it cost, and the outside count agrees.
  expect(body.stats.statements).toBe(outside.statements);
  expect(body.stats.round_trips).toBe(outside.round_trips);
  return { body, outside };
}

describe('statement budget', () => {
  it('the first identifying search brings the keys up to date (two extra round trips), then answers', async () => {
    const { body, outside } = await measured(q([{ id: 'c1', field: 'po', op: 'is', values: ['K100003'], source: 'builder' }]));
    expect(body.covering_count).toBe(1);
    expect(outside.round_trips).toBeLessThanOrEqual(6);
    expect(body.keys_pending ?? 0).toBe(0);
  });

  it('a scope-only search is ONE round trip: the page, every facet and the labels in one batch', async () => {
    const { body, outside } = await measured(q(SCOPE));
    expect(outside.round_trips).toBe(1);
    expect(outside.statements).toBe(FACET_FIELDS.length + 2);
    expect(body.total).toBe(6);
  });

  it('asking for five facets (Easy mode) prepares five facet statements', async () => {
    const { body, outside } = await measured(q(SCOPE), { facetFields: ['supplier', 'document_type', 'product', 'status', 'uploaded'] });
    expect(outside.round_trips).toBe(1);
    expect(outside.statements).toBe(7);
    expect(Object.keys(body.facets ?? {}).sort()).toEqual(['document_type', 'product', 'status', 'supplier', 'uploaded']);
  });

  it('a Lots / Products / Suppliers mode adds ONE statement to the same round trip', async () => {
    const { body, outside } = await measured({ ...q(SCOPE), view: { entity: 'suppliers' } });
    expect(outside.round_trips).toBe(1);
    expect(outside.statements).toBe(FACET_FIELDS.length + 3);
    expect(body.groups?.rows.map((r) => r.document_count)).toEqual([6]);
  });

  it('a text + scope search is still one round trip', async () => {
    const { outside } = await measured(q(SCOPE, 'budget'));
    expect(outside.round_trips).toBe(1);
  });

  it('an identifying search with current keys takes at most four round trips and a bounded statement count', async () => {
    const { body, outside } = await measured(q([...SCOPE, { id: 'c4', field: 'code_date', op: 'on', values: ['2026-07-03'], source: 'builder' }]));
    expect(body.coverage).toBe('covered');
    expect(outside.round_trips).toBeLessThanOrEqual(4);
    expect(outside.statements).toBeLessThanOrEqual(12);
    expect(body.stats.scan_fallback).toBe(false);
  });

  it('words that may NAME a product cost one round trip for the catalog, no more', async () => {
    const { outside } = await measured(q(SCOPE, 'budget'), { interpret: true });
    expect(outside.round_trips).toBeLessThanOrEqual(2);
  });

  it('interpreting typed text costs no extra round trip', async () => {
    const { body, outside } = await measured(q([], 'K100004'), { interpret: true });
    expect(body.interpreted?.clauses[0]).toMatchObject({ field: 'po' });
    expect(body.covering_count).toBe(1);
    expect(outside.round_trips).toBeLessThanOrEqual(4);
  });
});

describe('search keys stay fresh', () => {
  it('a metadata edit is seen by the next search without any backfill', async () => {
    await db.prepare(`UPDATE documents SET primary_metadata = ? WHERE id = 'sqb-doc-1'`)
      .bind(JSON.stringify({ po_number: 'K777777' })).run();
    const { body } = await measured(q([{ id: 'c1', field: 'po', op: 'is', values: ['K777777'], source: 'builder' }]));
    expect(body.covering_count).toBe(1);
    const old = await measured(q([{ id: 'c1', field: 'po', op: 'is', values: ['K100001'], source: 'builder' }]));
    expect(old.body.covering_count).toBe(0);
  });

  it('more pending than one search drains: it says so, and judges the scoped set so the answer is still right', async () => {
    for (let i = 2; i <= 4; i++) {
      await db.prepare(`UPDATE documents SET primary_metadata = ? WHERE id = ?`).bind(JSON.stringify({ po_number: `K88880${i}` }), `sqb-doc-${i}`).run();
    }
    const { body } = await measured(q([{ id: 'c1', field: 'po', op: 'is', values: ['K888804'], source: 'builder' }]), { repairLimit: 1 });
    expect(body.keys_pending).toBeGreaterThan(0);
    expect(body.stats.scan_fallback).toBe(true);
    expect(body.covering_count).toBe(1);
  });
});
