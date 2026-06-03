/**
 * GET /api/queue — profile_exists enrichment.
 *
 * Each returned queue item carries profile_exists: true when a
 * supplier_extraction_instructions row with non-empty instructions exists for
 * its (supplier_id, document_type_id) pair, false otherwise (and always false
 * when supplier_id is NULL / unverified).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { seedTestData, generateTestId } from '../helpers/db';
import { onRequestGet as listQueue } from '../../functions/api/queue/index';

let seed: Awaited<ReturnType<typeof seedTestData>>;
const db = env.DB;

beforeAll(async () => {
  seed = await seedTestData(db);
}, 30_000);

function makeGetContext(
  query: string,
  user: { id: string; role: string; tenant_id: string | null }
) {
  const request = new Request(`http://localhost/api/queue${query}`, { method: 'GET' });
  return {
    request,
    env,
    data: { user },
    params: {},
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
    functionPath: '/api/queue',
  } as unknown as Parameters<typeof listQueue>[0];
}

async function seedSupplier(tenantId: string): Promise<string> {
  const id = generateTestId();
  await db
    .prepare('INSERT INTO suppliers (id, tenant_id, name, slug) VALUES (?, ?, ?, ?)')
    .bind(id, tenantId, `Sup ${id.slice(0, 6)}`, `sup-${id.slice(0, 6)}`)
    .run();
  return id;
}

async function seedDocType(tenantId: string): Promise<string> {
  const id = generateTestId();
  await db
    .prepare('INSERT INTO document_types (id, tenant_id, name, slug, active) VALUES (?, ?, ?, ?, 1)')
    .bind(id, tenantId, 'COA', `coa-${id.slice(0, 6)}`)
    .run();
  return id;
}

async function seedInstructions(
  tenantId: string,
  supplierId: string,
  docTypeId: string,
  instructions: string
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO supplier_extraction_instructions
         (id, supplier_id, document_type_id, tenant_id, instructions)
       VALUES (?, ?, ?, ?, ?)`
    )
    .bind(generateTestId(), supplierId, docTypeId, tenantId, instructions)
    .run();
}

async function seedQueueItem(
  tenantId: string,
  userId: string,
  opts: { supplierId: string | null; docTypeId: string | null }
): Promise<string> {
  const id = generateTestId();
  await db
    .prepare(
      `INSERT INTO processing_queue
       (id, tenant_id, document_type_id, file_r2_key, file_name, file_size, mime_type,
        processing_status, status, created_by, supplier_id)
       VALUES (?, ?, ?, ?, 'f.pdf', 10, 'application/pdf', 'ready', 'pending', ?, ?)`
    )
    .bind(id, tenantId, opts.docTypeId, `queue/${id}/f.pdf`, userId, opts.supplierId)
    .run();
  return id;
}

const orgAdmin = () => ({ id: seed.orgAdminId, role: 'org_admin', tenant_id: seed.tenantId });

describe('GET /api/queue profile_exists', () => {
  it('is true when an instructions row exists for the item pair, false otherwise', async () => {
    const docTypeId = await seedDocType(seed.tenantId);
    const supplierWithProfile = await seedSupplier(seed.tenantId);
    const supplierNoProfile = await seedSupplier(seed.tenantId);

    await seedInstructions(seed.tenantId, supplierWithProfile, docTypeId, 'Lot is top-right.');

    const idWith = await seedQueueItem(seed.tenantId, seed.orgAdminId, {
      supplierId: supplierWithProfile,
      docTypeId,
    });
    const idWithout = await seedQueueItem(seed.tenantId, seed.orgAdminId, {
      supplierId: supplierNoProfile,
      docTypeId,
    });
    // Unverified item: supplier_id NULL -> always false.
    const idUnverified = await seedQueueItem(seed.tenantId, seed.orgAdminId, {
      supplierId: null,
      docTypeId,
    });

    const res = await listQueue(makeGetContext('?status=pending&limit=200', orgAdmin()));
    expect(res.status).toBe(200);
    const data = (await res.json()) as { items: Array<{ id: string; profile_exists: boolean }> };

    const byId = new Map(data.items.map((i) => [i.id, i.profile_exists]));
    expect(byId.get(idWith)).toBe(true);
    expect(byId.get(idWithout)).toBe(false);
    expect(byId.get(idUnverified)).toBe(false);
  });

  it('is false when the instructions row exists but is empty', async () => {
    const docTypeId = await seedDocType(seed.tenantId);
    const supplier = await seedSupplier(seed.tenantId);
    await seedInstructions(seed.tenantId, supplier, docTypeId, '   ');

    const id = await seedQueueItem(seed.tenantId, seed.orgAdminId, {
      supplierId: supplier,
      docTypeId,
    });

    const res = await listQueue(makeGetContext('?status=pending&limit=200', orgAdmin()));
    const data = (await res.json()) as { items: Array<{ id: string; profile_exists: boolean }> };
    const found = data.items.find((i) => i.id === id);
    expect(found?.profile_exists).toBe(false);
  });
});
