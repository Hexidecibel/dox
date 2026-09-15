/**
 * Coverage-aware search, end to end — GET /api/search and
 * POST /api/documents/search/natural against a seeded corpus shaped like the
 * real case (AJ Conner, Any-Field COA Retrieval, §2 and §8).
 *
 *   Darigold multi-lot COA, split one document per sublot the way approval
 *   splits it, every sibling carrying the WHOLE bundle's text as its
 *   extracted_text and the row-scoped text (0106) as its search_text; each lot
 *   row carries its own production date:
 *     10426203-02 / -03 / -04  production 2026-07-22
 *     10426204-13              production 2026-07-23
 *   Legacy Darigold            production date only in code_date (2026-05-30),
 *                              printed under "Production Date"; lot row source
 *                              'extracted_code_date_legacy'
 *   Ambiguous row              10426199-02, "04-05-2026" (status ambiguous)
 *   Two-lot certificate        ONE document, lots 10426300-01 (Aug 1) and -02 (Aug 2)
 *   West Point butter          code date 2026-07-31 (no production date)
 *   Review Queue (pending)     Darigold lot 10426212, production 2026-07-31
 *   Country Morning            Whole Milk 300 Gallon Tote, production 2026-09-02
 *                              Heavy Cream 40% 300 Gallon Tote, production 2026-05-26
 *                              Chocolate Milk 5 Gallon Bag
 *
 * A11 is the one that matters: production date 7/31/2026 must come back as
 * "no covering document on file", with the West Point code-date certificate
 * only as a labelled non-match and the queued certificate only as unreviewed.
 */

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { onRequestGet as universalSearch } from '../../functions/api/search/index';
import { onRequestPost as naturalSearch } from '../../functions/api/documents/search/natural';
import { indexedLotDocumentIds } from '../../functions/lib/search-coverage';
import { makeDateConstraint } from '../../shared/searchCoverage';
import { rowScopedSearchText } from '../../shared/rowScopedText';

const db = env.DB;
const T = 'cov-tenant';
const USER = { id: 'cov-user', role: 'org_admin', tenant_id: T };

const SUP_DG = 'cov-sup-darigold';
const SUP_WP = 'cov-sup-westpoint';
const SUP_CMF = 'cov-sup-cmf';
const DT_COA = 'cov-dt-coa';

const DOC = {
  dg02: 'cov-doc-dg-02',
  dg03: 'cov-doc-dg-03',
  dg04: 'cov-doc-dg-04',
  dg13: 'cov-doc-dg-13',
  westPoint: 'cov-doc-westpoint',
  wholeMilkTote: 'cov-doc-cmf-whole-tote',
  heavyCreamTote: 'cov-doc-cmf-cream-tote',
  bag: 'cov-doc-cmf-bag',
  legacy: 'cov-doc-dg-legacy',
  ambiguous: 'cov-doc-dg-ambiguous',
  twoLot: 'cov-doc-dg-two-lot',
};
const QUEUE_ID = 'cov-queue-10426212';

const BUNDLE_TEXT =
  'DARIGOLD CERTIFICATE OF ANALYSIS SWEET CREAM BUTTER Btr NS Gr AA 25kg PO K135797 EDI187653 '
  + 'Lot 10426204 Sub Lot 13 Production Date 23-Jul-2026 Lot 10426203 Sub Lot 04 Production Date 22-Jul-2026 '
  + 'Lot 10426203 Sub Lot 03 Production Date 22-Jul-2026 Lot 10426203 Sub Lot 02 Production Date 22-Jul-2026';

async function insertDoc(opts: {
  id: string;
  title: string;
  supplierId: string;
  metadata: Record<string, unknown>;
  text: string;
  searchText?: string | null;
}) {
  await db.prepare(
    `INSERT INTO documents (id, tenant_id, title, tags, current_version, status, created_by, supplier_id, document_type_id, primary_metadata, created_at, updated_at)
     VALUES (?, ?, ?, '[]', 1, 'active', ?, ?, ?, ?, '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z')`,
  ).bind(opts.id, T, opts.title, USER.id, opts.supplierId, DT_COA, JSON.stringify(opts.metadata)).run();
  await db.prepare(
    `INSERT INTO document_versions (id, document_id, version_number, file_name, file_size, mime_type, r2_key, checksum, extracted_text, search_text, uploaded_by)
     VALUES (?, ?, 1, ?, 1024, 'application/pdf', ?, 'x', ?, ?, ?)`,
  ).bind(`${opts.id}-v1`, opts.id, `${opts.id}.pdf`, `r2/${opts.id}.pdf`, opts.text, opts.searchText ?? null, USER.id).run();
}

