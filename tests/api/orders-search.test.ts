/**
 * Integration tests for GET /api/orders ?search=… — FTS5 backed
 * (Phase 4c of the Document Search v2 plan).
 *
 * Phase 4c swaps the LIKE-based `?search=` branch on the orders list
 * endpoint to `orders_fts MATCH ?`. The response shape stays the same
 * (`{ orders, total, limit, offset }`); only the matching internals
 * change. Multi-token AND, tenant isolation, and pre-existing structured
 * filters (status, customer_id, connector_id) are exercised.
 *
 * Drives onRequestGet directly — SELF.fetch isn't wired up.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { seedTestData, generateTestId } from '../helpers/db';
import { onRequestGet as ordersGet } from '../../functions/api/orders/index';

const db = env.DB;
let seed: Awaited<ReturnType<typeof seedTestData>>;

let orderAcmeId: string;          // tenant A — customer "Acme Corp", PO ABC-001
let orderAcmeBetaId: string;      // tenant A — customer "Acme Beta",  PO ABC-002
let orderUnrelatedId: string;     // tenant A — customer "Other Co",   PO XYZ-999
let orderCrossTenantId: string;   // tenant B — customer "Acme Cross"

function makeContext(
  url: string,
  user: { id: string; role: string; tenant_id: string | null },
): any {
  return {
    request: new Request(url, { method: 'GET' }),
    env,
    data: { user },
    params: {},
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
    functionPath: '/api/orders',
  };
}

async function listOrders(
  qs: string,
  user: { id: string; role: string; tenant_id: string | null },
) {
  const res = await ordersGet(makeContext(`http://localhost/api/orders?${qs}`, user));
  return { status: res.status, body: (await res.json()) as any };
}

beforeAll(async () => {
  seed = await seedTestData(db);

  orderAcmeId = `srch4ord-A-${generateTestId().slice(0, 8)}`;
  orderAcmeBetaId = `srch4ord-B-${generateTestId().slice(0, 8)}`;
  orderUnrelatedId = `srch4ord-U-${generateTestId().slice(0, 8)}`;
  orderCrossTenantId = `srch4ord-X-${generateTestId().slice(0, 8)}`;

  await db.prepare(
    `INSERT INTO orders (id, tenant_id, order_number, po_number, customer_name, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'pending', datetime('now'), datetime('now'))`,
  ).bind(orderAcmeId, seed.tenantId, `O-${orderAcmeId.slice(-6)}`, 'PO-NAT-ABC-001', 'Acme4 Corp').run();

  await db.prepare(
    `INSERT INTO orders (id, tenant_id, order_number, po_number, customer_name, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'pending', datetime('now'), datetime('now'))`,
  ).bind(orderAcmeBetaId, seed.tenantId, `O-${orderAcmeBetaId.slice(-6)}`, 'PO-NAT-ABC-002', 'Acme4 Beta').run();

  await db.prepare(
    `INSERT INTO orders (id, tenant_id, order_number, po_number, customer_name, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'pending', datetime('now'), datetime('now'))`,
  ).bind(orderUnrelatedId, seed.tenantId, `O-${orderUnrelatedId.slice(-6)}`, 'PO-NAT-XYZ-999', 'Other4 Co').run();

  await db.prepare(
    `INSERT INTO orders (id, tenant_id, order_number, po_number, customer_name, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'pending', datetime('now'), datetime('now'))`,
  ).bind(orderCrossTenantId, seed.tenantId2, `O-${orderCrossTenantId.slice(-6)}`, 'PO-NAT-CROSS', 'Acme4 Cross').run();

  // One order item with a unique lot_number for "search by lot" coverage.
  await db.prepare(
    `INSERT INTO order_items (id, order_id, product_name, lot_number, created_at)
     VALUES (?, ?, ?, ?, datetime('now'))`,
  ).bind(generateTestId(), orderAcmeId, 'Cheddar Wheel', 'NATLOT-7771').run();
}, 60_000);

describe('GET /api/orders ?search= — FTS5 backbone', () => {
  const orgAdmin = {
    id: 'user-org-admin',
    role: 'org_admin',
    tenant_id: 'test-tenant-001',
  };
  const otherOrgAdmin = {
    id: 'user-org-admin-2',
    role: 'org_admin',
    tenant_id: 'test-tenant-002',
  };

  it('keeps the existing response shape', async () => {
    const { status, body } = await listOrders(`tenant_id=${seed.tenantId}`, orgAdmin);
    expect(status).toBe(200);
    expect(body).toHaveProperty('orders');
    expect(body).toHaveProperty('total');
    expect(body).toHaveProperty('limit');
    expect(body).toHaveProperty('offset');
  });

  it('matches by customer_name', async () => {
    const { body } = await listOrders(
      `tenant_id=${seed.tenantId}&search=Acme4`,
      orgAdmin,
    );
    const ids = body.orders.map((o: { id: string }) => o.id);
    expect(ids).toContain(orderAcmeId);
    expect(ids).toContain(orderAcmeBetaId);
    expect(ids).not.toContain(orderUnrelatedId);
  });

  it('matches by po_number', async () => {
    const { body } = await listOrders(
      `tenant_id=${seed.tenantId}&search=PO-NAT-ABC-001`,
      orgAdmin,
    );
    const ids = body.orders.map((o: { id: string }) => o.id);
    expect(ids).toContain(orderAcmeId);
    expect(ids).not.toContain(orderAcmeBetaId);
    expect(ids).not.toContain(orderUnrelatedId);
  });

  it('matches by lot_number on order_items', async () => {
    const { body } = await listOrders(
      `tenant_id=${seed.tenantId}&search=NATLOT-7771`,
      orgAdmin,
    );
    const ids = body.orders.map((o: { id: string }) => o.id);
    expect(ids).toContain(orderAcmeId);
  });

  it('multi-token AND — both tokens must appear (across columns OK)', async () => {
    // Cross-column AND: PO-NAT-ABC-002 is on orderAcmeBetaId, and
    // "Beta" is the customer_name. Multi-token AND matches a doc when
    // each token appears anywhere in the indexed columns. LIKE-based
    // search would FAIL this — `customer_name LIKE '%PO-NAT-ABC-002 Beta%'`
    // is never true because the words live in different columns.
    const { body } = await listOrders(
      `tenant_id=${seed.tenantId}&search=${encodeURIComponent('PO-NAT-ABC-002 Beta')}`,
      orgAdmin,
    );
    const ids = body.orders.map((o: { id: string }) => o.id);
    expect(ids).toContain(orderAcmeBetaId);
    expect(ids).not.toContain(orderAcmeId); // has neither term
  });

  it('respects tenant isolation (no cross-tenant matches)', async () => {
    const { body } = await listOrders(
      `tenant_id=${seed.tenantId}&search=Acme4`,
      orgAdmin,
    );
    const ids = body.orders.map((o: { id: string }) => o.id);
    expect(ids).not.toContain(orderCrossTenantId);
  });

  it('non-admins are forced to their own tenant (cross-tenant search via param ignored)', async () => {
    const { body } = await listOrders(
      `tenant_id=${seed.tenantId}&search=Acme4`,
      otherOrgAdmin,
    );
    const ids = body.orders.map((o: { id: string }) => o.id);
    expect(ids).toContain(orderCrossTenantId);
    expect(ids).not.toContain(orderAcmeId);
  });

  it('FTS5 operator sanitization: q with operators returns 200', async () => {
    const { status } = await listOrders(
      `tenant_id=${seed.tenantId}&search=${encodeURIComponent('*"():-')}`,
      orgAdmin,
    );
    expect(status).toBe(200);
  });

  it('empty search param falls back to listing all orders for the tenant', async () => {
    const { body } = await listOrders(
      `tenant_id=${seed.tenantId}`,
      orgAdmin,
    );
    const ids = body.orders.map((o: { id: string }) => o.id);
    expect(ids).toContain(orderAcmeId);
    expect(ids).toContain(orderUnrelatedId);
  });
});
