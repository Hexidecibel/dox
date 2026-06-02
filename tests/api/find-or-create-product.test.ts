/**
 * Tests for the shared product resolver findOrCreateProduct
 * (functions/lib/entities/products.ts).
 *
 * Covers: create-with-supplier-link (asserts product_suppliers row + legacy
 * supplier_id), NULL supplier_id backfill on an existing product, idempotency
 * of the join (no duplicate product_suppliers rows on repeat calls), and the
 * no-supplier case (no product_suppliers row, NULL supplier_id).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { seedTestData, generateTestId } from '../helpers/db';
import { findOrCreateProduct } from '../../functions/lib/entities/products';
import { onRequestGet as listProducts } from '../../functions/api/products/index';

let seed: Awaited<ReturnType<typeof seedTestData>>;
const db = env.DB;

let supplierId = '';
let supplierId2 = '';

beforeAll(async () => {
  seed = await seedTestData(db);

  supplierId = generateTestId();
  await db
    .prepare('INSERT INTO suppliers (id, tenant_id, name, slug) VALUES (?, ?, ?, ?)')
    .bind(supplierId, seed.tenantId, 'Resolver Supplier A', `resolver-supp-a-${supplierId.slice(0, 6)}`)
    .run();

  supplierId2 = generateTestId();
  await db
    .prepare('INSERT INTO suppliers (id, tenant_id, name, slug) VALUES (?, ?, ?, ?)')
    .bind(supplierId2, seed.tenantId, 'Resolver Supplier B', `resolver-supp-b-${supplierId2.slice(0, 6)}`)
    .run();
}, 30_000);

async function joinRows(productId: string) {
  const res = await db
    .prepare('SELECT supplier_id, supplier_sku FROM product_suppliers WHERE product_id = ?')
    .bind(productId)
    .all<{ supplier_id: string; supplier_sku: string | null }>();
  return res.results ?? [];
}

describe('findOrCreateProduct', () => {
  it('creates a product with a supplier link (legacy FK + product_suppliers row)', async () => {
    const name = `Resolver Created ${generateTestId().slice(0, 8)}`;
    const { id } = await findOrCreateProduct(db, seed.tenantId, name, {
      supplierId,
      supplierSku: 'SKU-123',
    });

    const product = await db
      .prepare('SELECT name, slug, supplier_id, tenant_id FROM products WHERE id = ?')
      .bind(id)
      .first<{ name: string; slug: string; supplier_id: string | null; tenant_id: string }>();

    expect(product).not.toBeNull();
    expect(product!.name).toBe(name);
    expect(product!.tenant_id).toBe(seed.tenantId);
    expect(product!.supplier_id).toBe(supplierId);

    const rows = await joinRows(id);
    expect(rows).toHaveLength(1);
    expect(rows[0].supplier_id).toBe(supplierId);
    expect(rows[0].supplier_sku).toBe('SKU-123');
  });

  it('backfills a NULL supplier_id on an existing product and adds a join row', async () => {
    // Seed a product with NULL supplier_id directly.
    const productId = generateTestId();
    const name = `Orphan Product ${productId.slice(0, 8)}`;
    await db
      .prepare('INSERT INTO products (id, tenant_id, name, slug, active) VALUES (?, ?, ?, ?, 1)')
      .bind(productId, seed.tenantId, name, `orphan-${productId.slice(0, 8)}`)
      .run();

    const { id } = await findOrCreateProduct(db, seed.tenantId, name, { supplierId });
    expect(id).toBe(productId);

    const product = await db
      .prepare('SELECT supplier_id FROM products WHERE id = ?')
      .bind(id)
      .first<{ supplier_id: string | null }>();
    expect(product!.supplier_id).toBe(supplierId);

    const rows = await joinRows(id);
    expect(rows).toHaveLength(1);
    expect(rows[0].supplier_id).toBe(supplierId);
  });

  it('never overwrites a non-null existing supplier_id', async () => {
    const productId = generateTestId();
    const name = `Already Supplied ${productId.slice(0, 8)}`;
    await db
      .prepare('INSERT INTO products (id, tenant_id, name, slug, supplier_id, active) VALUES (?, ?, ?, ?, ?, 1)')
      .bind(productId, seed.tenantId, name, `already-${productId.slice(0, 8)}`, supplierId)
      .run();

    // Resolve with a DIFFERENT supplier.
    const { id } = await findOrCreateProduct(db, seed.tenantId, name, { supplierId: supplierId2 });
    expect(id).toBe(productId);

    const product = await db
      .prepare('SELECT supplier_id FROM products WHERE id = ?')
      .bind(id)
      .first<{ supplier_id: string | null }>();
    // Legacy FK is untouched.
    expect(product!.supplier_id).toBe(supplierId);

    // The provenance graph records the supplier we just resolved with. (The
    // pre-existing legacy supplier_id was set directly in the seed without a
    // corresponding join row, so only supplierId2 is recorded here.)
    const rows = await joinRows(id);
    const supplierIds = rows.map((r) => r.supplier_id);
    expect(supplierIds).toContain(supplierId2);
  });

  it('is idempotent on the join — no duplicate product_suppliers rows', async () => {
    const name = `Idempotent ${generateTestId().slice(0, 8)}`;
    const first = await findOrCreateProduct(db, seed.tenantId, name, { supplierId });
    const second = await findOrCreateProduct(db, seed.tenantId, name, { supplierId });
    const third = await findOrCreateProduct(db, seed.tenantId, name.toUpperCase(), { supplierId });

    expect(second.id).toBe(first.id);
    expect(third.id).toBe(first.id); // case-insensitive match

    const rows = await joinRows(first.id);
    expect(rows).toHaveLength(1);
  });

  it('creates no product_suppliers row when supplierId is omitted', async () => {
    const name = `No Supplier ${generateTestId().slice(0, 8)}`;
    const { id } = await findOrCreateProduct(db, seed.tenantId, name);

    const product = await db
      .prepare('SELECT supplier_id FROM products WHERE id = ?')
      .bind(id)
      .first<{ supplier_id: string | null }>();
    expect(product!.supplier_id).toBeNull();

    const rows = await joinRows(id);
    expect(rows).toHaveLength(0);
  });
});

describe('GET /api/products?supplier_id= reads the product_suppliers join', () => {
  function makeContext(url: string, user: { id: string; role: string; tenant_id: string | null }): any {
    return {
      request: new Request(url, { method: 'GET' }),
      env,
      data: { user },
      params: {},
      waitUntil: () => {},
      passThroughOnException: () => {},
      next: async () => new Response(null),
      functionPath: '/api/products',
    };
  }

  it('includes products linked via product_suppliers even when products.supplier_id is NULL', async () => {
    const orgAdmin = { id: seed.orgAdminId, role: 'org_admin', tenant_id: seed.tenantId };

    // Product linked ONLY via the join table (legacy supplier_id stays NULL).
    const joinOnlyId = generateTestId();
    const joinOnlyName = `JoinOnly ${joinOnlyId.slice(0, 8)}`;
    await db
      .prepare('INSERT INTO products (id, tenant_id, name, slug, active) VALUES (?, ?, ?, ?, 1)')
      .bind(joinOnlyId, seed.tenantId, joinOnlyName, `joinonly-${joinOnlyId.slice(0, 8)}`)
      .run();
    await db
      .prepare('INSERT INTO product_suppliers (id, tenant_id, product_id, supplier_id) VALUES (?, ?, ?, ?)')
      .bind(generateTestId(), seed.tenantId, joinOnlyId, supplierId)
      .run();

    // Product linked via the legacy column only.
    const legacyId = generateTestId();
    const legacyName = `Legacy ${legacyId.slice(0, 8)}`;
    await db
      .prepare('INSERT INTO products (id, tenant_id, name, slug, supplier_id, active) VALUES (?, ?, ?, ?, ?, 1)')
      .bind(legacyId, seed.tenantId, legacyName, `legacy-${legacyId.slice(0, 8)}`, supplierId)
      .run();

    const res = await listProducts(
      makeContext(`http://localhost/api/products?supplier_id=${supplierId}`, orgAdmin)
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { products: Array<{ id: string }> };
    const ids = new Set(body.products.map((p) => p.id));
    expect(ids).toContain(joinOnlyId);
    expect(ids).toContain(legacyId);
  });
});
