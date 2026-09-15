/**
 * Tests for the Phase 2 lots entity + lot-based matching engine.
 *
 * Covers:
 *   - normalizeLotNumber: punctuation/prefix variants → one key.
 *   - findOrCreateLot: identity upsert, NULL backfill, NULL-product collapse.
 *   - matching: COA→order and order→COA both auto-link on product agreement;
 *     lot-only (unknown/mismatched product) → suggestion + no auto-link;
 *     a lot collision across two different products does not cross-link.
 *   - lot-matches/:id endpoint: accept promotes to a strong link; reject sets
 *     status.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { runMigrations, seedTestData, cleanTables, generateTestId } from '../helpers/db';
import { normalizeLotNumber, findOrCreateLot } from '../../functions/lib/entities/lots';
import {
  linkCoaToOrders,
  linkOrderToCoas,
  parseDistributorCode,
  classifyMatch,
} from '../../functions/lib/entities/matching';
import { insertProductIdentifier } from '../../functions/lib/product-identifiers';
import { onRequestPost as resolveLotMatch } from '../../functions/api/lot-matches/[id]';
import { onRequestGet as listLotMatches } from '../../functions/api/lot-matches/index';
import { onRequestGet as getOrder } from '../../functions/api/orders/[id]';

const db = env.DB;
let seed: Awaited<ReturnType<typeof seedTestData>>;

// --- small fixture helpers -------------------------------------------------

async function makeSupplier(tenantId: string, name: string): Promise<string> {
  const id = generateTestId();
  await db
    .prepare('INSERT INTO suppliers (id, tenant_id, name, slug) VALUES (?, ?, ?, ?)')
    .bind(id, tenantId, name, `${name.toLowerCase().replace(/\s+/g, '-')}-${id.slice(0, 6)}`)
    .run();
  return id;
}

async function makeProduct(tenantId: string, name: string): Promise<string> {
  const id = generateTestId();
  await db
    .prepare('INSERT INTO products (id, tenant_id, name, slug, active) VALUES (?, ?, ?, ?, 1)')
    .bind(id, tenantId, name, `${name.toLowerCase().replace(/\s+/g, '-')}-${id.slice(0, 6)}`)
    .run();
  return id;
}

async function makeDocument(
  tenantId: string,
  supplierId: string | null,
  title?: string
): Promise<string> {
  const id = generateTestId();
  await db
    .prepare(
      `INSERT INTO documents (id, tenant_id, title, tags, current_version, status, created_by, supplier_id)
       VALUES (?, ?, ?, '[]', 1, 'active', ?, ?)`
    )
    .bind(id, tenantId, title ?? `Doc ${id.slice(0, 6)}`, seed.userId, supplierId)
    .run();
  return id;
}

async function makeOrderWithItem(
  tenantId: string,
  item: {
    productId?: string | null;
    lotId?: string | null;
    lotNumber?: string | null;
    productCode?: string | null;
  }
): Promise<{ orderId: string; orderItemId: string }> {
  const orderId = generateTestId();
  await db
    .prepare(
      `INSERT INTO orders (id, tenant_id, order_number, source_data) VALUES (?, ?, ?, '{}')`
    )
    .bind(orderId, tenantId, `ORD-${orderId.slice(0, 6)}`)
    .run();
  const orderItemId = generateTestId();
  await db
    .prepare(
      `INSERT INTO order_items (id, order_id, product_id, product_code, lot_id, lot_number)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .bind(
      orderItemId,
      orderId,
      item.productId ?? null,
      item.productCode ?? null,
      item.lotId ?? null,
      item.lotNumber ?? null
    )
    .run();
  return { orderId, orderItemId };
}

async function getOrderItem(id: string) {
  return db
    .prepare(
      `SELECT coa_document_id, lot_id, lot_matched, match_confidence, coa_match_status
       FROM order_items WHERE id = ?`
    )
    .bind(id)
    .first<{
      coa_document_id: string | null;
      lot_id: string | null;
      lot_matched: number;
      match_confidence: number | null;
      coa_match_status: string;
    }>();
}

/**
 * The engine never asserts a lot-to-shipment match (client rule, 14 Sep 2026):
 * however strong the evidence, the pair is a PENDING suggestion and the order
 * line stays unlinked until a person accepts it.
 */
async function expectSuggestedOnly(
  orderItemId: string,
  docId: string,
  opts: { confidence?: number; minConfidence?: number } = {}
) {
  const oi = await getOrderItem(orderItemId);
  expect(oi!.coa_document_id).toBeNull();
  expect(oi!.coa_match_status).toBe('unmatched');
  expect(oi!.lot_matched).toBeFalsy();
  const sugg = (await getSuggestions(orderItemId)).filter((x) => x.document_id === docId);
  expect(sugg).toHaveLength(1);
  expect(sugg[0].status).toBe('pending');
  if (opts.confidence !== undefined) expect(sugg[0].match_confidence).toBe(opts.confidence);
  if (opts.minConfidence !== undefined) {
    expect(sugg[0].match_confidence).toBeGreaterThanOrEqual(opts.minConfidence);
  }
  return sugg[0];
}

async function getSuggestions(orderItemId: string) {
  const res = await db
    .prepare(
      `SELECT id, document_id, match_basis, match_confidence, status, lot_id
       FROM lot_match_suggestions WHERE order_item_id = ?`
    )
    .bind(orderItemId)
    .all<{
      id: string;
      document_id: string;
      match_basis: string;
      match_confidence: number;
      status: string;
      lot_id: string | null;
    }>();
  return res.results ?? [];
}

beforeEach(async () => {
  await runMigrations(db);
  await cleanTables(db);
  seed = await seedTestData(db);
}, 30_000);

// --- normalizeLotNumber ----------------------------------------------------

