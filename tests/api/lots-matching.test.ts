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
import { onRequestPost as resolveLotMatch } from '../../functions/api/lot-matches/[id]';

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
  it('auto-links (strong) when product agrees', async () => {
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

    const oi = await getOrderItem(orderItemId);
    expect(oi!.coa_document_id).toBe(docId);
    expect(oi!.coa_match_status).toBe('matched');
    expect(oi!.lot_matched).toBe(1);
    expect(oi!.match_confidence).toBeGreaterThanOrEqual(0.85);
    expect(await getSuggestions(orderItemId)).toHaveLength(0);
  });

  it('matches an order line that has a raw lot_number but no lot_id yet', async () => {
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

    const oi = await getOrderItem(orderItemId);
    expect(oi!.coa_document_id).toBe(docId);
    expect(oi!.coa_match_status).toBe('matched');
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
  it('auto-links (strong) when product agrees', async () => {
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

    const oi = await getOrderItem(orderItemId);
    expect(oi!.coa_document_id).toBe(docId);
    expect(oi!.coa_match_status).toBe('matched');
  });
});

describe('matching: distributor-code auto-confirm', () => {
  it('order → COA: codes agree (different products) → STRONG auto-link, no suggestion', async () => {
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

    const oi = await getOrderItem(orderItemId);
    expect(oi!.coa_document_id).toBe(docId);
    expect(oi!.coa_match_status).toBe('matched');
    expect(oi!.match_confidence).toBe(0.9);
    expect(await getSuggestions(orderItemId)).toHaveLength(0);
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

  it('COA → orders: codes agree (different products) → STRONG auto-link', async () => {
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

    const oi = await getOrderItem(orderItemId);
    expect(oi!.coa_document_id).toBe(docId);
    expect(oi!.coa_match_status).toBe('matched');
    expect(await getSuggestions(orderItemId)).toHaveLength(0);
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

// --- supplier_product_map (0075): teach-at-review product bridge ------------

async function makeProductMap(
  tenantId: string,
  supplierId: string,
  coaProductNameKey: string,
  orderProductId: string,
  distributorSku?: string | null
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO supplier_product_map
         (id, tenant_id, supplier_id, coa_product_name_key, order_product_id, distributor_sku)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .bind(
      generateTestId(),
      tenantId,
      supplierId,
      coaProductNameKey,
      orderProductId,
      distributorSku ?? null
    )
    .run();
}

describe('supplier_product_map bridge (0075)', () => {
  it('COA→orders: a map row upgrades a name-divergent pair from lot_only to strong lot+product', async () => {
    const supplierId = await makeSupplier(seed.tenantId, 'Country Morning Farms');
    // Two DIFFERENT product rows: the COA-side ("Milk - Whole") and the
    // order-side distributor SKU product. classifyMatch would see different
    // product_ids → lot_only, except the map substitutes the order product.
    const coaProductId = await makeProduct(seed.tenantId, 'Milk - Whole');
    const orderProductId = await makeProduct(seed.tenantId, '0417 MS WHOLE 5 GL BAG');

    // Teach the bridge: COA name "Milk - Whole" → the order product.
    await makeProductMap(seed.tenantId, supplierId, 'MILK WHOLE', orderProductId);

    // Order line resolved to the bare-date lot + the order product.
    const orderLot = await findOrCreateLot(db, seed.tenantId, {
      lotNumber: '061626',
      productId: orderProductId,
    });
    const { orderItemId } = await makeOrderWithItem(seed.tenantId, {
      productId: orderProductId,
      lotId: orderLot!.id,
    });

    // COA doc carries the COA-side product; lot stripped by date_code.
    const docId = await makeDocument(seed.tenantId, supplierId);
    const coaLot = await findOrCreateLot(db, seed.tenantId, {
      lotNumber: '061626WHO',
      productId: coaProductId,
      supplierId,
      lotScheme: 'date_code',
    });
    await db
      .prepare('INSERT INTO document_lots (id, document_id, lot_id) VALUES (?, ?, ?)')
      .bind(generateTestId(), docId, coaLot!.id)
      .run();
    await db
      .prepare('INSERT INTO document_products (id, document_id, product_id) VALUES (?, ?, ?)')
      .bind(generateTestId(), docId, coaProductId)
      .run();

    await linkCoaToOrders(db, seed.tenantId, {
      documentId: docId,
      lotId: coaLot!.id,
      productId: coaProductId,
      supplierId,
      coaProductName: 'Milk - Whole',
    });

    const oi = await getOrderItem(orderItemId);
    expect(oi!.coa_document_id).toBe(docId);
    expect(oi!.coa_match_status).toBe('matched');
    expect(oi!.match_confidence).toBe(0.85);
    expect(await getSuggestions(orderItemId)).toHaveLength(0);
  });

  it('order→COAs: a map row upgrades the same pair via the rematch path', async () => {
    const supplierId = await makeSupplier(seed.tenantId, 'Country Morning Farms');
    const coaProductId = await makeProduct(seed.tenantId, 'Half-and-Half');
    const orderProductId = await makeProduct(seed.tenantId, '0801 WHIP 5 GL BAG');
    await makeProductMap(seed.tenantId, supplierId, 'HALF AND HALF', orderProductId);

    // COA already in the graph: bare-date lot, COA-side product, doc-product link.
    const docId = await makeDocument(seed.tenantId, supplierId);
    const coaLot = await findOrCreateLot(db, seed.tenantId, {
      lotNumber: '052226HAH',
      productId: coaProductId,
      supplierId,
      lotScheme: 'date_code',
    });
    await db
      .prepare('INSERT INTO document_lots (id, document_id, lot_id) VALUES (?, ?, ?)')
      .bind(generateTestId(), docId, coaLot!.id)
      .run();
    await db
      .prepare('INSERT INTO document_products (id, document_id, product_id) VALUES (?, ?, ?)')
      .bind(generateTestId(), docId, coaProductId)
      .run();

    // Order line lands on the bare-date lot + order product.
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

    const oi = await getOrderItem(orderItemId);
    expect(oi!.coa_document_id).toBe(docId);
    expect(oi!.coa_match_status).toBe('matched');
    expect(oi!.match_confidence).toBe(0.85);
    expect(await getSuggestions(orderItemId)).toHaveLength(0);
  });

  it('no map row → behavior identical to today (name-divergent pair stays lot_only)', async () => {
    const supplierId = await makeSupplier(seed.tenantId, 'Country Morning Farms');
    const coaProductId = await makeProduct(seed.tenantId, 'Milk - Whole');
    const orderProductId = await makeProduct(seed.tenantId, '0417 MS WHOLE 5 GL BAG');
    // NO makeProductMap call.

    const orderLot = await findOrCreateLot(db, seed.tenantId, {
      lotNumber: '061626',
      productId: orderProductId,
    });
    const { orderItemId } = await makeOrderWithItem(seed.tenantId, {
      productId: orderProductId,
      lotId: orderLot!.id,
    });

    const docId = await makeDocument(seed.tenantId, supplierId);
    const coaLot = await findOrCreateLot(db, seed.tenantId, {
      lotNumber: '061626WHO',
      productId: coaProductId,
      supplierId,
      lotScheme: 'date_code',
    });
    await db
      .prepare('INSERT INTO document_lots (id, document_id, lot_id) VALUES (?, ?, ?)')
      .bind(generateTestId(), docId, coaLot!.id)
      .run();
    await db
      .prepare('INSERT INTO document_products (id, document_id, product_id) VALUES (?, ?, ?)')
      .bind(generateTestId(), docId, coaProductId)
      .run();

    await linkCoaToOrders(db, seed.tenantId, {
      documentId: docId,
      lotId: coaLot!.id,
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

  it('accept promotes the suggestion to a strong link', async () => {
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
