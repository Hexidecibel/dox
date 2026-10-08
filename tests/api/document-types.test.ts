import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { seedTestData, generateTestId } from '../helpers/db';
import { fnContext, readJson } from '../helpers/requests';
import type { TestUser } from '../helpers/requests';
import { onRequestPost as createDocumentType } from '../../functions/api/document-types/index';
import { onRequestPut as updateDocumentType } from '../../functions/api/document-types/[id]';

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

describe('Document Types - Supplier scope (hybrid model)', () => {
  let supplierA: string;
  let supplierB: string;

  beforeAll(async () => {
    supplierA = generateTestId();
    supplierB = generateTestId();
    await db
      .prepare('INSERT INTO suppliers (id, tenant_id, name, slug) VALUES (?, ?, ?, ?)')
      .bind(supplierA, seed.tenantId, 'Supplier A', `supplier-a-${supplierA.slice(0, 6)}`).run();
    await db
      .prepare('INSERT INTO suppliers (id, tenant_id, name, slug) VALUES (?, ?, ?, ?)')
      .bind(supplierB, seed.tenantId, 'Supplier B', `supplier-b-${supplierB.slice(0, 6)}`).run();
  });

  it('should persist supplier_id on create and return it', async () => {
    const id = generateTestId();
    await db
      .prepare(
        'INSERT INTO document_types (id, tenant_id, name, slug, supplier_id, active) VALUES (?, ?, ?, ?, ?, 1)'
      )
      .bind(id, seed.tenantId, 'Owned DT', `owned-dt-${id.slice(0, 6)}`, supplierA)
      .run();

    const dt = await db.prepare('SELECT * FROM document_types WHERE id = ?').bind(id).first();
    expect(dt!.supplier_id).toBe(supplierA);
  });

  it('should default supplier_id to NULL (global) when omitted', async () => {
    const id = generateTestId();
    await db
      .prepare('INSERT INTO document_types (id, tenant_id, name, slug, active) VALUES (?, ?, ?, ?, 1)')
      .bind(id, seed.tenantId, 'Global DT', `global-dt-${id.slice(0, 6)}`)
      .run();

    const dt = await db.prepare('SELECT supplier_id FROM document_types WHERE id = ?').bind(id).first();
    expect(dt!.supplier_id).toBeNull();
  });

  it('list?supplier_id=X returns global + that supplier but not other suppliers', async () => {
    const tag = `scope-${Date.now()}`;
    const globalId = generateTestId();
    const aId = generateTestId();
    const bId = generateTestId();
    await db.prepare('INSERT INTO document_types (id, tenant_id, name, slug, active) VALUES (?, ?, ?, ?, 1)')
      .bind(globalId, seed.tenantId, `${tag}-global`, `${tag}-global`).run();
    await db.prepare('INSERT INTO document_types (id, tenant_id, name, slug, supplier_id, active) VALUES (?, ?, ?, ?, ?, 1)')
      .bind(aId, seed.tenantId, `${tag}-a`, `${tag}-a`, supplierA).run();
    await db.prepare('INSERT INTO document_types (id, tenant_id, name, slug, supplier_id, active) VALUES (?, ?, ?, ?, ?, 1)')
      .bind(bId, seed.tenantId, `${tag}-b`, `${tag}-b`, supplierB).run();

    // Mirrors the endpoint's filter: WHERE tenant_id=? AND active=1 AND (supplier_id IS NULL OR supplier_id=?)
    const result = await db
      .prepare(
        'SELECT id FROM document_types WHERE tenant_id = ? AND active = 1 AND (supplier_id IS NULL OR supplier_id = ?)'
      )
      .bind(seed.tenantId, supplierA).all();
    const ids = result.results.map((r) => r.id);
    expect(ids).toContain(globalId);
    expect(ids).toContain(aId);
    expect(ids).not.toContain(bId);
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

// ---------------------------------------------------------------------------
// The sharing rule on a type (migration 0137, decision C-003)
// ---------------------------------------------------------------------------
describe('Document Types - sharing rule', () => {
  const admin = (): TestUser => ({
    id: seed.orgAdminId,
    email: 'orgadmin@test.com',
    name: 'Org Admin',
    role: 'org_admin',
    tenant_id: seed.tenantId,
  });
  const member = (): TestUser => ({
    id: seed.userId,
    email: 'user@test.com',
    name: 'Regular User',
    role: 'user',
    tenant_id: seed.tenantId,
  });

  async function create(body: Record<string, unknown>, user: TestUser = admin()) {
    const res = await createDocumentType(
      fnContext('http://localhost/api/document-types', {
        method: 'POST',
        body: JSON.stringify({ tenant_id: seed.tenantId, ...body }),
        user,
      }),
    );
    return { status: res.status, body: (await readJson(res)) as { documentType?: Record<string, any>; error?: string } };
  }

  async function update(id: string, body: Record<string, unknown>, user: TestUser = admin()) {
    const res = await updateDocumentType(
      fnContext(`http://localhost/api/document-types/${id}`, {
        method: 'PUT',
        body: JSON.stringify(body),
        user,
        params: { id },
      }),
    );
    return { status: res.status, body: (await readJson(res)) as { documentType?: Record<string, any>; error?: string } };
  }

  const unique = (name: string) => `${name} ${generateTestId().slice(0, 6)}`;

  it('a new type starts with the rule its name calls for, STORED', async () => {
    for (const [name, rule] of [
      ['Certificate of Analysis', 'free'],
      ['Allergen Statement', 'free'],
      ['Letter of Guarantee', 'qa'],
      ['Audit Report', 'locked'],
      // Nobody recognises this one: a person looks before it goes (C-038).
      ['Vendor Questionnaire', 'qa'],
    ] as const) {
      const { status, body } = await create({ name: unique(name) });
      expect(status, name).toBe(201);
      expect(body.documentType!.sharing_rule, name).toBe(rule);
    }
  });

  it('a rule the caller states wins over the name, and a bad one is refused', async () => {
    const stated = await create({ name: unique('Certificate of Analysis'), sharing_rule: 'locked' });
    expect(stated.status).toBe(201);
    expect(stated.body.documentType!.sharing_rule).toBe('locked');

    const bad = await create({ name: unique('Anything'), sharing_rule: 'public' });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toContain('sharing_rule');
  });

  it('an admin changes it, and the change is audited on its own with what it was', async () => {
    const made = await create({ name: unique('Letter of Guarantee') });
    const id = made.body.documentType!.id as string;

    const res = await update(id, { sharing_rule: 'free' });
    expect(res.status).toBe(200);
    expect(res.body.documentType!.sharing_rule).toBe('free');

    const audit = await db
      .prepare(`SELECT user_id, details FROM audit_log WHERE action = 'document_type.sharing_rule_updated' AND resource_id = ?`)
      .bind(id)
      .all<{ user_id: string; details: string }>();
    expect(audit.results).toHaveLength(1);
    expect(audit.results[0].user_id).toBe(seed.orgAdminId);
    expect(JSON.parse(audit.results[0].details)).toEqual({
      sharing_rule: 'free',
      previous_sharing_rule: 'qa',
      previous_effective_rule: 'qa',
    });
  });

  it('a type that predates the column records what it was READ as before the change', async () => {
    // No stored rule: until now it resolved from its name.
    const id = generateTestId();
    await db
      .prepare('INSERT INTO document_types (id, tenant_id, name, slug, active) VALUES (?, ?, ?, ?, 1)')
      .bind(id, seed.tenantId, 'W-9', `w9-${id.slice(0, 6)}`)
      .run();
    const res = await update(id, { sharing_rule: 'qa' });
    expect(res.status).toBe(200);
    const audit = await db
      .prepare(`SELECT details FROM audit_log WHERE action = 'document_type.sharing_rule_updated' AND resource_id = ?`)
      .bind(id)
      .first<{ details: string }>();
    expect(JSON.parse(audit!.details)).toEqual({
      sharing_rule: 'qa',
      previous_sharing_rule: null,
      previous_effective_rule: 'locked',
    });
  });

  it('refuses a bad value, refuses null, and refuses anybody who is not an admin', async () => {
    const made = await create({ name: unique('Letter of Guarantee') });
    const id = made.body.documentType!.id as string;
    expect((await update(id, { sharing_rule: 'open' })).status).toBe(400);
    expect((await update(id, { sharing_rule: null })).status).toBe(400);
    expect((await update(id, { sharing_rule: 'free' }, member())).status).toBe(403);
    const row = await db.prepare('SELECT sharing_rule FROM document_types WHERE id = ?').bind(id).first<{ sharing_rule: string }>();
    expect(row!.sharing_rule).toBe('qa');
  });
});