describe('normalizeLotNumber', () => {
  it('collapses prefix/punctuation/case variants to one key', () => {
    const expected = '061926LC3';
    expect(normalizeLotNumber('Lot# 061926LC3')).toBe(expected);
    expect(normalizeLotNumber('  061926lc3 ')).toBe(expected);
    expect(normalizeLotNumber('LOT 061926-LC3')).toBe(expected);
    expect(normalizeLotNumber('#061926 LC3')).toBe(expected);
    expect(normalizeLotNumber('LOT: 061926.LC3')).toBe(expected);
  });

  it('returns empty for nullish / non-alphanumeric input', () => {
    expect(normalizeLotNumber(null)).toBe('');
    expect(normalizeLotNumber(undefined)).toBe('');
    expect(normalizeLotNumber('   ')).toBe('');
    expect(normalizeLotNumber('LOT #')).toBe('');
  });
});

// --- parseDistributorCode --------------------------------------------------

describe('parseDistributorCode', () => {
  it('extracts the leading parenthesized prefix', () => {
    expect(parseDistributorCode('(1167) Foo')).toBe('1167');
    expect(
      parseDistributorCode('(1167) 76187-29125 CF LIQ WHOLE EGG 2-20# LOT 6141 07-02-26')
    ).toBe('1167');
  });

  it('preserves leading zeros and alphanumerics', () => {
    expect(parseDistributorCode('(0708) x')).toBe('0708');
    expect(parseDistributorCode('  (AB-12) bar')).toBe('AB-12');
  });

  it('returns null when there is no parenthesized prefix', () => {
    expect(parseDistributorCode('no prefix')).toBeNull();
    expect(parseDistributorCode('LOT 6141 (1167) trailing')).toBeNull();
    expect(parseDistributorCode(null)).toBeNull();
    expect(parseDistributorCode(undefined)).toBeNull();
    expect(parseDistributorCode('() empty')).toBeNull();
  });
});

// --- classifyMatch (distributor code) --------------------------------------

describe('classifyMatch: distributor code', () => {
  it('codes agree (different product_ids) → strong lot+code 0.9', () => {
    const cls = classifyMatch({
      coaProductId: 'prod-A',
      orderProductId: 'prod-B',
      coaSupplierId: null,
      orderSupplierId: null,
      coaProductCode: '1167',
      orderProductCode: '1167',
    });
    expect(cls.strong).toBe(true);
    expect(cls.basis).toBe('lot+code');
    expect(cls.confidence).toBe(0.9);
  });

  it('codes agree + supplier agrees → supplier-confirmed tier', () => {
    const cls = classifyMatch({
      coaProductId: 'prod-A',
      orderProductId: 'prod-B',
      coaSupplierId: 'sup-1',
      orderSupplierId: 'sup-1',
      coaProductCode: '1167',
      orderProductCode: '1167',
    });
    expect(cls.strong).toBe(true);
    expect(cls.basis).toBe('lot+product+supplier');
    expect(cls.confidence).toBe(0.95);
  });

  it('zero-padding fallback ("0708" vs "708") → strong', () => {
    const cls = classifyMatch({
      coaProductId: 'prod-A',
      orderProductId: 'prod-B',
      coaSupplierId: null,
      orderSupplierId: null,
      coaProductCode: '0708',
      orderProductCode: '708',
    });
    expect(cls.strong).toBe(true);
    expect(cls.basis).toBe('lot+code');
  });

  it('codes differ + products differ → lot_only weak', () => {
    const cls = classifyMatch({
      coaProductId: 'prod-A',
      orderProductId: 'prod-B',
      coaSupplierId: null,
      orderSupplierId: null,
      coaProductCode: '1167',
      orderProductCode: '9999',
    });
    expect(cls.strong).toBe(false);
    expect(cls.basis).toBe('lot_only');
    expect(cls.confidence).toBe(0.5);
  });

  it('product agreement still wins when codes are absent', () => {
    const cls = classifyMatch({
      coaProductId: 'prod-A',
      orderProductId: 'prod-A',
      coaSupplierId: null,
      orderSupplierId: null,
    });
    expect(cls.strong).toBe(true);
    expect(cls.basis).toBe('lot+product');
    expect(cls.confidence).toBe(0.85);
  });
});

// --- findOrCreateLot -------------------------------------------------------

describe('findOrCreateLot', () => {
  it('upserts by (tenant, product, lot_key) — same key+product collapses', async () => {
    const productId = await makeProduct(seed.tenantId, 'Cheese');
    const a = await findOrCreateLot(db, seed.tenantId, { lotNumber: 'Lot# 12345', productId });
    const b = await findOrCreateLot(db, seed.tenantId, { lotNumber: '  12345 ', productId });
    expect(a).not.toBeNull();
    expect(b!.id).toBe(a!.id);
  });

  it('returns null when the lot number normalizes to empty', async () => {
    const r = await findOrCreateLot(db, seed.tenantId, { lotNumber: 'LOT #' });
    expect(r).toBeNull();
  });

  it('backfills NULL supplier/product/dates on a later call, never overwriting', async () => {
    const supplierId = await makeSupplier(seed.tenantId, 'Acme');
    const supplierId2 = await makeSupplier(seed.tenantId, 'Other');
    const productId = await makeProduct(seed.tenantId, 'Milk');

    // First call: NULL-product lot, no supplier/dates.
    const first = await findOrCreateLot(db, seed.tenantId, { lotNumber: 'ABC1' });
    expect(first).not.toBeNull();

    // NOTE: a NULL-product lot and a product-bound lot are distinct rows by
    // identity. Backfill only applies within the SAME identity. Re-call with
    // NULL product to exercise backfill of supplier + dates.
    const again = await findOrCreateLot(db, seed.tenantId, {
      lotNumber: 'abc1',
      supplierId,
      codeDate: '2026-01-01',
      expirationDate: '2027-01-01',
    });
    expect(again!.id).toBe(first!.id);

    let row = await db
      .prepare('SELECT supplier_id, code_date, expiration_date FROM lots WHERE id = ?')
      .bind(first!.id)
      .first<{ supplier_id: string | null; code_date: string | null; expiration_date: string | null }>();
    expect(row!.supplier_id).toBe(supplierId);
    expect(row!.code_date).toBe('2026-01-01');
    expect(row!.expiration_date).toBe('2027-01-01');

    // A later call with a DIFFERENT supplier must not overwrite the non-null one.
    await findOrCreateLot(db, seed.tenantId, { lotNumber: 'ABC1', supplierId: supplierId2 });
    row = await db
      .prepare('SELECT supplier_id FROM lots WHERE id = ?')
      .bind(first!.id)
      .first<{ supplier_id: string | null; code_date: string | null; expiration_date: string | null }>();
    expect(row!.supplier_id).toBe(supplierId);

    // Sanity: only one NULL-product row for this key.
    const count = await db
      .prepare('SELECT COUNT(*) AS n FROM lots WHERE tenant_id = ? AND lot_key = ?')
      .bind(seed.tenantId, 'ABC1')
      .first<{ n: number }>();
    expect(count!.n).toBe(1);
  });

  it('collapses two NULL-product lots with the same key to one row', async () => {
    const a = await findOrCreateLot(db, seed.tenantId, { lotNumber: 'Lot# Z9' });
    const b = await findOrCreateLot(db, seed.tenantId, { lotNumber: 'z9' });
    expect(b!.id).toBe(a!.id);
    const count = await db
      .prepare('SELECT COUNT(*) AS n FROM lots WHERE tenant_id = ? AND lot_key = ?')
      .bind(seed.tenantId, 'Z9')
      .first<{ n: number }>();
    expect(count!.n).toBe(1);
  });
});

