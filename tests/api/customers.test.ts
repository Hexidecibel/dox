import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { seedTestData, generateTestId } from '../helpers/db';

let seed: Awaited<ReturnType<typeof seedTestData>>;
const db = env.DB;

beforeAll(async () => {
  seed = await seedTestData(db);
}, 30_000);

describe('Customers - Create', () => {
  it('should create a customer with required fields', async () => {
    const id = generateTestId();
    await db
      .prepare(
        `INSERT INTO customers (id, tenant_id, customer_number, name, created_at, updated_at)
         VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))`
      )
      .bind(id, seed.tenantId, 'CUST-001', 'Acme Corp')
      .run();

    const customer = await db.prepare('SELECT * FROM customers WHERE id = ?').bind(id).first();

    expect(customer).not.toBeNull();
    expect(customer!.customer_number).toBe('CUST-001');
    expect(customer!.name).toBe('Acme Corp');
    expect(customer!.active).toBe(1);
    expect(customer!.coa_delivery_method).toBe('email');
  });

  it('should create a customer with all fields', async () => {
    const id = generateTestId();
    const requirements = JSON.stringify({ include_lot: true, format: 'pdf' });

    await db
      .prepare(
        `INSERT INTO customers (id, tenant_id, customer_number, name, email, coa_delivery_method, coa_requirements, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
      )
      .bind(id, seed.tenantId, `CUST-FULL-${id}`, 'Full Corp', 'full@corp.com', 'portal', requirements)
      .run();

    const customer = await db.prepare('SELECT * FROM customers WHERE id = ?').bind(id).first();

    expect(customer!.email).toBe('full@corp.com');
    expect(customer!.coa_delivery_method).toBe('portal');
    expect(JSON.parse(customer!.coa_requirements as string).include_lot).toBe(true);
  });

  it('should enforce unique customer_number per tenant', async () => {
    const uniqueNum = `UNIQUE-${Date.now()}`;
    const id1 = generateTestId();
    const id2 = generateTestId();

    await db
      .prepare(
        `INSERT INTO customers (id, tenant_id, customer_number, name, created_at, updated_at)
         VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))`
      )
      .bind(id1, seed.tenantId, uniqueNum, 'First Customer')
      .run();

    try {
      await db
        .prepare(
          `INSERT INTO customers (id, tenant_id, customer_number, name, created_at, updated_at)
           VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))`
        )
        .bind(id2, seed.tenantId, uniqueNum, 'Duplicate Customer')
        .run();
      // If we get here, constraint didn't fire
      expect(false).toBe(true);
    } catch (err: any) {
      expect(err.message).toContain('UNIQUE');
    }
  });

  it('should allow same customer_number in different tenants', async () => {
    const num = `CROSS-${Date.now()}`;
    const id1 = generateTestId();
    const id2 = generateTestId();

    await db
      .prepare(
        `INSERT INTO customers (id, tenant_id, customer_number, name, created_at, updated_at)
         VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))`
      )
      .bind(id1, seed.tenantId, num, 'T1 Customer')
      .run();

    await db
      .prepare(
        `INSERT INTO customers (id, tenant_id, customer_number, name, created_at, updated_at)
         VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))`
      )
      .bind(id2, seed.tenantId2, num, 'T2 Customer')
      .run();

    const c1 = await db.prepare('SELECT * FROM customers WHERE id = ?').bind(id1).first();
    const c2 = await db.prepare('SELECT * FROM customers WHERE id = ?').bind(id2).first();

    expect(c1).not.toBeNull();
    expect(c2).not.toBeNull();
    expect(c1!.tenant_id).not.toBe(c2!.tenant_id);
  });
});

describe('Customers - List', () => {
  it('should list active customers for a tenant', async () => {
    const result = await db
      .prepare('SELECT * FROM customers WHERE tenant_id = ? AND active = 1 ORDER BY name ASC')
      .bind(seed.tenantId)
      .all();

    for (const c of result.results) {
      expect(c.tenant_id).toBe(seed.tenantId);
      expect(c.active).toBe(1);
    }
  });

  it('should search customers by name', async () => {
    const id = generateTestId();
    await db
      .prepare(
        `INSERT INTO customers (id, tenant_id, customer_number, name, created_at, updated_at)
         VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))`
      )
      .bind(id, seed.tenantId, `SEARCH-${id}`, 'Searchable Customer XYZ')
      .run();

    const result = await db
      .prepare(
        'SELECT * FROM customers WHERE tenant_id = ? AND active = 1 AND name LIKE ?'
      )
      .bind(seed.tenantId, '%Searchable%')
      .all();

    expect(result.results.length).toBeGreaterThanOrEqual(1);
    expect(result.results.some((c) => c.name === 'Searchable Customer XYZ')).toBe(true);
  });

  it('should search customers by customer_number', async () => {
    const num = `NUMFIND-${Date.now()}`;
    const id = generateTestId();
    await db
      .prepare(
        `INSERT INTO customers (id, tenant_id, customer_number, name, created_at, updated_at)
         VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))`
      )
      .bind(id, seed.tenantId, num, 'Number Search Customer')
      .run();

    const result = await db
      .prepare(
        'SELECT * FROM customers WHERE tenant_id = ? AND active = 1 AND customer_number LIKE ?'
      )
      .bind(seed.tenantId, `%${num}%`)
      .all();

    expect(result.results.length).toBe(1);
  });

  it('should not show inactive customers by default', async () => {
    const id = generateTestId();
    await db
      .prepare(
        `INSERT INTO customers (id, tenant_id, customer_number, name, active, created_at, updated_at)
         VALUES (?, ?, ?, ?, 0, datetime('now'), datetime('now'))`
      )
      .bind(id, seed.tenantId, `INACTIVE-${id}`, 'Inactive Customer')
      .run();

    const result = await db
      .prepare('SELECT * FROM customers WHERE tenant_id = ? AND active = 1')
      .bind(seed.tenantId)
      .all();

    const inactiveFound = result.results.find((c) => c.id === id);
    expect(inactiveFound).toBeUndefined();
  });
});

describe('Customers - Get by ID', () => {
  it('should get customer with order count', async () => {
    const custId = generateTestId();
    await db
      .prepare(
        `INSERT INTO customers (id, tenant_id, customer_number, name, created_at, updated_at)
         VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))`
      )
      .bind(custId, seed.tenantId, `COUNT-${custId}`, 'Count Customer')
      .run();

    // Create an order for this customer
    const orderId = generateTestId();
    await db
      .prepare(
        `INSERT INTO orders (id, tenant_id, order_number, customer_id, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'pending', datetime('now'), datetime('now'))`
      )
      .bind(orderId, seed.tenantId, `ORD-${orderId}`, custId)
      .run();

    const customer = await db
      .prepare(
        `SELECT c.*, (SELECT COUNT(*) FROM orders WHERE customer_id = c.id) as order_count
         FROM customers c WHERE c.id = ?`
      )
      .bind(custId)
      .first();

    expect(customer).not.toBeNull();
    expect(customer!.order_count).toBe(1);
  });

  it('should return null for non-existent customer', async () => {
    const customer = await db
      .prepare('SELECT * FROM customers WHERE id = ?')
      .bind('nonexistent')
      .first();

    expect(customer).toBeNull();
  });
});

describe('Customers - Update', () => {
  let custId: string;

  beforeAll(async () => {
    custId = generateTestId();
    await db
      .prepare(
        `INSERT INTO customers (id, tenant_id, customer_number, name, email, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
      )
      .bind(custId, seed.tenantId, `UPD-${custId}`, 'Update Customer', 'old@email.com')
      .run();
  });

  it('should update customer name', async () => {
    await db
      .prepare("UPDATE customers SET name = ?, updated_at = datetime('now') WHERE id = ?")
      .bind('Updated Customer Name', custId)
      .run();

    const c = await db.prepare('SELECT name FROM customers WHERE id = ?').bind(custId).first();
    expect(c!.name).toBe('Updated Customer Name');
  });

  it('should update customer email', async () => {
    await db
      .prepare("UPDATE customers SET email = ?, updated_at = datetime('now') WHERE id = ?")
      .bind('new@email.com', custId)
      .run();

    const c = await db.prepare('SELECT email FROM customers WHERE id = ?').bind(custId).first();
    expect(c!.email).toBe('new@email.com');
  });

  it('should update coa_delivery_method', async () => {
    await db
      .prepare("UPDATE customers SET coa_delivery_method = ?, updated_at = datetime('now') WHERE id = ?")
      .bind('portal', custId)
      .run();

    const c = await db.prepare('SELECT coa_delivery_method FROM customers WHERE id = ?').bind(custId).first();
    expect(c!.coa_delivery_method).toBe('portal');
  });

  it('should update coa_requirements (JSON)', async () => {
    const req = JSON.stringify({ format: 'csv', include_lot: false });
    await db
      .prepare("UPDATE customers SET coa_requirements = ?, updated_at = datetime('now') WHERE id = ?")
      .bind(req, custId)
      .run();

    const c = await db.prepare('SELECT coa_requirements FROM customers WHERE id = ?').bind(custId).first();
    expect(JSON.parse(c!.coa_requirements as string).format).toBe('csv');
  });
});

