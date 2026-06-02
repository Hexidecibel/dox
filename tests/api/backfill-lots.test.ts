/**
 * Tests for POST /api/admin/backfill-lots.
 *
 * The backfill walks `documents` rows, pulls lot info out of
 * `primary_metadata` JSON, and funnels it through the existing
 * `attachLotToCoaDocument` helper (findOrCreateLot → document_lots →
 * order↔COA matcher). These tests cover:
 *
 *   - a doc whose lot matches an existing order line → lot + link created,
 *     order line bound (coa_document_id + matched).
 *   - a doc whose lot has no matching order → lot + link created, no bind.
 *   - a doc with no lot_number in metadata → skipped, nothing created.
 *   - idempotency: a second run creates no new lots / links.
 *   - super_admin scoping (non-super roles blocked) + tenant_id filter.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { seedTestData, generateTestId, cleanTables } from '../helpers/db';
import { onRequestPost as backfillPost } from '../../functions/api/admin/backfill-lots';
import { findOrCreateProduct } from '../../functions/lib/entities/products';

const db = env.DB;
let seed: Awaited<ReturnType<typeof seedTestData>>;

beforeEach(async () => {
  await cleanTables(db);
  seed = await seedTestData(db);
});

interface BackfillResult {
  documents_scanned: number;
  lots_created: number;
  links_created: number;
  orders_linked: number;
  skipped: number;
  errors: Array<{ document_id: string; error: string }>;
}

function makeContext(
  user: { id: string; role: string; tenant_id: string | null },
  query = ''
) {
  const request = new Request(
    `http://localhost/api/admin/backfill-lots${query}`,
    { method: 'POST' }
  );
  return {
    request,
    env,
    data: { user },
    params: {},
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
    functionPath: '/api/admin/backfill-lots',
  } as any;
}

const superUser = () => ({
  id: seed.superAdminId,
  role: 'super_admin',
  tenant_id: null,
});

async function insertDocument(opts: {
  tenantId: string;
  primaryMetadata: Record<string, unknown> | null;
  supplierId?: string | null;
}): Promise<string> {
  const id = generateTestId();
  await db
    .prepare(
      `INSERT INTO documents (id, tenant_id, title, created_by, supplier_id, primary_metadata)
       VALUES (?, ?, 'COA', ?, ?, ?)`
    )
    .bind(
      id,
      opts.tenantId,
      seed.userId,
      opts.supplierId ?? null,
      opts.primaryMetadata ? JSON.stringify(opts.primaryMetadata) : null
    )
    .run();
  return id;
}

/**
 * Seed an order line carrying only a RAW lot_number (no resolved lot_id) —
 * this mirrors the real connector path where the order side writes the lot as
 * free text and the COA side (this backfill) is what first materializes the
 * `lots` row. `linkCoaToOrders` normalizes the raw lot_number to find the
 * candidate, so the backfill both creates the lot AND binds the order line.
 */
async function insertOrderLineWithRawLot(opts: {
  tenantId: string;
  productId: string | null;
  lotNumber: string;
}): Promise<string> {
  const orderId = generateTestId();
  await db
    .prepare(
      `INSERT INTO orders (id, tenant_id, order_number, source_data) VALUES (?, ?, ?, '{}')`
    )
    .bind(orderId, opts.tenantId, `ORD-${orderId.slice(0, 6)}`)
    .run();
  const itemId = generateTestId();
  await db
    .prepare(
      `INSERT INTO order_items (id, order_id, product_id, product_name, lot_number)
       VALUES (?, ?, ?, 'Backfill Product', ?)`
    )
    .bind(itemId, orderId, opts.productId, opts.lotNumber)
    .run();
  return itemId;
}

