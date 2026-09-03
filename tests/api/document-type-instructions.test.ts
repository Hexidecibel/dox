/**
 * API tests for the DOCUMENT-TYPE layer of the extraction prompt stack
 * (migration 0098) and, more importantly, for the RESOLUTION ORDER of the whole
 * stack.
 *
 * The behaviour worth pinning is not CRUD. It is:
 *   - a type-level instruction reaching the prompt when NO supplier-level row
 *     exists (the case the layer was built for — a first-time vendor);
 *   - the two layers COMPOSING general -> specific when both exist, rather than
 *     the narrower one replacing the broader one;
 *   - `instructions` staying the supplier row verbatim, because the reviewer's
 *     editor PUTs that value straight back and folding the broader layer into
 *     it would copy shared text into one supplier's row on the next blur.
 *
 * Driven with a fake PagesFunction context, same as
 * tests/api/extraction-instructions.test.ts.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { runMigrations, seedTestData, generateTestId } from '../helpers/db';
import {
  onRequestGet as getTypeInstructions,
  onRequestPut as putTypeInstructions,
  onRequestDelete as deleteTypeInstructions,
} from '../../functions/api/document-type-instructions/index';
import {
  onRequestGet as getPairInstructions,
  onRequestPut as putPairInstructions,
} from '../../functions/api/extraction-instructions/index';
import { onRequestGet as getBySupplier } from '../../functions/api/extraction-instructions/by-supplier';
import { resolveInstructionStack, composeInstructions } from '../../functions/lib/extractionInstructionStack';

const db = env.DB;
let seed: Awaited<ReturnType<typeof seedTestData>>;

let supplierId = '';
let otherSupplierId = '';
let coiTypeId = '';
let kosherTypeId = '';
let otherTenantTypeId = '';

interface TestUser {
  id: string;
  role: string;
  tenant_id: string | null;
}

function makeContext(url: string, method: string, user: TestUser, body?: unknown): any {
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
    functionPath: '/api/document-type-instructions',
  };
}

async function typeGet(user: TestUser, qs: string) {
  const res = await getTypeInstructions(
    makeContext(`http://localhost/api/document-type-instructions?${qs}`, 'GET', user),
  );
  return { status: res.status, body: (await res.json()) as any };
}

async function typePut(user: TestUser, body: unknown) {
  const res = await putTypeInstructions(
    makeContext('http://localhost/api/document-type-instructions', 'PUT', user, body),
  );
  return { status: res.status, body: (await res.json()) as any };
}

async function typeDelete(user: TestUser, qs: string) {
  const res = await deleteTypeInstructions(
    makeContext(`http://localhost/api/document-type-instructions?${qs}`, 'DELETE', user),
  );
  return { status: res.status, body: (await res.json()) as any };
}

async function pairGet(user: TestUser, qs: string) {
  const res = await getPairInstructions(
    makeContext(`http://localhost/api/extraction-instructions?${qs}`, 'GET', user),
  );
  return { status: res.status, body: (await res.json()) as any };
}

async function pairPut(user: TestUser, body: unknown) {
  const res = await putPairInstructions(
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
    .bind(supplierId, seed.tenantId, 'Layered Supplier', `layered-${supplierId.slice(0, 6)}`)
    .run();

  otherSupplierId = generateTestId();
  await db
    .prepare('INSERT INTO suppliers (id, tenant_id, name, slug) VALUES (?, ?, ?, ?)')
    .bind(otherSupplierId, seed.tenantId, 'Brand New Supplier', `brandnew-${otherSupplierId.slice(0, 6)}`)
    .run();

  coiTypeId = generateTestId();
  await db
    .prepare('INSERT INTO document_types (id, tenant_id, name, slug, active) VALUES (?, ?, ?, ?, 1)')
    .bind(coiTypeId, seed.tenantId, 'Certificate of Insurance', `coi-${coiTypeId.slice(0, 6)}`)
    .run();

  kosherTypeId = generateTestId();
  await db
    .prepare('INSERT INTO document_types (id, tenant_id, name, slug, active) VALUES (?, ?, ?, ?, 1)')
    .bind(kosherTypeId, seed.tenantId, 'Kosher Certificate', `kosher-${kosherTypeId.slice(0, 6)}`)
    .run();

  otherTenantTypeId = generateTestId();
  await db
    .prepare('INSERT INTO document_types (id, tenant_id, name, slug, active) VALUES (?, ?, ?, ?, 1)')
    .bind(otherTenantTypeId, seed.tenantId2, 'Foreign Type', `foreign-${otherTenantTypeId.slice(0, 6)}`)
    .run();
}, 30_000);

const orgAdmin = (): TestUser => ({ id: seed.orgAdminId, role: 'org_admin', tenant_id: seed.tenantId });
const plainUser = (): TestUser => ({ id: seed.userId, role: 'user', tenant_id: seed.tenantId });

describe('CRUD on /api/document-type-instructions', () => {
  it('reports null instructions for a type nobody has written guidance for', async () => {
    const { status, body } = await typeGet(orgAdmin(), `document_type_id=${kosherTypeId}`);
    expect(status).toBe(200);
    expect(body.instructions).toBeNull();
    expect(body.document_type_name).toBe('Kosher Certificate');
    expect(body.supplier_overrides).toEqual([]);
  });

  it('upserts and reads back, then updates in place', async () => {
    const first = await typePut(orgAdmin(), {
      document_type_id: coiTypeId,
      instructions: 'The expiry is the earliest POLICY EXP on the ACORD grid.',
    });
    expect(first.status).toBe(200);

    const second = await typePut(orgAdmin(), {
      document_type_id: coiTypeId,
      instructions: 'The INSURED box is the supplier; the PRODUCER box is the broker.',
    });
    expect(second.status).toBe(200);

    const { body } = await typeGet(orgAdmin(), `document_type_id=${coiTypeId}`);
    expect(body.instructions).toBe('The INSURED box is the supplier; the PRODUCER box is the broker.');

    // One row, not two — the plain UNIQUE(tenant_id, document_type_id) from
    // 0098 actually constrains, which is the whole reason this layer got its
    // own table instead of a nullable supplier_id.
    const count = await db
      .prepare(
        `SELECT COUNT(*) AS n FROM document_type_extraction_instructions
          WHERE tenant_id = ? AND document_type_id = ?`,
      )
      .bind(seed.tenantId, coiTypeId)
      .first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  it('lists every active type, authored or not', async () => {
    const { status, body } = await typeGet(orgAdmin(), '');
    expect(status).toBe(200);
    const byId = new Map(body.document_types.map((r: any) => [r.document_type_id, r]));
    expect(byId.get(coiTypeId).instructions).toContain('INSURED box');
    expect(byId.get(kosherTypeId).instructions).toBeNull();
  });

  it('refuses a document type from another tenant', async () => {
    const { status } = await typePut(orgAdmin(), {
      document_type_id: otherTenantTypeId,
      instructions: 'should not land',
    });
    expect(status).toBe(400);
  });

  it('deletes the layer, and deleting again is still a success', async () => {
    await typePut(orgAdmin(), { document_type_id: kosherTypeId, instructions: 'temp' });
    const first = await typeDelete(orgAdmin(), `document_type_id=${kosherTypeId}`);
    expect(first.status).toBe(200);
    expect(first.body.deleted).toBe(true);

    const second = await typeDelete(orgAdmin(), `document_type_id=${kosherTypeId}`);
    expect(second.status).toBe(200);
    expect(second.body.deleted).toBe(false);
  });

  it('lets a plain user author a layer but not remove one', async () => {
    const put = await typePut(plainUser(), {
      document_type_id: kosherTypeId,
      instructions: 'The agency (OU, OK, Star-K) is the issuing body.',
    });
    expect(put.status).toBe(200);

    const del = await typeDelete(plainUser(), `document_type_id=${kosherTypeId}`);
    expect(del.status).toBe(403);
  });
});

describe('resolution order across the stack', () => {
  it('applies the type layer when NO supplier-level row exists', async () => {
    // The case the layer exists for: a supplier nobody has ever configured
    // sends a Kosher Certificate. Before 0098 this extracted with no guidance
    // at all.
    const stack = await resolveInstructionStack(db, {
      tenantId: seed.tenantId,
      supplierId: otherSupplierId,
      documentTypeId: kosherTypeId,
    });
    expect(stack.supplier_instructions).toBe('');
    expect(stack.type_instructions).toContain('Star-K');
    // With only one layer there is no labelling to do — it is emitted bare, so
    // a tenant that has only ever had one layer sees no prompt change.
    expect(stack.effective_instructions).toBe(stack.type_instructions);
  });

  it('applies the type layer with no supplier resolved at all', async () => {
    const stack = await resolveInstructionStack(db, {
      tenantId: seed.tenantId,
      supplierId: null,
      documentTypeId: kosherTypeId,
    });
    expect(stack.type_instructions).toContain('Star-K');
    expect(stack.effective_instructions).toContain('Star-K');
  });

  it('composes both layers general -> specific when both exist', async () => {
    await pairPut(orgAdmin(), {
      supplier_id: supplierId,
      document_type_id: kosherTypeId,
      instructions: 'This plant prints the UKD number in the footer, not the header.',
    });

    const stack = await resolveInstructionStack(db, {
      tenantId: seed.tenantId,
      supplierId,
      documentTypeId: kosherTypeId,
    });

    const typeAt = stack.effective_instructions.indexOf('Star-K');
    const supplierAt = stack.effective_instructions.indexOf('UKD number');
    expect(typeAt).toBeGreaterThanOrEqual(0);
    expect(supplierAt).toBeGreaterThanOrEqual(0);
    // Specific text comes LAST so it reads as a refinement of what precedes it.
    expect(supplierAt).toBeGreaterThan(typeAt);
    // And the composed text says which is which, so a prompt dump is readable.
    expect(stack.effective_instructions).toContain('applies to every supplier');
    expect(stack.effective_instructions).toContain('refines');
  });

  it('keeps `instructions` the supplier row alone, and composes into a separate field', async () => {
    const { body } = await pairGet(orgAdmin(), `supplier_id=${supplierId}&document_type_id=${kosherTypeId}`);
    // The reviewer editor round-trips this value. If the type layer leaked in
    // here, the next blur would copy shared text into this supplier's row.
    expect(body.instructions).toBe('This plant prints the UKD number in the footer, not the header.');
    expect(body.document_type_instructions).toContain('Star-K');
    expect(body.effective_instructions).toContain('Star-K');
    expect(body.effective_instructions).toContain('UKD number');
  });

  it('serves the type layer for a supplier with nothing of its own', async () => {
    const { body } = await pairGet(
      orgAdmin(),
      `supplier_id=${otherSupplierId}&document_type_id=${kosherTypeId}`,
    );
    expect(body.instructions).toBeNull();
    expect(body.document_type_instructions).toContain('Star-K');
    expect(body.effective_instructions).toContain('Star-K');
  });

  it('reports null on both layers when neither exists', async () => {
    const bareTypeId = generateTestId();
    await db
      .prepare('INSERT INTO document_types (id, tenant_id, name, slug, active) VALUES (?, ?, ?, ?, 1)')
      .bind(bareTypeId, seed.tenantId, 'Bare Type', `bare-${bareTypeId.slice(0, 6)}`)
      .run();
    const { body } = await pairGet(orgAdmin(), `supplier_id=${supplierId}&document_type_id=${bareTypeId}`);
    expect(body.instructions).toBeNull();
    expect(body.document_type_instructions).toBeNull();
    expect(body.effective_instructions).toBeNull();
  });

  it('does not leak a type layer across tenants', async () => {
    const stack = await resolveInstructionStack(db, {
      tenantId: seed.tenantId2,
      supplierId: null,
      documentTypeId: kosherTypeId,
    });
    expect(stack.type_instructions).toBe('');
  });

  it('surfaces suppliers that refine a type, so the editor can show the layering', async () => {
    const { body } = await typeGet(orgAdmin(), `document_type_id=${kosherTypeId}`);
    expect(body.supplier_overrides.map((o: any) => o.supplier_name)).toContain('Layered Supplier');
  });

  it('carries the inherited layer on the by-supplier listing', async () => {
    const res = await getBySupplier(
      makeContext(
        `http://localhost/api/extraction-instructions/by-supplier?supplier_id=${otherSupplierId}`,
        'GET',
        orgAdmin(),
      ),
    );
    const body = (await res.json()) as any;
    const row = body.document_types.find((r: any) => r.document_type_id === kosherTypeId);
    // This supplier has authored nothing, but the tab must still show what the
    // type says — otherwise a reviewer re-types it here, per supplier.
    expect(row.instructions).toBeNull();
    expect(row.type_instructions).toContain('Star-K');
  });
});

describe('composeInstructions', () => {
  it('emits a single layer bare, so nothing changes for a one-layer tenant', () => {
    expect(composeInstructions('', 'only the supplier')).toBe('only the supplier');
    expect(composeInstructions('only the type', '')).toBe('only the type');
    expect(composeInstructions('', '')).toBe('');
  });

  it('labels both layers when both are present', () => {
    const out = composeInstructions('TYPE TEXT', 'SUPPLIER TEXT');
    expect(out.indexOf('TYPE TEXT')).toBeLessThan(out.indexOf('SUPPLIER TEXT'));
    expect(out).toContain('applies to every supplier');
  });
});
