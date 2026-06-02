/**
 * API tests for the lots read surface (Phase 2 entity graph browse):
 *   - GET /api/lots         (functions/api/lots/index.ts)
 *   - GET /api/lots/:id     (functions/api/lots/[id].ts)
 *
 * Drives onRequestGet directly with a fake PagesFunction context, mirroring
 * tests/api/extraction-instructions.test.ts (the vitest-pool-workers config
 * doesn't wire up SELF.fetch in this project).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { runMigrations, seedTestData, cleanTables, generateTestId } from '../helpers/db';
import { onRequestGet as listLots } from '../../functions/api/lots/index';
import { onRequestGet as getLot } from '../../functions/api/lots/[id]';

const db = env.DB;
let seed: Awaited<ReturnType<typeof seedTestData>>;

// Fixtures (IDs filled in beforeAll)
let supplierA = '';
let supplierB = '';
let productX = '';
let productY = '';
let lotOld = '';   // oldest, supplierA + productX, has 2 COA docs + 1 matched order + 1 suggestion
let lotMid = '';   // middle, supplierB + productY, 1 COA doc, no matched orders
let lotNew = '';   // newest, no supplier/product, bare
let otherTenantLot = ''; // in tenant 2 — for cross-tenant 404

function makeContext(url: string, user: { id: string; role: string; tenant_id: string | null }, params: Record<string, string> = {}): any {
  return {
    request: new Request(url, { method: 'GET' }),
    env,
    data: { user },
    params,
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
    functionPath: '/api/lots',
  };
}

async function doList(user: any, qs = '') {
  const res = await listLots(makeContext(`http://localhost/api/lots${qs ? `?${qs}` : ''}`, user));
  return { status: res.status, body: (await res.json()) as any };
}

async function doGet(user: any, id: string) {
  const res = await getLot(makeContext(`http://localhost/api/lots/${id}`, user, { id }));
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
    .prepare('INSERT INTO products (id, tenant_id, name, slug, active) VALUES (?, ?, ?, ?, 1)')
    .bind(id, tenantId, name, `${name.toLowerCase().replace(/\s+/g, '-')}-${id.slice(0, 6)}`)
    .run();
  return id;
}

async function makeLot(
  tenantId: string,
  opts: {
    lotNumber: string;
    lotKey: string;
    supplierId?: string | null;
    productId?: string | null;
    createdAt?: string;
  }
): Promise<string> {
  const id = generateTestId();
  // created_at defaults to datetime('now') if not provided; pass an explicit
  // timestamp string when ordering matters (all callers here do).
  const createdAt = opts.createdAt ?? new Date().toISOString().replace('T', ' ').slice(0, 19);
  await db
    .prepare(
      `INSERT INTO lots (id, tenant_id, supplier_id, product_id, lot_number, lot_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      id,
      tenantId,
      opts.supplierId ?? null,
      opts.productId ?? null,
      opts.lotNumber,
      opts.lotKey,
      createdAt,
      createdAt
    )
    .run();
  return id;
}

async function makeDocument(tenantId: string, title: string): Promise<string> {
  const id = generateTestId();
  await db
    .prepare(
      `INSERT INTO documents (id, tenant_id, title, tags, current_version, status, created_by)
       VALUES (?, ?, ?, '[]', 1, 'active', ?)`
    )
    .bind(id, tenantId, title, seed.userId)
    .run();
  // A current version (version 1) carrying a file_name.
  await db
    .prepare(
      `INSERT INTO document_versions (id, document_id, version_number, file_name, file_size, mime_type, r2_key, checksum, uploaded_by)
       VALUES (?, ?, 1, ?, 100, 'application/pdf', ?, 'sha', ?)`
    )
    .bind(generateTestId(), id, `${title}.pdf`, `r2/${id}`, seed.userId)
    .run();
  return id;
}

async function linkDocLot(documentId: string, lotId: string) {
  await db
    .prepare('INSERT INTO document_lots (id, document_id, lot_id) VALUES (?, ?, ?)')
    .bind(generateTestId(), documentId, lotId)
    .run();
}

async function makeOrderItem(
  tenantId: string,
  opts: {
    orderNumber: string;
    poNumber?: string | null;
    customerName?: string | null;
    productId?: string | null;
    productName?: string | null;
    quantity?: number | null;
    lotId?: string | null;
    coaMatchStatus?: string;
    coaDocumentId?: string | null;
  }
): Promise<{ orderId: string; orderItemId: string }> {
  const orderId = generateTestId();
  await db
    .prepare(
      `INSERT INTO orders (id, tenant_id, order_number, po_number, customer_name, source_data)
       VALUES (?, ?, ?, ?, ?, '{}')`
    )
    .bind(orderId, tenantId, opts.orderNumber, opts.poNumber ?? null, opts.customerName ?? null)
    .run();
  const orderItemId = generateTestId();
  await db
    .prepare(
      `INSERT INTO order_items
        (id, order_id, product_id, product_name, quantity, lot_id, coa_match_status, coa_document_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      orderItemId,
      orderId,
      opts.productId ?? null,
      opts.productName ?? null,
      opts.quantity ?? null,
      opts.lotId ?? null,
      opts.coaMatchStatus ?? 'unmatched',
      opts.coaDocumentId ?? null
    )
    .run();
  return { orderId, orderItemId };
}

async function makeSuggestion(
  tenantId: string,
  opts: { orderItemId: string; documentId: string; lotId: string | null; status?: string; basis?: string; confidence?: number }
): Promise<string> {
  const id = generateTestId();
  await db
    .prepare(
      `INSERT INTO lot_match_suggestions
        (id, tenant_id, order_item_id, document_id, lot_id, match_confidence, match_basis, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      id,
      tenantId,
      opts.orderItemId,
      opts.documentId,
      opts.lotId ?? null,
      opts.confidence ?? 0.5,
      opts.basis ?? 'lot_only',
      opts.status ?? 'pending'
    )
    .run();
  return id;
}

beforeAll(async () => {
  await runMigrations(db);
  await cleanTables(db);
  seed = await seedTestData(db);

  supplierA = await makeSupplier(seed.tenantId, 'Supplier A');
  supplierB = await makeSupplier(seed.tenantId, 'Supplier B');
  productX = await makeProduct(seed.tenantId, 'Product X');
  productY = await makeProduct(seed.tenantId, 'Product Y');

  // lotOld — oldest. supplierA + productX. 2 COA docs, 1 matched order, 1 suggestion.
  lotOld = await makeLot(seed.tenantId, {
    lotNumber: 'LOT-OLD-001',
    lotKey: 'LOTOLD001',
    supplierId: supplierA,
    productId: productX,
    createdAt: '2026-01-01 00:00:00',
  });
  const docOld1 = await makeDocument(seed.tenantId, 'COA Old One');
  const docOld2 = await makeDocument(seed.tenantId, 'COA Old Two');
  await linkDocLot(docOld1, lotOld);
  await linkDocLot(docOld2, lotOld);

  // A matched order line on lotOld.
  const matched = await makeOrderItem(seed.tenantId, {
    orderNumber: 'ORD-MATCHED',
    poNumber: 'PO-1',
    customerName: 'Acme Foods',
    productId: productX,
    productName: 'Product X',
    quantity: 12,
    lotId: lotOld,
    coaMatchStatus: 'matched',
    coaDocumentId: docOld1,
  });
  // An unmatched order line that has a PENDING suggestion for lotOld (so it
  // shows in order_lines via the suggestion branch, and feeds suggested_count).
  const unmatched = await makeOrderItem(seed.tenantId, {
    orderNumber: 'ORD-SUGGEST',
    poNumber: 'PO-2',
    customerName: 'Beta Corp',
    productId: productX,
    productName: 'Product X',
    quantity: 5,
    lotId: null,
    coaMatchStatus: 'unmatched',
  });
  await makeSuggestion(seed.tenantId, {
    orderItemId: unmatched.orderItemId,
    documentId: docOld1,
    lotId: lotOld,
    status: 'pending',
  });

  // lotMid — supplierB + productY. 1 COA doc, no matched orders.
  lotMid = await makeLot(seed.tenantId, {
    lotNumber: 'LOT-MID-002',
    lotKey: 'LOTMID002',
    supplierId: supplierB,
    productId: productY,
    createdAt: '2026-02-01 00:00:00',
  });
  const docMid = await makeDocument(seed.tenantId, 'COA Mid');
  await linkDocLot(docMid, lotMid);

  // lotNew — newest, bare (no supplier/product, no docs/orders).
  lotNew = await makeLot(seed.tenantId, {
    lotNumber: 'LOT-NEW-003',
    lotKey: 'LOTNEW003',
    createdAt: '2026-03-01 00:00:00',
  });

  // A lot in tenant 2, for cross-tenant isolation.
  otherTenantLot = await makeLot(seed.tenantId2, {
    lotNumber: 'OTHER-LOT',
    lotKey: 'OTHERLOT',
    createdAt: '2026-01-15 00:00:00',
  });
}, 30_000);

const user = () => ({ id: seed.userId, role: 'user', tenant_id: seed.tenantId });
const superUser = () => ({ id: seed.superAdminId, role: 'super_admin', tenant_id: null });

describe('GET /api/lots', () => {
  it('returns lots newest-first with correct rollup counts', async () => {
    const { status, body } = await doList(user());
    expect(status).toBe(200);
    expect(body.total).toBe(3);
    // Newest-first by created_at DESC.
    expect(body.lots.map((l: any) => l.id)).toEqual([lotNew, lotMid, lotOld]);

    const old = body.lots.find((l: any) => l.id === lotOld);
    expect(old.product_name).toBe('Product X');
    expect(old.supplier_name).toBe('Supplier A');
    expect(old.coa_document_count).toBe(2);
    expect(old.matched_order_count).toBe(1);
    expect(old.suggested_count).toBe(1);

    const mid = body.lots.find((l: any) => l.id === lotMid);
    expect(mid.coa_document_count).toBe(1);
    expect(mid.matched_order_count).toBe(0);
    expect(mid.suggested_count).toBe(0);

    const fresh = body.lots.find((l: any) => l.id === lotNew);
    expect(fresh.product_name).toBeNull();
    expect(fresh.supplier_name).toBeNull();
    expect(fresh.coa_document_count).toBe(0);
  });

  it('filters by supplier_id', async () => {
    const { body } = await doList(user(), `supplier_id=${supplierA}`);
    expect(body.total).toBe(1);
    expect(body.lots[0].id).toBe(lotOld);
  });

  it('filters by product_id', async () => {
    const { body } = await doList(user(), `product_id=${productY}`);
    expect(body.total).toBe(1);
    expect(body.lots[0].id).toBe(lotMid);
  });

  it('searches by lot number (case-insensitive)', async () => {
    const { body } = await doList(user(), `search=lot-mid`);
    expect(body.total).toBe(1);
    expect(body.lots[0].id).toBe(lotMid);
  });

  it('searches by lot key', async () => {
    const { body } = await doList(user(), `search=LOTOLD`);
    expect(body.total).toBe(1);
    expect(body.lots[0].id).toBe(lotOld);
  });

  it('paginates: limit caps the page but total reflects all matches', async () => {
    const { body } = await doList(user(), `limit=2&offset=0`);
    expect(body.total).toBe(3);
    expect(body.lots).toHaveLength(2);
    expect(body.lots.map((l: any) => l.id)).toEqual([lotNew, lotMid]);

    const page2 = await doList(user(), `limit=2&offset=2`);
    expect(page2.body.lots).toHaveLength(1);
    expect(page2.body.lots[0].id).toBe(lotOld);
  });

  it('does not leak other tenant lots to a regular user', async () => {
    const { body } = await doList(user());
    expect(body.lots.some((l: any) => l.id === otherTenantLot)).toBe(false);
  });

  it('super_admin scopes to ?tenant_id=', async () => {
    const t1 = await doList(superUser(), `tenant_id=${seed.tenantId}`);
    expect(t1.body.total).toBe(3);

    const t2 = await doList(superUser(), `tenant_id=${seed.tenantId2}`);
    expect(t2.body.total).toBe(1);
    expect(t2.body.lots[0].id).toBe(otherTenantLot);
  });

  it('super_admin without tenant_id sees all tenants', async () => {
    const { body } = await doList(superUser());
    expect(body.total).toBe(4);
  });
});

describe('GET /api/lots/:id', () => {
  it('returns full detail: lot + coa_documents + order_lines + suggestions', async () => {
    const { status, body } = await doGet(user(), lotOld);
    expect(status).toBe(200);

    expect(body.lot.id).toBe(lotOld);
    expect(body.lot.product_name).toBe('Product X');
    expect(body.lot.supplier_name).toBe('Supplier A');

    // 2 COA documents with file_names.
    expect(body.coa_documents).toHaveLength(2);
    const titles = body.coa_documents.map((d: any) => d.title).sort();
    expect(titles).toEqual(['COA Old One', 'COA Old Two']);
    expect(body.coa_documents.every((d: any) => d.file_name && d.file_name.endsWith('.pdf'))).toBe(true);

    // order_lines: 1 directly linked (matched) + 1 via pending suggestion.
    expect(body.order_lines).toHaveLength(2);
    const orderNums = body.order_lines.map((l: any) => l.order_number).sort();
    expect(orderNums).toEqual(['ORD-MATCHED', 'ORD-SUGGEST']);
    const matchedLine = body.order_lines.find((l: any) => l.order_number === 'ORD-MATCHED');
    expect(matchedLine.coa_match_status).toBe('matched');
    expect(matchedLine.po_number).toBe('PO-1');
    expect(matchedLine.customer_name).toBe('Acme Foods');
    expect(matchedLine.quantity).toBe(12);

    // 1 pending suggestion.
    expect(body.suggestions).toHaveLength(1);
    expect(body.suggestions[0].order_number).toBe('ORD-SUGGEST');
    expect(body.suggestions[0].status).toBe('pending');
    expect(body.suggestions[0].match_basis).toBe('lot_only');
  });

  it('returns empty arrays for a bare lot', async () => {
    const { status, body } = await doGet(user(), lotNew);
    expect(status).toBe(200);
    expect(body.coa_documents).toEqual([]);
    expect(body.order_lines).toEqual([]);
    expect(body.suggestions).toEqual([]);
  });

  it('404s on cross-tenant access', async () => {
    const { status } = await doGet(user(), otherTenantLot);
    expect(status).toBe(404);
  });

  it('404s on a non-existent lot', async () => {
    const { status } = await doGet(user(), 'does-not-exist');
    expect(status).toBe(404);
  });

  it('super_admin can read any tenant lot', async () => {
    const { status, body } = await doGet(superUser(), otherTenantLot);
    expect(status).toBe(200);
    expect(body.lot.id).toBe(otherTenantLot);
  });
});
