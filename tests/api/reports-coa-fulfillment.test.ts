/**
 * API tests for the COA-fulfillment report (entity-graph daily view):
 *   - GET /api/reports/coa-fulfillment  (functions/api/reports/coa-fulfillment.ts)
 *
 * Drives onRequestGet directly with a fake PagesFunction context, mirroring
 * tests/api/lots-read.test.ts (this project's vitest-pool-workers config
 * doesn't wire up SELF.fetch).
 *
 * Seeds one order per gap state plus a second-tenant order for scoping:
 *   - line OK         : lot linked + matched COA + lot not expired
 *   - line MISSING_LOT: order_item.lot_id IS NULL
 *   - line MISSING_COA: lot linked, no coa_document_id, status != matched
 *   - line EXPIRED    : lot + COA, but lot.expiration_date < as_of
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { runMigrations, seedTestData, cleanTables, generateTestId } from '../helpers/db';
import { onRequestGet as coaReport } from '../../functions/api/reports/coa-fulfillment';

const db = env.DB;
let seed: Awaited<ReturnType<typeof seedTestData>>;

const AS_OF = '2026-06-01';

function makeContext(url: string, user: { id: string; role: string; tenant_id: string | null }): any {
  return {
    request: new Request(url, { method: 'GET' }),
    env,
    data: { user },
    params: {},
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
    functionPath: '/api/reports/coa-fulfillment',
  };
}

async function runReport(user: any, qs = '') {
  const res = await coaReport(
    makeContext(`http://localhost/api/reports/coa-fulfillment${qs ? `?${qs}` : ''}`, user),
  );
  return { status: res.status, body: (await res.json()) as any };
}

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
    .prepare('INSERT INTO products (id, tenant_id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, datetime(\'now\'), datetime(\'now\'))')
    .bind(id, tenantId, name, `${name.toLowerCase().replace(/\s+/g, '-')}-${id.slice(0, 6)}`)
    .run();
  return id;
}

async function makeLot(
  tenantId: string,
  productId: string,
  supplierId: string,
  lotNumber: string,
  expirationDate: string | null,
): Promise<string> {
  const id = generateTestId();
  await db
    .prepare(
      `INSERT INTO lots (id, tenant_id, supplier_id, product_id, lot_number, lot_key, expiration_date)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, tenantId, supplierId, productId, lotNumber, lotNumber.toLowerCase(), expirationDate)
    .run();
  return id;
}

async function makeCoaDoc(
  tenantId: string,
  title: string,
  fileName: string,
  opts: { supplierId?: string | null; primaryMetadata?: Record<string, unknown> | null } = {},
): Promise<string> {
  const docId = generateTestId();
  await db
    .prepare(
      `INSERT INTO documents (id, tenant_id, title, tags, current_version, status, created_by, supplier_id, primary_metadata)
       VALUES (?, ?, ?, '[]', 1, 'active', ?, ?, ?)`,
    )
    .bind(
      docId,
      tenantId,
      title,
      seed.userId,
      opts.supplierId ?? null,
      opts.primaryMetadata ? JSON.stringify(opts.primaryMetadata) : null,
    )
    .run();
  await db
    .prepare(
      `INSERT INTO document_versions (id, document_id, version_number, file_name, file_size, mime_type, r2_key, uploaded_by)
       VALUES (?, ?, 1, ?, 1024, 'application/pdf', ?, ?)`,
    )
    .bind(generateTestId(), docId, fileName, `r2/${docId}`, seed.userId)
    .run();
  return docId;
}

async function linkDocLot(documentId: string, lotId: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO document_lots (id, document_id, lot_id) VALUES (?, ?, ?)`,
    )
    .bind(generateTestId(), documentId, lotId)
    .run();
}

async function makeCustomer(tenantId: string, name: string): Promise<string> {
  const id = generateTestId();
  await db
    .prepare(
      `INSERT INTO customers (id, tenant_id, customer_number, name, created_at, updated_at)
       VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))`,
    )
    .bind(id, tenantId, `CUST-${id.slice(0, 6)}`, name)
    .run();
  return id;
}

async function makeOrder(
  tenantId: string,
  orderNumber: string,
  customerId: string | null,
  customerName: string | null,
  poNumber: string | null,
): Promise<string> {
  const id = generateTestId();
  await db
    .prepare(
      `INSERT INTO orders (id, tenant_id, order_number, po_number, customer_id, customer_name, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'fulfilled', datetime('now'), datetime('now'))`,
    )
    .bind(id, tenantId, orderNumber, poNumber, customerId, customerName)
    .run();
  return id;
}

async function makeItem(
  orderId: string,
  productName: string,
  lotId: string | null,
  coaDocId: string | null,
  matchStatus: string,
  quantity = 10,
  productId: string | null = null,
): Promise<string> {
  const id = generateTestId();
  await db
    .prepare(
      `INSERT INTO order_items (id, order_id, product_id, product_name, quantity, lot_id, coa_document_id, coa_match_status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
    )
    .bind(id, orderId, productId, productName, quantity, lotId, coaDocId, matchStatus)
    .run();
  return id;
}

// Fixture order IDs so individual assertions can target them.
let okOrderId = '';
let missingLotOrderId = '';
let missingCoaOrderId = '';
let expiredOrderId = '';
let coaSideOrderId = '';

// Fixture entity IDs so id-link assertions can compare exact targets.
let supplierId = '';
let productId = '';
let lotOkId = '';
let coaSupplierId = '';

beforeAll(async () => {
  await runMigrations(db);
  await cleanTables(db);
  seed = await seedTestData(db);

  const supplier = await makeSupplier(seed.tenantId, 'Acme Supply');
  const product = await makeProduct(seed.tenantId, 'Widget');
  const customer = await makeCustomer(seed.tenantId, 'Globex');
  supplierId = supplier;
  productId = product;

  // OK line: lot (not expired) + matched COA.
  const lotOk = await makeLot(seed.tenantId, product, supplier, 'LOT-OK', '2027-01-01');
  lotOkId = lotOk;
  const coaOk = await makeCoaDoc(seed.tenantId, 'COA OK', 'coa-ok.pdf');
  okOrderId = await makeOrder(seed.tenantId, 'ORD-OK', customer, 'Globex', 'PO-OK');
  await makeItem(okOrderId, 'Widget', lotOk, coaOk, 'matched', 10, product);

  // MISSING_LOT line: no lot.
  missingLotOrderId = await makeOrder(seed.tenantId, 'ORD-NOLOT', customer, 'Globex', null);
  await makeItem(missingLotOrderId, 'Widget', null, null, 'unmatched');

  // MISSING_COA line: lot present, no COA, status not matched.
  const lotNoCoa = await makeLot(seed.tenantId, product, supplier, 'LOT-NOCOA', '2027-01-01');
  missingCoaOrderId = await makeOrder(seed.tenantId, 'ORD-NOCOA', customer, 'Globex', null);
  await makeItem(missingCoaOrderId, 'Widget', lotNoCoa, null, 'suggested');

  // EXPIRED line: lot + COA, but lot expired before AS_OF.
  const lotExpired = await makeLot(seed.tenantId, product, supplier, 'LOT-EXP', '2025-01-01');
  const coaExp = await makeCoaDoc(seed.tenantId, 'COA Exp', 'coa-exp.pdf');
  expiredOrderId = await makeOrder(seed.tenantId, 'ORD-EXP', customer, 'Globex', null);
  await makeItem(expiredOrderId, 'Widget', lotExpired, coaExp, 'matched');

  // COA-SIDE line: the order-side lot carries NO supplier and NO expiration
  // (exactly the real-world shape: order-derived lots have supplier_id=NULL and
  // no exp). The supplier + expiration live on the matched COA instead —
  // supplier via documents.supplier_id, expiration via the COA's linked lot.
  const coaSupplier = await makeSupplier(seed.tenantId, 'COA Supplier');
  coaSupplierId = coaSupplier;
  const orderLotBare = await makeLot(seed.tenantId, product, supplier, 'LOT-COASIDE', null);
  // Wipe supplier on the order-side lot so only the COA can provide it.
  await db.prepare('UPDATE lots SET supplier_id = NULL WHERE id = ?').bind(orderLotBare).run();
  const coaLot = await makeLot(seed.tenantId, product, coaSupplier, 'LOT-COA-LINKED', '2028-03-15');
  const coaSideDoc = await makeCoaDoc(seed.tenantId, 'COA Side', 'coa-side.pdf', {
    supplierId: coaSupplier,
  });
  await linkDocLot(coaSideDoc, coaLot);
  coaSideOrderId = await makeOrder(seed.tenantId, 'ORD-COASIDE', customer, 'Globex', null);
  await makeItem(coaSideOrderId, 'Widget', orderLotBare, coaSideDoc, 'matched');

  // Other-tenant order — must never appear for tenant 1.
  const otherCust = await makeCustomer(seed.tenantId2, 'Other Co');
  const otherOrder = await makeOrder(seed.tenantId2, 'ORD-OTHER', otherCust, 'Other Co', null);
  await makeItem(otherOrder, 'Other Widget', null, null, 'unmatched');
}, 30_000);

describe('COA Fulfillment report — rows + gap rules', () => {
  it('returns one row per order line with correct gap classification', async () => {
    const { status, body } = await runReport(seed.orgAdminId
      ? { id: seed.orgAdminId, role: 'org_admin', tenant_id: seed.tenantId }
      : null as any, `as_of=${AS_OF}`);
    expect(status).toBe(200);

    const byOrder = (n: string) => body.rows.find((r: any) => r.order_number === n);

    expect(byOrder('ORD-OK')?.gap).toBe('ok');
    expect(byOrder('ORD-NOLOT')?.gap).toBe('missing_lot');
    expect(byOrder('ORD-NOCOA')?.gap).toBe('missing_coa');
    expect(byOrder('ORD-EXP')?.gap).toBe('expired');
  });

  it('joins lot, supplier, COA file name into the OK row', async () => {
    const { body } = await runReport(
      { id: seed.orgAdminId, role: 'org_admin', tenant_id: seed.tenantId },
      `as_of=${AS_OF}`,
    );
    const ok = body.rows.find((r: any) => r.order_number === 'ORD-OK');
    expect(ok.lot_number).toBe('LOT-OK');
    expect(ok.supplier_name).toBe('Acme Supply');
    expect(ok.coa_file_name).toBe('coa-ok.pdf');
    expect(ok.customer_name).toBe('Globex');
    expect(ok.po_number).toBe('PO-OK');
    expect(ok.product_name).toBe('Widget');
  });

  it('carries product_id, supplier_id, lot_id link targets on a matched row', async () => {
    const { body } = await runReport(
      { id: seed.orgAdminId, role: 'org_admin', tenant_id: seed.tenantId },
      `as_of=${AS_OF}`,
    );
    const ok = body.rows.find((r: any) => r.order_number === 'ORD-OK');
    expect(ok).toBeTruthy();
    // product_id ← order_items.product_id
    expect(ok.product_id).toBe(productId);
    // lot_id ← order_items.lot_id
    expect(ok.lot_id).toBe(lotOkId);
    // supplier_id ← order-side lot supplier (no COA supplier set on this doc)
    expect(ok.supplier_id).toBe(supplierId);
  });

  it('populates supplier_name + expiration_date from the COA side on a matched line', async () => {
    // Regression: previously supplier_name + expiration_date were sourced from
    // the order-side lot, which has supplier_id=NULL and no expiration, so a
    // matched line came back blank. They must now come from the matched COA.
    const { body } = await runReport(
      { id: seed.orgAdminId, role: 'org_admin', tenant_id: seed.tenantId },
      `as_of=${AS_OF}`,
    );
    const row = body.rows.find((r: any) => r.order_number === 'ORD-COASIDE');
    expect(row).toBeTruthy();
    // Supplier comes from the COA document (documents.supplier_id → suppliers).
    expect(row.supplier_name).toBe('COA Supplier');
    // supplier_id is COA-side-first: it must be the COA's supplier, not the
    // (NULL) order-side lot supplier.
    expect(row.supplier_id).toBe(coaSupplierId);
    // Expiration comes from the COA's linked lot (document_lots → lots).
    expect(row.expiration_date).toBe('2028-03-15');
    // Sanity: this is a matched, non-expired line.
    expect(row.gap).toBe('ok');
  });
});

describe('COA Fulfillment report — summary + coverage', () => {
  it('counts each gap state and computes coverage_pct', async () => {
    const { body } = await runReport(
      { id: seed.orgAdminId, role: 'org_admin', tenant_id: seed.tenantId },
      `as_of=${AS_OF}`,
    );
    const s = body.summary;
    expect(s.total).toBe(5);
    expect(s.ok).toBe(2);
    expect(s.missing_lot).toBe(1);
    expect(s.missing_coa).toBe(1);
    expect(s.expired).toBe(1);
    // 2 of 5 fully OK => 40%.
    expect(s.coverage_pct).toBe(40);
  });

  it('returns coverage_pct 0 when there are no rows', async () => {
    const { body } = await runReport(
      { id: seed.orgAdmin2Id, role: 'org_admin', tenant_id: seed.tenantId2 },
      `as_of=${AS_OF}&customer_id=does-not-exist`,
    );
    expect(body.summary.total).toBe(0);
    expect(body.summary.coverage_pct).toBe(0);
  });
});

describe('COA Fulfillment report — tenant scoping', () => {
  it('org_admin only sees their own tenant lines', async () => {
    const { body } = await runReport(
      { id: seed.orgAdminId, role: 'org_admin', tenant_id: seed.tenantId },
      `as_of=${AS_OF}`,
    );
    const numbers = body.rows.map((r: any) => r.order_number);
    expect(numbers).not.toContain('ORD-OTHER');
    expect(body.summary.total).toBe(5);
  });

  it('super_admin can scope to a specific tenant via tenant_id', async () => {
    const { body } = await runReport(
      { id: seed.superAdminId, role: 'super_admin', tenant_id: null },
      `tenant_id=${seed.tenantId2}&as_of=${AS_OF}`,
    );
    const numbers = body.rows.map((r: any) => r.order_number);
    expect(numbers).toEqual(['ORD-OTHER']);
    expect(body.summary.total).toBe(1);
    expect(body.summary.missing_lot).toBe(1);
  });

  it('requires tenant_id for super_admin (400 when absent)', async () => {
    const { status } = await runReport(
      { id: seed.superAdminId, role: 'super_admin', tenant_id: null },
      `as_of=${AS_OF}`,
    );
    expect(status).toBe(400);
  });

  it('ignores a cross-tenant tenant_id from a non-super_admin', async () => {
    // org_admin of tenant 1 passing tenant 2's id is pinned back to tenant 1.
    const { body } = await runReport(
      { id: seed.orgAdminId, role: 'org_admin', tenant_id: seed.tenantId },
      `tenant_id=${seed.tenantId2}&as_of=${AS_OF}`,
    );
    const numbers = body.rows.map((r: any) => r.order_number);
    expect(numbers).not.toContain('ORD-OTHER');
    expect(body.summary.total).toBe(5);
  });
});

describe('COA Fulfillment report — date range selector', () => {
  it('filters out everything when the range is in the future', async () => {
    const { body } = await runReport(
      { id: seed.orgAdminId, role: 'org_admin', tenant_id: seed.tenantId },
      `from=2099-01-01&as_of=${AS_OF}`,
    );
    expect(body.summary.total).toBe(0);
  });
});

// Appended LAST so the extra tenant-2 rows don't perturb the fixed-count
// assertions in the tenant-scoping block above (which run earlier in file order).
describe('COA Fulfillment report — missing-COA availability (collect vs absent)', () => {
  async function makeItemWithCode(
    orderId: string, productName: string, productCode: string, lotId: string,
  ): Promise<void> {
    await db
      .prepare(
        `INSERT INTO order_items (id, order_id, product_id, product_name, product_code, quantity, lot_id, coa_document_id, coa_match_status, created_at)
         VALUES (?, ?, NULL, ?, ?, 5, ?, NULL, 'suggested', datetime('now'))`,
      )
      .bind(generateTestId(), orderId, productName, productCode, lotId)
      .run();
  }

  beforeAll(async () => {
    const supplier = await makeSupplier(seed.tenantId2, 'Avail Supply');
    const product = await makeProduct(seed.tenantId2, 'Coded Widget');
    const customer = await makeCustomer(seed.tenantId2, 'Avail Co');
    // Line A: product code 7777, no COA for its lot — but a COA titled "(7777)"
    // exists (for a different lot) → collectible / have_other_lot.
    const lotA = await makeLot(seed.tenantId2, product, supplier, 'AVAIL-LOT-A', '2027-01-01');
    await makeCoaDoc(seed.tenantId2, '(7777) SOME OTHER LOT COA', 'coa-7777.pdf');
    const ordA = await makeOrder(seed.tenantId2, 'ORD-AVAIL-A', customer, 'Avail Co', null);
    await makeItemWithCode(ordA, 'Coded Widget', '7777', lotA);
    // Line B: product code 8888, no COA anywhere → none_on_file.
    const lotB = await makeLot(seed.tenantId2, product, supplier, 'AVAIL-LOT-B', '2027-01-01');
    const ordB = await makeOrder(seed.tenantId2, 'ORD-AVAIL-B', customer, 'Avail Co', null);
    await makeItemWithCode(ordB, 'Coded Widget', '8888', lotB);
  });

  it('flags collectible (have_other_lot) vs no_product_coa per missing-COA line', async () => {
    const { status, body } = await runReport(
      { id: seed.superAdminId, role: 'super_admin', tenant_id: null },
      `tenant_id=${seed.tenantId2}&as_of=${AS_OF}`,
    );
    expect(status).toBe(200);
    const a = body.rows.find((r: any) => r.order_number === 'ORD-AVAIL-A');
    const b = body.rows.find((r: any) => r.order_number === 'ORD-AVAIL-B');
    expect(a.gap).toBe('missing_coa');
    expect(a.coa_availability).toBe('have_other_lot');
    expect(b.gap).toBe('missing_coa');
    expect(b.coa_availability).toBe('none_on_file');
    expect(body.summary.collectible).toBeGreaterThanOrEqual(1);
    expect(body.summary.no_product_coa).toBeGreaterThanOrEqual(1);
  });
});