// --- matching engine -------------------------------------------------------

describe('matching: COA → orders', () => {
  it('suggests at high confidence, and does not link, when product agrees', async () => {
    const productId = await makeProduct(seed.tenantId, 'Butter');
    const supplierId = await makeSupplier(seed.tenantId, 'Dairy Co');

    // Order line resolved to a lot with the same key + product.
    const orderLot = await findOrCreateLot(db, seed.tenantId, { lotNumber: '555', productId });
    const { orderItemId } = await makeOrderWithItem(seed.tenantId, {
      productId,
      lotId: orderLot!.id,
    });

    // COA side: same product, same lot key ("Lot# 555" normalizes to "555").
    const docId = await makeDocument(seed.tenantId, supplierId);
    const coaLot = await findOrCreateLot(db, seed.tenantId, {
      lotNumber: 'Lot# 555',
      productId,
      supplierId,
    });
    await db
      .prepare('INSERT INTO document_lots (id, document_id, lot_id) VALUES (?, ?, ?)')
      .bind(generateTestId(), docId, coaLot!.id)
      .run();

    await linkCoaToOrders(db, seed.tenantId, {
      documentId: docId,
      lotId: coaLot!.id,
      productId,
      supplierId,
    });

    await expectSuggestedOnly(orderItemId, docId, { minConfidence: 0.85 });
  });

  it('suggests a match for an order line that has a raw lot_number but no lot_id yet', async () => {
    const productId = await makeProduct(seed.tenantId, 'Cream');
    const { orderItemId } = await makeOrderWithItem(seed.tenantId, {
      productId,
      lotNumber: 'lot 777',
    });

    const docId = await makeDocument(seed.tenantId, null);
    const coaLot = await findOrCreateLot(db, seed.tenantId, { lotNumber: '777', productId });
    await db
      .prepare('INSERT INTO document_lots (id, document_id, lot_id) VALUES (?, ?, ?)')
      .bind(generateTestId(), docId, coaLot!.id)
      .run();

    await linkCoaToOrders(db, seed.tenantId, {
      documentId: docId,
      lotId: coaLot!.id,
      productId,
      supplierId: null,
    });

    await expectSuggestedOnly(orderItemId, docId);
  });

  it('suggests (weak) when only the lot matches and product is unknown — no auto-link', async () => {
    const orderProduct = await makeProduct(seed.tenantId, 'Yogurt');
    const orderLot = await findOrCreateLot(db, seed.tenantId, { lotNumber: 'W-1', productId: orderProduct });
    const { orderItemId } = await makeOrderWithItem(seed.tenantId, {
      productId: orderProduct,
      lotId: orderLot!.id,
    });

    // COA lot shares the key but has NO product (unknown) → lot_only.
    const docId = await makeDocument(seed.tenantId, null);
    const coaLot = await findOrCreateLot(db, seed.tenantId, { lotNumber: 'W1' });
    await db
      .prepare('INSERT INTO document_lots (id, document_id, lot_id) VALUES (?, ?, ?)')
      .bind(generateTestId(), docId, coaLot!.id)
      .run();

    await linkCoaToOrders(db, seed.tenantId, {
      documentId: docId,
      lotId: coaLot!.id,
      productId: null,
      supplierId: null,
    });

    const oi = await getOrderItem(orderItemId);
    expect(oi!.coa_document_id).toBeNull();
    expect(oi!.coa_match_status).toBe('unmatched');
    const sugg = await getSuggestions(orderItemId);
    expect(sugg).toHaveLength(1);
    expect(sugg[0].match_basis).toBe('lot_only');
    expect(sugg[0].status).toBe('pending');
  });

  it('does not cross-link a lot collision across two different products', async () => {
    const productA = await makeProduct(seed.tenantId, 'Prod A');
    const productB = await makeProduct(seed.tenantId, 'Prod B');

    // Order line for product A, lot key SAME as the COA but COA is product B.
    const orderLot = await findOrCreateLot(db, seed.tenantId, { lotNumber: 'COLLIDE', productId: productA });
    const { orderItemId } = await makeOrderWithItem(seed.tenantId, {
      productId: productA,
      lotId: orderLot!.id,
    });

    const docId = await makeDocument(seed.tenantId, null);
    const coaLot = await findOrCreateLot(db, seed.tenantId, { lotNumber: 'collide', productId: productB });
    await db
      .prepare('INSERT INTO document_lots (id, document_id, lot_id) VALUES (?, ?, ?)')
      .bind(generateTestId(), docId, coaLot!.id)
      .run();

    await linkCoaToOrders(db, seed.tenantId, {
      documentId: docId,
      lotId: coaLot!.id,
      productId: productB,
      supplierId: null,
    });

    const oi = await getOrderItem(orderItemId);
    // Product disagrees → weak → suggestion, NOT an auto-link.
    expect(oi!.coa_document_id).toBeNull();
    const sugg = await getSuggestions(orderItemId);
    expect(sugg).toHaveLength(1);
    expect(sugg[0].match_basis).toBe('lot_only');
  });
});

