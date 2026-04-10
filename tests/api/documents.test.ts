import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { seedTestData, generateTestId } from '../helpers/db';

let seed: Awaited<ReturnType<typeof seedTestData>>;
const db = env.DB;

beforeAll(async () => {
  seed = await seedTestData(db);
}, 30_000);

describe('Documents - Create', () => {
  it('should create a document with minimal fields', async () => {
    const id = generateTestId();
    await db
      .prepare(
        `INSERT INTO documents (id, tenant_id, title, tags, current_version, status, created_by)
         VALUES (?, ?, ?, '[]', 0, 'active', ?)`
      )
      .bind(id, seed.tenantId, 'Test Document', seed.userId)
      .run();

    const doc = await db.prepare('SELECT * FROM documents WHERE id = ?').bind(id).first();
    expect(doc).not.toBeNull();
    expect(doc!.title).toBe('Test Document');
    expect(doc!.status).toBe('active');
    expect(doc!.current_version).toBe(0);
    expect(doc!.tenant_id).toBe(seed.tenantId);
  });

  it('should create a document with all fields', async () => {
    const id = generateTestId();
    const metadata = JSON.stringify({ lot_number: 'LOT-001', expiration_date: '2025-12-31' });

    await db
      .prepare(
        `INSERT INTO documents (id, tenant_id, title, description, category, tags, current_version, status, created_by, primary_metadata, extended_metadata)
         VALUES (?, ?, ?, ?, ?, ?, 0, 'active', ?, ?, ?)`
      )
      .bind(id, seed.tenantId, 'Full Document', 'A test description', 'COA',
        '["tag1","tag2"]', seed.userId, metadata, '{"extra":"data"}')
      .run();

    const doc = await db.prepare('SELECT * FROM documents WHERE id = ?').bind(id).first();
    expect(doc!.description).toBe('A test description');
    expect(doc!.category).toBe('COA');
    expect(JSON.parse(doc!.tags as string)).toEqual(['tag1', 'tag2']);
    expect(JSON.parse(doc!.primary_metadata as string).lot_number).toBe('LOT-001');
  });
});

describe('Documents - List', () => {
  beforeAll(async () => {
    for (let i = 0; i < 5; i++) {
      await db
        .prepare(
          `INSERT INTO documents (id, tenant_id, title, tags, current_version, status, created_by)
           VALUES (?, ?, ?, '[]', 0, 'active', ?)`
        )
        .bind(generateTestId(), seed.tenantId, `List Doc ${i}`, seed.userId)
        .run();
    }
    await db
      .prepare(
        `INSERT INTO documents (id, tenant_id, title, tags, current_version, status, created_by)
         VALUES (?, ?, ?, '[]', 0, 'active', ?)`
      )
      .bind(generateTestId(), seed.tenantId2, 'Other Tenant Doc', seed.orgAdmin2Id)
      .run();
  });

  it('should list documents with tenant filter', async () => {
    const result = await db
      .prepare("SELECT * FROM documents WHERE tenant_id = ? AND status = 'active' ORDER BY updated_at DESC LIMIT 50")
      .bind(seed.tenantId)
      .all();
    expect(result.results.length).toBeGreaterThanOrEqual(5);
    for (const doc of result.results) {
      expect(doc.tenant_id).toBe(seed.tenantId);
    }
  });

  it('should not show deleted documents', async () => {
    const id = generateTestId();
    await db
      .prepare(
        `INSERT INTO documents (id, tenant_id, title, tags, current_version, status, created_by)
         VALUES (?, ?, ?, '[]', 0, 'deleted', ?)`
      )
      .bind(id, seed.tenantId, 'Deleted Doc', seed.userId)
      .run();

    const result = await db
      .prepare("SELECT * FROM documents WHERE tenant_id = ? AND status = 'active'")
      .bind(seed.tenantId)
      .all();
    const found = result.results.find((d) => d.id === id);
    expect(found).toBeUndefined();
  });

  it('should paginate results', async () => {
    const page1 = await db
      .prepare("SELECT * FROM documents WHERE tenant_id = ? AND status = 'active' ORDER BY updated_at DESC LIMIT 2 OFFSET 0")
      .bind(seed.tenantId)
      .all();
    const page2 = await db
      .prepare("SELECT * FROM documents WHERE tenant_id = ? AND status = 'active' ORDER BY updated_at DESC LIMIT 2 OFFSET 2")
      .bind(seed.tenantId)
      .all();
    expect(page1.results.length).toBeLessThanOrEqual(2);
    if (page2.results.length > 0) {
      expect(page1.results[0].id).not.toBe(page2.results[0].id);
    }
  });

  it('should return total count', async () => {
    const countResult = await db
      .prepare("SELECT COUNT(*) as total FROM documents WHERE tenant_id = ? AND status = 'active'")
      .bind(seed.tenantId)
      .first<{ total: number }>();
    expect(countResult!.total).toBeGreaterThanOrEqual(5);
  });
});

