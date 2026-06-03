/**
 * API tests for GET /api/sources/:id/profile.
 *
 * A "source" is a `connectors` row. This endpoint is the read surface the
 * unified intake worker hits to learn how to route + extract a queued
 * document.
 *
 * As of migration 0068 (Connectors -> Sources refactor), the extraction
 * profile (field_mappings + extraction_instructions + examples) is keyed on
 * (tenant_id, supplier_id, document_type_id) and read from
 * `supplier_extraction_instructions` — NOT from the connector row. The :id
 * route resolves the source's supplier_id + document_type_id from the
 * connector, then loads the profile from the unified store. These tests seed
 * the profile store accordingly.
 *
 * Drives onRequestGet directly with a fake PagesFunction context — mirrors
 * tests/api/extraction-instructions.test.ts since this project's
 * vitest-pool-workers config doesn't wire up SELF.fetch.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { runMigrations, seedTestData, generateTestId } from '../helpers/db';
import { onRequestGet as getProfile } from '../../functions/api/sources/[id]/profile';

const db = env.DB;
let seed: Awaited<ReturnType<typeof seedTestData>>;

let connectorId = '';
let otherTenantConnectorId = '';

function makeContext(
  url: string,
  user: { id: string; role: string; tenant_id: string | null },
  params: Record<string, string>,
): any {
  return {
    request: new Request(url, { method: 'GET' }),
    env,
    data: { user },
    params,
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
    functionPath: '/api/sources/:id/profile',
  };
}

async function doGet(
  user: any,
  id: string,
) {
  const res = await getProfile(
    makeContext(`http://localhost/api/sources/${id}/profile`, user, { id }),
  );
  return { status: res.status, body: (await res.json()) as any };
}

/** Seed a connector with the P0 routing columns populated. */
async function insertSource(
  tenantId: string,
  opts: {
    originKind?: string;
    outputKind?: string;
    supplierId?: string | null;
    documentTypeId?: string | null;
    extractionInstructions?: string | null;
    fieldMappings?: string;
  } = {},
): Promise<string> {
  const id = generateTestId();
  await db
    .prepare(
      `INSERT INTO connectors
         (id, tenant_id, name, config, field_mappings, active,
          origin_kind, output_kind, supplier_id, document_type_id,
          extraction_instructions, created_by, created_at, updated_at)
       VALUES (?, ?, ?, '{}', ?, 1, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
    )
    .bind(
      id,
      tenantId,
      `source-test-${id.slice(0, 6)}`,
      opts.fieldMappings ?? '{}',
      opts.originKind ?? 'supplier',
      opts.outputKind ?? 'coa',
      opts.supplierId ?? null,
      opts.documentTypeId ?? null,
      opts.extractionInstructions ?? null,
      seed.orgAdminId,
    )
    .run();
  return id;
}

let supplierId = '';
let docTypeId = '';

beforeAll(async () => {
  await runMigrations(db);
  seed = await seedTestData(db);

  // Real supplier + document type for the unified profile key.
  supplierId = generateTestId();
  await db
    .prepare('INSERT INTO suppliers (id, tenant_id, name, slug) VALUES (?, ?, ?, ?)')
    .bind(supplierId, seed.tenantId, 'Profile Supplier', `profile-supp-${supplierId.slice(0, 6)}`)
    .run();

  docTypeId = generateTestId();
  await db
    .prepare('INSERT INTO document_types (id, tenant_id, name, slug) VALUES (?, ?, ?, ?)')
    .bind(docTypeId, seed.tenantId, 'COA', `coa-${docTypeId.slice(0, 6)}`)
    .run();

  // The profile (instructions + field_mappings) lives in the unified store,
  // keyed (tenant, supplier, document_type) — NOT on the connector row.
  await db
    .prepare(
      `INSERT INTO supplier_extraction_instructions
         (id, supplier_id, document_type_id, tenant_id, instructions, field_mappings,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
    )
    .bind(
      generateTestId(),
      supplierId,
      docTypeId,
      seed.tenantId,
      'Dates are DD/MM/YYYY.',
      JSON.stringify({ version: 2, fields: [{ source: 'Lot No', target: 'lot_number' }] }),
    )
    .run();

  // Connector carries only the routing key; its own field_mappings /
  // extraction_instructions columns are intentionally left as defaults to
  // prove the endpoint no longer reads them.
  connectorId = await insertSource(seed.tenantId, {
    originKind: 'supplier',
    outputKind: 'coa',
    supplierId,
    documentTypeId: docTypeId,
    extractionInstructions: null,
    fieldMappings: '{}',
  });

  otherTenantConnectorId = await insertSource(seed.tenantId2, {
    outputKind: 'order',
  });
}, 30_000);

describe('GET /api/sources/:id/profile', () => {
  it('returns the source profile shape for the owning tenant user', async () => {
    const user = { id: seed.userId, role: 'user', tenant_id: seed.tenantId };
    const { status, body } = await doGet(user, connectorId);

    expect(status).toBe(200);
    expect(body).toMatchObject({
      id: connectorId,
      tenant_id: seed.tenantId,
      origin_kind: 'supplier',
      output_kind: 'coa',
      supplier_id: supplierId,
      document_type_id: docTypeId,
      // resolved from supplier_extraction_instructions, not the connector row
      extraction_instructions: 'Dates are DD/MM/YYYY.',
    });
    // field_mappings is normalized to the canonical shape (always present).
    expect(body).toHaveProperty('field_mappings');
    expect(body.field_mappings).toBeTypeOf('object');
    // Endpoint must not leak credentials or other connector columns.
    expect(body).not.toHaveProperty('credentials_encrypted');
    expect(body).not.toHaveProperty('config');
  });

  it('super_admin can read any tenant source', async () => {
    const superUser = { id: seed.superAdminId, role: 'super_admin', tenant_id: null };
    const { status, body } = await doGet(superUser, otherTenantConnectorId);
    expect(status).toBe(200);
    expect(body.id).toBe(otherTenantConnectorId);
    expect(body.tenant_id).toBe(seed.tenantId2);
    expect(body.output_kind).toBe('order');
  });

  it('404s for a cross-tenant source (no existence leak)', async () => {
    const user = { id: seed.userId, role: 'user', tenant_id: seed.tenantId };
    const { status } = await doGet(user, otherTenantConnectorId);
    expect(status).toBe(404);
  });

  it('404s for an unknown source id', async () => {
    const user = { id: seed.userId, role: 'user', tenant_id: seed.tenantId };
    const { status } = await doGet(user, 'does-not-exist');
    expect(status).toBe(404);
  });
});