describe('matching: order → COAs', () => {
  it('suggests at high confidence, and does not link, when product agrees', async () => {
    const productId = await makeProduct(seed.tenantId, 'Whey');
    const supplierId = await makeSupplier(seed.tenantId, 'Whey Co');

    // COA already exists for this lot + product.
    const docId = await makeDocument(seed.tenantId, supplierId);
    const coaLot = await findOrCreateLot(db, seed.tenantId, {
      lotNumber: 'WH-9',
      productId,
      supplierId,
    });
    await db
      .prepare('INSERT INTO document_lots (id, document_id, lot_id) VALUES (?, ?, ?)')
      .bind(generateTestId(), docId, coaLot!.id)
      .run();

    // Now an order line lands with the same lot + product.
    const orderLot = await findOrCreateLot(db, seed.tenantId, { lotNumber: 'Lot# WH9', productId });
    const { orderItemId } = await makeOrderWithItem(seed.tenantId, {
      productId,
      lotId: orderLot!.id,
    });

    await linkOrderToCoas(db, seed.tenantId, {
      orderItemId,
      lotId: orderLot!.id,
      productId,
    });

    await expectSuggestedOnly(orderItemId, docId);
  });
});

describe('matching: distributor-code agreement', () => {
  it('order → COA: codes agree (different products) → high-confidence suggestion, no link', async () => {
    const orderProduct = await makeProduct(seed.tenantId, 'WILL CAGE FREE WHOLE LIQ');
    const coaProduct = await makeProduct(seed.tenantId, 'Willamette Cage-Free Liquid Whole Egg');

    // COA doc: title carries distributor code "1167", lot 6141, product B.
    const docId = await makeDocument(
      seed.tenantId,
      null,
      '(1167) 76187-29125 CF LIQ WHOLE EGG 2-20# LOT 6141 07-02-26'
    );
    const coaLot = await findOrCreateLot(db, seed.tenantId, {
      lotNumber: '6141',
      productId: coaProduct,
    });
    await db
      .prepare('INSERT INTO document_lots (id, document_id, lot_id) VALUES (?, ?, ?)')
      .bind(generateTestId(), docId, coaLot!.id)
      .run();

    // Order line: product code "1167", lot 6141, DIFFERENT product A.
    const orderLot = await findOrCreateLot(db, seed.tenantId, {
      lotNumber: '6141',
      productId: orderProduct,
    });
    const { orderItemId } = await makeOrderWithItem(seed.tenantId, {
      productId: orderProduct,
      productCode: '1167',
      lotId: orderLot!.id,
    });

    await linkOrderToCoas(db, seed.tenantId, {
      orderItemId,
      lotId: orderLot!.id,
      productId: orderProduct,
    });

    await expectSuggestedOnly(orderItemId, docId, { confidence: 0.9 });
  });

  it('order → COA: codes differ → stays a weak suggestion', async () => {
    const orderProduct = await makeProduct(seed.tenantId, 'Prod A');
    const coaProduct = await makeProduct(seed.tenantId, 'Prod B');

    const docId = await makeDocument(
      seed.tenantId,
      null,
      '(9999) something else LOT 6141'
    );
    const coaLot = await findOrCreateLot(db, seed.tenantId, {
      lotNumber: '6141',
      productId: coaProduct,
    });
    await db
      .prepare('INSERT INTO document_lots (id, document_id, lot_id) VALUES (?, ?, ?)')
      .bind(generateTestId(), docId, coaLot!.id)
      .run();

    const orderLot = await findOrCreateLot(db, seed.tenantId, {
      lotNumber: '6141',
      productId: orderProduct,
    });
    const { orderItemId } = await makeOrderWithItem(seed.tenantId, {
      productId: orderProduct,
      productCode: '1167',
      lotId: orderLot!.id,
    });

    await linkOrderToCoas(db, seed.tenantId, {
      orderItemId,
      lotId: orderLot!.id,
      productId: orderProduct,
    });

    const oi = await getOrderItem(orderItemId);
    expect(oi!.coa_document_id).toBeNull();
    const sugg = await getSuggestions(orderItemId);
    expect(sugg).toHaveLength(1);
    expect(sugg[0].match_basis).toBe('lot_only');
  });

  it('COA → orders: codes agree (different products) → high-confidence suggestion, no link', async () => {
    const orderProduct = await makeProduct(seed.tenantId, 'Order Name');
    const coaProduct = await makeProduct(seed.tenantId, 'Coa Name');

    const orderLot = await findOrCreateLot(db, seed.tenantId, {
      lotNumber: '6141',
      productId: orderProduct,
    });
    const { orderItemId } = await makeOrderWithItem(seed.tenantId, {
      productId: orderProduct,
      productCode: '1167',
      lotId: orderLot!.id,
    });

    const docId = await makeDocument(
      seed.tenantId,
      null,
      '(1167) CF LIQ WHOLE EGG LOT 6141'
    );
    const coaLot = await findOrCreateLot(db, seed.tenantId, {
      lotNumber: 'Lot# 6141',
      productId: coaProduct,
    });
    await db
      .prepare('INSERT INTO document_lots (id, document_id, lot_id) VALUES (?, ?, ?)')
      .bind(generateTestId(), docId, coaLot!.id)
      .run();

    await linkCoaToOrders(db, seed.tenantId, {
      documentId: docId,
      lotId: coaLot!.id,
      productId: coaProduct,
      supplierId: null,
    });

    await expectSuggestedOnly(orderItemId, docId);
  });
});

// --- lot_scheme (0075): date_code re-keying --------------------------------

