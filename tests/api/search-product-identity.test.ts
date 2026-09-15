/**
 * Any-Field COA Retrieval, Phase 3 — a person names a product the way THEY
 * know it, and search resolves it (migration 0107), end to end through
 * GET /api/search and POST /api/documents/search/natural.
 *
 * Fixture, shaped on the real records (prod, 2026-09-15):
 *
 *   Our products and what they go by
 *     DG BTR BULK U/S 55.115#   our SKU 2235 · Darigold item 810004 · Darigold name
 *                               "SWEET CREAM BUTTER - Btr NS Gr AA 25kg" · FORMER
 *                               Darigold item 310348, UNCONFIRMED (AJ has not said
 *                               what 310348 is)
 *     40% CREAM 300GL           our SKU 10286 · CMF item 30904 · "Cream - Heavy Whipping 40%" · pack 300 Gallon Tote
 *     MS WHOLE 300GL            our SKU 10284 · CMF item 30906 · "Milk - Whole" · pack 300 Gallon Tote
 *     WHIP 5 GL BAG (1/CS), M   our SKU 0801  · CMF item 50903 · "Cream - Heavy Whipping 40%" · pack 5 Gallon Bag
 *     MS WHOLE 5 GL BAG         our SKU 0417  · CMF item 50900 · "Milk - Whole" · pack 5 Gallon Bag
 *
 *   Certificates
 *     Darigold 810004, split per lot row: 10426203-02/-03/-04 produced Jul 22, 10426204-13 Jul 23
 *     Darigold SALTED 810001 ("Btr Gr AA 25kg"), lot 10426299-09, produced Jul 22
 *     CMF cream tote (30904, customer item 10286), produced May 26 — the latest real one
 *     CMF whole milk tote (30906, customer item 10284), produced Sep 2
 *     CMF whip 5 gal bag (50903) and whole milk 5 gal bag (50900), produced Aug 28
 *
 *   WMS order 1797062 (A7)
 *     line 2235 lot 1042620304  — a person ACCEPTED the -04 certificate
 *     line 2235 lot 1042620413  — no link at all; the -13 row IS that lot
 *     line 2235 lot 1042620399  — a PENDING suggestion to the -02 certificate
 *     line 2235 lot 1042620388  — linked automatically before suggest-only, to the SALTED certificate
 *                                 (the wrong product: flagged, not offered)
 */

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { onRequestGet as universalSearch } from '../../functions/api/search/index';
import { onRequestPost as naturalSearch } from '../../functions/api/documents/search/natural';
import { onRequestGet as listIdentifiers, onRequestPost as addIdentifier } from '../../functions/api/products/[id]/identifiers';
import { onRequestPut as putIdentifier, onRequestDelete as deleteIdentifier } from '../../functions/api/product-identifiers/[id]';
import { normalizeIdentifierValue } from '../../functions/lib/product-identifiers';

const db = env.DB;
const T = 'pid-tenant';
const USER = { id: 'pid-user', role: 'org_admin', tenant_id: T };

const SUP_DG = 'pid-sup-dg';
const SUP_CMF = 'pid-sup-cmf';
const DT_COA = 'pid-dt-coa';

const P = {
  bulk: 'pid-p-2235',
  creamTote: 'pid-p-10286',
  wholeTote: 'pid-p-10284',
  whipBag: 'pid-p-0801',
  wholeBag: 'pid-p-0417',
  dgSupplierProduct: 'pid-p-dg-supplier',
};

const DOC = {
  dg02: 'pid-doc-dg-02',
  dg03: 'pid-doc-dg-03',
  dg04: 'pid-doc-dg-04',
  dg13: 'pid-doc-dg-13',
  dgSalted: 'pid-doc-dg-salted',
  creamTote: 'pid-doc-cmf-cream-tote',
  wholeTote: 'pid-doc-cmf-whole-tote',
  whipBag: 'pid-doc-cmf-whip-bag',
  wholeBag: 'pid-doc-cmf-whole-bag',
};

