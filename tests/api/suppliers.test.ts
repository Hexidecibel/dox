import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { seedTestData, generateTestId } from '../helpers/db';

let seed: Awaited<ReturnType<typeof seedTestData>>;
const db = env.DB;

beforeAll(async () => {
  seed = await seedTestData(db);
}, 30_000);

describe('Suppliers - Create', () => {
  it('should create with required fields', async () => {
    const id = generateTestId();
    await db
      .prepare('INSERT INTO suppliers (id, tenant_id, name, slug) VALUES (?, ?, ?, ?)')
      .bind(id, seed.tenantId, 'Acme Supplies', 'acme-supplies')
      .run();

    const s = await db.prepare('SELECT * FROM suppliers WHERE id = ?').bind(id).first();
    expect(s).not.toBeNull();
    expect(s!.name).toBe('Acme Supplies');
    expect(s!.slug).toBe('acme-supplies');
    expect(s!.active).toBe(1);
  });

  it('should create with aliases', async () => {
    const id = generateTestId();
    const aliases = JSON.stringify(['Acme Inc', 'ACME LLC']);
    await db
      .prepare('INSERT INTO suppliers (id, tenant_id, name, slug, aliases) VALUES (?, ?, ?, ?, ?)')
      .bind(id, seed.tenantId, 'Alias Supplier', `alias-supp-${id.slice(0, 6)}`, aliases)
      .run();

    const s = await db.prepare('SELECT aliases FROM suppliers WHERE id = ?').bind(id).first();
    expect(JSON.parse(s!.aliases as string)).toEqual(['Acme Inc', 'ACME LLC']);
  });
});

describe('Suppliers - List', () => {
  it('should list active suppliers for a tenant', async () => {
    const result = await db
      .prepare('SELECT * FROM suppliers WHERE tenant_id = ? AND active = 1 ORDER BY name ASC')
      .bind(seed.tenantId).all();
    for (const s of result.results) {
      expect(s.tenant_id).toBe(seed.tenantId);
      expect(s.active).toBe(1);
    }
  });

  it('should search by name', async () => {
    const id = generateTestId();
    await db
      .prepare('INSERT INTO suppliers (id, tenant_id, name, slug) VALUES (?, ?, ?, ?)')
      .bind(id, seed.tenantId, 'Findable Supplier XYZ', `findable-${id.slice(0, 6)}`).run();

    const result = await db
      .prepare("SELECT * FROM suppliers WHERE tenant_id = ? AND active = 1 AND name LIKE ?")
      .bind(seed.tenantId, '%Findable Supplier XYZ%').all();
    expect(result.results.length).toBeGreaterThanOrEqual(1);
  });

  it('should search by aliases', async () => {
    const id = generateTestId();
    const aliases = JSON.stringify(['SearchAlias123']);
    await db
      .prepare('INSERT INTO suppliers (id, tenant_id, name, slug, aliases) VALUES (?, ?, ?, ?, ?)')
      .bind(id, seed.tenantId, 'Alias Search', `alias-search-${id.slice(0, 6)}`, aliases).run();

    const result = await db
      .prepare("SELECT * FROM suppliers WHERE tenant_id = ? AND active = 1 AND aliases LIKE ?")
      .bind(seed.tenantId, '%SearchAlias123%').all();
    expect(result.results.length).toBeGreaterThanOrEqual(1);
  });
});

describe('Suppliers - Get by ID', () => {
  it('should get supplier with counts', async () => {
    const suppId = generateTestId();
    await db
      .prepare('INSERT INTO suppliers (id, tenant_id, name, slug) VALUES (?, ?, ?, ?)')
      .bind(suppId, seed.tenantId, 'Count Supplier', `count-supp-${suppId.slice(0, 6)}`).run();

    // Add a document linked to this supplier
    const docId = generateTestId();
    await db
      .prepare(`INSERT INTO documents (id, tenant_id, title, tags, current_version, status, created_by, supplier_id) VALUES (?, ?, ?, '[]', 0, 'active', ?, ?)`)
      .bind(docId, seed.tenantId, 'Supplier Doc', seed.userId, suppId).run();

    const supplier = await db
      .prepare(`SELECT s.*, (SELECT COUNT(*) FROM documents d WHERE d.supplier_id = s.id) as document_count FROM suppliers s WHERE s.id = ?`)
      .bind(suppId).first();
    expect(supplier!.document_count).toBe(1);
  });

  it('should return null for non-existent supplier', async () => {
    const s = await db.prepare('SELECT * FROM suppliers WHERE id = ?').bind('nonexistent').first();
    expect(s).toBeNull();
  });
});

