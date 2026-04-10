import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { seedTestData, generateTestId } from '../helpers/db';

let seed: Awaited<ReturnType<typeof seedTestData>>;
const db = env.DB;

beforeAll(async () => {
  seed = await seedTestData(db);
}, 30_000);

describe('Bundles - Create', () => {
  it('should create a draft bundle', async () => {
    const id = generateTestId();
    await db
      .prepare(
        `INSERT INTO document_bundles (id, tenant_id, name, description, status, created_by)
         VALUES (?, ?, ?, ?, 'draft', ?)`
      )
      .bind(id, seed.tenantId, 'Test Bundle', 'A compliance package', seed.userId)
      .run();

    const b = await db.prepare('SELECT * FROM document_bundles WHERE id = ?').bind(id).first();
    expect(b).not.toBeNull();
    expect(b!.name).toBe('Test Bundle');
    expect(b!.status).toBe('draft');
    expect(b!.created_by).toBe(seed.userId);
  });

  it('should create with product_id', async () => {
    const prodId = generateTestId();
    await db
      .prepare('INSERT INTO products (id, tenant_id, name, slug, active) VALUES (?, ?, ?, ?, 1)')
      .bind(prodId, seed.tenantId, 'Bundle Product', `bundle-prod-${prodId.slice(0, 6)}`).run();

    const id = generateTestId();
    await db
      .prepare(
        `INSERT INTO document_bundles (id, tenant_id, name, product_id, status, created_by)
         VALUES (?, ?, ?, ?, 'draft', ?)`
      )
      .bind(id, seed.tenantId, 'Product Bundle', prodId, seed.userId)
      .run();

    const b = await db.prepare('SELECT product_id FROM document_bundles WHERE id = ?').bind(id).first();
    expect(b!.product_id).toBe(prodId);
  });
});

describe('Bundles - List', () => {
  it('should list bundles for a tenant', async () => {
    const result = await db
      .prepare(
        `SELECT b.*, (SELECT COUNT(*) FROM document_bundle_items WHERE bundle_id = b.id) as item_count
         FROM document_bundles b WHERE b.tenant_id = ? ORDER BY b.updated_at DESC`
      )
      .bind(seed.tenantId).all();

    for (const b of result.results) {
      expect(b.tenant_id).toBe(seed.tenantId);
    }
  });
});

describe('Bundles - Get by ID', () => {
  it('should get bundle with items', async () => {
    const bundleId = generateTestId();
    await db
      .prepare(
        `INSERT INTO document_bundles (id, tenant_id, name, status, created_by)
         VALUES (?, ?, ?, 'draft', ?)`
      )
      .bind(bundleId, seed.tenantId, 'Item Bundle', seed.userId).run();

    // Create a document
    const docId = generateTestId();
    await db
      .prepare(`INSERT INTO documents (id, tenant_id, title, tags, current_version, status, created_by) VALUES (?, ?, ?, '[]', 1, 'active', ?)`)
      .bind(docId, seed.tenantId, 'Bundle Doc', seed.userId).run();

    await db
      .prepare(`INSERT INTO document_versions (id, document_id, version_number, file_name, file_size, mime_type, r2_key, uploaded_by) VALUES (?, ?, 1, 'doc.pdf', 100, 'application/pdf', 'key/doc', ?)`)
      .bind(generateTestId(), docId, seed.userId).run();

    // Add to bundle
    const itemId = generateTestId();
    await db
      .prepare('INSERT INTO document_bundle_items (id, bundle_id, document_id, sort_order) VALUES (?, ?, ?, 0)')
      .bind(itemId, bundleId, docId).run();

    const bundle = await db.prepare('SELECT * FROM document_bundles WHERE id = ?').bind(bundleId).first();
    expect(bundle).not.toBeNull();

    const items = await db
      .prepare(`SELECT bi.*, d.title as document_title FROM document_bundle_items bi INNER JOIN documents d ON bi.document_id = d.id WHERE bi.bundle_id = ?`)
      .bind(bundleId).all();
    expect(items.results.length).toBe(1);
    expect(items.results[0].document_title).toBe('Bundle Doc');
  });

  it('should return null for non-existent bundle', async () => {
    const b = await db.prepare('SELECT * FROM document_bundles WHERE id = ?').bind('nonexistent').first();
    expect(b).toBeNull();
  });
});

