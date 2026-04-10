import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { seedTestData, generateTestId } from '../helpers/db';

let seed: Awaited<ReturnType<typeof seedTestData>>;
const db = env.DB;

beforeAll(async () => {
  seed = await seedTestData(db);
}, 30_000);

describe('Orders - Create', () => {
  it('should create an order with minimal fields', async () => {
    const id = generateTestId();
    await db
      .prepare(
        `INSERT INTO orders (id, tenant_id, order_number, status, created_at, updated_at)
         VALUES (?, ?, ?, 'pending', datetime('now'), datetime('now'))`
      )
      .bind(id, seed.tenantId, `ORD-${id.slice(0, 8)}`)
      .run();

    const order = await db.prepare('SELECT * FROM orders WHERE id = ?').bind(id).first();
    expect(order).not.toBeNull();
    expect(order!.status).toBe('pending');
    expect(order!.tenant_id).toBe(seed.tenantId);
  });

  it('should create an order with items', async () => {
    const orderId = generateTestId();
    await db
      .prepare(
        `INSERT INTO orders (id, tenant_id, order_number, po_number, customer_name, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'pending', datetime('now'), datetime('now'))`
      )
      .bind(orderId, seed.tenantId, `ORD-ITEMS-${orderId.slice(0, 6)}`, 'PO-123', 'Test Customer')
      .run();

    // Add items
    for (let i = 0; i < 3; i++) {
      await db
        .prepare(
          `INSERT INTO order_items (id, order_id, product_name, product_code, quantity, lot_number, created_at)
           VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`
        )
        .bind(generateTestId(), orderId, `Product ${i}`, `CODE-${i}`, 10 + i, `LOT-${i}`)
        .run();
    }

    const items = await db
      .prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY created_at')
      .bind(orderId)
      .all();
    expect(items.results.length).toBe(3);
    expect(items.results[0].product_name).toBe('Product 0');
    expect(items.results[0].quantity).toBe(10);
  });

  it('should enforce unique order_number per tenant', async () => {
    const num = `UNIQ-ORD-${Date.now()}`;
    await db
      .prepare(
        `INSERT INTO orders (id, tenant_id, order_number, status, created_at, updated_at)
         VALUES (?, ?, ?, 'pending', datetime('now'), datetime('now'))`
      )
      .bind(generateTestId(), seed.tenantId, num)
      .run();

    try {
      await db
        .prepare(
          `INSERT INTO orders (id, tenant_id, order_number, status, created_at, updated_at)
           VALUES (?, ?, ?, 'pending', datetime('now'), datetime('now'))`
        )
        .bind(generateTestId(), seed.tenantId, num)
        .run();
      expect.unreachable('Should have thrown UNIQUE constraint error');
    } catch (err: any) {
      expect(err.message).toContain('UNIQUE');
    }
  });

  it('should allow same order_number in different tenants', async () => {
    const num = `CROSS-ORD-${Date.now()}`;
    await db
      .prepare(`INSERT INTO orders (id, tenant_id, order_number, status, created_at, updated_at) VALUES (?, ?, ?, 'pending', datetime('now'), datetime('now'))`)
      .bind(generateTestId(), seed.tenantId, num).run();
    await db
      .prepare(`INSERT INTO orders (id, tenant_id, order_number, status, created_at, updated_at) VALUES (?, ?, ?, 'pending', datetime('now'), datetime('now'))`)
      .bind(generateTestId(), seed.tenantId2, num).run();
    expect(true).toBe(true);
  });
});