describe('POST /api/admin/backfill-lots — auth gate', () => {
  it('blocks readers with 403', async () => {
    const resp = await backfillPost(
      makeContext({ id: seed.readerId, role: 'reader', tenant_id: seed.tenantId })
    );
    expect(resp.status).toBe(403);
  });

  it('blocks regular users with 403', async () => {
    const resp = await backfillPost(
      makeContext({ id: seed.userId, role: 'user', tenant_id: seed.tenantId })
    );
    expect(resp.status).toBe(403);
  });

  it('blocks org_admins with 403', async () => {
    const resp = await backfillPost(
      makeContext({
        id: seed.orgAdminId,
        role: 'org_admin',
        tenant_id: seed.tenantId,
      })
    );
    expect(resp.status).toBe(403);
  });

  it('allows super_admin', async () => {
    const resp = await backfillPost(makeContext(superUser()));
    expect(resp.status).toBe(200);
  });
});

describe('POST /api/admin/backfill-lots — extraction + linkage', () => {
  it('promotes a lot and binds a matching order line', async () => {
    const product = await findOrCreateProduct(db, seed.tenantId, 'Backfill Product');

    // Pre-existing order line shipped as lot 6141 for this product.
    const itemId = await insertOrderLineWithRawLot({
      tenantId: seed.tenantId,
      productId: product.id,
      lotNumber: '6141',
    });

    // COA doc with lot 6141 in primary_metadata, linked to the same product.
    const docId = await insertDocument({
      tenantId: seed.tenantId,
      primaryMetadata: {
        lot_number: '6141',
        code_date: '2026-01-15',
        expiration_date: '2027-01-15',
      },
    });
    await db
      .prepare(
        `INSERT INTO document_products (id, document_id, product_id) VALUES (?, ?, ?)`
      )
      .bind(generateTestId(), docId, product.id)
      .run();

    const resp = await backfillPost(makeContext(superUser()));
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as BackfillResult;

    expect(body.lots_created).toBe(1);
    expect(body.links_created).toBe(1);
    expect(body.orders_linked).toBe(1);
    expect(body.errors).toHaveLength(0);

    // document_lots row exists for the doc.
    const link = await db
      .prepare('SELECT lot_id FROM document_lots WHERE document_id = ?')
      .bind(docId)
      .first<{ lot_id: string }>();
    expect(link).toBeTruthy();

    // Lot carries the dates pulled from metadata.
    const lot = await db
      .prepare('SELECT code_date, expiration_date FROM lots WHERE id = ?')
      .bind(link!.lot_id)
      .first<{ code_date: string | null; expiration_date: string | null }>();
    expect(lot!.code_date).toBe('2026-01-15');
    expect(lot!.expiration_date).toBe('2027-01-15');

    // The order line got bound to the COA.
    const item = await db
      .prepare(
        'SELECT coa_document_id, coa_match_status FROM order_items WHERE id = ?'
      )
      .bind(itemId)
      .first<{ coa_document_id: string | null; coa_match_status: string }>();
    expect(item!.coa_document_id).toBe(docId);
    expect(item!.coa_match_status).toBe('matched');
  });

  it('promotes a lot with no matching order (link created, no bind)', async () => {
    const docId = await insertDocument({
      tenantId: seed.tenantId,
      primaryMetadata: { lot_number: 'ORPHAN-99' },
    });

    const resp = await backfillPost(makeContext(superUser()));
    const body = (await resp.json()) as BackfillResult;

    expect(body.lots_created).toBe(1);
    expect(body.links_created).toBe(1);
    expect(body.orders_linked).toBe(0);

    const link = await db
      .prepare('SELECT id FROM document_lots WHERE document_id = ?')
      .bind(docId)
      .first();
    expect(link).toBeTruthy();
  });

  it('skips a document with no lot_number in metadata', async () => {
    await insertDocument({
      tenantId: seed.tenantId,
      primaryMetadata: { supplier: 'Acme', some_other_field: 'x' },
    });

    const resp = await backfillPost(makeContext(superUser()));
    const body = (await resp.json()) as BackfillResult;

    expect(body.documents_scanned).toBe(1);
    expect(body.skipped).toBe(1);
    expect(body.lots_created).toBe(0);
    expect(body.links_created).toBe(0);

    const lots = await db
      .prepare('SELECT COUNT(*) AS c FROM lots WHERE tenant_id = ?')
      .bind(seed.tenantId)
      .first<{ c: number }>();
    expect(Number(lots!.c)).toBe(0);
  });

  it('is idempotent — a second run creates nothing new', async () => {
    await insertDocument({
      tenantId: seed.tenantId,
      primaryMetadata: { lot_number: 'IDEM-1' },
    });

    const first = (await (
      await backfillPost(makeContext(superUser()))
    ).json()) as BackfillResult;
    expect(first.lots_created).toBe(1);
    expect(first.links_created).toBe(1);

    const second = (await (
      await backfillPost(makeContext(superUser()))
    ).json()) as BackfillResult;
    expect(second.documents_scanned).toBe(1);
    expect(second.lots_created).toBe(0);
    expect(second.links_created).toBe(0);

    const lots = await db
      .prepare('SELECT COUNT(*) AS c FROM lots WHERE tenant_id = ?')
      .bind(seed.tenantId)
      .first<{ c: number }>();
    expect(Number(lots!.c)).toBe(1);

    const links = await db
      .prepare(
        `SELECT COUNT(*) AS c FROM document_lots dl
         JOIN documents d ON d.id = dl.document_id
         WHERE d.tenant_id = ?`
      )
      .bind(seed.tenantId)
      .first<{ c: number }>();
    expect(Number(links!.c)).toBe(1);
  });
});