describe('lot_scheme date_code (0075)', () => {
  it('a date_code COA lot (061626WHO) and a bare-date order lot (061626) share one row', async () => {
    const productId = await makeProduct(seed.tenantId, 'Whole Milk');

    // Order side: bare-date key (CMF WMS strips the suffix).
    const orderLot = await findOrCreateLot(db, seed.tenantId, {
      lotNumber: '061626',
      productId,
    });
    // COA side: suffixed lot, but the supplier's date_code scheme strips it.
    const coaLot = await findOrCreateLot(db, seed.tenantId, {
      lotNumber: '061626WHO',
      productId,
      lotScheme: 'date_code',
    });

    // Same physical lot row — the suffix was stripped to the bare date.
    expect(coaLot!.id).toBe(orderLot!.id);
    const row = await db
      .prepare('SELECT lot_key, sub_lot_code FROM lots WHERE id = ?')
      .bind(coaLot!.id)
      .first<{ lot_key: string; sub_lot_code: string }>();
    expect(row!.lot_key).toBe('061626');
    expect(row!.sub_lot_code).toBe('');
  });
});

// --- product identifier bridge (0107 / 0113): teach-at-review product bridge -
// supplier_product_map (0075) is retired; the matcher resolves the certificate's
// product from product_identifiers (shared/supplierProductBridge.ts).

async function makeIdentifier(
  tenantId: string,
  productId: string,
  kind: 'supplier_name' | 'supplier_item' | 'our_sku' | 'pack',
  value: string,
  supplierId: string | null,
  opts: { confirmed?: boolean } = {}
): Promise<void> {
  await insertProductIdentifier(
    db,
    tenantId,
    productId,
    { kind, value, supplier_id: supplierId, confirmed: opts.confirmed ?? true, source: 'reviewer' },
    null
  );
}

async function setMetadata(docId: string, metadata: Record<string, unknown>): Promise<void> {
  await db
    .prepare('UPDATE documents SET primary_metadata = ? WHERE id = ?')
    .bind(JSON.stringify(metadata), docId)
    .run();
}

/** A COA document on its own (COA-side product) lot, linked the way approval links it. */
async function makeCoaOnLot(
  supplierId: string,
  coaProductId: string,
  lotNumber: string,
  metadata?: Record<string, unknown>
): Promise<{ docId: string; lotId: string }> {
  const docId = await makeDocument(seed.tenantId, supplierId);
  if (metadata) await setMetadata(docId, metadata);
  const lot = await findOrCreateLot(db, seed.tenantId, {
    lotNumber,
    productId: coaProductId,
    supplierId,
    lotScheme: 'date_code',
  });
  await db
    .prepare('INSERT INTO document_lots (id, document_id, lot_id) VALUES (?, ?, ?)')
    .bind(generateTestId(), docId, lot!.id)
    .run();
  await db
    .prepare('INSERT INTO document_products (id, document_id, product_id) VALUES (?, ?, ?)')
    .bind(generateTestId(), docId, coaProductId)
    .run();
  return { docId, lotId: lot!.id };
}

async function getNote(orderItemId: string, docId: string): Promise<string | null> {
  const row = await db
    .prepare('SELECT match_note FROM lot_match_suggestions WHERE order_item_id = ? AND document_id = ?')
    .bind(orderItemId, docId)
    .first<{ match_note: string | null }>();
  return row?.match_note ?? null;
}

