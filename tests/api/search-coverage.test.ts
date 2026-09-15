/**
 * Coverage-aware search, end to end — GET /api/search and
 * POST /api/documents/search/natural against a seeded corpus shaped like the
 * real case (AJ Conner, Any-Field COA Retrieval, §2 and §8).
 *
 *   Darigold multi-lot COA, split one document per sublot the way approval
 *   splits it, every sibling carrying the WHOLE bundle's text:
 *     10426203-02 / -03 / -04  production 2026-07-22
 *     10426204-13              production 2026-07-23
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
}) {
  await db.prepare(
    `INSERT INTO documents (id, tenant_id, title, tags, current_version, status, created_by, supplier_id, document_type_id, primary_metadata, created_at, updated_at)
     VALUES (?, ?, ?, '[]', 1, 'active', ?, ?, ?, ?, '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z')`,
  ).bind(opts.id, T, opts.title, USER.id, opts.supplierId, DT_COA, JSON.stringify(opts.metadata)).run();
  await db.prepare(
    `INSERT INTO document_versions (id, document_id, version_number, file_name, file_size, mime_type, r2_key, checksum, extracted_text, uploaded_by)
     VALUES (?, ?, 1, ?, 1024, 'application/pdf', ?, 'x', ?, ?)`,
  ).bind(`${opts.id}-v1`, opts.id, `${opts.id}.pdf`, `r2/${opts.id}.pdf`, opts.text, USER.id).run();
}

async function linkLot(docId: string, lotNumber: string, sub: string) {
  const lotId = `${docId}-lot`;
  await db.prepare(
    `INSERT INTO lots (id, tenant_id, supplier_id, lot_number, sub_lot_code, lot_key) VALUES (?, ?, ?, ?, ?, ?)`,
  ).bind(lotId, T, SUP_DG, lotNumber, sub, `${lotNumber}${sub}`).run();
  await db.prepare(`INSERT INTO document_lots (id, document_id, lot_id) VALUES (?, ?, ?)`)
    .bind(`${docId}-dl`, docId, lotId).run();
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
  for (const [id, lot, sub, prod] of darigold) {
    await insertDoc({
      id,
      title: 'SWEET CREAM BUTTER - Btr NS Gr AA 25kg',
      supplierId: SUP_DG,
      metadata: {
        supplier_name: 'Darigold, Inc.', lot_number: lot, sub_lot_code: sub, production_date: prod,
        po_number: 'K135797', order_number: 'EDI187653', product_code: '810004',
      },
      text: BUNDLE_TEXT,
    });
    await linkLot(id, lot, sub);
  }

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