describe('Documents - Get by ID', () => {
  let docId: string;

  beforeAll(async () => {
    docId = generateTestId();
    await db
      .prepare(
        `INSERT INTO documents (id, tenant_id, title, tags, current_version, status, created_by)
         VALUES (?, ?, ?, '[]', 1, 'active', ?)`
      )
      .bind(docId, seed.tenantId, 'Get Doc Test', seed.userId)
      .run();

    await db
      .prepare(
        `INSERT INTO document_versions (id, document_id, version_number, file_name, file_size, mime_type, r2_key, uploaded_by)
         VALUES (?, ?, 1, 'test.pdf', 1024, 'application/pdf', 'test/key', ?)`
      )
      .bind(generateTestId(), docId, seed.userId)
      .run();
  });

  it('should get document by ID', async () => {
    const doc = await db
      .prepare("SELECT * FROM documents WHERE id = ? AND status != 'deleted'")
      .bind(docId)
      .first();
    expect(doc).not.toBeNull();
    expect(doc!.title).toBe('Get Doc Test');
  });

  it('should return null for non-existent document', async () => {
    const doc = await db
      .prepare("SELECT * FROM documents WHERE id = ? AND status != 'deleted'")
      .bind('nonexistent-doc')
      .first();
    expect(doc).toBeNull();
  });

  it('should get current version info', async () => {
    const version = await db
      .prepare('SELECT * FROM document_versions WHERE document_id = ? AND version_number = ?')
      .bind(docId, 1)
      .first();
    expect(version).not.toBeNull();
    expect(version!.file_name).toBe('test.pdf');
    expect(version!.file_size).toBe(1024);
  });

  it('should not return deleted documents', async () => {
    const deletedId = generateTestId();
    await db
      .prepare(
        `INSERT INTO documents (id, tenant_id, title, tags, current_version, status, created_by)
         VALUES (?, ?, ?, '[]', 0, 'deleted', ?)`
      )
      .bind(deletedId, seed.tenantId, 'Deleted', seed.userId)
      .run();

    const doc = await db
      .prepare("SELECT * FROM documents WHERE id = ? AND status != 'deleted'")
      .bind(deletedId)
      .first();
    expect(doc).toBeNull();
  });
});

describe('Documents - Update', () => {
  let docId: string;

  beforeAll(async () => {
    docId = generateTestId();
    await db
      .prepare(
        `INSERT INTO documents (id, tenant_id, title, description, tags, current_version, status, created_by)
         VALUES (?, ?, ?, ?, '[]', 0, 'active', ?)`
      )
      .bind(docId, seed.tenantId, 'Update Test', 'Original description', seed.userId)
      .run();
  });

  it('should update title', async () => {
    await db.prepare("UPDATE documents SET title = ?, updated_at = datetime('now') WHERE id = ?").bind('Updated Title', docId).run();
    const doc = await db.prepare('SELECT title FROM documents WHERE id = ?').bind(docId).first();
    expect(doc!.title).toBe('Updated Title');
  });

  it('should update description', async () => {
    await db.prepare("UPDATE documents SET description = ?, updated_at = datetime('now') WHERE id = ?").bind('New desc', docId).run();
    const doc = await db.prepare('SELECT description FROM documents WHERE id = ?').bind(docId).first();
    expect(doc!.description).toBe('New desc');
  });

  it('should update status to archived', async () => {
    await db.prepare("UPDATE documents SET status = ?, updated_at = datetime('now') WHERE id = ?").bind('archived', docId).run();
    const doc = await db.prepare('SELECT status FROM documents WHERE id = ?').bind(docId).first();
    expect(doc!.status).toBe('archived');
    await db.prepare("UPDATE documents SET status = 'active' WHERE id = ?").bind(docId).run();
  });

  it('should update primary_metadata', async () => {
    const meta = JSON.stringify({ lot_number: 'LOT-999' });
    await db.prepare("UPDATE documents SET primary_metadata = ?, updated_at = datetime('now') WHERE id = ?").bind(meta, docId).run();
    const doc = await db.prepare('SELECT primary_metadata FROM documents WHERE id = ?').bind(docId).first();
    expect(JSON.parse(doc!.primary_metadata as string).lot_number).toBe('LOT-999');
  });
});

describe('Documents - Delete (Soft)', () => {
  it('should soft-delete by setting status to deleted', async () => {
    const id = generateTestId();
    await db
      .prepare(`INSERT INTO documents (id, tenant_id, title, tags, current_version, status, created_by) VALUES (?, ?, ?, '[]', 0, 'active', ?)`)
      .bind(id, seed.tenantId, 'To Delete', seed.userId)
      .run();
    await db.prepare("UPDATE documents SET status = 'deleted', updated_at = datetime('now') WHERE id = ?").bind(id).run();
    const doc = await db.prepare('SELECT status FROM documents WHERE id = ?').bind(id).first();
    expect(doc!.status).toBe('deleted');
  });
});