async function product(id: string, name: string, supplierId: string | null = null) {
  await db.prepare(`INSERT INTO products (id, tenant_id, name, slug, active, supplier_id) VALUES (?, ?, ?, ?, 1, ?)`)
    .bind(id, T, name, id, supplierId).run();
}

let identSeq = 0;
async function ident(productId: string, kind: string, value: string, opts: { supplier?: string; confirmed?: boolean; superseded?: boolean; note?: string } = {}) {
  await db.prepare(
    `INSERT INTO product_identifiers (id, tenant_id, product_id, kind, value, value_norm, supplier_id, superseded, confirmed, source, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'seed', ?)`,
  ).bind(
    `pid-ident-${++identSeq}`, T, productId, kind, value, normalizeIdentifierValue(kind as never, value),
    opts.supplier ?? null, opts.superseded ? 1 : 0, opts.confirmed === false ? 0 : 1, opts.note ?? null,
  ).run();
}

async function doc(id: string, supplierId: string, metadata: Record<string, unknown>, text: string) {
  await db.prepare(
    `INSERT INTO documents (id, tenant_id, title, tags, current_version, status, created_by, supplier_id, document_type_id, primary_metadata, created_at, updated_at)
     VALUES (?, ?, ?, '[]', 1, 'active', ?, ?, ?, ?, '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z')`,
  ).bind(id, T, String(metadata.product_name ?? id), USER.id, supplierId, DT_COA, JSON.stringify(metadata)).run();
  await db.prepare(
    `INSERT INTO document_versions (id, document_id, version_number, file_name, file_size, mime_type, r2_key, checksum, extracted_text, uploaded_by)
     VALUES (?, ?, 1, ?, 1024, 'application/pdf', ?, 'x', ?, ?)`,
  ).bind(`${id}-v1`, id, `${id}.pdf`, `r2/${id}.pdf`, text, USER.id).run();
}

async function lotRow(docId: string, lot: string, sub: string, prod: string, productId: string | null) {
  const lotId = `${docId}-lot`;
  await db.prepare(
    `INSERT INTO lots (id, tenant_id, supplier_id, product_id, lot_number, sub_lot_code, lot_key,
                       production_date, production_date_raw, production_date_source, production_date_status, production_date_document_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'extracted', 'resolved', ?)`,
  ).bind(lotId, T, SUP_DG, productId, lot, sub, `${lot}${sub}`, prod, prod, docId).run();
  await db.prepare(`INSERT INTO document_lots (id, document_id, lot_id) VALUES (?, ?, ?)`).bind(`${lotId}-dl`, docId, lotId).run();
}

