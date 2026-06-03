/**
 * GET /api/queue?mine=1 — per-owner review filter.
 *
 * Returns only items whose (supplier_id, document_type_id) is owned by the
 * caller via an assignments row (owner_user_id = caller). Excludes items
 * owned by someone else, unowned combos, and NULL-supplier items. Composes
 * with the existing status / processing_status filters. Powers the Review
 * "Mine" view and the notifications bell feed.
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

type TestUser = { id: string; role: string; tenant_id: string | null };

function makeGetContext(query: string, user: TestUser) {
  const request = new Request(`http://localhost/api/queue${query}`, { method: 'GET' });
  return {
    request, env, data: { user }, params: {},
    waitUntil: () => {}, passThroughOnException: () => {},
    next: async () => new Response(null), functionPath: '/api/queue',
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

async function assign(tenantId: string, supplierId: string, docTypeId: string, ownerUserId: string | null) {
  await db
    .prepare(
      `INSERT INTO assignments (id, tenant_id, supplier_id, document_type_id, owner_user_id)
       VALUES (?, ?, ?, ?, ?)`
    )
    .bind(generateTestId(), tenantId, supplierId, docTypeId, ownerUserId)
    .run();
}

async function seedQueueItem(
  tenantId: string,
  opts: { supplierId: string | null; docTypeId: string | null; status?: string; processingStatus?: string }
): Promise<string> {
  const id = generateTestId();
  await db
    .prepare(
      `INSERT INTO processing_queue
       (id, tenant_id, document_type_id, file_r2_key, file_name, file_size, mime_type,
        processing_status, status, created_by, supplier_id)
       VALUES (?, ?, ?, ?, 'f.pdf', 10, 'application/pdf', ?, ?, ?, ?)`
    )
    .bind(
      id, tenantId, opts.docTypeId, `queue/${id}/f.pdf`,
      opts.processingStatus ?? 'ready', opts.status ?? 'pending',
      seed.orgAdminId, opts.supplierId,
    )
    .run();
  return id;
}

const orgAdmin = (): TestUser => ({ id: seed.orgAdminId, role: 'org_admin', tenant_id: seed.tenantId });

describe('GET /api/queue?mine=1', () => {
  it('returns only items owned by the caller, excluding others and NULL-supplier items', async () => {
    const docTypeId = await seedDocType(seed.tenantId);
    const mySupplier = await seedSupplier(seed.tenantId);
    const otherSupplier = await seedSupplier(seed.tenantId);
    const unownedSupplier = await seedSupplier(seed.tenantId);

    // mySupplier+docType owned by the caller (orgAdmin); otherSupplier owned by someone else.
    await assign(seed.tenantId, mySupplier, docTypeId, seed.orgAdminId);
    await assign(seed.tenantId, otherSupplier, docTypeId, seed.userId);
    // unownedSupplier has no assignment row.

    const mineItem = await seedQueueItem(seed.tenantId, { supplierId: mySupplier, docTypeId });
    const othersItem = await seedQueueItem(seed.tenantId, { supplierId: otherSupplier, docTypeId });
    const unownedItem = await seedQueueItem(seed.tenantId, { supplierId: unownedSupplier, docTypeId });
    const nullSupplierItem = await seedQueueItem(seed.tenantId, { supplierId: null, docTypeId });

    const res = await listQueue(makeGetContext('?status=pending&mine=1&limit=200', orgAdmin()));
    expect(res.status).toBe(200);
    const data = (await res.json()) as { items: Array<{ id: string }>; total: number };
    const ids = new Set(data.items.map((i) => i.id));

    expect(ids.has(mineItem)).toBe(true);
    expect(ids.has(othersItem)).toBe(false);
    expect(ids.has(unownedItem)).toBe(false);
    expect(ids.has(nullSupplierItem)).toBe(false);
  });

  it('composes with status + processing_status filters (the bell feed shape)', async () => {
    const docTypeId = await seedDocType(seed.tenantId);
    const supplier = await seedSupplier(seed.tenantId);
    await assign(seed.tenantId, supplier, docTypeId, seed.orgAdminId);

    const readyPending = await seedQueueItem(seed.tenantId, {
      supplierId: supplier, docTypeId, status: 'pending', processingStatus: 'ready',
    });
    const notReady = await seedQueueItem(seed.tenantId, {
      supplierId: supplier, docTypeId, status: 'pending', processingStatus: 'queued',
    });

    const res = await listQueue(makeGetContext(
      '?mine=1&status=pending&processing_status=ready&limit=6', orgAdmin(),
    ));
    const data = (await res.json()) as { items: Array<{ id: string }> };
    const ids = new Set(data.items.map((i) => i.id));
    expect(ids.has(readyPending)).toBe(true);
    expect(ids.has(notReady)).toBe(false);
  });

  it('without mine, ownership is ignored (item still returned)', async () => {
    const docTypeId = await seedDocType(seed.tenantId);
    const supplier = await seedSupplier(seed.tenantId);
    // owned by someone else
    await assign(seed.tenantId, supplier, docTypeId, seed.userId);
    const item = await seedQueueItem(seed.tenantId, { supplierId: supplier, docTypeId });

    const res = await listQueue(makeGetContext('?status=pending&limit=200', orgAdmin()));
    const data = (await res.json()) as { items: Array<{ id: string }> };
    expect(data.items.some((i) => i.id === item)).toBe(true);
  });
});
