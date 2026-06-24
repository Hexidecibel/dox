/**
 * Tests for POST /api/admin/rematch-lots.
 *
 * Re-runs `linkOrderToCoas` for every lot-bound order_item in scope so a
 * matcher change (distributor-code auto-confirm) can retroactively link
 * existing data. Covers:
 *   - distributor codes agree across diverging products → STRONG link made,
 *     counts returned.
 *   - non-super roles are tenant-scoped; non-admins blocked.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { runMigrations, seedTestData, generateTestId, cleanTables } from '../helpers/db';
import { findOrCreateLot } from '../../functions/lib/entities/lots';
import { onRequestPost as rematchPost } from '../../functions/api/admin/rematch-lots';

const db = env.DB;
let seed: Awaited<ReturnType<typeof seedTestData>>;

beforeEach(async () => {
  await runMigrations(db);
  await cleanTables(db);
  seed = await seedTestData(db);
}, 30_000);

interface RematchResult {
  order_items_processed: number;
  strong_links_made: number;
  suggestions_created: number;
}

function makeContext(
  user: { id: string; role: string; tenant_id: string | null },
  query = ''
) {
  return {
    request: new Request(`http://localhost/api/admin/rematch-lots${query}`, {
      method: 'POST',
    }),
    env,
    data: { user },
    params: {},
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
    functionPath: '/api/admin/rematch-lots',
  } as any;
}

async function makeProduct(tenantId: string, name: string): Promise<string> {
  const id = generateTestId();
  await db
    .prepare('INSERT INTO products (id, tenant_id, name, slug, active) VALUES (?, ?, ?, ?, 1)')
    .bind(id, tenantId, name, `${name.toLowerCase().replace(/\s+/g, '-')}-${id.slice(0, 6)}`)
    .run();
  return id;
}

async function makeCoaDoc(tenantId: string, title: string): Promise<string> {
  const id = generateTestId();
  await db
    .prepare(
      `INSERT INTO documents (id, tenant_id, title, tags, current_version, status, created_by)
       VALUES (?, ?, ?, '[]', 1, 'active', ?)`
    )
    .bind(id, tenantId, title, seed.userId)
    .run();
  return id;
}

async function makeOrderItem(
  tenantId: string,
  item: { productId: string | null; productCode: string | null; lotId: string }
): Promise<string> {
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
    .bind(orderItemId, orderId, item.productId, item.productCode, item.lotId, null)
    .run();
  return orderItemId;
}

async function getOrderItem(id: string) {
  return db
    .prepare('SELECT coa_document_id, coa_match_status FROM order_items WHERE id = ?')
    .bind(id)
    .first<{ coa_document_id: string | null; coa_match_status: string }>();
}

describe('POST /api/admin/rematch-lots', () => {
  it('retroactively makes a STRONG link when distributor codes agree', async () => {
    const orderProduct = await makeProduct(seed.tenantId, 'WILL CAGE FREE WHOLE LIQ');
    const coaProduct = await makeProduct(seed.tenantId, 'Willamette Cage-Free Liquid Whole Egg');

    // COA: title code "1167", lot 6141, product B — already in the graph.
    const docId = await makeCoaDoc(
      seed.tenantId,
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

    // Order line: code "1167", lot 6141, product A — link NOT yet made.
    const orderLot = await findOrCreateLot(db, seed.tenantId, {
      lotNumber: '6141',
      productId: orderProduct,
    });
    const orderItemId = await makeOrderItem(seed.tenantId, {
      productId: orderProduct,
      productCode: '1167',
      lotId: orderLot!.id,
    });

    // Precondition: unmatched.
    expect((await getOrderItem(orderItemId))!.coa_document_id).toBeNull();

    const res = await rematchPost(makeContext(superUser()));
    expect(res.status).toBe(200);
    const body = (await res.json()) as RematchResult;

    expect(body.order_items_processed).toBe(1);
    expect(body.strong_links_made).toBe(1);

    const oi = await getOrderItem(orderItemId);
    expect(oi!.coa_document_id).toBe(docId);
    expect(oi!.coa_match_status).toBe('matched');
  });

  it('flips a date_code + product-map CMF pair from unmatched to matched (0075)', async () => {
    const supplierId = generateTestId();
    await db
      .prepare(
        "INSERT INTO suppliers (id, tenant_id, name, slug, lot_scheme) VALUES (?, ?, ?, ?, 'date_code')"
      )
      .bind(supplierId, seed.tenantId, 'Country Morning Farms', `cmf-${supplierId.slice(0, 6)}`)
      .run();

    const coaProductId = await makeProduct(seed.tenantId, 'Milk - Whole');
    const orderProductId = await makeProduct(seed.tenantId, '0417 MS WHOLE 5 GL BAG');

    // Teach the bridge: COA name → order product.
    await db
      .prepare(
        `INSERT INTO supplier_product_map
           (id, tenant_id, supplier_id, coa_product_name_key, order_product_id)
         VALUES (?, ?, ?, 'MILK WHOLE', ?)`
      )
      .bind(generateTestId(), seed.tenantId, supplierId, orderProductId)
      .run();

    // COA already in the graph: bare-date lot (stripped), doc + product link.
    const docId = await makeCoaDoc(seed.tenantId, 'CMF Whole Milk COA');
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

    // Order line: bare-date lot, order product, NO link yet.
    const orderLot = await findOrCreateLot(db, seed.tenantId, {
      lotNumber: '061626',
      productId: orderProductId,
    });
    const orderItemId = await makeOrderItem(seed.tenantId, {
      productId: orderProductId,
      productCode: null,
      lotId: orderLot!.id,
    });

    // Both lots share the bare-date lot_key "061626" (the date_code scheme
    // stripped the COA suffix); they are distinct rows only because the COA and
    // order products differ — the map bridges them at classify time. The
    // matcher keys on lot_key, so the candidate join still finds the COA.
    expect((await getOrderItem(orderItemId))!.coa_document_id).toBeNull();

    const res = await rematchPost(makeContext(superUser()));
    expect(res.status).toBe(200);
    const body = (await res.json()) as RematchResult;
    expect(body.strong_links_made).toBe(1);

    const oi = await getOrderItem(orderItemId);
    expect(oi!.coa_document_id).toBe(docId);
    expect(oi!.coa_match_status).toBe('matched');
  });

  it('blocks non-admin roles', async () => {
    const res = await rematchPost(
      makeContext({ id: seed.userId, role: 'user', tenant_id: seed.tenantId })
    );
    expect(res.status).toBe(403);
  });

  it('org_admin is scoped to their own tenant', async () => {
    // Seed a linkable pair in tenant 1.
    const orderProduct = await makeProduct(seed.tenantId, 'A');
    const coaProduct = await makeProduct(seed.tenantId, 'B');
    const docId = await makeCoaDoc(seed.tenantId, '(1167) LOT 6141');
    const coaLot = await findOrCreateLot(db, seed.tenantId, { lotNumber: '6141', productId: coaProduct });
    await db
      .prepare('INSERT INTO document_lots (id, document_id, lot_id) VALUES (?, ?, ?)')
      .bind(generateTestId(), docId, coaLot!.id)
      .run();
    const orderLot = await findOrCreateLot(db, seed.tenantId, { lotNumber: '6141', productId: orderProduct });
    await makeOrderItem(seed.tenantId, { productId: orderProduct, productCode: '1167', lotId: orderLot!.id });

    // org_admin of tenant 2 runs it — sees zero of tenant 1's items.
    const res = await rematchPost(
      makeContext({ id: seed.orgAdmin2Id, role: 'org_admin', tenant_id: seed.tenantId2 })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as RematchResult;
    expect(body.order_items_processed).toBe(0);
    expect(body.strong_links_made).toBe(0);
  });
});

const superUser = () => ({
  id: seed.superAdminId,
  role: 'super_admin',
  tenant_id: null,
});