describe('Suppliers - Update', () => {
  let suppId: string;

  beforeAll(async () => {
    suppId = generateTestId();
    await db
      .prepare('INSERT INTO suppliers (id, tenant_id, name, slug) VALUES (?, ?, ?, ?)')
      .bind(suppId, seed.tenantId, 'Update Supplier', `upd-supp-${suppId.slice(0, 6)}`).run();
  });

  it('should update name', async () => {
    await db.prepare("UPDATE suppliers SET name = ?, updated_at = datetime('now') WHERE id = ?").bind('New Supplier Name', suppId).run();
    const s = await db.prepare('SELECT name FROM suppliers WHERE id = ?').bind(suppId).first();
    expect(s!.name).toBe('New Supplier Name');
  });

  it('should update aliases', async () => {
    const aliases = JSON.stringify(['Alias A', 'Alias B']);
    await db.prepare("UPDATE suppliers SET aliases = ?, updated_at = datetime('now') WHERE id = ?").bind(aliases, suppId).run();
    const s = await db.prepare('SELECT aliases FROM suppliers WHERE id = ?').bind(suppId).first();
    expect(JSON.parse(s!.aliases as string)).toEqual(['Alias A', 'Alias B']);
  });

  it('should soft-delete by setting active to 0', async () => {
    await db.prepare("UPDATE suppliers SET active = 0, updated_at = datetime('now') WHERE id = ?").bind(suppId).run();
    const s = await db.prepare('SELECT active FROM suppliers WHERE id = ?').bind(suppId).first();
    expect(s!.active).toBe(0);
  });
});

describe('Suppliers - Lookup or Create', () => {
  it('should find existing by slug', async () => {
    const id = generateTestId();
    await db
      .prepare('INSERT INTO suppliers (id, tenant_id, name, slug) VALUES (?, ?, ?, ?)')
      .bind(id, seed.tenantId, 'Lookup Supplier', 'lookup-supplier').run();

    const existing = await db
      .prepare('SELECT * FROM suppliers WHERE tenant_id = ? AND slug = ?')
      .bind(seed.tenantId, 'lookup-supplier').first();
    expect(existing).not.toBeNull();
    expect(existing!.id).toBe(id);
  });

  it('should find existing by case-insensitive name', async () => {
    const id = generateTestId();
    await db
      .prepare('INSERT INTO suppliers (id, tenant_id, name, slug) VALUES (?, ?, ?, ?)')
      .bind(id, seed.tenantId, 'Case Test', `case-test-${id.slice(0, 6)}`).run();

    const existing = await db
      .prepare('SELECT * FROM suppliers WHERE tenant_id = ? AND LOWER(name) = LOWER(?)')
      .bind(seed.tenantId, 'case test').first();
    expect(existing).not.toBeNull();
  });

  it('should find by alias match', async () => {
    const id = generateTestId();
    const aliases = JSON.stringify(['Alias Match Corp']);
    await db
      .prepare('INSERT INTO suppliers (id, tenant_id, name, slug, aliases) VALUES (?, ?, ?, ?, ?)')
      .bind(id, seed.tenantId, 'Alias Corp', `alias-corp-${id.slice(0, 6)}`, aliases).run();

    const existing = await db
      .prepare("SELECT * FROM suppliers WHERE tenant_id = ? AND aliases LIKE ? LIMIT 1")
      .bind(seed.tenantId, '%Alias Match Corp%').first();
    expect(existing).not.toBeNull();
  });

  it('should create new when not found', async () => {
    const name = `Brand New ${Date.now()}`;
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

    // Verify it doesn't exist
    const existing = await db
      .prepare('SELECT * FROM suppliers WHERE tenant_id = ? AND slug = ?')
      .bind(seed.tenantId, slug).first();
    expect(existing).toBeNull();

    // Create it
    const id = generateTestId();
    await db
      .prepare('INSERT INTO suppliers (id, tenant_id, name, slug) VALUES (?, ?, ?, ?)')
      .bind(id, seed.tenantId, name, slug).run();

    const created = await db.prepare('SELECT * FROM suppliers WHERE id = ?').bind(id).first();
    expect(created).not.toBeNull();
    expect(created!.name).toBe(name);
  });
});
