/**
 * DB-backed tests for the `order` producer (functions/lib/kinds/order.ts).
 *
 * These reproduce and pin the 2026-06 production failure: a manually-imported
 * "Order report" extracted 12 header-only orders (order_number set, items:[])
 * plus distinct customers, and ingestOrders persisted 0 orders / ~1 customer
 * because the per-record INSERTs threw and were swallowed into output.errors.
 *
 * Root cause: results.ts passed connectorId/connectorRunId as '' (empty string)
 * instead of null, and the orders.connector_id / connector_run_id FK columns
 * reject '' — every order INSERT hit a FOREIGN KEY constraint and was swallowed.
 *
 * Drives ingestOrders directly against env.DB (cloudflare:test).
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { runMigrations, seedTestData, cleanTables, generateTestId } from '../helpers/db';
import { ingestOrders } from '../../functions/lib/kinds/order';
import { findOrCreateLot } from '../../functions/lib/entities/lots';
import type { ConnectorOutput } from '../../functions/lib/connectors/types';

const db = env.DB;
let seed: Awaited<ReturnType<typeof seedTestData>>;

beforeAll(async () => {
  await runMigrations(db);
  seed = await seedTestData(db);
});

beforeEach(async () => {
  await cleanTables(db);
  // cleanTables doesn't cover customers / customer_contacts; wipe them so each
  // test starts with zero customers and create/update counts are deterministic.
  await db.prepare('DELETE FROM customer_contacts').run().catch(() => {});
  await db.prepare('DELETE FROM customers').run().catch(() => {});
  seed = await seedTestData(db);
});

/** Build the EXACT prod shape: header-only orders + customers, items: []. */
function buildOrderReport(): ConnectorOutput {
  return {
    orders: [
      { order_number: '1795128', customer_number: 'C-100', customer_name: 'Acme Foods', items: [], source_data: {}, _confidence: 0.7 },
      { order_number: '1795129', customer_number: 'C-200', customer_name: 'Beta Dairy', items: [], source_data: {}, _confidence: 0.7 },
      { order_number: '1795130', customer_number: 'C-300', customer_name: 'Gamma Co', items: [], source_data: {}, _confidence: 0.7 },
    ],
    customers: [
      { customer_number: 'C-100', name: 'Acme Foods', _confidence: 0.7 },
      { customer_number: 'C-200', name: 'Beta Dairy', _confidence: 0.7 },
      { customer_number: 'C-300', name: 'Gamma Co', _confidence: 0.7 },
    ],
    errors: [],
    info: [],
  } as unknown as ConnectorOutput;
}