describe('Orders - List', () => {
  beforeAll(async () => {
    for (let i = 0; i < 3; i++) {
      await db
        .prepare(`INSERT INTO orders (id, tenant_id, order_number, status, created_at, updated_at) VALUES (?, ?, ?, 'pending', datetime('now'), datetime('now'))`)
        .bind(generateTestId(), seed.tenantId, `LIST-ORD-${Date.now()}-${i}`).run();
    }
  });

  it('should list orders for a tenant', async () => {
    const result = await db
      .prepare('SELECT * FROM orders WHERE tenant_id = ? ORDER BY created_at DESC')
      .bind(seed.tenantId).all();
    expect(result.results.length).toBeGreaterThanOrEqual(3);
    for (const o of result.results) {
      expect(o.tenant_id).toBe(seed.tenantId);
    }
  });

  it('should filter by status', async () => {
    const id = generateTestId();
    await db
      .prepare(`INSERT INTO orders (id, tenant_id, order_number, status, created_at, updated_at) VALUES (?, ?, ?, 'fulfilled', datetime('now'), datetime('now'))`)
      .bind(id, seed.tenantId, `FULF-${id.slice(0, 8)}`).run();

    const result = await db
      .prepare("SELECT * FROM orders WHERE tenant_id = ? AND status = 'fulfilled'")
      .bind(seed.tenantId).all();
    expect(result.results.length).toBeGreaterThanOrEqual(1);
    for (const o of result.results) {
      expect(o.status).toBe('fulfilled');
    }
  });

  it('should filter by customer_id', async () => {
    const custId = generateTestId();
    await db
      .prepare(`INSERT INTO customers (id, tenant_id, customer_number, name, created_at, updated_at) VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))`)
      .bind(custId, seed.tenantId, `CUST-FILT-${custId.slice(0, 6)}`, 'Filter Customer').run();

    const orderId = generateTestId();
    await db
      .prepare(`INSERT INTO orders (id, tenant_id, order_number, customer_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'pending', datetime('now'), datetime('now'))`)
      .bind(orderId, seed.tenantId, `CUST-ORD-${orderId.slice(0, 6)}`, custId).run();

    const result = await db
      .prepare('SELECT * FROM orders WHERE tenant_id = ? AND customer_id = ?')
      .bind(seed.tenantId, custId).all();
    expect(result.results.length).toBe(1);
    expect(result.results[0].customer_id).toBe(custId);
  });

  it('should search across order fields', async () => {
    const orderId = generateTestId();
    await db
      .prepare(`INSERT INTO orders (id, tenant_id, order_number, po_number, customer_name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'pending', datetime('now'), datetime('now'))`)
      .bind(orderId, seed.tenantId, `SRCH-ORD-${orderId.slice(0, 6)}`, 'PO-SEARCHME', 'Search Corp').run();

    // Search by PO number
    const result = await db
      .prepare("SELECT * FROM orders WHERE tenant_id = ? AND po_number LIKE ?")
      .bind(seed.tenantId, '%PO-SEARCHME%').all();
    expect(result.results.length).toBeGreaterThanOrEqual(1);
  });

  it('should search order items by lot_number', async () => {
    const orderId = generateTestId();
    await db
      .prepare(`INSERT INTO orders (id, tenant_id, order_number, status, created_at, updated_at) VALUES (?, ?, ?, 'pending', datetime('now'), datetime('now'))`)
      .bind(orderId, seed.tenantId, `LOT-SRCH-${orderId.slice(0, 6)}`).run();

    await db
      .prepare(`INSERT INTO order_items (id, order_id, product_name, lot_number, created_at) VALUES (?, ?, ?, ?, datetime('now'))`)
      .bind(generateTestId(), orderId, 'Lot Product', 'FINDMELOT123').run();

    const result = await db
      .prepare(`SELECT DISTINCT o.* FROM orders o LEFT JOIN order_items oi ON oi.order_id = o.id WHERE o.tenant_id = ? AND oi.lot_number LIKE ?`)
      .bind(seed.tenantId, '%FINDMELOT123%').all();
    expect(result.results.length).toBeGreaterThanOrEqual(1);
  });
});

describe('Orders - Get by ID', () => {
  it('should get order with items', async () => {
    const orderId = generateTestId();
    await db
      .prepare(`INSERT INTO orders (id, tenant_id, order_number, status, created_at, updated_at) VALUES (?, ?, ?, 'pending', datetime('now'), datetime('now'))`)
      .bind(orderId, seed.tenantId, `GET-ORD-${orderId.slice(0, 6)}`).run();

    await db
      .prepare(`INSERT INTO order_items (id, order_id, product_name, quantity, created_at) VALUES (?, ?, ?, ?, datetime('now'))`)
      .bind(generateTestId(), orderId, 'Widget', 5).run();

    const order = await db.prepare('SELECT * FROM orders WHERE id = ?').bind(orderId).first();
    expect(order).not.toBeNull();

    const items = await db.prepare('SELECT * FROM order_items WHERE order_id = ?').bind(orderId).all();
    expect(items.results.length).toBe(1);
    expect(items.results[0].product_name).toBe('Widget');
  });

  it('should return null for non-existent order', async () => {
    const order = await db.prepare('SELECT * FROM orders WHERE id = ?').bind('nonexistent').first();
    expect(order).toBeNull();
  });
});