describe('Documents - Ingest (external_ref)', () => {
  it('should create a document with external_ref', async () => {
    const id = generateTestId();
    const externalRef = `ext-ref-${id}`;
    await db
      .prepare(
        `INSERT INTO documents (id, tenant_id, title, tags, current_version, status, created_by, external_ref, source_metadata)
         VALUES (?, ?, ?, '[]', 1, 'active', ?, ?, ?)`
      )
      .bind(id, seed.tenantId, 'Ingested Doc', seed.userId, externalRef, '{"source":"api"}')
      .run();

    const doc = await db.prepare('SELECT * FROM documents WHERE id = ?').bind(id).first();
    expect(doc!.external_ref).toBe(externalRef);
    expect(JSON.parse(doc!.source_metadata as string).source).toBe('api');
  });

  it('should find existing by external_ref + tenant_id', async () => {
    const ref = `lookup-ref-${Date.now()}`;
    const id = generateTestId();
    await db
      .prepare(
        `INSERT INTO documents (id, tenant_id, title, tags, current_version, status, created_by, external_ref)
         VALUES (?, ?, ?, '[]', 1, 'active', ?, ?)`
      )
      .bind(id, seed.tenantId, 'Lookup Doc', seed.userId, ref)
      .run();

    const existing = await db
      .prepare("SELECT * FROM documents WHERE external_ref = ? AND tenant_id = ? AND status != 'deleted'")
      .bind(ref, seed.tenantId)
      .first();
    expect(existing).not.toBeNull();
    expect(existing!.id).toBe(id);
  });

  it('should add new version on re-ingest', async () => {
    const id = generateTestId();
    await db
      .prepare(
        `INSERT INTO documents (id, tenant_id, title, tags, current_version, status, created_by, external_ref)
         VALUES (?, ?, ?, '[]', 1, 'active', ?, ?)`
      )
      .bind(id, seed.tenantId, 'Multi-Version', seed.userId, `multi-ver-${id}`)
      .run();

    await db
      .prepare(`INSERT INTO document_versions (id, document_id, version_number, file_name, file_size, mime_type, r2_key, uploaded_by) VALUES (?, ?, 1, 'v1.pdf', 100, 'application/pdf', 'key/v1', ?)`)
      .bind(generateTestId(), id, seed.userId).run();

    await db
      .prepare(`INSERT INTO document_versions (id, document_id, version_number, file_name, file_size, mime_type, r2_key, uploaded_by) VALUES (?, ?, 2, 'v2.pdf', 200, 'application/pdf', 'key/v2', ?)`)
      .bind(generateTestId(), id, seed.userId).run();

    await db.prepare('UPDATE documents SET current_version = 2 WHERE id = ?').bind(id).run();

    const doc = await db.prepare('SELECT current_version FROM documents WHERE id = ?').bind(id).first();
    expect(doc!.current_version).toBe(2);

    const versions = await db.prepare('SELECT * FROM document_versions WHERE document_id = ? ORDER BY version_number').bind(id).all();
    expect(versions.results.length).toBe(2);
  });
});

describe('Documents - Lookup', () => {
  it('should lookup by external_ref', async () => {
    const ref = `lookup-test-${Date.now()}`;
    const id = generateTestId();
    await db
      .prepare(
        `INSERT INTO documents (id, tenant_id, title, tags, current_version, status, created_by, external_ref)
         VALUES (?, ?, ?, '[]', 1, 'active', ?, ?)`
      )
      .bind(id, seed.tenantId, 'Lookup Test', seed.userId, ref)
      .run();

    const doc = await db
      .prepare("SELECT * FROM documents WHERE external_ref = ? AND tenant_id = ? AND status != 'deleted'")
      .bind(ref, seed.tenantId)
      .first();
    expect(doc).not.toBeNull();
    expect(doc!.title).toBe('Lookup Test');
  });

  it('should return null for non-existent external_ref', async () => {
    const doc = await db
      .prepare("SELECT * FROM documents WHERE external_ref = ? AND tenant_id = ? AND status != 'deleted'")
      .bind('nonexistent-ref', seed.tenantId)
      .first();
    expect(doc).toBeNull();
  });
});

describe('Documents - Document Products', () => {
  it('should link a document to a product', async () => {
    const docId = generateTestId();
    const productId = generateTestId();

    await db
      .prepare(`INSERT INTO documents (id, tenant_id, title, tags, current_version, status, created_by) VALUES (?, ?, ?, '[]', 0, 'active', ?)`)
      .bind(docId, seed.tenantId, 'Product Link Doc', seed.userId).run();

    await db
      .prepare('INSERT INTO products (id, tenant_id, name, slug, active) VALUES (?, ?, ?, ?, 1)')
      .bind(productId, seed.tenantId, 'Test Product', `test-product-${productId}`).run();

    await db
      .prepare('INSERT INTO document_products (id, document_id, product_id, expires_at, notes) VALUES (?, ?, ?, ?, ?)')
      .bind(generateTestId(), docId, productId, '2025-12-31', 'Test link').run();

    const links = await db.prepare('SELECT * FROM document_products WHERE document_id = ?').bind(docId).all();
    expect(links.results.length).toBe(1);
    expect(links.results[0].product_id).toBe(productId);
    expect(links.results[0].expires_at).toBe('2025-12-31');
  });
});