describe('ingestOrders — header-only orders with null connector refs (prod repro)', () => {
  it('persists every header-only order when connector refs are null', async () => {
    const output = buildOrderReport();
    const result = await ingestOrders(db, output, {
      tenantId: seed.tenantId,
      connectorId: null,
      connectorRunId: null,
    });

    // The bug: 0 orders persisted. The fix: all 3.
    expect(result.ordersCreated).toBe(3);
    expect(result.customersCreated).toBe(3);
    expect(result.errors).toBe(0);
    expect(result.errorMessages).toEqual([]);
    // output.errors must NOT have hidden a swallowed FK failure.
    expect(output.errors).toEqual([]);

    const orderRows = await db
      .prepare('SELECT order_number, connector_id, connector_run_id, customer_id FROM orders WHERE tenant_id = ? ORDER BY order_number')
      .bind(seed.tenantId)
      .all<{ order_number: string; connector_id: string | null; connector_run_id: string | null; customer_id: string | null }>();
    expect(orderRows.results.map(r => r.order_number)).toEqual(['1795128', '1795129', '1795130']);
    // FK columns must be real NULL, not ''.
    for (const r of orderRows.results) {
      expect(r.connector_id).toBeNull();
      expect(r.connector_run_id).toBeNull();
      // Customer resolved from customer_number.
      expect(r.customer_id).not.toBeNull();
    }
  });

  it('is idempotent: re-running upserts rather than duplicating', async () => {
    await ingestOrders(db, buildOrderReport(), { tenantId: seed.tenantId, connectorId: null, connectorRunId: null });
    const second = await ingestOrders(db, buildOrderReport(), { tenantId: seed.tenantId, connectorId: null, connectorRunId: null });

    // Second pass creates nothing new.
    expect(second.ordersCreated).toBe(0);
    expect(second.customersCreated).toBe(0);

    const orderCount = await db.prepare('SELECT COUNT(*) as n FROM orders WHERE tenant_id = ?').bind(seed.tenantId).first<{ n: number }>();
    const custCount = await db.prepare('SELECT COUNT(*) as n FROM customers WHERE tenant_id = ?').bind(seed.tenantId).first<{ n: number }>();
    expect(orderCount?.n).toBe(3);
    expect(custCount?.n).toBe(3);
  });

  it('stores what it can: one bad record does not abort the batch, and failures are surfaced', async () => {
    const output: ConnectorOutput = {
      orders: [
        { order_number: '1795128', customer_number: 'C-100', items: [], source_data: {} },
        { order_number: '', items: [], source_data: {} } as any, // missing order_number → must be reported, not crash
        { order_number: '1795130', items: [], source_data: {} },
      ],
      customers: [
        { customer_number: 'C-100', name: 'Acme Foods' },
        { customer_number: '', name: 'No Number' } as any, // missing customer_number → reported
      ],
      errors: [],
      info: [],
    } as unknown as ConnectorOutput;

    const result = await ingestOrders(db, output, { tenantId: seed.tenantId, connectorId: null, connectorRunId: null });

    // The 2 valid orders persisted; the 2 bad records are surfaced.
    expect(result.ordersCreated).toBe(2);
    expect(result.customersCreated).toBe(1);
    expect(result.errors).toBe(2);
    expect(result.errorMessages.length).toBe(2);
    expect(result.errorMessages.some(m => /order_number/i.test(m))).toBe(true);
    expect(result.errorMessages.some(m => /customer_number/i.test(m))).toBe(true);
  });
});

