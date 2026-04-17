/**
 * API tests for GET + PUT /api/extraction-instructions.
 *
 * Drives onRequestGet / onRequestPut directly with a fake PagesFunction
 * context — mirrors tests/api/activity.test.ts since the vitest-pool-workers
 * config doesn't wire up SELF.fetch in this project.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { runMigrations, seedTestData, generateTestId } from '../helpers/db';
import {
  onRequestGet as getInstructions,
  onRequestPut as putInstructions,
} from '../../functions/api/extraction-instructions/index';

const db = env.DB;
let seed: Awaited<ReturnType<typeof seedTestData>>;

// Fixtures
let supplierId = '';
let supplierId2 = '';
let otherTenantSupplierId = '';
let docTypeId = '';
let docTypeId2 = '';
let otherTenantDocTypeId = '';

function makeContext(url: string, method: string, user: { id: string; role: string; tenant_id: string | null }, body?: unknown): any {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { 'Content-Type': 'application/json' };
  }
  return {
    request: new Request(url, init),
    env,
    data: { user },
    params: {},
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
    functionPath: '/api/extraction-instructions',
  };
}

async function doGet(user: any, qs: string) {
  const res = await getInstructions(makeContext(`http://localhost/api/extraction-instructions?${qs}`, 'GET', user));
  return { status: res.status, body: await res.json() as any };
}

async function doPut(user: any, body: any) {
  const res = await putInstructions(makeContext('http://localhost/api/extraction-instructions', 'PUT', user, body));
  return { status: res.status, body: await res.json() as any };
}

beforeAll(async () => {
  // Apply migrations (includes 0035). Idempotent — re-runs tolerate
  // "already exists" errors like the helper does for the rest of the chain.
  await runMigrations(db);
  seed = await seedTestData(db);

  // Seed two suppliers + doctypes in tenant 1, and one pair in tenant 2 (for
  // cross-tenant isolation checks).
  supplierId = generateTestId();
  await db.prepare('INSERT INTO suppliers (id, tenant_id, name, slug) VALUES (?, ?, ?, ?)')
    .bind(supplierId, seed.tenantId, 'Instr Supplier A', `instr-supp-a-${supplierId.slice(0, 6)}`)
    .run();

  supplierId2 = generateTestId();
  await db.prepare('INSERT INTO suppliers (id, tenant_id, name, slug) VALUES (?, ?, ?, ?)')
    .bind(supplierId2, seed.tenantId, 'Instr Supplier B', `instr-supp-b-${supplierId2.slice(0, 6)}`)
    .run();

  otherTenantSupplierId = generateTestId();
  await db.prepare('INSERT INTO suppliers (id, tenant_id, name, slug) VALUES (?, ?, ?, ?)')
    .bind(otherTenantSupplierId, seed.tenantId2, 'Other Supplier', `other-supp-${otherTenantSupplierId.slice(0, 6)}`)
    .run();

  docTypeId = generateTestId();
  await db.prepare('INSERT INTO document_types (id, tenant_id, name, slug, active) VALUES (?, ?, ?, ?, 1)')
    .bind(docTypeId, seed.tenantId, 'COA Instr', `coa-instr-${docTypeId.slice(0, 6)}`)
    .run();

  docTypeId2 = generateTestId();
  await db.prepare('INSERT INTO document_types (id, tenant_id, name, slug, active) VALUES (?, ?, ?, ?, 1)')
    .bind(docTypeId2, seed.tenantId, 'BOL Instr', `bol-instr-${docTypeId2.slice(0, 6)}`)
    .run();

  otherTenantDocTypeId = generateTestId();
  await db.prepare('INSERT INTO document_types (id, tenant_id, name, slug, active) VALUES (?, ?, ?, ?, 1)')
    .bind(otherTenantDocTypeId, seed.tenantId2, 'Other DT', `other-dt-${otherTenantDocTypeId.slice(0, 6)}`)
    .run();
}, 30_000);

describe('GET /api/extraction-instructions', () => {
  const user = () => ({ id: seed.userId, role: 'user', tenant_id: seed.tenantId });

  it('returns nulls when no row exists for the pair', async () => {
    const qs = `supplier_id=${supplierId}&document_type_id=${docTypeId2}`;
    const { status, body } = await doGet(user(), qs);
    expect(status).toBe(200);
    expect(body.instructions).toBeNull();
    expect(body.updated_at).toBeNull();
    expect(body.updated_by).toBeNull();
  });

  it('400s when supplier_id is missing', async () => {
    const qs = `document_type_id=${docTypeId}`;
    const { status } = await doGet(user(), qs);
    expect(status).toBe(400);
  });

  it('400s when document_type_id is missing', async () => {
    const qs = `supplier_id=${supplierId}`;
    const { status } = await doGet(user(), qs);
    expect(status).toBe(400);
  });
});

describe('PUT /api/extraction-instructions', () => {
  const user = () => ({ id: seed.userId, role: 'user', tenant_id: seed.tenantId });

  it('creates a row on first upsert and returns it', async () => {
    const { status, body } = await doPut(user(), {
      supplier_id: supplierId,
      document_type_id: docTypeId,
      instructions: 'COAG values belong in column A, not column B.',
    });
    expect(status).toBe(200);
    expect(body.instructions).toMatchObject({
      supplier_id: supplierId,
      document_type_id: docTypeId,
      tenant_id: seed.tenantId,
      instructions: 'COAG values belong in column A, not column B.',
      updated_by: seed.userId,
    });
  });

  it('GET returns the row after PUT', async () => {
    const qs = `supplier_id=${supplierId}&document_type_id=${docTypeId}`;
    const { status, body } = await doGet(user(), qs);
    expect(status).toBe(200);
    expect(body.instructions).toBe('COAG values belong in column A, not column B.');
    expect(body.updated_by).toBe(seed.userId);
    expect(body.updated_at).toBeTruthy();
  });

  it('second PUT on the same pair updates the existing row (upsert)', async () => {
    await doPut(user(), {
      supplier_id: supplierId,
      document_type_id: docTypeId,
      instructions: 'Updated guidance: ignore fake customer field.',
    });
    const { body } = await doGet(user(), `supplier_id=${supplierId}&document_type_id=${docTypeId}`);
    expect(body.instructions).toBe('Updated guidance: ignore fake customer field.');
  });

  it('rejects instructions when supplier does not belong to tenant (cross-tenant)', async () => {
    const { status } = await doPut(user(), {
      supplier_id: otherTenantSupplierId,
      document_type_id: docTypeId,
      instructions: 'attempting cross-tenant write',
    });
    expect(status).toBe(400);
  });

  it('rejects instructions when document_type does not belong to tenant', async () => {
    const { status } = await doPut(user(), {
      supplier_id: supplierId,
      document_type_id: otherTenantDocTypeId,
      instructions: 'attempting cross-tenant write',
    });
    expect(status).toBe(400);
  });

  it('400s when instructions is not a string', async () => {
    const { status } = await doPut(user(), {
      supplier_id: supplierId,
      document_type_id: docTypeId,
      instructions: 42,
    });
    expect(status).toBe(400);
  });

  it('400s when instructions exceeds length cap', async () => {
    const bigText = 'x'.repeat(8001);
    const { status } = await doPut(user(), {
      supplier_id: supplierId,
      document_type_id: docTypeId,
      instructions: bigText,
    });
    expect(status).toBe(400);
  });

  it('rejects reader role', async () => {
    const readerUser = { id: seed.readerId, role: 'reader', tenant_id: seed.tenantId };
    const { status } = await doPut(readerUser as any, {
      supplier_id: supplierId,
      document_type_id: docTypeId,
      instructions: 'reader should not write',
    });
    expect(status).toBe(403);
  });
});

describe('Tenant isolation', () => {
  it('other-tenant user cannot read this tenant\'s instructions', async () => {
    const otherUser = { id: seed.orgAdmin2Id, role: 'org_admin', tenant_id: seed.tenantId2 };
    // Use the supplier_id that belongs to tenant 1 — the query is scoped to
    // the caller's tenant, so this should return nulls (not the tenant-1 row).
    const qs = `supplier_id=${supplierId}&document_type_id=${docTypeId}`;
    const { status, body } = await doGet(otherUser as any, qs);
    expect(status).toBe(200);
    expect(body.instructions).toBeNull();
  });

  it('super_admin can target any tenant via tenant_id query param', async () => {
    const superUser = { id: seed.superAdminId, role: 'super_admin', tenant_id: null };
    const qs = `supplier_id=${supplierId}&document_type_id=${docTypeId}&tenant_id=${seed.tenantId}`;
    const { status, body } = await doGet(superUser as any, qs);
    expect(status).toBe(200);
    expect(body.instructions).toBe('Updated guidance: ignore fake customer field.');
  });

  it('super_admin without tenant_id gets 400', async () => {
    const superUser = { id: seed.superAdminId, role: 'super_admin', tenant_id: null };
    const qs = `supplier_id=${supplierId}&document_type_id=${docTypeId}`;
    const { status } = await doGet(superUser as any, qs);
    expect(status).toBe(400);
  });
});
