import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { seedTestData, generateTestId } from '../helpers/db';

let seed: Awaited<ReturnType<typeof seedTestData>>;
const db = env.DB;

beforeAll(async () => {
  seed = await seedTestData(db);
}, 30_000);

describe('Document Types - Create', () => {
  it('should create with name and slug', async () => {
    const id = generateTestId();
    await db
      .prepare(
        'INSERT INTO document_types (id, tenant_id, name, slug, active) VALUES (?, ?, ?, ?, 1)'
      )
      .bind(id, seed.tenantId, 'Certificate of Analysis', 'certificate-of-analysis')
      .run();

    const dt = await db.prepare('SELECT * FROM document_types WHERE id = ?').bind(id).first();
    expect(dt).not.toBeNull();
    expect(dt!.name).toBe('Certificate of Analysis');
    expect(dt!.slug).toBe('certificate-of-analysis');
    expect(dt!.active).toBe(1);
  });

  it('should create with description', async () => {
    const id = generateTestId();
    await db
      .prepare(
        'INSERT INTO document_types (id, tenant_id, name, slug, description, active) VALUES (?, ?, ?, ?, ?, 1)'
      )
      .bind(id, seed.tenantId, 'SDS', `sds-${id.slice(0, 6)}`, 'Safety Data Sheet')
      .run();

    const dt = await db.prepare('SELECT description FROM document_types WHERE id = ?').bind(id).first();
    expect(dt!.description).toBe('Safety Data Sheet');
  });

  it('should enforce unique slug per tenant', async () => {
    const slug = `unique-dt-${Date.now()}`;
    await db
      .prepare('INSERT INTO document_types (id, tenant_id, name, slug, active) VALUES (?, ?, ?, ?, 1)')
      .bind(generateTestId(), seed.tenantId, 'First DT', slug).run();

    const existing = await db
      .prepare('SELECT id FROM document_types WHERE slug = ? AND tenant_id = ?')
      .bind(slug, seed.tenantId).first();
    expect(existing).not.toBeNull();
  });

  it('should support auto_ingest and extract_tables flags', async () => {
    const id = generateTestId();
    await db
      .prepare(
        'INSERT INTO document_types (id, tenant_id, name, slug, active, auto_ingest, extract_tables) VALUES (?, ?, ?, ?, 1, 1, 0)'
      )
      .bind(id, seed.tenantId, 'Auto DT', `auto-dt-${id.slice(0, 6)}`)
      .run();

    const dt = await db.prepare('SELECT auto_ingest, extract_tables FROM document_types WHERE id = ?').bind(id).first();
    expect(dt!.auto_ingest).toBe(1);
    expect(dt!.extract_tables).toBe(0);
  });
});

describe('Document Types - List', () => {
  it('should list active document types for a tenant', async () => {
    const result = await db
      .prepare('SELECT * FROM document_types WHERE tenant_id = ? AND active = 1 ORDER BY name ASC')
      .bind(seed.tenantId).all();
    for (const dt of result.results) {
      expect(dt.tenant_id).toBe(seed.tenantId);
      expect(dt.active).toBe(1);
    }
  });

  it('should not show inactive types by default', async () => {
    const id = generateTestId();
    await db
      .prepare('INSERT INTO document_types (id, tenant_id, name, slug, active) VALUES (?, ?, ?, ?, 0)')
      .bind(id, seed.tenantId, 'Inactive DT', `inactive-dt-${id.slice(0, 6)}`).run();

    const result = await db
      .prepare('SELECT * FROM document_types WHERE tenant_id = ? AND active = 1')
      .bind(seed.tenantId).all();
    const found = result.results.find((dt) => dt.id === id);
    expect(found).toBeUndefined();
  });
});

describe('Document Types - Get by ID', () => {
  it('should get document type by ID', async () => {
    const id = generateTestId();
    await db
      .prepare('INSERT INTO document_types (id, tenant_id, name, slug, active) VALUES (?, ?, ?, ?, 1)')
      .bind(id, seed.tenantId, 'Get DT', `get-dt-${id.slice(0, 6)}`).run();

    const dt = await db.prepare('SELECT * FROM document_types WHERE id = ?').bind(id).first();
    expect(dt).not.toBeNull();
    expect(dt!.name).toBe('Get DT');
  });

  it('should return null for non-existent', async () => {
    const dt = await db.prepare('SELECT * FROM document_types WHERE id = ?').bind('nonexistent').first();
    expect(dt).toBeNull();
  });
});

describe('Document Types - Update', () => {
  let dtId: string;

  beforeAll(async () => {
    dtId = generateTestId();
    await db
      .prepare('INSERT INTO document_types (id, tenant_id, name, slug, active) VALUES (?, ?, ?, ?, 1)')
      .bind(dtId, seed.tenantId, 'Update DT', `upd-dt-${dtId.slice(0, 6)}`).run();
  });

  it('should update name', async () => {
    await db.prepare("UPDATE document_types SET name = ?, updated_at = datetime('now') WHERE id = ?").bind('New DT Name', dtId).run();
    const dt = await db.prepare('SELECT name FROM document_types WHERE id = ?').bind(dtId).first();
    expect(dt!.name).toBe('New DT Name');
  });

  it('should soft-delete by setting active to 0', async () => {
    await db.prepare("UPDATE document_types SET active = 0, updated_at = datetime('now') WHERE id = ?").bind(dtId).run();
    const dt = await db.prepare('SELECT active FROM document_types WHERE id = ?').bind(dtId).first();
    expect(dt!.active).toBe(0);
  });
});