describe('ingestOrders — accumulative lot linkage (store now, link when lot arrives)', () => {
  it('binds order_items.lot_id + coa_document_id when an order line matches an existing COA-linked lot', async () => {
    const tenantId = seed.tenantId;

    // 1. A COA document already on file, linked to a lot (the COA side).
    const productId = generateTestId();
    await db.prepare('INSERT INTO products (id, tenant_id, name, slug, active) VALUES (?, ?, ?, ?, 1)')
      .bind(productId, tenantId, 'Whole Milk', `whole-milk-${productId.slice(0, 6)}`).run();

    const coaDocId = generateTestId();
    await db.prepare(
      `INSERT INTO documents (id, tenant_id, title, tags, current_version, status, created_by)
       VALUES (?, ?, 'COA LOT-XYZ', '[]', 1, 'active', ?)`
    ).bind(coaDocId, tenantId, seed.userId).run();

    // Create the lot the COA certifies, then link it.
    const coaLot = await findOrCreateLot(db, tenantId, {
      lotNumber: 'LOT-XYZ',
      productId,
      source: 'coa',
    });
    expect(coaLot).not.toBeNull();
    await db.prepare('INSERT INTO document_lots (id, document_id, lot_id) VALUES (?, ?, ?)')
      .bind(generateTestId(), coaDocId, coaLot!.id).run();

    // 2. Now an order arrives with a line carrying the SAME product + lot.
    const output: ConnectorOutput = {
      orders: [
        {
          order_number: 'ORD-1',
          customer_number: 'C-1',
          items: [
            { product_name: 'Whole Milk', lot_number: 'LOT-XYZ', quantity: 10 },
          ],
          source_data: {},
        },
      ],
      customers: [{ customer_number: 'C-1', name: 'Customer One' }],
      errors: [],
      info: [],
    } as unknown as ConnectorOutput;

    const result = await ingestOrders(db, output, { tenantId, connectorId: null, connectorRunId: null });
    expect(result.ordersCreated).toBe(1);
    expect(result.errors).toBe(0);

    // The order line must be bound to the lot AND to the existing COA document.
    const item = await db.prepare(
      `SELECT oi.lot_id, oi.coa_document_id, oi.coa_match_status
       FROM order_items oi JOIN orders o ON o.id = oi.order_id
       WHERE o.tenant_id = ? AND o.order_number = 'ORD-1'`
    ).bind(tenantId).first<{ lot_id: string | null; coa_document_id: string | null; coa_match_status: string | null }>();

    expect(item).not.toBeNull();
    expect(item!.lot_id).toBe(coaLot!.id);
    expect(item!.coa_document_id).toBe(coaDocId);
    expect(item!.coa_match_status).toBe('matched');
  });

  it('header-only order persists now and links later when the lot arrives via a re-run', async () => {
    const tenantId = seed.tenantId;
    const productId = generateTestId();
    await db.prepare('INSERT INTO products (id, tenant_id, name, slug, active) VALUES (?, ?, ?, ?, 1)')
      .bind(productId, tenantId, 'Cream', `cream-${productId.slice(0, 6)}`).run();

    // First: a header-only order (no items, no lot). Must persist.
    await ingestOrders(db, {
      orders: [{ order_number: 'ORD-9', customer_number: 'C-9', items: [], source_data: {} }],
      customers: [{ customer_number: 'C-9', name: 'Cust Nine' }],
      errors: [],
      info: [],
    } as unknown as ConnectorOutput, { tenantId, connectorId: null, connectorRunId: null });

    let order = await db.prepare("SELECT id FROM orders WHERE tenant_id = ? AND order_number = 'ORD-9'")
      .bind(tenantId).first<{ id: string }>();
    expect(order).not.toBeNull();

    // Later: the COA for the lot lands.
    const coaDocId = generateTestId();
    await db.prepare(
      `INSERT INTO documents (id, tenant_id, title, tags, current_version, status, created_by)
       VALUES (?, ?, 'COA LOT-9', '[]', 1, 'active', ?)`
    ).bind(coaDocId, tenantId, seed.userId).run();
    const coaLot = await findOrCreateLot(db, tenantId, { lotNumber: 'LOT-9', productId, source: 'coa' });
    await db.prepare('INSERT INTO document_lots (id, document_id, lot_id) VALUES (?, ?, ?)')
      .bind(generateTestId(), coaDocId, coaLot!.id).run();

    // Re-run the SAME order, now enriched with the line + lot (idempotent upsert).
    const result = await ingestOrders(db, {
      orders: [{
        order_number: 'ORD-9',
        customer_number: 'C-9',
        items: [{ product_name: 'Cream', lot_number: 'LOT-9', quantity: 5 }],
        source_data: {},
      }],
      customers: [{ customer_number: 'C-9', name: 'Cust Nine' }],
      errors: [],
      info: [],
    } as unknown as ConnectorOutput, { tenantId, connectorId: null, connectorRunId: null });

    // Still one order (upsert), now with a bound line.
    expect(result.ordersCreated).toBe(0);
    const orderCount = await db.prepare('SELECT COUNT(*) as n FROM orders WHERE tenant_id = ?').bind(tenantId).first<{ n: number }>();
    expect(orderCount?.n).toBe(1);

    const item = await db.prepare(
      `SELECT oi.lot_id, oi.coa_document_id FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       WHERE o.tenant_id = ? AND o.order_number = 'ORD-9'`
    ).bind(tenantId).first<{ lot_id: string | null; coa_document_id: string | null }>();
    expect(item!.lot_id).toBe(coaLot!.id);
    expect(item!.coa_document_id).toBe(coaDocId);
  });
});