describe('product identifier bridge (0113)', () => {
  it('COA→orders: a supplier_name identifier upgrades a name-divergent pair from lot_only to a lot+product suggestion', async () => {
    const supplierId = await makeSupplier(seed.tenantId, 'Country Morning Farms');
    // Two DIFFERENT product rows: the COA-side ("Milk - Whole") and the
    // order-side distributor SKU product. classifyMatch would see different
    // product_ids → lot_only, except the identifier names the order product.
    const coaProductId = await makeProduct(seed.tenantId, 'Milk - Whole');
    const orderProductId = await makeProduct(seed.tenantId, '0417 MS WHOLE 5 GL BAG');

    // Teach: CMF calls the order product "Milk - Whole".
    await makeIdentifier(seed.tenantId, orderProductId, 'supplier_name', 'Milk - Whole', supplierId);

    const orderLot = await findOrCreateLot(db, seed.tenantId, {
      lotNumber: '061626',
      productId: orderProductId,
    });
    const { orderItemId } = await makeOrderWithItem(seed.tenantId, {
      productId: orderProductId,
      lotId: orderLot!.id,
    });

    const { docId, lotId } = await makeCoaOnLot(supplierId, coaProductId, '061626WHO');

    await linkCoaToOrders(db, seed.tenantId, {
      documentId: docId,
      lotId,
      productId: coaProductId,
      supplierId,
      coaProductName: 'Milk - Whole',
    });

    const sugg = await expectSuggestedOnly(orderItemId, docId, { confidence: 0.85 });
    expect(sugg.match_basis).toBe('lot+product');
    expect(await getNote(orderItemId, docId)).toBeNull();
  });

  it('order→COAs: the same identifier upgrades the pair via the rematch path', async () => {
    const supplierId = await makeSupplier(seed.tenantId, 'Country Morning Farms');
    const coaProductId = await makeProduct(seed.tenantId, 'Half-and-Half');
    const orderProductId = await makeProduct(seed.tenantId, '0708 H&H 5 GL DISP');
    // A value copied from the old map by 0113 is the NORMALIZED 0075 key.
    await makeIdentifier(seed.tenantId, orderProductId, 'supplier_name', 'HALF AND HALF', supplierId);

    const { docId } = await makeCoaOnLot(supplierId, coaProductId, '052226HAH');

    const orderLot = await findOrCreateLot(db, seed.tenantId, {
      lotNumber: '052226',
      productId: orderProductId,
    });
    const { orderItemId } = await makeOrderWithItem(seed.tenantId, {
      productId: orderProductId,
      lotId: orderLot!.id,
    });

    await linkOrderToCoas(db, seed.tenantId, {
      orderItemId,
      lotId: orderLot!.id,
      productId: orderProductId,
    });

    await expectSuggestedOnly(orderItemId, docId, { confidence: 0.85 });
  });

  it('no identifiers → behavior identical to today (name-divergent pair stays lot_only)', async () => {
    const supplierId = await makeSupplier(seed.tenantId, 'Country Morning Farms');
    const coaProductId = await makeProduct(seed.tenantId, 'Milk - Whole');
    const orderProductId = await makeProduct(seed.tenantId, '0417 MS WHOLE 5 GL BAG');

    const orderLot = await findOrCreateLot(db, seed.tenantId, {
      lotNumber: '061626',
      productId: orderProductId,
    });
    const { orderItemId } = await makeOrderWithItem(seed.tenantId, {
      productId: orderProductId,
      lotId: orderLot!.id,
    });
    const { docId, lotId } = await makeCoaOnLot(supplierId, coaProductId, '061626WHO');

    await linkCoaToOrders(db, seed.tenantId, {
      documentId: docId,
      lotId,
      productId: coaProductId,
      supplierId,
      coaProductName: 'Milk - Whole',
    });

    const oi = await getOrderItem(orderItemId);
    expect(oi!.coa_document_id).toBeNull();
    expect(oi!.coa_match_status).toBe('unmatched');
    const sugg = await getSuggestions(orderItemId);
    expect(sugg).toHaveLength(1);
    expect(sugg[0].match_basis).toBe('lot_only');
    expect(await getNote(orderItemId, docId)).toBeNull();
  });

  describe('Country Morning: one name on the 300 gal tote (30904 = our 10286) and the 5 gal bag (50903 = our 0801)', () => {
    async function cmfFixture() {
      const supplierId = await makeSupplier(seed.tenantId, 'Country Morning Farms');
      const coaProductId = await makeProduct(seed.tenantId, 'Cream - Heavy Whipping 40%');
      const tote = await makeProduct(seed.tenantId, '40% CREAM 300GL');
      const bag = await makeProduct(seed.tenantId, 'WHIP 5 GL BAG (1/CS), M');
      for (const [p, item, sku, pack] of [
        [tote, '30904', '10286', '300 Gallon Tote'],
        [bag, '50903', '0801', '5 Gallon Bag'],
      ] as const) {
        await makeIdentifier(seed.tenantId, p, 'supplier_item', item, supplierId);
        await makeIdentifier(seed.tenantId, p, 'supplier_name', 'Cream - Heavy Whipping 40%', supplierId);
        await makeIdentifier(seed.tenantId, p, 'our_sku', sku, null);
        await makeIdentifier(seed.tenantId, p, 'pack', pack, null);
      }
      // Order 1794420's shape: the 0801 BAG line on lot 061626.
      const bagLot = await findOrCreateLot(db, seed.tenantId, { lotNumber: '061626', productId: bag });
      const bagLine = await makeOrderWithItem(seed.tenantId, { productId: bag, lotId: bagLot!.id, productCode: '0801' });
      const toteLot = await findOrCreateLot(db, seed.tenantId, { lotNumber: '061626', productId: tote });
      const toteLine = await makeOrderWithItem(seed.tenantId, { productId: tote, lotId: toteLot!.id, productCode: '10286' });
      return { supplierId, coaProductId, tote, bag, bagLot: bagLot!.id, toteLot: toteLot!.id, bagLine: bagLine.orderItemId, toteLine: toteLine.orderItemId };
    }

    it('a TOTE certificate (item 30904) is suggested to the tote line and NOT offered to the bag line', async () => {
      const f = await cmfFixture();
      const { docId, lotId } = await makeCoaOnLot(f.supplierId, f.coaProductId, '061626HCR', {
        product_name: 'Cream - Heavy Whipping 40%', product_code: '30904', net_weight: '300 Gallon Tote',
      });

      await linkCoaToOrders(db, seed.tenantId, {
        documentId: docId, lotId, productId: f.coaProductId, supplierId: f.supplierId, coaProductName: 'Cream - Heavy Whipping 40%',
      });

      const toteSugg = await expectSuggestedOnly(f.toteLine, docId, { confidence: 0.85 });
      expect(toteSugg.match_basis).toBe('lot+product');
      expect(await getSuggestions(f.bagLine)).toHaveLength(0);

      // The rematch path (order side) agrees.
      await linkOrderToCoas(db, seed.tenantId, { orderItemId: f.bagLine, lotId: f.bagLot, productId: f.bag });
      expect(await getSuggestions(f.bagLine)).toHaveLength(0);
    });

    it('a BAG certificate with no item number is disambiguated by its pack', async () => {
      const f = await cmfFixture();
      const { docId, lotId } = await makeCoaOnLot(f.supplierId, f.coaProductId, '061626HCB', {
        product_name: 'Cream - Heavy Whipping 40%', net_weight: '5 Gallon Bag',
      });
      await linkCoaToOrders(db, seed.tenantId, {
        documentId: docId, lotId, productId: f.coaProductId, supplierId: f.supplierId, coaProductName: 'Cream - Heavy Whipping 40%',
      });
      const bagSugg = await expectSuggestedOnly(f.bagLine, docId);
      expect(bagSugg.match_basis).toBe('lot+product');
      // Name + pack is not a number: the tote line still gets the lot_only
      // candidate, saying what the certificate reads as.
      const toteSugg = await expectSuggestedOnly(f.toteLine, docId, { confidence: 0.5 });
      expect(toteSugg.match_basis).toBe('lot_only');
      expect(await getNote(f.toteLine, docId)).toMatch(/reads as WHIP 5 GL BAG .* by the supplier's product name and pack, not this line's product/);
    });

    it('the ambiguous name alone yields NO product: both lines get lot_only, carrying the ambiguity as a reason', async () => {
      const f = await cmfFixture();
      const { docId, lotId } = await makeCoaOnLot(f.supplierId, f.coaProductId, '061626HCX', {
        product_name: 'Cream - Heavy Whipping 40%',
      });
      await linkCoaToOrders(db, seed.tenantId, {
        documentId: docId, lotId, productId: f.coaProductId, supplierId: f.supplierId, coaProductName: 'Cream - Heavy Whipping 40%',
      });
      for (const line of [f.bagLine, f.toteLine]) {
        const s = await expectSuggestedOnly(line, docId, { confidence: 0.5 });
        expect(s.match_basis).toBe('lot_only');
        expect(await getNote(line, docId)).toMatch(/for 2 of our products .* so no product is assumed/);
      }
    });
  });

  it('an UNCONFIRMED identifier still suggests, ranked below a confirmed one, and says "via unconfirmed identifier"', async () => {
    const supplierId = await makeSupplier(seed.tenantId, 'Country Morning Farms');
    const coaProductId = await makeProduct(seed.tenantId, 'Buttermilk - 1%');
    const orderProductId = await makeProduct(seed.tenantId, 'BUTTERMILK 1% 5 GL BAG');
    await makeIdentifier(seed.tenantId, orderProductId, 'supplier_name', 'Buttermilk - 1%', supplierId, { confirmed: false });

    const orderLot = await findOrCreateLot(db, seed.tenantId, { lotNumber: '061226', productId: orderProductId });
    const { orderItemId } = await makeOrderWithItem(seed.tenantId, { productId: orderProductId, lotId: orderLot!.id });
    const { docId, lotId } = await makeCoaOnLot(supplierId, coaProductId, '061226BUO', { product_name: 'Buttermilk - 1%' });

    await linkCoaToOrders(db, seed.tenantId, {
      documentId: docId, lotId, productId: coaProductId, supplierId, coaProductName: 'Buttermilk - 1%',
    });

    const s = await expectSuggestedOnly(orderItemId, docId, { confidence: 0.7 });
    expect(s.match_basis).toBe('lot+product');
    expect(await getNote(orderItemId, docId)).toMatch(/via unconfirmed identifier Country Morning Farms product name "Buttermilk - 1%"/);

    // Confirming the identifier and re-running refreshes the words (same tier,
    // same basis: the note is rewritten, confidence is raised).
    await db.prepare('UPDATE product_identifiers SET confirmed = 1 WHERE product_id = ?').bind(orderProductId).run();
    await linkOrderToCoas(db, seed.tenantId, { orderItemId, lotId: orderLot!.id, productId: orderProductId });
    await expectSuggestedOnly(orderItemId, docId, { confidence: 0.85 });
    expect(await getNote(orderItemId, docId)).toBeNull();
  });
});