beforeAll(async () => {
  await db.prepare(`INSERT OR IGNORE INTO tenants (id, name, slug, active) VALUES (?, 'Identity Co', 'identity-co', 1)`).bind(T).run();
  await db.prepare(
    `INSERT OR IGNORE INTO users (id, email, name, role, tenant_id, password_hash, active, force_password_change)
     VALUES (?, 'pid@test.com', 'Pid', 'org_admin', ?, 'x', 1, 0)`,
  ).bind(USER.id, T).run();
  await db.prepare(`INSERT INTO suppliers (id, tenant_id, name, slug, active) VALUES (?, ?, 'Darigold, Inc.', 'pid-dg', 1)`).bind(SUP_DG, T).run();
  await db.prepare(`INSERT INTO suppliers (id, tenant_id, name, slug, active) VALUES (?, ?, 'Country Morning Farms', 'pid-cmf', 1)`).bind(SUP_CMF, T).run();
  await db.prepare(`INSERT INTO document_types (id, tenant_id, name, slug, active) VALUES (?, ?, 'COA', 'coa', 1)`).bind(DT_COA, T).run();

  await product(P.bulk, 'DG BTR BULK U/S 55.115#');
  await ident(P.bulk, 'our_sku', '2235');
  await ident(P.bulk, 'supplier_item', '810004', { supplier: SUP_DG });
  await ident(P.bulk, 'supplier_name', 'SWEET CREAM BUTTER - Btr NS Gr AA 25kg', { supplier: SUP_DG });
  await ident(P.bulk, 'supplier_item', '310348', { supplier: SUP_DG, superseded: true, confirmed: false, note: 'In a Darigold COA filename; AJ has not confirmed what it is.' });

  await product(P.creamTote, '40% CREAM 300GL');
  await ident(P.creamTote, 'our_sku', '10286');
  await ident(P.creamTote, 'supplier_item', '30904', { supplier: SUP_CMF });
  await ident(P.creamTote, 'supplier_name', 'Cream - Heavy Whipping 40%', { supplier: SUP_CMF });
  await ident(P.creamTote, 'pack', '300 Gallon Tote');

  await product(P.wholeTote, 'MS WHOLE 300GL');
  await ident(P.wholeTote, 'our_sku', '10284');
  await ident(P.wholeTote, 'supplier_item', '30906', { supplier: SUP_CMF });
  await ident(P.wholeTote, 'supplier_name', 'Milk - Whole', { supplier: SUP_CMF });
  await ident(P.wholeTote, 'pack', '300 Gallon Tote');

  await product(P.whipBag, 'WHIP 5 GL BAG  (1/CS), M');
  await ident(P.whipBag, 'our_sku', '0801');
  await ident(P.whipBag, 'supplier_item', '50903', { supplier: SUP_CMF });
  await ident(P.whipBag, 'supplier_name', 'Cream - Heavy Whipping 40%', { supplier: SUP_CMF });

  await product(P.wholeBag, 'MS WHOLE 5 GL BAG');
  await ident(P.wholeBag, 'our_sku', '0417');
  await ident(P.wholeBag, 'supplier_item', '50900', { supplier: SUP_CMF });
  await ident(P.wholeBag, 'supplier_name', 'Milk - Whole', { supplier: SUP_CMF });

  await product(P.dgSupplierProduct, 'SWEET CREAM BUTTER - Btr NS Gr AA 25kg', SUP_DG);

  const dgRows = [[DOC.dg02, '02', '2026-07-22'], [DOC.dg03, '03', '2026-07-22'], [DOC.dg04, '04', '2026-07-22'], [DOC.dg13, '13', '2026-07-23']] as const;
  for (const [id, sub, prod] of dgRows) {
    const lot = sub === '13' ? '10426204' : '10426203';
    await doc(id, SUP_DG, {
      supplier_name: 'Darigold, Inc.', product_name: 'SWEET CREAM BUTTER - Btr NS Gr AA 25kg', product_code: '810004',
      lot_number: lot, sub_lot_code: sub, production_date: prod, net_weight: sub === '13' ? '5511.5 LB' : '2755.75 LB',
    }, `DARIGOLD CERTIFICATE OF ANALYSIS SWEET CREAM BUTTER Btr NS Gr AA 25kg Item Number 810004 Lot ${lot} Sub Lot ${sub}`);
    await lotRow(id, lot, sub, prod, P.dgSupplierProduct);
  }
  await doc(DOC.dgSalted, SUP_DG, {
    supplier_name: 'Darigold, Inc.', product_name: 'SWEET CREAM BUTTER - Btr Gr AA 25kg', product_code: '810001',
    lot_number: '10426299', sub_lot_code: '09', production_date: '2026-07-22',
  }, 'DARIGOLD CERTIFICATE OF ANALYSIS SWEET CREAM BUTTER Btr Gr AA 25kg Item Number 810001');
  await lotRow(DOC.dgSalted, '10426299', '09', '2026-07-22', null);

  await doc(DOC.creamTote, SUP_CMF, {
    supplier_name: 'Country Morning Farms', product_name: 'Cream - Heavy Whipping 40%', product_code: '30904',
    customer_item_number: '10286', net_weight: '300 Gallon Tote', production_date: '2026-05-26', lot_number: '052626HCR',
  }, 'COUNTRY MORNING FARMS PRODUCT NAME: Cream - Heavy Whipping 40% CMF ITEM #: 30904 CUSTOMER ITEM #: 10286 PACKAGE SIZE: 300 Gallon Tote');
  await doc(DOC.wholeTote, SUP_CMF, {
    supplier_name: 'Country Morning Farms', product_name: 'Milk - Whole', product_code: '30906',
    customer_item_number: '10284', net_weight: '300 Gallon Tote', production_date: '2026-09-02', lot_number: '092326WHO',
  }, 'COUNTRY MORNING FARMS PRODUCT NAME: Milk - Whole CMF ITEM #: 30906 CUSTOMER ITEM #: 10284 PACKAGE SIZE: 300 Gallon Tote');
  await doc(DOC.whipBag, SUP_CMF, {
    supplier_name: 'Country Morning Farms', product_name: 'Cream - Heavy Whipping 40%', product_code: '50903',
    net_weight: '5 Gallon Bag', production_date: '2026-08-28', lot_number: '092226HCR',
  }, 'COUNTRY MORNING FARMS PRODUCT NAME: Cream - Heavy Whipping 40% CMF ITEM #: 50903 PACKAGE SIZE: 5 Gallon Bag');
  await doc(DOC.wholeBag, SUP_CMF, {
    supplier_name: 'Country Morning Farms', product_name: 'Milk - Whole', product_code: '50900',
    net_weight: '5 Gallon Bag', production_date: '2026-08-28', lot_number: '092226WHO',
  }, 'COUNTRY MORNING FARMS PRODUCT NAME: Milk - Whole CMF ITEM #: 50900 PACKAGE SIZE: 5 Gallon Bag');

  // WMS order 1797062.
  await db.prepare(`INSERT INTO orders (id, tenant_id, order_number, customer_name, status) VALUES ('pid-order', ?, '1797062', 'King and Prince Seafood', 'pending')`).bind(T).run();
  const items = [
    ['pid-oi-accepted', '1042620304', null],
    ['pid-oi-exact', '1042620413', null],
    ['pid-oi-suggested', '1042620399', null],
    ['pid-oi-legacy', '1042620388', DOC.dgSalted],
  ] as const;
  for (const [id, lot, legacyDoc] of items) {
    await db.prepare(
      `INSERT INTO order_items (id, order_id, product_name, product_code, lot_number, coa_document_id, coa_match_status)
       VALUES (?, 'pid-order', 'DG BTR BULK U/S 55.115#', '2235', ?, ?, ?)`,
    ).bind(id, lot, legacyDoc, legacyDoc ? 'matched' : 'unmatched').run();
  }
  await db.prepare(
    `INSERT INTO lot_match_suggestions (id, tenant_id, order_item_id, document_id, match_confidence, match_basis, status)
     VALUES ('pid-lms-accepted', ?, 'pid-oi-accepted', ?, 0.9, 'lot_and_product', 'accepted')`,
  ).bind(T, DOC.dg04).run();
  await db.prepare(
    `INSERT INTO lot_match_suggestions (id, tenant_id, order_item_id, document_id, match_confidence, match_basis, status)
     VALUES ('pid-lms-pending', ?, 'pid-oi-suggested', ?, 0.5, 'lot_only', 'pending')`,
  ).bind(T, DOC.dg02).run();
}, 60_000);