async function linkLot(
  docId: string,
  lotNumber: string,
  sub: string,
  production?: { iso: string | null; raw: string; source: string; status: string },
) {
  const lotId = `${docId}-lot-${lotNumber}${sub}`;
  await db.prepare(
    `INSERT INTO lots (id, tenant_id, supplier_id, lot_number, sub_lot_code, lot_key,
                       production_date, production_date_raw, production_date_source, production_date_status, production_date_document_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    lotId, T, SUP_DG, lotNumber, sub, `${lotNumber}${sub}`,
    production?.iso ?? null, production?.raw ?? null, production?.source ?? null, production?.status ?? null,
    production ? docId : null,
  ).run();
  await db.prepare(`INSERT INTO document_lots (id, document_id, lot_id) VALUES (?, ?, ?)`)
    .bind(`${lotId}-dl`, docId, lotId).run();
}

beforeAll(async () => {
  await db.prepare(`INSERT OR IGNORE INTO tenants (id, name, slug, active) VALUES (?, 'Coverage Co', 'coverage-co', 1)`).bind(T).run();
  await db.prepare(
    `INSERT OR IGNORE INTO users (id, email, name, role, tenant_id, password_hash, active, force_password_change)
     VALUES (?, 'cov@test.com', 'Cov', 'org_admin', ?, 'x', 1, 0)`,
  ).bind(USER.id, T).run();
  for (const [id, name] of [[SUP_DG, 'Darigold, Inc.'], [SUP_WP, 'West Point Dairy Products'], [SUP_CMF, 'Country Morning Farms']]) {
    await db.prepare(`INSERT INTO suppliers (id, tenant_id, name, slug, active) VALUES (?, ?, ?, ?, 1)`).bind(id, T, name, id).run();
  }
  await db.prepare(`INSERT INTO document_types (id, tenant_id, name, slug, active) VALUES (?, ?, 'COA', 'coa', 1)`).bind(DT_COA, T).run();

  const darigold = [
    [DOC.dg02, '10426203', '02', '2026-07-22'],
    [DOC.dg03, '10426203', '03', '2026-07-22'],
    [DOC.dg04, '10426203', '04', '2026-07-22'],
    [DOC.dg13, '10426204', '13', '2026-07-23'],
  ] as const;
  const rowFields = darigold.map(([, lot, sub, prod]) => ({ lot_number: lot, sub_lot_code: sub, production_date: prod }));
  for (const [i, [id, lot, sub, prod]] of darigold.entries()) {
    await insertDoc({
      id,
      title: 'SWEET CREAM BUTTER - Btr NS Gr AA 25kg',
      supplierId: SUP_DG,
      metadata: {
        supplier_name: 'Darigold, Inc.', lot_number: lot, sub_lot_code: sub, production_date: prod,
        po_number: 'K135797', order_number: 'EDI187653', product_code: '810004',
        quantity: sub === '13' ? '100 EA' : '50 EA', net_weight: sub === '13' ? '5511.5 LB' : '2755.75 LB',
      },
      text: BUNDLE_TEXT,
      // Exactly what approval writes (produceCoaRecords): the bundle with the
      // other rows' lots and dates blanked.
      searchText: rowScopedSearchText(BUNDLE_TEXT, rowFields[i], rowFields.filter((_, j) => j !== i))?.text ?? null,
    });
    await linkLot(id, lot, sub, { iso: prod, raw: prod, source: 'extracted', status: 'resolved' });
  }

  await insertDoc({
    id: DOC.legacy,
    title: 'Darigold Butter (older extraction)',
    supplierId: SUP_DG,
    metadata: { supplier_name: 'Darigold, Inc.', lot_number: '10426150', sub_lot_code: '01', code_date: '2026-05-30' },
    text: 'DARIGOLD CERTIFICATE OF ANALYSIS Lot Number 10426150 Sub Lot Number 01 Production Date 30-May-2026',
  });
  await linkLot(DOC.legacy, '10426150', '01', { iso: '2026-05-30', raw: '2026-05-30', source: 'extracted_code_date_legacy', status: 'resolved' });

  await insertDoc({
    id: DOC.ambiguous,
    title: 'Darigold Butter (ambiguous date)',
    supplierId: SUP_DG,
    metadata: { supplier_name: 'Darigold, Inc.', lot_number: '10426199', sub_lot_code: '02', production_date: '04-05-2026' },
    text: 'DARIGOLD Lot 10426199 Sub Lot 02 Production Date 04-05-2026',
  });
  await linkLot(DOC.ambiguous, '10426199', '02', { iso: null, raw: '04-05-2026', source: 'extracted', status: 'ambiguous' });

  await insertDoc({
    id: DOC.twoLot,
    title: 'Darigold two-lot certificate (not split)',
    supplierId: SUP_DG,
    metadata: { supplier_name: 'Darigold, Inc.', lot_number: '10426300' },
    text: 'DARIGOLD Lot 10426300 Sub Lot 01 Production Date 01-Aug-2026 Lot 10426300 Sub Lot 02 Production Date 02-Aug-2026',
  });
  await linkLot(DOC.twoLot, '10426300', '01', { iso: '2026-08-01', raw: '01-Aug-2026', source: 'extracted', status: 'resolved' });
  await linkLot(DOC.twoLot, '10426300', '02', { iso: '2026-08-02', raw: '02-Aug-2026', source: 'extracted', status: 'resolved' });

  await insertDoc({
    id: DOC.westPoint,
    title: 'West Point Butter Solids',
    supplierId: SUP_WP,
    metadata: { supplier_name: 'West Point Dairy Products', lot_number: 'WP-A7', code_date: '2026-07-31', expiration_date: '2026-07-31' },
    text: 'West Point Dairy butter certificate code date 07/31/2026',
  });
  await insertDoc({
    id: DOC.wholeMilkTote,
    title: 'Whole Milk 300 Gallon Tote',
    supplierId: SUP_CMF,
    metadata: { production_date: '2026-09-02', product_name: 'Whole Milk 300 Gallon Tote' },
    text: 'Country Morning Farms Whole Milk 300 Gallon Tote production 09/02/2026',
  });
  await insertDoc({
    id: DOC.heavyCreamTote,
    title: 'Heavy Cream 40% 300 Gallon Tote',
    supplierId: SUP_CMF,
    metadata: { production_date: '2026-05-26', product_name: 'Heavy Cream 40% 300 Gallon Tote' },
    text: 'Country Morning Farms Heavy Cream 40% 300 Gallon Tote production 05/26/2026',
  });
  await insertDoc({
    id: DOC.bag,
    title: 'Chocolate Milk 5 Gallon Bag',
    supplierId: SUP_CMF,
    metadata: { production_date: '2026-06-10' },
    text: 'Country Morning Farms Chocolate Milk 5 Gallon Bag',
  });

  await db.prepare(
    `INSERT INTO processing_queue (id, tenant_id, document_type_id, file_r2_key, file_name, file_size, mime_type, extracted_text, ai_fields, ai_records, supplier, status, processing_status)
     VALUES (?, ?, ?, 'staging/q.pdf', 'Darigold COA -EDI190001.pdf', 2048, 'application/pdf', ?, ?, ?, 'Darigold, Inc.', 'pending', 'ready')`,
  ).bind(
    QUEUE_ID, T, DT_COA,
    'DARIGOLD CERTIFICATE Lot 10426212 Sub Lot 01 Production Date 31-Jul-2026 SWEET CREAM BUTTER',
    JSON.stringify({ lot_number: '10426212', sub_lot_code: '01', production_date: '2026-07-31' }),
    JSON.stringify({ records: [{ fields: { lot_code: '10426212', sub_lot_code: '01', production_date: '2026-07-31' } }] }),
  ).run();
}, 60_000);

function ctxGet(qs: string): any {
  return {
    request: new Request(`http://localhost/api/search?${qs}`),
    env, data: { user: USER }, params: {},
    waitUntil: () => {}, passThroughOnException: () => {}, next: async () => new Response(null), functionPath: '/api/search',
  };
}