describe('Bundles - Update', () => {
  let bundleId: string;

  beforeAll(async () => {
    bundleId = generateTestId();
    await db
      .prepare(`INSERT INTO document_bundles (id, tenant_id, name, status, created_by) VALUES (?, ?, ?, 'draft', ?)`)
      .bind(bundleId, seed.tenantId, 'Update Bundle', seed.userId).run();
  });

  it('should update name', async () => {
    await db.prepare("UPDATE document_bundles SET name = ?, updated_at = datetime('now') WHERE id = ?").bind('New Bundle Name', bundleId).run();
    const b = await db.prepare('SELECT name FROM document_bundles WHERE id = ?').bind(bundleId).first();
    expect(b!.name).toBe('New Bundle Name');
  });

  it('should update status to finalized', async () => {
    await db.prepare("UPDATE document_bundles SET status = 'finalized', updated_at = datetime('now') WHERE id = ?").bind(bundleId).run();
    const b = await db.prepare('SELECT status FROM document_bundles WHERE id = ?').bind(bundleId).first();
    expect(b!.status).toBe('finalized');
  });
});

describe('Bundles - Add Items', () => {
  it('should add a document to a bundle', async () => {
    const bundleId = generateTestId();
    await db.prepare(`INSERT INTO document_bundles (id, tenant_id, name, status, created_by) VALUES (?, ?, ?, 'draft', ?)`).bind(bundleId, seed.tenantId, 'Add Item Bundle', seed.userId).run();

    const docId = generateTestId();
    await db.prepare(`INSERT INTO documents (id, tenant_id, title, tags, current_version, status, created_by) VALUES (?, ?, ?, '[]', 0, 'active', ?)`).bind(docId, seed.tenantId, 'Add Doc', seed.userId).run();

    const itemId = generateTestId();
    await db.prepare('INSERT INTO document_bundle_items (id, bundle_id, document_id, sort_order) VALUES (?, ?, ?, 1)').bind(itemId, bundleId, docId).run();

    const item = await db.prepare('SELECT * FROM document_bundle_items WHERE id = ?').bind(itemId).first();
    expect(item).not.toBeNull();
    expect(item!.bundle_id).toBe(bundleId);
    expect(item!.document_id).toBe(docId);
    expect(item!.sort_order).toBe(1);
  });

  it('should prevent duplicate document in same bundle', async () => {
    const bundleId = generateTestId();
    const docId = generateTestId();

    await db.prepare(`INSERT INTO document_bundles (id, tenant_id, name, status, created_by) VALUES (?, ?, ?, 'draft', ?)`).bind(bundleId, seed.tenantId, 'Dup Bundle', seed.userId).run();
    await db.prepare(`INSERT INTO documents (id, tenant_id, title, tags, current_version, status, created_by) VALUES (?, ?, ?, '[]', 0, 'active', ?)`).bind(docId, seed.tenantId, 'Dup Doc', seed.userId).run();

    await db.prepare('INSERT INTO document_bundle_items (id, bundle_id, document_id) VALUES (?, ?, ?)').bind(generateTestId(), bundleId, docId).run();

    try {
      await db.prepare('INSERT INTO document_bundle_items (id, bundle_id, document_id) VALUES (?, ?, ?)').bind(generateTestId(), bundleId, docId).run();
      expect.unreachable('Should have thrown UNIQUE constraint error');
    } catch (err: any) {
      expect(err.message).toContain('UNIQUE');
    }
  });
});

describe('Bundles - Delete', () => {
  it('should delete bundle and cascade to items', async () => {
    const bundleId = generateTestId();
    const docId = generateTestId();

    await db.prepare(`INSERT INTO document_bundles (id, tenant_id, name, status, created_by) VALUES (?, ?, ?, 'draft', ?)`).bind(bundleId, seed.tenantId, 'Del Bundle', seed.userId).run();
    await db.prepare(`INSERT INTO documents (id, tenant_id, title, tags, current_version, status, created_by) VALUES (?, ?, ?, '[]', 0, 'active', ?)`).bind(docId, seed.tenantId, 'Del Item Doc', seed.userId).run();
    await db.prepare('INSERT INTO document_bundle_items (id, bundle_id, document_id) VALUES (?, ?, ?)').bind(generateTestId(), bundleId, docId).run();

    await db.prepare('DELETE FROM document_bundles WHERE id = ?').bind(bundleId).run();

    const bundle = await db.prepare('SELECT * FROM document_bundles WHERE id = ?').bind(bundleId).first();
    expect(bundle).toBeNull();

    const items = await db.prepare('SELECT * FROM document_bundle_items WHERE bundle_id = ?').bind(bundleId).all();
    expect(items.results.length).toBe(0);
  });
});