// --- endpoint --------------------------------------------------------------

function makeContext(suggestionId: string, body: unknown, user: { id: string; role: string; tenant_id: string | null }): any {
  return {
    request: new Request(`http://localhost/api/lot-matches/${suggestionId}`, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    }),
    env,
    data: { user },
    params: { id: suggestionId },
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
    functionPath: '/api/lot-matches/[id]',
  };
}

describe('POST /api/lot-matches/:id', () => {
  async function seedSuggestion() {
    const productId = await makeProduct(seed.tenantId, 'Suggested Prod');
    const orderLot = await findOrCreateLot(db, seed.tenantId, { lotNumber: 'SG-1', productId });
    const { orderItemId } = await makeOrderWithItem(seed.tenantId, { productId, lotId: orderLot!.id });
    const docId = await makeDocument(seed.tenantId, null);
    const coaLot = await findOrCreateLot(db, seed.tenantId, { lotNumber: 'SG1' });
    await db
      .prepare('INSERT INTO document_lots (id, document_id, lot_id) VALUES (?, ?, ?)')
      .bind(generateTestId(), docId, coaLot!.id)
      .run();
    await linkCoaToOrders(db, seed.tenantId, {
      documentId: docId,
      lotId: coaLot!.id,
      productId: null,
      supplierId: null,
    });
    const sugg = await getSuggestions(orderItemId);
    expect(sugg).toHaveLength(1);
    return { suggestionId: sugg[0].id, orderItemId, docId };
  }

  it('accept links the COA to the order line', async () => {
    const { suggestionId, orderItemId, docId } = await seedSuggestion();
    const orgAdmin = { id: seed.orgAdminId, role: 'org_admin', tenant_id: seed.tenantId };

    const res = await resolveLotMatch(makeContext(suggestionId, { action: 'accept' }, orgAdmin));
    expect(res.status).toBe(200);

    const oi = await getOrderItem(orderItemId);
    expect(oi!.coa_document_id).toBe(docId);
    expect(oi!.lot_matched).toBe(1);
    expect(oi!.coa_match_status).toBe('matched');

    const sugg = await db
      .prepare('SELECT status FROM lot_match_suggestions WHERE id = ?')
      .bind(suggestionId)
      .first<{ status: string }>();
    expect(sugg!.status).toBe('accepted');
  });

  it('reject sets status and leaves the order_item untouched', async () => {
    const { suggestionId, orderItemId } = await seedSuggestion();
    const orgAdmin = { id: seed.orgAdminId, role: 'org_admin', tenant_id: seed.tenantId };

    const res = await resolveLotMatch(makeContext(suggestionId, { action: 'reject' }, orgAdmin));
    expect(res.status).toBe(200);

    const oi = await getOrderItem(orderItemId);
    expect(oi!.coa_document_id).toBeNull();
    expect(oi!.coa_match_status).toBe('unmatched');

    const sugg = await db
      .prepare('SELECT status FROM lot_match_suggestions WHERE id = ?')
      .bind(suggestionId)
      .first<{ status: string }>();
    expect(sugg!.status).toBe('rejected');
  });

  it('rejects cross-tenant access', async () => {
    const { suggestionId } = await seedSuggestion();
    const otherAdmin = { id: seed.orgAdmin2Id, role: 'org_admin', tenant_id: seed.tenantId2 };
    const res = await resolveLotMatch(makeContext(suggestionId, { action: 'accept' }, otherAdmin));
    expect(res.status).toBe(403);
  });
});