function ctx(url: string, init: RequestInit = {}, params: Record<string, string> = {}): any {
  return {
    request: new Request(url, init), env, data: { user: USER }, params,
    waitUntil: () => {}, passThroughOnException: () => {}, next: async () => new Response(null), functionPath: '',
  };
}

async function search(q: string) {
  const res = await universalSearch(ctx(`http://localhost/api/search?q=${encodeURIComponent(q)}&limit=50`));
  expect(res.status).toBe(200);
  return (await res.json()) as any;
}

const withStatus = (body: any, status: string) =>
  body.documents.results.filter((r: any) => r.match_status === status).map((r: any) => r.id).sort();
const result = (body: any, id: string) => body.documents.results.find((r: any) => r.id === id);
const productConstraint = (body: any) => body.constraints.find((c: any) => c.kind === 'product');

describe('GET /api/search — a product named by a number', () => {
  it('A8: supplier item 810004 covers the Darigold 810004 certificates, says what it resolved to, and shows the pack conversion', async () => {
    const body = await search('810004');
    expect(body.constraints.map((c: any) => c.kind)).toEqual(['product']);
    const pc = productConstraint(body);
    expect(pc.product_resolution.ambiguous).toBe(false);
    expect(pc.product_resolution.candidates.map((c: any) => c.product_id)).toEqual([P.bulk]);
    expect(pc.product_resolution.message).toBe('"810004" → DG BTR BULK U/S 55.115# (Darigold, Inc. item 810004, our SKU 2235) via Darigold, Inc. item 810004.');
    expect(body.coverage).toBe('covered');
    expect(withStatus(body, 'covering')).toEqual([DOC.dg02, DOC.dg03, DOC.dg04, DOC.dg13].sort());
    const dg03 = result(body, DOC.dg03);
    // 25 kg on the certificate, 55.115# in our name: equal only by conversion, and said so.
    expect(dg03.match_checks[0].message).toContain('25 kg = 55.116 lb, matched to 55.115 lb by unit conversion');
    // The salted certificate is Darigold butter too — and not this product.
    const salted = result(body, DOC.dgSalted);
    expect(salted?.match_status ?? 'absent').not.toBe('covering');
  });

  it('A9: our product 2235 + production date 23-Jul-2026 resolves 2235 → 810004 and covers only the Jul 23 row', async () => {
    const body = await search('2235 production date 2026-07-23');
    expect(body.constraints.map((c: any) => c.kind).sort()).toEqual(['date', 'product']);
    const k = productConstraint(body).product_resolution.candidates[0];
    expect(k.our_skus).toEqual(['2235']);
    expect(k.supplier_items.map((i: any) => i.value)).toContain('810004');
    expect(k.matched_via).toEqual([expect.objectContaining({ kind: 'our_sku', value: '2235', confirmed: true })]);
    expect(body.coverage).toBe('covered');
    expect(withStatus(body, 'covering')).toEqual([DOC.dg13]);
    expect(result(body, DOC.dg13).matched_lot).toMatchObject({ sub_lot_code: '13', production_date: '2026-07-23' });
    for (const id of [DOC.dg02, DOC.dg03, DOC.dg04]) expect(result(body, id).match_status).toBe('candidate_not_matching');
  });

  it('"10286 produced 9/2/2026": no covering document; the real 10286 certificate is nearby-labelled and the whole-milk tote is not the product', async () => {
    const body = await search('10286 produced 9/2/2026');
    expect(body.coverage).toBe('none');
    expect(body.covering_count).toBe(0);
    expect(body.coverage_summary).toMatch(/^No document on file covers production date Sep 2, 2026, product 40% CREAM 300GL \(Country Morning Farms item 30904, our SKU 10286\)\.$/);
    const cream = result(body, DOC.creamTote);
    expect(cream.match_status).toBe('candidate_not_matching');
    expect(cream.match_reason).toContain('May 26, 2026');
    const whole = result(body, DOC.wholeTote);
    expect(whole.match_status).toBe('candidate_not_matching');
    expect(whole.match_reason).toMatch(/item 30906, not item 30904/);
  });

  it('an unconfirmed former item number (310348) finds the product, and everything it finds is "likely — confirm", labelled', async () => {
    const body = await search('310348');
    const res = productConstraint(body).product_resolution;
    expect(res.candidates[0].confirmed).toBe(false);
    expect(res.message).toMatch(/via unconfirmed former Darigold, Inc\. item 310348/);
    expect(body.coverage).toBe('likely');
    expect(withStatus(body, 'covering')).toEqual([]);
    expect(withStatus(body, 'likely_covering')).toEqual([DOC.dg02, DOC.dg03, DOC.dg04, DOC.dg13].sort());
    expect(result(body, DOC.dg13).match_checks[0].message).toMatch(/Reached via unconfirmed former Darigold, Inc\. item 310348 — confirm/);
  });
});

