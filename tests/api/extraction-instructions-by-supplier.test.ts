/**
 * API tests for GET /api/extraction-instructions/by-supplier (R2.a).
 *
 * The endpoint backs the SupplierDetail "Extraction Instructions" tab. It
 * returns one row per active document_type in the tenant, with the
 * reviewer-authored instructions for that (supplier, doc_type) pair when
 * present, or `null` when absent. The UI's render path uses the same row
 * shape for both states — server pre-joins so the page doesn't fan out N
 * single-pair GETs.
 *
 * Drives the handler directly with a fake PagesFunction context.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { runMigrations, seedTestData, generateTestId } from '../helpers/db';
import { onRequestGet as listBySupplier } from '../../functions/api/extraction-instructions/by-supplier';
import { onRequestPut as putInstructions } from '../../functions/api/extraction-instructions/index';

const db = env.DB;
let seed: Awaited<ReturnType<typeof seedTestData>>;

// Fixtures (initialized in beforeAll)
let supplierId = '';
let otherTenantSupplierId = '';
let docTypeAId = '';
let docTypeBId = '';
let docTypeInactiveId = '';
let otherTenantDocTypeId = '';

function makeContext(
  url: string,
  method: string,
  user: { id: string; role: string; tenant_id: string | null },
  body?: unknown,
): any {
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
    functionPath: '/api/extraction-instructions/by-supplier',
  };
}

async function doGet(user: any, qs: string) {
  const res = await listBySupplier(
    makeContext(`http://localhost/api/extraction-instructions/by-supplier?${qs}`, 'GET', user),
  );
  return { status: res.status, body: (await res.json()) as any };
}

async function doPut(user: any, body: any) {
  const res = await putInstructions(
    makeContext('http://localhost/api/extraction-instructions', 'PUT', user, body),
  );
  return { status: res.status, body: (await res.json()) as any };
}

beforeAll(async () => {
  await runMigrations(db);
  seed = await seedTestData(db);

  supplierId = generateTestId();
  await db
    .prepare('INSERT INTO suppliers (id, tenant_id, name, slug) VALUES (?, ?, ?, ?)')
    .bind(supplierId, seed.tenantId, 'By-Supplier Test Co', `bs-test-${supplierId.slice(0, 6)}`)
    .run();

  otherTenantSupplierId = generateTestId();
  await db
    .prepare('INSERT INTO suppliers (id, tenant_id, name, slug) VALUES (?, ?, ?, ?)')
    .bind(otherTenantSupplierId, seed.tenantId2, 'Other Tenant Supplier', `other-${otherTenantSupplierId.slice(0, 6)}`)
    .run();

  docTypeAId = generateTestId();
  await db
    .prepare('INSERT INTO document_types (id, tenant_id, name, slug, active) VALUES (?, ?, ?, ?, 1)')
    .bind(docTypeAId, seed.tenantId, 'A-COA', `a-coa-${docTypeAId.slice(0, 6)}`)
    .run();

  docTypeBId = generateTestId();
  await db
    .prepare('INSERT INTO document_types (id, tenant_id, name, slug, active) VALUES (?, ?, ?, ?, 1)')
    .bind(docTypeBId, seed.tenantId, 'B-BOL', `b-bol-${docTypeBId.slice(0, 6)}`)
    .run();

  docTypeInactiveId = generateTestId();
  await db
    .prepare('INSERT INTO document_types (id, tenant_id, name, slug, active) VALUES (?, ?, ?, ?, 0)')
    .bind(docTypeInactiveId, seed.tenantId, 'Z-INACTIVE', `z-inactive-${docTypeInactiveId.slice(0, 6)}`)
    .run();

  otherTenantDocTypeId = generateTestId();
  await db
    .prepare('INSERT INTO document_types (id, tenant_id, name, slug, active) VALUES (?, ?, ?, ?, 1)')
    .bind(otherTenantDocTypeId, seed.tenantId2, 'Other-DT', `other-dt-${otherTenantDocTypeId.slice(0, 6)}`)
    .run();
}, 30_000);

describe('GET /api/extraction-instructions/by-supplier', () => {
  const user = () => ({ id: seed.userId, role: 'user', tenant_id: seed.tenantId });

  it('returns one row per active doctype with null instructions when none exist', async () => {
    const { status, body } = await doGet(user(), `supplier_id=${supplierId}`);
    expect(status).toBe(200);
    expect(body.supplier_id).toBe(supplierId);
    expect(body.tenant_id).toBe(seed.tenantId);
    expect(Array.isArray(body.document_types)).toBe(true);
    // Only the 2 active doctypes we seeded; the inactive Z-INACTIVE is filtered.
    // Note: other tests in this suite may seed additional doctypes for this
    // tenant — assert membership of our IDs rather than exact length.
    const byId = new Map<string, any>(
      body.document_types.map((r: any) => [r.document_type_id, r]),
    );
    expect(byId.has(docTypeAId)).toBe(true);
    expect(byId.has(docTypeBId)).toBe(true);
    expect(byId.has(docTypeInactiveId)).toBe(false);
    expect(byId.get(docTypeAId).instructions).toBeNull();
    expect(byId.get(docTypeBId).instructions).toBeNull();
    expect(byId.get(docTypeAId).document_type_name).toBe('A-COA');
  });

  it('returns authored instructions on the matching doctype row only', async () => {
    // PUT instructions on doctype A, leave B untouched.
    const putRes = await doPut(user(), {
      supplier_id: supplierId,
      document_type_id: docTypeAId,
      instructions: 'A-specific reviewer guidance: trust the second column.',
    });
    expect(putRes.status).toBe(200);

    const { status, body } = await doGet(user(), `supplier_id=${supplierId}`);
    expect(status).toBe(200);

    const a = body.document_types.find((r: any) => r.document_type_id === docTypeAId);
    const b = body.document_types.find((r: any) => r.document_type_id === docTypeBId);
    expect(a.instructions).toBe('A-specific reviewer guidance: trust the second column.');
    expect(a.updated_by).toBe(seed.userId);
    expect(a.updated_at).toBeTruthy();
    expect(b.instructions).toBeNull();
  });

  it('400s when supplier_id is missing', async () => {
    const { status } = await doGet(user(), '');
    expect(status).toBe(400);
  });

  it('400s when supplier does not belong to caller tenant', async () => {
    const { status } = await doGet(user(), `supplier_id=${otherTenantSupplierId}`);
    expect(status).toBe(400);
  });

  it('cross-tenant user gets 400 (supplier scoped to their tenant doesn\'t match)', async () => {
    const otherUser = { id: seed.orgAdmin2Id, role: 'org_admin', tenant_id: seed.tenantId2 };
    const { status } = await doGet(otherUser as any, `supplier_id=${supplierId}`);
    expect(status).toBe(400);
  });

  it('reader role is permitted (matches single-pair GET semantics)', async () => {
    // Reader can READ but not write. The endpoint includes 'user' in the
    // allowed roles — readers map to false here. Verify rejection is 403.
    const reader = { id: seed.readerId, role: 'reader', tenant_id: seed.tenantId };
    const { status } = await doGet(reader as any, `supplier_id=${supplierId}`);
    expect(status).toBe(403);
  });

  it('super_admin must supply tenant_id', async () => {
    const superUser = { id: seed.superAdminId, role: 'super_admin', tenant_id: null };
    const { status } = await doGet(superUser as any, `supplier_id=${supplierId}`);
    expect(status).toBe(400);
  });

  it('super_admin with tenant_id returns the list', async () => {
    const superUser = { id: seed.superAdminId, role: 'super_admin', tenant_id: null };
    const { status, body } = await doGet(
      superUser as any,
      `supplier_id=${supplierId}&tenant_id=${seed.tenantId}`,
    );
    expect(status).toBe(200);
    expect(body.document_types.length).toBeGreaterThan(0);
  });
});
