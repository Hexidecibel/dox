/**
 * /api/assignments — ownership of (supplier, document_type) review combos.
 *
 * Covers: PUT upsert sets the owner + GET returns it with joined names;
 * re-PUT updates the same row (no duplicate); clearing to unassigned;
 * cross-tenant + non-admin rejection; DELETE by id.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { seedTestData, generateTestId } from '../helpers/db';
import { onRequestGet as listAssignments, onRequestPut as putAssignment } from '../../functions/api/assignments/index';
import { onRequestDelete as deleteAssignment } from '../../functions/api/assignments/[id]';

let seed: Awaited<ReturnType<typeof seedTestData>>;
const db = env.DB;

beforeAll(async () => {
  seed = await seedTestData(db);
}, 30_000);

type TestUser = { id: string; role: string; tenant_id: string | null };

function makeGetContext(query: string, user: TestUser) {
  const request = new Request(`http://localhost/api/assignments${query}`, { method: 'GET' });
  return {
    request, env, data: { user }, params: {},
    waitUntil: () => {}, passThroughOnException: () => {},
    next: async () => new Response(null), functionPath: '/api/assignments',
  } as unknown as Parameters<typeof listAssignments>[0];
}

function makePutContext(body: unknown, user: TestUser) {
  const request = new Request('http://localhost/api/assignments', {
    method: 'PUT', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' },
  });
  return {
    request, env, data: { user }, params: {},
    waitUntil: () => {}, passThroughOnException: () => {},
    next: async () => new Response(null), functionPath: '/api/assignments',
  } as unknown as Parameters<typeof putAssignment>[0];
}

function makeDeleteContext(id: string, user: TestUser) {
  const request = new Request(`http://localhost/api/assignments/${id}`, { method: 'DELETE' });
  return {
    request, env, data: { user }, params: { id },
    waitUntil: () => {}, passThroughOnException: () => {},
    next: async () => new Response(null), functionPath: '/api/assignments/[id]',
  } as unknown as Parameters<typeof deleteAssignment>[0];
}

async function seedSupplier(tenantId: string, name = 'Acme'): Promise<string> {
  const id = generateTestId();
  await db
    .prepare('INSERT INTO suppliers (id, tenant_id, name, slug) VALUES (?, ?, ?, ?)')
    .bind(id, tenantId, `${name} ${id.slice(0, 6)}`, `sup-${id.slice(0, 6)}`)
    .run();
  return id;
}

async function seedDocType(tenantId: string, name = 'COA'): Promise<string> {
  const id = generateTestId();
  await db
    .prepare('INSERT INTO document_types (id, tenant_id, name, slug, active) VALUES (?, ?, ?, ?, 1)')
    .bind(id, tenantId, name, `dt-${id.slice(0, 6)}`)
    .run();
  return id;
}

const orgAdmin = (): TestUser => ({ id: seed.orgAdminId, role: 'org_admin', tenant_id: seed.tenantId });
const superAdmin = (): TestUser => ({ id: seed.superAdminId, role: 'super_admin', tenant_id: null });
const regularUser = (): TestUser => ({ id: seed.userId, role: 'user', tenant_id: seed.tenantId });
const otherAdmin = (): TestUser => ({ id: seed.orgAdmin2Id, role: 'org_admin', tenant_id: seed.tenantId2 });

describe('PUT /api/assignments — upsert', () => {
  it('sets an owner, and GET returns it with joined supplier/doctype/owner names', async () => {
    const supplierId = await seedSupplier(seed.tenantId);
    const docTypeId = await seedDocType(seed.tenantId);

    const putRes = await putAssignment(makePutContext(
      { supplier_id: supplierId, document_type_id: docTypeId, owner_user_id: seed.userId },
      orgAdmin(),
    ));
    expect(putRes.status).toBe(200);
    const putData = (await putRes.json()) as { assignment: any };
    expect(putData.assignment.owner_user_id).toBe(seed.userId);
    expect(putData.assignment.supplier_name).toContain('Acme');

    const getRes = await listAssignments(makeGetContext(
      `?supplier_id=${supplierId}&document_type_id=${docTypeId}`, orgAdmin(),
    ));
    expect(getRes.status).toBe(200);
    const getData = (await getRes.json()) as { assignments: any[] };
    expect(getData.assignments).toHaveLength(1);
    const row = getData.assignments[0];
    expect(row.owner_user_id).toBe(seed.userId);
    expect(row.owner_user_name).toBe('Regular User');
    expect(row.owner_user_email).toBe('user@test.com');
    expect(row.document_type_name).toBe('COA');
    expect(typeof row.supplier_name).toBe('string');
  });

  it('re-PUT updates the existing row in place (no duplicate)', async () => {
    const supplierId = await seedSupplier(seed.tenantId);
    const docTypeId = await seedDocType(seed.tenantId);

    await putAssignment(makePutContext(
      { supplier_id: supplierId, document_type_id: docTypeId, owner_user_id: seed.userId },
      orgAdmin(),
    ));
    // Re-assign to org admin.
    const res2 = await putAssignment(makePutContext(
      { supplier_id: supplierId, document_type_id: docTypeId, owner_user_id: seed.orgAdminId },
      orgAdmin(),
    ));
    expect(res2.status).toBe(200);

    const rows = await db
      .prepare('SELECT * FROM assignments WHERE tenant_id = ? AND supplier_id = ? AND document_type_id = ?')
      .bind(seed.tenantId, supplierId, docTypeId)
      .all();
    expect(rows.results).toHaveLength(1);
    expect((rows.results[0] as any).owner_user_id).toBe(seed.orgAdminId);
  });

  it('allows clearing to unassigned (both owners null)', async () => {
    const supplierId = await seedSupplier(seed.tenantId);
    const docTypeId = await seedDocType(seed.tenantId);
    await putAssignment(makePutContext(
      { supplier_id: supplierId, document_type_id: docTypeId, owner_user_id: seed.userId },
      orgAdmin(),
    ));
    const res = await putAssignment(makePutContext(
      { supplier_id: supplierId, document_type_id: docTypeId },
      orgAdmin(),
    ));
    expect(res.status).toBe(200);
    const data = (await res.json()) as { assignment: any };
    expect(data.assignment.owner_user_id).toBeNull();
    expect(data.assignment.owner_group_id).toBeNull();
  });

  it('rejects an owner_user_id from another tenant', async () => {
    const supplierId = await seedSupplier(seed.tenantId);
    const docTypeId = await seedDocType(seed.tenantId);
    const res = await putAssignment(makePutContext(
      { supplier_id: supplierId, document_type_id: docTypeId, owner_user_id: seed.orgAdmin2Id },
      orgAdmin(),
    ));
    expect(res.status).toBe(400);
  });

  it('rejects a supplier from another tenant', async () => {
    const foreignSupplier = await seedSupplier(seed.tenantId2);
    const docTypeId = await seedDocType(seed.tenantId);
    const res = await putAssignment(makePutContext(
      { supplier_id: foreignSupplier, document_type_id: docTypeId, owner_user_id: seed.userId },
      orgAdmin(),
    ));
    expect(res.status).toBe(400);
  });

  it('rejects a non-admin (role user)', async () => {
    const supplierId = await seedSupplier(seed.tenantId);
    const docTypeId = await seedDocType(seed.tenantId);
    const res = await putAssignment(makePutContext(
      { supplier_id: supplierId, document_type_id: docTypeId, owner_user_id: seed.userId },
      regularUser(),
    ));
    expect(res.status).toBe(403);
  });

  it('super_admin can target a tenant via body.tenant_id', async () => {
    const supplierId = await seedSupplier(seed.tenantId2);
    const docTypeId = await seedDocType(seed.tenantId2);
    const res = await putAssignment(makePutContext(
      { supplier_id: supplierId, document_type_id: docTypeId, owner_user_id: seed.orgAdmin2Id, tenant_id: seed.tenantId2 },
      superAdmin(),
    ));
    expect(res.status).toBe(200);
  });
});

describe('GET /api/assignments — scoping', () => {
  it('an org_admin only sees their own tenant assignments', async () => {
    // Seed an assignment in tenant 2 via super_admin.
    const supplierId = await seedSupplier(seed.tenantId2);
    const docTypeId = await seedDocType(seed.tenantId2);
    await putAssignment(makePutContext(
      { supplier_id: supplierId, document_type_id: docTypeId, owner_user_id: seed.orgAdmin2Id, tenant_id: seed.tenantId2 },
      superAdmin(),
    ));

    const res = await listAssignments(makeGetContext('', orgAdmin()));
    const data = (await res.json()) as { assignments: any[] };
    for (const row of data.assignments) {
      expect(row.tenant_id).toBe(seed.tenantId);
    }
  });

  it('rejects a non-admin', async () => {
    const res = await listAssignments(makeGetContext('', regularUser()));
    expect(res.status).toBe(403);
  });
});

describe('DELETE /api/assignments/:id', () => {
  it('removes the assignment', async () => {
    const supplierId = await seedSupplier(seed.tenantId);
    const docTypeId = await seedDocType(seed.tenantId);
    const putRes = await putAssignment(makePutContext(
      { supplier_id: supplierId, document_type_id: docTypeId, owner_user_id: seed.userId },
      orgAdmin(),
    ));
    const { assignment } = (await putRes.json()) as { assignment: any };

    const delRes = await deleteAssignment(makeDeleteContext(assignment.id, orgAdmin()));
    expect(delRes.status).toBe(200);

    const row = await db.prepare('SELECT id FROM assignments WHERE id = ?').bind(assignment.id).first();
    expect(row).toBeNull();
  });

  it('rejects deleting an assignment in another tenant', async () => {
    const supplierId = await seedSupplier(seed.tenantId2);
    const docTypeId = await seedDocType(seed.tenantId2);
    const putRes = await putAssignment(makePutContext(
      { supplier_id: supplierId, document_type_id: docTypeId, owner_user_id: seed.orgAdmin2Id, tenant_id: seed.tenantId2 },
      superAdmin(),
    ));
    const { assignment } = (await putRes.json()) as { assignment: any };

    const delRes = await deleteAssignment(makeDeleteContext(assignment.id, orgAdmin()));
    expect(delRes.status).toBe(403);
  });
});