describe('GET /api/search — a product named by its pack, and ambiguity', () => {
  it('S2: "300 gal tote produced 9/2/2026" could be whole milk or cream — nothing is picked, coverage is per product', async () => {
    const body = await search('300 gal tote produced 9/2/2026');
    expect(body.coverage).toBe('ambiguous');
    const res = productConstraint(body).product_resolution;
    expect(res.ambiguous).toBe(true);
    expect(res.candidates.map((c: any) => c.product_id).sort()).toEqual([P.creamTote, P.wholeTote].sort());
    expect(res.message).toMatch(/^"300 gal tote" could mean 2 products/);
    const byId = Object.fromEntries(res.candidates.map((c: any) => [c.product_id, c]));
    expect(byId[P.wholeTote].covering_count).toBe(1);
    expect(byId[P.creamTote].covering_count).toBe(0);
    expect(body.coverage_summary).toMatch(/could mean 2 products, so nothing is picked/);
    expect(body.coverage_summary).toMatch(/As 40% CREAM 300GL \(Country Morning Farms item 30904, our SKU 10286\): no document on file covers production date Sep 2, 2026/);
    const whole = result(body, DOC.wholeTote);
    expect(whole.match_status).toBe('covering');
    expect(whole.match_checks.find((c: any) => c.field !== 'production_date').message).toMatch(/^As MS WHOLE 300GL/);
    // The cream tote is the other reading, labelled — never promoted by the ambiguity.
    expect(result(body, DOC.creamTote).match_status).toBe('candidate_not_matching');
  });

  it('naming the product removes the ambiguity: "heavy cream 300 gal tote produced 9/2/2026" is the cream tote alone, and nothing covers it', async () => {
    const body = await search('heavy cream 300 gal tote produced 9/2/2026');
    const res = productConstraint(body).product_resolution;
    expect(res.candidates.map((c: any) => c.product_id)).toEqual([P.creamTote]);
    expect(body.coverage).toBe('none');
    expect(result(body, DOC.wholeTote).match_status).toBe('candidate_not_matching');
  });

  it('"5 gallon bags": the ambiguity is shown, whip and whole milk each covered as themselves', async () => {
    const body = await search('5 gallon bags');
    expect(body.coverage).toBe('ambiguous');
    const res = productConstraint(body).product_resolution;
    expect(res.candidates.map((c: any) => c.product_id).sort()).toEqual([P.wholeBag, P.whipBag].sort());
    expect(withStatus(body, 'covering')).toEqual([DOC.whipBag, DOC.wholeBag].sort());
    const whip = result(body, DOC.whipBag);
    expect(whip.match_checks[0]).toMatchObject({ candidate_product_id: P.whipBag });
    // The 300-gallon totes are the same products in the wrong pack.
    expect(withStatus(body, 'covering')).not.toContain(DOC.creamTote);
  });

  it('a pack typed in the other unit converts, and says so: "unsalted butter 25 kg production date 2026-07-23"', async () => {
    const body = await search('unsalted butter 25 kg production date 2026-07-23');
    const k = productConstraint(body).product_resolution.candidates[0];
    expect(k.product_id).toBe(P.bulk);
    expect(k.conversion_note).toBe('25 kg = 55.116 lb, matched to 55.115 lb by unit conversion');
    expect(k.matched_via).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'attribute', value: expect.stringContaining('unsalted = U/S') })]));
    expect(withStatus(body, 'covering')).toEqual([DOC.dg13]);
  });

  it('a plain word stays a browse: "butter" is not turned into a coverage question', async () => {
    const body = await search('butter');
    expect(body.coverage).toBe('unconstrained');
  });
});

