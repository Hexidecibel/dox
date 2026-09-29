/**
 * POST /api/search/query — every clause composes (AJ's I1).
 *
 * AJ on the Supplier Documents screen: supplier A -> butter -> COA ->
 * September narrowed on the supplier alone. The client sent only the FIRST
 * supplier and type, never the product or status, and the server ignored the
 * date it did send. Here the same four filters run in all 24 orders and must
 * give exactly the September butter COAs from supplier A every time; clearing
 * any one keeps the other three; and every facet count equals a brute-force
 * recount with that facet's own selection left out (sticky exclusion).
 *
 * The product is linked two ways on purpose — document_products on some
 * documents, only through a linked lot row's product on others (a split COA) —
 * because the old product facet saw only the first.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { onRequestPost as queryHandler } from '../../functions/api/search/query';
import type { Clause, SearchQuery } from '../../shared/searchQuery';
import { dayOffset } from '../../functions/lib/search/compileScope';

const db = env.DB;
const T = 'sqc-tenant';
const USER = { id: 'sqc-user', role: 'org_admin', tenant_id: T };

const SA = 'sqc-sup-a';
const SB = 'sqc-sup-b';
const PB = 'sqc-prod-butter';
const PC = 'sqc-prod-cream';
const TC = 'sqc-type-coa';
const TS = 'sqc-type-spec';

interface Fixture {
  id: string;
  supplier: string;
  product: string | null;
  productVia: 'document' | 'lot';
  type: string;
  day: string;
  status: 'active' | 'archived';
}

const DOCS: Fixture[] = [];
let n = 0;
for (const supplier of [SA, SB]) {
  for (const product of [PB, PC, null]) {
    for (const type of [TC, TS]) {
      for (const day of ['2026-08-14', '2026-09-10']) {
        n++;
        DOCS.push({ id: `sqc-doc-${n}`, supplier, product, productVia: n % 2 === 0 ? 'lot' : 'document', type, day, status: 'active' });
      }
    }
  }
}
// Archived: in every other respect the answer, and never in it by default.
DOCS.push({ id: 'sqc-doc-archived', supplier: SA, product: PB, productVia: 'document', type: TC, day: '2026-09-12', status: 'archived' });
// A second September butter COA from A, linked only through its lot row.
DOCS.push({ id: 'sqc-doc-split', supplier: SA, product: PB, productVia: 'lot', type: TC, day: '2026-09-21', status: 'active' });

beforeAll(async () => {
  await db.prepare(`INSERT OR IGNORE INTO tenants (id, name, slug, active) VALUES (?, 'Compose Co', 'compose-co', 1)`).bind(T).run();
  await db.prepare(
    `INSERT OR IGNORE INTO users (id, email, name, role, tenant_id, password_hash, active, force_password_change)
     VALUES (?, 'sqc@test.com', 'Sqc', 'org_admin', ?, 'x', 1, 0)`,
  ).bind(USER.id, T).run();
  for (const [id, name] of [[SA, 'Alpha Dairy'], [SB, 'Beta Creamery']]) {
    await db.prepare(`INSERT INTO suppliers (id, tenant_id, name, slug, active) VALUES (?, ?, ?, ?, 1)`).bind(id, T, name, id).run();
  }
  for (const [id, name] of [[PB, 'Butter'], [PC, 'Cream']]) {
    await db.prepare(`INSERT INTO products (id, tenant_id, name, slug, active) VALUES (?, ?, ?, ?, 1)`).bind(id, T, name, id).run();
  }
  for (const [id, name, slug] of [[TC, 'COA', 'coa'], [TS, 'Spec Sheet', 'spec-sheet']]) {
    await db.prepare(`INSERT INTO document_types (id, tenant_id, name, slug, active) VALUES (?, ?, ?, ?, 1)`).bind(id, T, name, slug).run();
  }
  for (const d of DOCS) {
    await db.prepare(
      `INSERT INTO documents (id, tenant_id, title, tags, current_version, status, created_by, supplier_id, document_type_id, primary_metadata, created_at, updated_at)
       VALUES (?, ?, ?, '[]', 1, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      d.id, T, `Certificate ${d.id}`, d.status, USER.id, d.supplier, d.type,
      JSON.stringify({ production_date: d.day }), `${d.day}T12:00:00Z`, `${d.day}T12:00:00Z`,
    ).run();
    if (d.product && d.productVia === 'document') {
      await db.prepare(`INSERT INTO document_products (id, document_id, product_id) VALUES (?, ?, ?)`).bind(`${d.id}-dp`, d.id, d.product).run();
    }
    if (d.product && d.productVia === 'lot') {
      await db.prepare(
        `INSERT INTO lots (id, tenant_id, supplier_id, product_id, lot_number, sub_lot_code, lot_key) VALUES (?, ?, ?, ?, ?, '', ?)`,
      ).bind(`${d.id}-lot`, T, d.supplier, d.product, `LOT${d.id}`, `LOT${d.id}`.toUpperCase().replace(/[^A-Z0-9]/g, '')).run();
      await db.prepare(`INSERT INTO document_lots (id, document_id, lot_id) VALUES (?, ?, ?)`).bind(`${d.id}-dl`, d.id, `${d.id}-lot`).run();
    }
  }
}, 60_000);

function ctx(body: unknown): any {
  return {
    request: new Request('http://localhost/api/search/query', { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }),
    env, data: { user: USER }, params: {},
    waitUntil: () => {}, passThroughOnException: () => {}, next: async () => new Response(null), functionPath: '/api/search/query',
  };
}

async function run(clauses: Clause[], extra: Record<string, unknown> = {}) {
  const query: SearchQuery = { v: 1, text: '', clauses, view: { entity: 'documents' } };
  const res = await queryHandler(ctx({ query, limit: 200, ...extra }));
  expect(res.status).toBe(200);
  return (await res.json()) as any;
}

const SUPPLIER: Clause = { id: 'x', field: 'supplier', op: 'in', values: [SA], source: 'facet' };
const PRODUCT: Clause = { id: 'x', field: 'product', op: 'in', values: [PB], source: 'facet' };
const TYPE: Clause = { id: 'x', field: 'document_type', op: 'in', values: [TC], source: 'facet' };
const SEPTEMBER: Clause = { id: 'x', field: 'uploaded', op: 'between', values: ['2026-09-01', '2026-09-30'], source: 'facet' };

function permutations<X>(xs: X[]): X[][] {
  if (xs.length <= 1) return [xs];
  return xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p]));
}

type Pred = (d: Fixture) => boolean;
const PREDS = new Map<Clause, Pred>([
  [SUPPLIER, (d) => d.supplier === SA],
  [PRODUCT, (d) => d.product === PB],
  [TYPE, (d) => d.type === TC],
  [SEPTEMBER, (d) => d.day >= '2026-09-01' && d.day <= '2026-09-30'],
]);

function expected(clauses: Clause[], statuses: string[] = ['active']): string[] {
  return DOCS.filter((d) => statuses.includes(d.status) && clauses.every((c) => PREDS.get(c)!(d))).map((d) => d.id).sort();
}

const ids = (body: any) => body.documents.map((d: any) => d.id).sort();

describe('I1 — supplier A → butter → COA → September, in every order', () => {
  const ALL = [SUPPLIER, PRODUCT, TYPE, SEPTEMBER];

  it('the answer is the September butter COAs from A, including the one linked only by its lot row', () => {
    expect(expected(ALL).length).toBe(2);
    expect(expected(ALL)).toContain('sqc-doc-split');
    expect(expected(ALL)).not.toContain('sqc-doc-archived');
  });

  it('gives the same documents in all 24 orderings', async () => {
    const want = expected(ALL);
    expect(want.length).toBeGreaterThan(0);
    const orders = permutations(ALL);
    expect(orders).toHaveLength(24);
    for (const order of orders) {
      const body = await run(order.map((c, i) => ({ ...c, id: `c${i + 1}` })));
      expect(ids(body)).toEqual(want);
      expect(body.total).toBe(want.length);
      expect(body.coverage).toBe('unconstrained');
    }
  });

  it('clearing any one clause keeps the other three', async () => {
    for (const drop of ALL) {
      const rest = ALL.filter((c) => c !== drop);
      const body = await run(rest.map((c, i) => ({ ...c, id: `c${i + 1}` })));
      expect(ids(body)).toEqual(expected(rest));
    }
  });

  it('every facet count equals a brute-force recount without that facet’s own selection', async () => {
    const body = await run(ALL.map((c, i) => ({ ...c, id: `c${i + 1}` })));
    const others = (drop: Clause) => ALL.filter((c) => c !== drop);
    const tally = (docs: Fixture[], key: (d: Fixture) => string | null) => {
      const m = new Map<string, number>();
      for (const d of docs) {
        const k = key(d);
        if (k) m.set(k, (m.get(k) ?? 0) + 1);
      }
      return m;
    };
    const facetMap = (list: Array<{ value: string; count: number }>) => new Map(list.filter((f) => f.count > 0).map((f) => [f.value, f.count]));
    const active = (cs: Clause[]) => DOCS.filter((d) => d.status === 'active' && cs.every((c) => PREDS.get(c)!(d)));

    expect(facetMap(body.facets.supplier)).toEqual(tally(active(others(SUPPLIER)), (d) => d.supplier));
    expect(facetMap(body.facets.document_type)).toEqual(tally(active(others(TYPE)), (d) => d.type));
    expect(facetMap(body.facets.product)).toEqual(tally(active(others(PRODUCT)), (d) => d.product));
    expect(facetMap(body.facets.status)).toEqual(tally(DOCS.filter((d) => ALL.every((c) => PREDS.get(c)!(d))), (d) => d.status));
    // Uploaded buckets are cumulative windows back from today.
    const today = new Date().toISOString().slice(0, 10);
    const within = (days: number) => active(others(SEPTEMBER)).filter((d) => `${d.day}T12:00:00Z` >= dayOffset(today, -days)).length;
    const up = new Map((body.facets.uploaded as Array<{ value: string; count: number }>).map((f) => [f.value, f.count]));
    for (const days of [1, 7, 30, 90, 365]) expect(up.get(`within:${days}`) ?? 0).toBe(within(days));
  });

  it('status: archived joins only when asked for, and the status facet is no longer empty', async () => {
    const both = await run([
      { ...SUPPLIER, id: 'c1' }, { ...PRODUCT, id: 'c2' }, { ...TYPE, id: 'c3' }, { ...SEPTEMBER, id: 'c4' },
      { id: 'c5', field: 'status', op: 'in', values: ['active', 'archived'], source: 'facet' },
    ]);
    expect(ids(both)).toEqual(expected([SUPPLIER, PRODUCT, TYPE, SEPTEMBER], ['active', 'archived']));
    expect(ids(both)).toContain('sqc-doc-archived');
    expect(both.facets.status.length).toBeGreaterThan(0);
  });

  it('multi-select ORs inside a field and ANDs across fields; exclude keeps everything else', async () => {
    const two = await run([{ id: 'c1', field: 'supplier', op: 'in', values: [SA, SB], source: 'facet' }, { ...TYPE, id: 'c2' }]);
    expect(ids(two)).toEqual(DOCS.filter((d) => d.status === 'active' && d.type === TC).map((d) => d.id).sort());
    const notA = await run([{ id: 'c1', field: 'supplier', op: 'in', values: [SA], exclude: true, source: 'builder' }]);
    expect(ids(notA)).toEqual(DOCS.filter((d) => d.status === 'active' && d.supplier !== SA).map((d) => d.id).sort());
  });

  it('with an identifying date instead of the upload month, every order gives the same COVERING set', async () => {
    const PROD_SEPT: Clause = { id: 'x', field: 'production_date', op: 'between', values: ['2026-09-01', '2026-09-30'], source: 'builder' };
    const want = expected([SUPPLIER, PRODUCT, TYPE, SEPTEMBER]);
    for (const order of permutations([SUPPLIER, PRODUCT, TYPE, PROD_SEPT])) {
      const body = await run(order.map((c, i) => ({ ...c, id: `c${i + 1}` })));
      expect(body.coverage).toBe('covered');
      const covering = body.documents.filter((d: any) => d.match_status === 'covering').map((d: any) => d.id).sort();
      expect(covering).toEqual(want);
      // A scope narrows the statement, and the summary says what to.
      expect(body.coverage_summary).toMatch(/Searched within: .*Alpha Dairy/);
      // Nearby documents stay inside the scope too.
      for (const d of body.documents) expect(DOCS.find((x) => x.id === d.id)!.supplier).toBe(SA);
    }
  });

  it('refuses what cannot mean one thing, in words', async () => {
    const query: SearchQuery = { v: 1, text: '', clauses: [{ id: 'c1', field: 'lot', op: 'is', values: ['10426203'], exclude: true, source: 'builder' }], view: { entity: 'documents' } };
    const res = await queryHandler(ctx({ query }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toMatch(/cannot be excluded/);
  });
});