async function search(q: string) {
  const res = await universalSearch(ctxGet(`q=${encodeURIComponent(q)}&limit=50`));
  expect(res.status).toBe(200);
  return (await res.json()) as any;
}

const idsWith = (body: any, status: string) =>
  body.documents.results.filter((r: any) => r.match_status === status).map((r: any) => r.id).sort();

describe('GET /api/search — coverage (instant search)', () => {
  it('A1: 1042620303 covers the -03 sibling only', async () => {
    const body = await search('1042620303');
    expect(body.coverage).toBe('covered');
    expect(body.constraints.map((c: any) => c.kind)).toEqual(['lot']);
    expect(idsWith(body, 'covering')).toEqual([DOC.dg03]);
    // Siblings share the bundle text but not the lot: labelled, not covering.
    const dg04 = body.documents.results.find((r: any) => r.id === DOC.dg04);
    expect(dg04.match_status).toBe('candidate_not_matching');
    expect(dg04.match_reason).toMatch(/10426203-04/);
  });

  it('A2: 10426203-03 is the same answer', async () => {
    const body = await search('10426203-03');
    expect(body.coverage).toBe('covered');
    expect(idsWith(body, 'covering')).toEqual([DOC.dg03]);
  });

  it('prefix 1042620 covers nothing; the lots it starts are partial-lot candidates', async () => {
    const body = await search('1042620');
    expect(body.coverage).toBe('none');
    expect(idsWith(body, 'covering')).toEqual([]);
    const candidates = body.documents.results.filter((r: any) => r.match_status === 'candidate_not_matching');
    expect(candidates.map((r: any) => r.id).sort()).toEqual([DOC.dg02, DOC.dg03, DOC.dg04, DOC.dg13].sort());
    for (const c of candidates) {
      expect(c.match_checks[0].outcome).toBe('partial_lot');
      expect(c.match_reason).toMatch(/Partial lot match/);
    }
  });

  it('A4: production date 22-Jul-2026 covers exactly the three 22-Jul rows; 23-Jul is a labelled candidate', async () => {
    const body = await search('production date 22-Jul-2026');
    expect(body.coverage).toBe('covered');
    expect(body.constraints[0]).toMatchObject({ kind: 'date', role: 'production', date_from: '2026-07-22' });
    expect(idsWith(body, 'covering')).toEqual([DOC.dg02, DOC.dg03, DOC.dg04].sort());
    const dg13 = body.documents.results.find((r: any) => r.id === DOC.dg13);
    expect(dg13.match_status).toBe('candidate_not_matching');
    expect(dg13.match_reason).toContain('Jul 23, 2026');
    expect(dg13.match_checks[0]).toMatchObject({ field: 'production_date', provenance: 'extracted' });
  });

  it('A11: production date 7/31/2026 — no covering document on file', async () => {
    const body = await search('production date 7/31/2026');
    expect(body.coverage).toBe('none');
    expect(body.covering_count).toBe(0);
    expect(body.coverage_summary).toBe('No document on file covers production date Jul 31, 2026.');
    expect(idsWith(body, 'covering')).toEqual([]);

    const wp = body.documents.results.find((r: any) => r.id === DOC.westPoint);
    expect(wp).toBeTruthy();
    expect(wp.match_status).toBe('candidate_not_matching');
    expect(wp.match_checks[0].outcome).toBe('role_mismatch');
    expect(wp.match_reason).toMatch(/code date is not a production date/);

    // The 22/23-Jul fixture is nearby, and never a match.
    for (const id of [DOC.dg02, DOC.dg03, DOC.dg04, DOC.dg13]) {
      const r = body.documents.results.find((x: any) => x.id === id);
      expect(r?.match_status ?? 'absent').not.toBe('covering');
    }

    const queued = body.unreviewed_candidates.find((u: any) => u.queue_id === QUEUE_ID);
    expect(queued).toMatchObject({
      match_status: 'unreviewed_candidate',
      matches_all_constraints: true,
      review_url: `/review?item=${QUEUE_ID}`,
    });
  });

  it('a supplier named next to a date is a constraint: West Point is not Darigold', async () => {
    const body = await search('Darigold production date 22-Jul-2026');
    expect(body.constraints.map((c: any) => c.kind).sort()).toEqual(['date', 'supplier']);
    expect(idsWith(body, 'covering')).toEqual([DOC.dg02, DOC.dg03, DOC.dg04].sort());
  });

  it('"COA for lot 10426203-03" asks for the lot, not for the word COA', async () => {
    const body = await search('COA for lot 10426203-03');
    expect(body.constraints.map((c: any) => c.kind)).toEqual(['lot']);
    expect(idsWith(body, 'covering')).toEqual([DOC.dg03]);
  });

  it('a bare date matches any document date and says which field it hit', async () => {
    const body = await search('2026-07-31');
    expect(body.constraints[0].role).toBe('any');
    const wp = body.documents.results.find((r: any) => r.id === DOC.westPoint);
    expect(wp.match_status).toBe('covering');
    expect(['code_date', 'expiration_date']).toContain(wp.match_checks[0].field);
  });

  it('"300 gal tote produced 9/2": coverage reflects only what was stated — no invented product constraint', async () => {
    const body = await search('300 gal tote produced 9/2');
    expect(body.constraints.map((c: any) => c.kind).sort()).toEqual(['date', 'text']);
    expect(body.constraints.find((c: any) => c.kind === 'date').month_day).toEqual({ month: 9, day: 2 });
    expect(idsWith(body, 'covering')).toEqual([DOC.wholeMilkTote]);
    const cream = body.documents.results.find((r: any) => r.id === DOC.heavyCreamTote);
    expect(cream.match_status).toBe('candidate_not_matching');
  });

  it('naming the product makes the whole-milk tote a non-matching candidate', async () => {
    const body = await search('heavy cream 300 gal tote produced 9/2');
    expect(body.coverage).toBe('none');
    const whole = body.documents.results.find((r: any) => r.id === DOC.wholeMilkTote);
    expect(whole.match_status).toBe('candidate_not_matching');
    expect(whole.match_reason).toMatch(/doesn't mention/);
  });

  it('"5 gallon bags" finds "5 Gallon Bag"', async () => {
    const body = await search('5 gallon bags');
    expect(body.coverage).toBe('unconstrained');
    expect(body.documents.results.map((r: any) => r.id)).toContain(DOC.bag);
  });

  it('an ordinary search stays unconstrained and a PO is not mistaken for a lot', async () => {
    const body = await search('K135797');
    expect(body.coverage).toBe('unconstrained');
    expect(body.documents.results.map((r: any) => r.id)).toEqual(expect.arrayContaining([DOC.dg03]));
  });

  it('a pending queue file is visible to an ordinary search as unreviewed', async () => {
    const body = await search('EDI190001');
    expect(body.unreviewed_candidates.map((u: any) => u.queue_id)).toContain(QUEUE_ID);
  });
});

// ---------------------------------------------------------------------------
// Phase 2 — lot rows (migration 0106)
// ---------------------------------------------------------------------------

async function searchLot(lot: string, sublot?: string, q = '') {
  const qs = new URLSearchParams({ q, lot, limit: '50' });
  if (sublot !== undefined) qs.set('sublot', sublot);
  const res = await universalSearch(ctxGet(qs.toString()));
  expect(res.status).toBe(200);
  return (await res.json()) as any;
}

describe('GET /api/search — lot rows (Phase 2)', () => {
  it('A1: the covering result names the lot row it matched, with its production date and pack', async () => {
    const body = await search('1042620303');
    const dg03 = body.documents.results.find((r: any) => r.id === DOC.dg03);
    expect(dg03.matched_lot).toMatchObject({
      lot_number: '10426203', sub_lot_code: '03', production_date: '2026-07-22',
      production_date_source: 'extracted', production_date_status: 'resolved',
      quantity: '50 EA', net_weight: '2755.75 LB',
    });
  });

  it('A2 in its spaced shape: "10426203 03" covers the -03 row only', async () => {
    const body = await search('10426203 03');
    expect(body.constraints).toHaveLength(1);
    expect(body.constraints[0]).toMatchObject({ kind: 'lot', lot_parts: { base: '10426203', sub: '03' } });
    expect(idsWith(body, 'covering')).toEqual([DOC.dg03]);
  });

  it('A3: base 10426203 + sublot 03 as two separate inputs covers the -03 row, part against part', async () => {
    const body = await searchLot('10426203', '03');
    expect(body.coverage).toBe('covered');
    expect(body.constraints[0]).toMatchObject({ kind: 'lot', source: 'structured', lot_parts: { base: '10426203', sub: '03' }, label: 'lot 10426203 · sublot 03' });
    expect(idsWith(body, 'covering')).toEqual([DOC.dg03]);
    expect(body.documents.results[0].matched_lot).toMatchObject({ sub_lot_code: '03', production_date: '2026-07-22' });
    const dg04 = body.documents.results.find((r: any) => r.id === DOC.dg04);
    expect(dg04.match_status).toBe('candidate_not_matching');
    expect(dg04.match_checks[0].outcome).toBe('near');
  });

  it('A3: a base with no sublot input covers every sublot of that base', async () => {
    const body = await searchLot('10426203');
    expect(idsWith(body, 'covering')).toEqual([DOC.dg02, DOC.dg03, DOC.dg04].sort());
  });

  it('a sublot without a lot is refused', async () => {
    const res = await universalSearch(ctxGet('q=&sublot=03'));
    expect(res.status).toBe(400);
  });

  it('A4: production date 22-Jul-2026 — exactly the three 22-Jul rows cover, read from the lot rows; 23-Jul is nearby with the reason', async () => {
    const body = await search('production date 22-Jul-2026');
    expect(idsWith(body, 'covering')).toEqual([DOC.dg02, DOC.dg03, DOC.dg04].sort());
    for (const r of body.documents.results.filter((x: any) => x.match_status === 'covering')) {
      expect(r.matched_lot.production_date).toBe('2026-07-22');
      expect(r.match_checks[0].message).toMatch(/on this lot row is Jul 22, 2026/);
    }
    const dg13 = body.documents.results.find((r: any) => r.id === DOC.dg13);
    expect(dg13.match_status).toBe('candidate_not_matching');
    expect(dg13.match_checks[0]).toMatchObject({ outcome: 'near', distance_days: 1 });
    expect(dg13.matched_lot).toMatchObject({ sub_lot_code: '13', production_date: '2026-07-23' });
  });

  it('the production-date lookup is an index read over lot rows (covering and nearby rows)', async () => {
    const ids = await indexedLotDocumentIds(db, T, [
      makeDateConstraint('c1', 'production', { kind: 'day', iso: '2026-07-22', raw: '2026-07-22', note: null }, 'query_text'),
    ]);
    expect([...ids]).toEqual(expect.arrayContaining([DOC.dg02, DOC.dg03, DOC.dg04, DOC.dg13, DOC.twoLot]));
    expect(ids.has(DOC.legacy)).toBe(false);
  });

  it("sibling text no longer covers: lot 10426204 with \"22-Jul\" does not cover the 23-Jul row", async () => {
    const body = await search('lot 10426204 22-Jul');
    expect(body.constraints.map((c: any) => c.kind).sort()).toEqual(['lot', 'text']);
    expect(idsWith(body, 'covering')).toEqual([]);
    const dg13 = body.documents.results.find((r: any) => r.id === DOC.dg13);
    expect(dg13.match_status).toBe('candidate_not_matching');
    expect(dg13.match_reason).toMatch(/doesn't mention "22-Jul"/);
  });

  it('a sibling that only shares the page is no longer listed as "mentioning" another row\'s lot', async () => {
    const body = await search('10426204');
    expect(idsWith(body, 'covering')).toEqual([DOC.dg13]);
    const listed = body.documents.results.map((r: any) => r.id);
    for (const id of [DOC.dg02, DOC.dg03, DOC.dg04]) expect(listed).not.toContain(id);
  });

  it('a legacy production date (read from the code date field) is "likely", never covering — and says where it came from', async () => {
    const body = await search('production date 5/30/2026');
    expect(body.coverage).toBe('likely');
    expect(body.covering_count).toBe(0);
    expect(body.likely_count).toBe(1);
    expect(body.coverage_summary).toMatch(/No document on file is confirmed to cover production date May 30, 2026\. 1 likely does/);
    const legacy = body.documents.results.find((r: any) => r.id === DOC.legacy);
    expect(legacy.match_status).toBe('likely_covering');
    expect(legacy.match_checks[0]).toMatchObject({ outcome: 'likely', provenance: 'extracted_code_date_legacy' });
    expect(legacy.match_checks[0].message).toMatch(/code date field \(older extraction\)/);
    expect(legacy.matched_lot.production_date_source).toBe('extracted_code_date_legacy');
  });

  it('an ambiguous row date is never a match, either way it could be read', async () => {
    for (const q of ['production date 4/5/2026', 'production date 5/4/2026']) {
      const body = await search(q);
      expect(idsWith(body, 'covering')).not.toContain(DOC.ambiguous);
      const row = body.documents.results.find((r: any) => r.id === DOC.ambiguous);
      expect(row.match_checks[0].outcome).toBe('ambiguous');
    }
  });

  it('row by row: one row\'s lot and another row\'s date never combine into a covering answer', async () => {
    const mixed = await search('lot 10426300 01 production date 8/2/2026');
    expect(idsWith(mixed, 'covering')).toEqual([]);
    const same = await search('lot 10426300 02 production date 8/2/2026');
    expect(idsWith(same, 'covering')).toEqual([DOC.twoLot]);
    const row = same.documents.results.find((r: any) => r.id === DOC.twoLot);
    // Not a split document, so the row's pack is not borrowed from the document.
    expect(row.matched_lot).toMatchObject({ sub_lot_code: '02', production_date: '2026-08-02', quantity: null });
  });

  it('A11 still holds with lot rows: production date 7/31/2026 has no covering document', async () => {
    const body = await search('production date 7/31/2026');
    expect(body.coverage).toBe('none');
    expect(idsWith(body, 'covering')).toEqual([]);
    expect(idsWith(body, 'likely_covering')).toEqual([]);
    const wp = body.documents.results.find((r: any) => r.id === DOC.westPoint);
    expect(wp.match_checks[0].outcome).toBe('role_mismatch');
  });
});

// ---------------------------------------------------------------------------
// Natural language
// ---------------------------------------------------------------------------

function mockLlm(parsed: Record<string, unknown>) {
  const original = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: any, init: any) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
    if (url.includes('/v1/chat/completions')) {
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(parsed) } }] }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }
    return original.call(globalThis, input, init);
  });
}