describe('GET /api/search — A7: a WMS order number follows its lines to the certificates', () => {
  it('covers only through a person\'s accepted match or an exact lot row; suggestions and old auto-links are "confirm"', async () => {
    const body = await search('1797062');
    expect(body.constraints.map((c: any) => c.kind)).toEqual(['order']);
    expect(body.constraints[0].label).toBe('order 1797062 (King and Prince Seafood)');
    expect(withStatus(body, 'covering')).toEqual([DOC.dg04, DOC.dg13].sort());
    expect(result(body, DOC.dg04).match_checks[0].message).toMatch(/A person accepted this certificate for order 1797062/);
    expect(result(body, DOC.dg13).match_checks[0].message).toMatch(/exactly the lot order 1797062 shipped/);
    expect(withStatus(body, 'likely_covering')).toEqual([DOC.dg02]);
    expect(result(body, DOC.dg02).match_checks[0].message).toMatch(/^Suggested match for order 1797062.*confirm it on the order/);
    // The old auto-link is to the SALTED certificate: line 2235 resolves to Darigold
    // 810004, and this is 810001 — the wrong product, said so, not offered.
    const salted = result(body, DOC.dgSalted);
    expect(salted.match_status).toBe('candidate_not_matching');
    expect(salted.match_checks[0].message).toMatch(/automatically before matches became suggestions, but it is the wrong product: This certificate is Darigold, Inc\. item 810001, not item 810004/);
    const dg03 = result(body, DOC.dg03);
    expect(dg03.match_status).toBe('candidate_not_matching');
    expect(dg03.match_checks[0].outcome).toBe('near');
  });
});