describe('POST /api/admin/backfill-lots — scoping', () => {
  it('processes all tenants by default', async () => {
    await insertDocument({
      tenantId: seed.tenantId,
      primaryMetadata: { lot_number: 'T1-LOT' },
    });
    await insertDocument({
      tenantId: seed.tenantId2,
      primaryMetadata: { lot_number: 'T2-LOT' },
    });

    const resp = await backfillPost(makeContext(superUser()));
    const body = (await resp.json()) as BackfillResult;

    expect(body.documents_scanned).toBe(2);
    expect(body.lots_created).toBe(2);
  });

  it('respects the tenant_id filter', async () => {
    await insertDocument({
      tenantId: seed.tenantId,
      primaryMetadata: { lot_number: 'T1-ONLY' },
    });
    await insertDocument({
      tenantId: seed.tenantId2,
      primaryMetadata: { lot_number: 'T2-SHOULD-SKIP' },
    });

    const resp = await backfillPost(
      makeContext(superUser(), `?tenant_id=${seed.tenantId}`)
    );
    const body = (await resp.json()) as BackfillResult;

    expect(body.documents_scanned).toBe(1);
    expect(body.lots_created).toBe(1);

    // Tenant 2 untouched.
    const t2lots = await db
      .prepare('SELECT COUNT(*) AS c FROM lots WHERE tenant_id = ?')
      .bind(seed.tenantId2)
      .first<{ c: number }>();
    expect(Number(t2lots!.c)).toBe(0);
  });

  it('honors limit + offset for batched runs', async () => {
    for (let i = 0; i < 3; i++) {
      await insertDocument({
        tenantId: seed.tenantId,
        primaryMetadata: { lot_number: `BATCH-${i}` },
      });
    }

    const page1 = (await (
      await backfillPost(makeContext(superUser(), '?limit=2&offset=0'))
    ).json()) as BackfillResult;
    expect(page1.documents_scanned).toBe(2);
    expect(page1.lots_created).toBe(2);

    const page2 = (await (
      await backfillPost(makeContext(superUser(), '?limit=2&offset=2'))
    ).json()) as BackfillResult;
    expect(page2.documents_scanned).toBe(1);
    expect(page2.lots_created).toBe(1);

    const lots = await db
      .prepare('SELECT COUNT(*) AS c FROM lots WHERE tenant_id = ?')
      .bind(seed.tenantId)
      .first<{ c: number }>();
    expect(Number(lots!.c)).toBe(3);
  });
});