const EMPTY_PARSE = {
  keywords: [], document_type_slug: null, product_names: [], supplier_name: null, date_from: null, date_to: null,
  metadata_filters: [], expiration_filter: null, content_search: null, intent_summary: 'test',
};

async function natural(query: string) {
  const res = await naturalSearch({
    request: new Request('http://localhost/api/documents/search/natural', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query }),
    }),
    env, data: { user: USER }, params: {},
    waitUntil: () => {}, passThroughOnException: () => {}, next: async () => new Response(null), functionPath: '/api/documents/search/natural',
  } as any);
  expect(res.status).toBe(200);
  return (await res.json()) as any;
}

describe('POST /api/documents/search/natural — coverage', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('A10: "Darigold bulk unsalted butter produced 7/22/26" never covers a non-22-Jul row', async () => {
    mockLlm({
      ...EMPTY_PARSE,
      keywords: ['bulk', 'unsalted', 'butter'],
      supplier_name: 'Darigold',
      metadata_filters: [{ field: 'production_date', operator: 'equals', value: '2026-07-22' }],
    });
    const body = await natural('Darigold bulk unsalted butter produced 7/22/26');
    expect(body.dropped_constraints).toEqual([]);
    expect(body.constraints).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'date', role: 'production', date_from: '2026-07-22', date_to: '2026-07-22' }),
      expect.objectContaining({ kind: 'supplier', value: 'Darigold' }),
    ]));
    expect(body.coverage).toBe('covered');
    const covering = body.results.filter((r: any) => r.match_status === 'covering').map((r: any) => r.id).sort();
    expect(covering).toEqual([DOC.dg02, DOC.dg03, DOC.dg04].sort());
    expect(covering).not.toContain(DOC.dg13);
  });

  it('a constraint that cannot be applied is listed, and coverage is not "covered"', async () => {
    mockLlm({
      ...EMPTY_PARSE,
      document_type_slug: 'no-such-type',
      metadata_filters: [{ field: 'production_date', operator: 'equals', value: '2026-07-22' }],
    });
    const body = await natural('the no-such-type for production date 7/22/2026');
    expect(body.dropped_constraints).toHaveLength(1);
    expect(body.dropped_constraints[0].kind).toBe('document_type');
    expect(body.coverage).toBe('none');
    expect(body.results.some((r: any) => r.match_status === 'covering')).toBe(false);
    // Not silently loosened into nothing either: the 22-Jul rows are listed, labelled.
    expect(body.results.map((r: any) => r.id)).toEqual(expect.arrayContaining([DOC.dg03]));
  });

  it('a production date the model put on upload time is checked against the document, not created_at', async () => {
    mockLlm({ ...EMPTY_PARSE, keywords: ['butter'], date_from: '2026-07-31', date_to: '2026-07-31' });
    const body = await natural('butter produced 7/31/2026');
    const dates = body.constraints.filter((c: any) => c.kind === 'date');
    expect(dates).toHaveLength(1);
    expect(dates[0].role).toBe('production');
    expect(body.coverage).toBe('none');
    expect(body.coverage_summary).toMatch(/No document on file covers/);
    expect(body.unreviewed_candidates.map((u: any) => u.queue_id)).toContain(QUEUE_ID);
  });
});
