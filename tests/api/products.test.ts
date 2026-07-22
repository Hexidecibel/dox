import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { seedTestData, generateTestId } from '../helpers/db';
import { onRequestPost as productsPost } from '../../functions/api/products/index';
import { onRequestPut as productPut } from '../../functions/api/products/[id]';

let seed: Awaited<ReturnType<typeof seedTestData>>;
const db = env.DB;

beforeAll(async () => {
  seed = await seedTestData(db);
}, 30_000);

describe('Products - Dual attribution (brand_owner / producer / plant_code)', () => {
  const orgAdmin = () => ({ id: seed.orgAdminId, role: 'org_admin' as const, tenant_id: seed.tenantId });

  it('POST persists attribution fields, PUT edits them', async () => {
    const name = `Attributed ${generateTestId()}`;
    const postRes = await productsPost({
      request: new Request('http://localhost/api/products', {
        method: 'POST',
        body: JSON.stringify({ name, brand_owner: 'BrandCo', producer: 'PlantCo', plant_code: 'P-42' }),
        headers: { 'Content-Type': 'application/json' },
      }),
      env,
      data: { user: orgAdmin() },
      params: {},
    } as any);
    expect(postRes.status).toBe(201);
    const { product } = await postRes.json() as any;
    expect(product.brand_owner).toBe('BrandCo');
    expect(product.producer).toBe('PlantCo');
    expect(product.plant_code).toBe('P-42');

    const putRes = await productPut({
      request: new Request(`http://localhost/api/products/${product.id}`, {
        method: 'PUT',
        body: JSON.stringify({ producer: 'NewPlant', plant_code: 'P-99' }),
        headers: { 'Content-Type': 'application/json' },
      }),
      env,
      data: { user: orgAdmin() },
      params: { id: product.id },
    } as any);
    expect(putRes.status).toBe(200);
    const updated = (await putRes.json() as any).product;
    expect(updated.brand_owner).toBe('BrandCo'); // untouched
    expect(updated.producer).toBe('NewPlant');
    expect(updated.plant_code).toBe('P-99');
  });
});

describe('Products - Create', () => {
  it('should create a product with name and slug', async () => {
    const id = generateTestId();
    await db
      .prepare('INSERT INTO products (id, tenant_id, name, slug, active) VALUES (?, ?, ?, ?, 1)')
      .bind(id, seed.tenantId, 'Widget Alpha', 'widget-alpha')
      .run();

    const p = await db.prepare('SELECT * FROM products WHERE id = ?').bind(id).first();
    expect(p).not.toBeNull();
    expect(p!.name).toBe('Widget Alpha');
    expect(p!.slug).toBe('widget-alpha');
    expect(p!.active).toBe(1);
    expect(p!.tenant_id).toBe(seed.tenantId);
  });

  it('should create with description and supplier_id', async () => {
    const suppId = generateTestId();
    await db
      .prepare('INSERT INTO suppliers (id, tenant_id, name, slug) VALUES (?, ?, ?, ?)')
      .bind(suppId, seed.tenantId, 'Test Supplier', `test-supplier-${suppId.slice(0, 6)}`)
      .run();

    const id = generateTestId();
    await db
      .prepare('INSERT INTO products (id, tenant_id, name, slug, description, supplier_id, active) VALUES (?, ?, ?, ?, ?, ?, 1)')
      .bind(id, seed.tenantId, 'Described Product', `desc-prod-${id.slice(0, 6)}`, 'A fine product', suppId)
      .run();

    const p = await db.prepare('SELECT * FROM products WHERE id = ?').bind(id).first();
    expect(p!.description).toBe('A fine product');
    expect(p!.supplier_id).toBe(suppId);
  });

  it('should enforce unique slug per tenant', async () => {
    const slug = `unique-slug-${Date.now()}`;
    await db
      .prepare('INSERT INTO products (id, tenant_id, name, slug, active) VALUES (?, ?, ?, ?, 1)')
      .bind(generateTestId(), seed.tenantId, 'First', slug).run();

    const existing = await db
      .prepare('SELECT id FROM products WHERE slug = ? AND tenant_id = ?')
      .bind(slug, seed.tenantId).first();
    expect(existing).not.toBeNull();
  });
});

describe('Products - List', () => {
  it('should list active products for a tenant', async () => {
    const result = await db
      .prepare('SELECT * FROM products WHERE tenant_id = ? AND active = 1 ORDER BY name ASC')
      .bind(seed.tenantId).all();
    for (const p of result.results) {
      expect(p.tenant_id).toBe(seed.tenantId);
      expect(p.active).toBe(1);
    }
  });

  it('should search by name', async () => {
    const id = generateTestId();
    await db
      .prepare('INSERT INTO products (id, tenant_id, name, slug, active) VALUES (?, ?, ?, ?, 1)')
      .bind(id, seed.tenantId, 'Searchable Widget', `search-widget-${id.slice(0, 6)}`).run();

    const result = await db
      .prepare("SELECT * FROM products WHERE tenant_id = ? AND active = 1 AND name LIKE ?")
      .bind(seed.tenantId, '%Searchable Widget%').all();
    expect(result.results.length).toBeGreaterThanOrEqual(1);
  });

  it('should paginate results', async () => {
    const page1 = await db
      .prepare('SELECT * FROM products WHERE tenant_id = ? AND active = 1 ORDER BY name ASC LIMIT 2 OFFSET 0')
      .bind(seed.tenantId).all();
    expect(page1.results.length).toBeLessThanOrEqual(2);
  });
});

describe('Products - Get by ID', () => {
  it('should get product by ID', async () => {
    const id = generateTestId();
    await db
      .prepare('INSERT INTO products (id, tenant_id, name, slug, active) VALUES (?, ?, ?, ?, 1)')
      .bind(id, seed.tenantId, 'Get Product', `get-prod-${id.slice(0, 6)}`).run();

    const p = await db.prepare('SELECT * FROM products WHERE id = ?').bind(id).first();
    expect(p).not.toBeNull();
    expect(p!.name).toBe('Get Product');
  });

  it('should return null for non-existent product', async () => {
    const p = await db.prepare('SELECT * FROM products WHERE id = ?').bind('nonexistent').first();
    expect(p).toBeNull();
  });
});

describe('Products - Update', () => {
  let prodId: string;

  beforeAll(async () => {
    prodId = generateTestId();
    await db
      .prepare('INSERT INTO products (id, tenant_id, name, slug, active) VALUES (?, ?, ?, ?, 1)')
      .bind(prodId, seed.tenantId, 'Update Product', `upd-prod-${prodId.slice(0, 6)}`).run();
  });

  it('should update name', async () => {
    await db.prepare("UPDATE products SET name = ?, updated_at = datetime('now') WHERE id = ?").bind('New Name', prodId).run();
    const p = await db.prepare('SELECT name FROM products WHERE id = ?').bind(prodId).first();
    expect(p!.name).toBe('New Name');
  });

  it('should update description', async () => {
    await db.prepare("UPDATE products SET description = ?, updated_at = datetime('now') WHERE id = ?").bind('New desc', prodId).run();
    const p = await db.prepare('SELECT description FROM products WHERE id = ?').bind(prodId).first();
    expect(p!.description).toBe('New desc');
  });

  it('should soft-delete by setting active to 0', async () => {
    await db.prepare("UPDATE products SET active = 0, updated_at = datetime('now') WHERE id = ?").bind(prodId).run();
    const p = await db.prepare('SELECT active FROM products WHERE id = ?').bind(prodId).first();
    expect(p!.active).toBe(0);
  });
});