describe('Customers - Soft Delete', () => {
  it('should set active to 0 on delete', async () => {
    const id = generateTestId();
    await db
      .prepare(
        `INSERT INTO customers (id, tenant_id, customer_number, name, created_at, updated_at)
         VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))`
      )
      .bind(id, seed.tenantId, `DEL-${id}`, 'Delete Customer')
      .run();

    await db
      .prepare("UPDATE customers SET active = 0, updated_at = datetime('now') WHERE id = ?")
      .bind(id)
      .run();

    const c = await db.prepare('SELECT active FROM customers WHERE id = ?').bind(id).first();
    expect(c!.active).toBe(0);
  });
});

describe('Customers - Lookup', () => {
  it('should lookup customer by customer_number and tenant_id', async () => {
    const num = `LOOKUP-${Date.now()}`;
    const id = generateTestId();
    await db
      .prepare(
        `INSERT INTO customers (id, tenant_id, customer_number, name, created_at, updated_at)
         VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))`
      )
      .bind(id, seed.tenantId, num, 'Lookup Customer')
      .run();

    const c = await db
      .prepare(
        'SELECT * FROM customers WHERE customer_number = ? AND tenant_id = ? AND active = 1'
      )
      .bind(num, seed.tenantId)
      .first();

    expect(c).not.toBeNull();
    expect(c!.name).toBe('Lookup Customer');
  });

  it('should return null for non-existent customer_number', async () => {
    const c = await db
      .prepare(
        'SELECT * FROM customers WHERE customer_number = ? AND tenant_id = ? AND active = 1'
      )
      .bind('NOPE-000', seed.tenantId)
      .first();

    expect(c).toBeNull();
  });

  it('should not return inactive customers in lookup', async () => {
    const num = `INACTIVE-LOOKUP-${Date.now()}`;
    const id = generateTestId();
    await db
      .prepare(
        `INSERT INTO customers (id, tenant_id, customer_number, name, active, created_at, updated_at)
         VALUES (?, ?, ?, ?, 0, datetime('now'), datetime('now'))`
      )
      .bind(id, seed.tenantId, num, 'Inactive Lookup')
      .run();

    const c = await db
      .prepare(
        'SELECT * FROM customers WHERE customer_number = ? AND tenant_id = ? AND active = 1'
      )
      .bind(num, seed.tenantId)
      .first();

    expect(c).toBeNull();
  });
});