describe('every match is a suggestion (never asserted)', () => {
  /** A COA and an order line agreeing on lot + product: the strongest evidence short of supplier. */
  async function strongPair(lotNumber: string) {
    const productId = await makeProduct(seed.tenantId, `Strong ${lotNumber}`);
    const orderLot = await findOrCreateLot(db, seed.tenantId, { lotNumber, productId });
    const { orderItemId } = await makeOrderWithItem(seed.tenantId, { productId, lotId: orderLot!.id });
    const docId = await makeDocument(seed.tenantId, null);
    const coaLot = await findOrCreateLot(db, seed.tenantId, { lotNumber, productId });
    await db
      .prepare('INSERT INTO document_lots (id, document_id, lot_id) VALUES (?, ?, ?)')
      .bind(generateTestId(), docId, coaLot!.id)
      .run();
    const run = () =>
      linkCoaToOrders(db, seed.tenantId, { documentId: docId, lotId: coaLot!.id, productId, supplierId: null });
    return { productId, orderItemId, docId, coaLotId: coaLot!.id, run };
  }

  it('a high-confidence suggestion is one click from a link', async () => {
    const pair = await strongPair('HC-1');
    await pair.run();
    const sugg = await expectSuggestedOnly(pair.orderItemId, pair.docId, { confidence: 0.85 });
    expect(sugg.match_basis).toBe('lot+product');

    const orgAdmin = { id: seed.orgAdminId, role: 'org_admin', tenant_id: seed.tenantId };
    const res = await resolveLotMatch(makeContext(sugg.id, { action: 'accept' }, orgAdmin));
    expect(res.status).toBe(200);
    const oi = await getOrderItem(pair.orderItemId);
    expect(oi!.coa_document_id).toBe(pair.docId);
    expect(oi!.coa_match_status).toBe('matched');
    expect(oi!.match_confidence).toBe(0.85);
  });

  it('raises a pending suggestion to stronger evidence, and never re-ranks a decided one', async () => {
    const pair = await strongPair('HC-2');
    // Pretend an earlier run only had the lot to go on.
    await db
      .prepare(
        `INSERT INTO lot_match_suggestions (id, tenant_id, order_item_id, document_id, lot_id, match_confidence, match_basis, status)
         VALUES (?, ?, ?, ?, ?, 0.5, 'lot_only', 'pending')`
      )
      .bind(generateTestId(), seed.tenantId, pair.orderItemId, pair.docId, pair.coaLotId)
      .run();
    await pair.run();
    const raised = await expectSuggestedOnly(pair.orderItemId, pair.docId, { confidence: 0.85 });
    expect(raised.match_basis).toBe('lot+product');

    // A person rejects it; re-running the matcher must not reopen or re-rank it.
    await db.prepare(`UPDATE lot_match_suggestions SET status = 'rejected', match_confidence = 0.5 WHERE id = ?`).bind(raised.id).run();
    await pair.run();
    const after = await getSuggestions(pair.orderItemId);
    expect(after).toHaveLength(1);
    expect(after[0].status).toBe('rejected');
    expect(after[0].match_confidence).toBe(0.5);
    expect((await getOrderItem(pair.orderItemId))!.coa_document_id).toBeNull();
  });

  it('leaves a line the old policy already linked alone, and does not re-suggest that pair', async () => {
    const pair = await strongPair('HC-3');
    await db
      .prepare(
        `UPDATE order_items SET coa_document_id = ?, lot_matched = 1, match_confidence = 0.85,
                coa_match_status = 'matched', coa_matched_at = '2026-06-01 00:00:00' WHERE id = ?`
      )
      .bind(pair.docId, pair.orderItemId)
      .run();
    await pair.run();
    const oi = await getOrderItem(pair.orderItemId);
    expect(oi!.coa_document_id).toBe(pair.docId);
    expect(oi!.coa_match_status).toBe('matched');
    expect(await getSuggestions(pair.orderItemId)).toHaveLength(0);
  });
});

describe('where a person sees a suggestion', () => {
  function getCtx(url: string, params: Record<string, string> = {}): any {
    return {
      request: new Request(`http://localhost${url}`),
      env,
      data: { user: { id: seed.orgAdminId, role: 'org_admin', tenant_id: seed.tenantId } },
      params,
      waitUntil: () => {},
      passThroughOnException: () => {},
      next: async () => new Response(null),
      functionPath: url,
    };
  }

  async function suggestedOrder(lotNumber: string) {
    const productId = await makeProduct(seed.tenantId, `Seen ${lotNumber}`);
    const orderLot = await findOrCreateLot(db, seed.tenantId, { lotNumber, productId });
    const { orderId, orderItemId } = await makeOrderWithItem(seed.tenantId, { productId, lotId: orderLot!.id });
    const docId = await makeDocument(seed.tenantId, null, `COA ${lotNumber}`);
    const coaLot = await findOrCreateLot(db, seed.tenantId, { lotNumber, productId });
    await db
      .prepare('INSERT INTO document_lots (id, document_id, lot_id) VALUES (?, ?, ?)')
      .bind(generateTestId(), docId, coaLot!.id)
      .run();
    await linkCoaToOrders(db, seed.tenantId, { documentId: docId, lotId: coaLot!.id, productId, supplierId: null });
    const order = await db
      .prepare('SELECT order_number FROM orders WHERE id = ?')
      .bind(orderId)
      .first<{ order_number: string }>();
    return { orderId, orderItemId, docId, orderNumber: order!.order_number };
  }

  it('GET /api/orders/:id carries the pending suggestions for its lines', async () => {
    const a = await suggestedOrder('SEEN-1');
    const res = await getOrder(getCtx(`/api/orders/${a.orderId}`, { id: a.orderId }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { suggestions: Array<Record<string, unknown>> };
    expect(body.suggestions).toHaveLength(1);
    expect(body.suggestions[0]).toMatchObject({
      order_item_id: a.orderItemId,
      document_id: a.docId,
      document_title: 'COA SEEN-1',
      match_basis: 'lot+product',
      match_confidence: 0.85,
      status: 'pending',
    });
  });

  it('GET /api/lot-matches honours every order_number it is given', async () => {
    const a = await suggestedOrder('SEEN-2');
    const b = await suggestedOrder('SEEN-3');
    const res = await listLotMatches(
      getCtx(`/api/lot-matches?status=pending&order_number=${a.orderNumber}&order_number=${b.orderNumber}`)
    );
    const body = (await res.json()) as { suggestions: Array<{ document_id: string }> };
    expect(body.suggestions.map((x) => x.document_id).sort()).toEqual([a.docId, b.docId].sort());
  });
});