// ---------------------------------------------------------------------------
// Natural language
// ---------------------------------------------------------------------------

const EMPTY_PARSE = {
  keywords: [], document_type_slug: null, product_names: [], product_text: null, supplier_name: null, date_from: null, date_to: null,
  metadata_filters: [], expiration_filter: null, content_search: null, intent_summary: 'test',
};

function mockLlm(parsed: Record<string, unknown>) {
  const original = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: any, init: any) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
    if (url.includes('/v1/chat/completions')) {
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(parsed) } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return original.call(globalThis, input, init);
  });
}

async function natural(query: string) {
  const res = await naturalSearch(ctx('http://localhost/api/documents/search/natural', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query }),
  }));
  expect(res.status).toBe(200);
  return (await res.json()) as any;
}

describe('POST /api/documents/search/natural — product resolution', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('A10: "Darigold bulk unsalted butter produced 7/22/26" → product via U/S = NS = unsalted, supplier, production date: exactly the Jul 22 rows', async () => {
    mockLlm({
      ...EMPTY_PARSE,
      product_text: 'bulk unsalted butter',
      // The model's catalog guess, which the resolution replaces.
      product_names: ['SWEET CREAM BUTTER - Btr NS Gr AA 25kg', 'SWEET CREAM BUTTER - Btr Gr AA 25kg'],
      supplier_name: 'Darigold',
      metadata_filters: [{ field: 'production_date', operator: 'equals', value: '2026-07-22' }],
    });
    const body = await natural('Darigold bulk unsalted butter produced 7/22/26');
    expect(body.dropped_constraints).toEqual([]);
    expect(body.constraints.map((c: any) => c.kind).sort()).toEqual(['date', 'product', 'supplier']);
    const res = productConstraint(body).product_resolution;
    expect(res.candidates.map((c: any) => c.product_id)).toEqual([P.bulk]);
    expect(res.message).toMatch(/^"bulk unsalted butter" → DG BTR BULK U\/S 55\.115#/);
    expect(body.coverage).toBe('covered');
    const covering = body.results.filter((r: any) => r.match_status === 'covering').map((r: any) => r.id).sort();
    expect(covering).toEqual([DOC.dg02, DOC.dg03, DOC.dg04].sort());
    // Same supplier, same day, same word "butter" — salted, so not this product.
    const salted = body.results.find((r: any) => r.id === DOC.dgSalted);
    expect(salted.match_status).toBe('candidate_not_matching');
    expect(salted.match_reason).toMatch(/item 810001, not item 810004/);
  });

  it('A10 when the model drops the product words: the question\'s own words still resolve it', async () => {
    mockLlm({
      ...EMPTY_PARSE,
      keywords: ['butter'],
      supplier_name: 'Darigold',
      metadata_filters: [{ field: 'production_date', operator: 'equals', value: '2026-07-22' }],
    });
    const body = await natural('Darigold bulk unsalted butter produced 7/22/26');
    expect(productConstraint(body)?.product_resolution.candidates.map((c: any) => c.product_id)).toEqual([P.bulk]);
    expect(body.results.filter((r: any) => r.match_status === 'covering').map((r: any) => r.id).sort()).toEqual([DOC.dg02, DOC.dg03, DOC.dg04].sort());
  });

  it('an order number the model filed as order_number is the WMS order', async () => {
    mockLlm({ ...EMPTY_PARSE, metadata_filters: [{ field: 'order_number', operator: 'equals', value: '1797062' }] });
    const body = await natural('COAs for order 1797062');
    expect(body.constraints.map((c: any) => c.kind)).toEqual(['order']);
    expect(body.results.filter((r: any) => r.match_status === 'covering').map((r: any) => r.id).sort()).toEqual([DOC.dg04, DOC.dg13].sort());
  });
});