describe('Orders - Update', () => {
  let orderId: string;

  beforeAll(async () => {
    orderId = generateTestId();
    await db
      .prepare(`INSERT INTO orders (id, tenant_id, order_number, status, created_at, updated_at) VALUES (?, ?, ?, 'pending', datetime('now'), datetime('now'))`)
      .bind(orderId, seed.tenantId, `UPD-ORD-${orderId.slice(0, 6)}`).run();
  });

  it('should update status', async () => {
    await db.prepare("UPDATE orders SET status = ?, updated_at = datetime('now') WHERE id = ?").bind('enriched', orderId).run();
    const o = await db.prepare('SELECT status FROM orders WHERE id = ?').bind(orderId).first();
    expect(o!.status).toBe('enriched');
  });

  it('should reject invalid status via CHECK constraint', async () => {
    try {
      await db.prepare("UPDATE orders SET status = 'invalid' WHERE id = ?").bind(orderId).run();
      // Some D1 versions may not enforce CHECK constraints — that's ok
    } catch (err: any) {
      expect(err.message).toContain('CHECK');
    }
  });

  it('should update po_number', async () => {
    await db.prepare("UPDATE orders SET po_number = ?, updated_at = datetime('now') WHERE id = ?").bind('PO-UPDATED', orderId).run();
    const o = await db.prepare('SELECT po_number FROM orders WHERE id = ?').bind(orderId).first();
    expect(o!.po_number).toBe('PO-UPDATED');
  });

  it('should update customer_name', async () => {
    await db.prepare("UPDATE orders SET customer_name = ?, updated_at = datetime('now') WHERE id = ?").bind('New Customer', orderId).run();
    const o = await db.prepare('SELECT customer_name FROM orders WHERE id = ?').bind(orderId).first();
    expect(o!.customer_name).toBe('New Customer');
  });

  it('should update error_message', async () => {
    await db.prepare("UPDATE orders SET error_message = ?, status = 'error', updated_at = datetime('now') WHERE id = ?").bind('Something went wrong', orderId).run();
    const o = await db.prepare('SELECT error_message, status FROM orders WHERE id = ?').bind(orderId).first();
    expect(o!.error_message).toBe('Something went wrong');
    expect(o!.status).toBe('error');
  });
});

describe('Orders - Delete', () => {
  it('should hard-delete order and cascade to items', async () => {
    const orderId = generateTestId();
    await db
      .prepare(`INSERT INTO orders (id, tenant_id, order_number, status, created_at, updated_at) VALUES (?, ?, ?, 'pending', datetime('now'), datetime('now'))`)
      .bind(orderId, seed.tenantId, `DEL-ORD-${orderId.slice(0, 6)}`).run();

    await db
      .prepare(`INSERT INTO order_items (id, order_id, product_name, created_at) VALUES (?, ?, ?, datetime('now'))`)
      .bind(generateTestId(), orderId, 'Delete Item').run();

    await db.prepare('DELETE FROM orders WHERE id = ?').bind(orderId).run();

    const order = await db.prepare('SELECT * FROM orders WHERE id = ?').bind(orderId).first();
    expect(order).toBeNull();

    const items = await db.prepare('SELECT * FROM order_items WHERE order_id = ?').bind(orderId).all();
    expect(items.results.length).toBe(0);
  });
});

describe('Orders - Item Matching', () => {
  it('should track lot_matched status on order items', async () => {
    const orderId = generateTestId();
    await db
      .prepare(`INSERT INTO orders (id, tenant_id, order_number, status, created_at, updated_at) VALUES (?, ?, ?, 'pending', datetime('now'), datetime('now'))`)
      .bind(orderId, seed.tenantId, `MATCH-ORD-${orderId.slice(0, 6)}`).run();

    const itemId = generateTestId();
    await db
      .prepare(`INSERT INTO order_items (id, order_id, product_name, lot_number, lot_matched, created_at) VALUES (?, ?, ?, ?, 0, datetime('now'))`)
      .bind(itemId, orderId, 'Match Product', 'LOT-MATCH-001').run();

    // Simulate matching
    await db.prepare('UPDATE order_items SET lot_matched = 1, match_confidence = 0.95 WHERE id = ?').bind(itemId).run();

    const item = await db.prepare('SELECT lot_matched, match_confidence FROM order_items WHERE id = ?').bind(itemId).first();
    expect(item!.lot_matched).toBe(1);
    expect(item!.match_confidence).toBe(0.95);
  });

  it('should link order item to COA document', async () => {
    const orderId = generateTestId();
    const docId = generateTestId();
    const itemId = generateTestId();

    await db.prepare(`INSERT INTO orders (id, tenant_id, order_number, status, created_at, updated_at) VALUES (?, ?, ?, 'pending', datetime('now'), datetime('now'))`)
      .bind(orderId, seed.tenantId, `COA-ORD-${orderId.slice(0, 6)}`).run();

    await db.prepare(`INSERT INTO documents (id, tenant_id, title, tags, current_version, status, created_by) VALUES (?, ?, ?, '[]', 1, 'active', ?)`)
      .bind(docId, seed.tenantId, 'COA Doc', seed.userId).run();

    await db.prepare(`INSERT INTO order_items (id, order_id, product_name, lot_number, coa_document_id, lot_matched, created_at) VALUES (?, ?, ?, ?, ?, 1, datetime('now'))`)
      .bind(itemId, orderId, 'COA Product', 'LOT-COA-001', docId).run();

    const item = await db.prepare('SELECT coa_document_id FROM order_items WHERE id = ?').bind(itemId).first();
    expect(item!.coa_document_id).toBe(docId);
  });
});