// ---------------------------------------------------------------------------
// Identifier admin API
// ---------------------------------------------------------------------------

describe('product identifier API', () => {
  const base = `http://localhost/api/products/${P.creamTote}/identifiers`;

  it('lists, adds (audited), confirms (audited) and removes (audited, with the row)', async () => {
    const list = await listIdentifiers(ctx(base, {}, { id: P.creamTote }));
    const listed = (await list.json()) as any;
    expect(listed.identifiers.map((i: any) => i.kind)).toEqual(['our_sku', 'supplier_item', 'supplier_name', 'pack']);

    const add = await addIdentifier(ctx(base, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'alias', value: 'heavy cream tote', confirmed: false }),
    }, { id: P.creamTote }));
    expect(add.status).toBe(201);
    const added = ((await add.json()) as any).identifier;
    expect(added).toMatchObject({ kind: 'alias', confirmed: 0, source: 'reviewer', value_norm: 'heavy cream tote' });

    const put = await putIdentifier(ctx(`http://localhost/api/product-identifiers/${added.id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirmed: true }),
    }, { id: added.id }));
    expect(put.status).toBe(200);
    expect(((await put.json()) as any).identifier).toMatchObject({ confirmed: 1, confirmed_by: USER.id });

    const del = await deleteIdentifier(ctx(`http://localhost/api/product-identifiers/${added.id}`, { method: 'DELETE' }, { id: added.id }));
    expect(del.status).toBe(200);
    const audit = await db.prepare(`SELECT action, details FROM audit_log WHERE tenant_id = ? AND action LIKE 'product_identifier.%' ORDER BY id`).bind(T).all<any>();
    expect(audit.results.map((r: any) => r.action)).toEqual(['product_identifier.added', 'product_identifier.confirmed', 'product_identifier.removed']);
    expect(JSON.parse(audit.results[2].details).identifier.value).toBe('heavy cream tote');
  });

  it('refuses a supplier item with no supplier, and a supplier from another workspace', async () => {
    const noSup = await addIdentifier(ctx(base, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'supplier_item', value: '30905' }),
    }, { id: P.creamTote }));
    expect(noSup.status).toBe(400);
    const otherTenant = await addIdentifier(ctx(base, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'supplier_item', value: '30905', supplier_id: 'cov-sup-cmf' }),
    }, { id: P.creamTote }));
    expect(otherTenant.status).toBe(400);
  });
});
