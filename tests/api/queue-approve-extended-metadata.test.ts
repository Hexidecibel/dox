/**
 * API test for PUT /api/queue/:id — the SINGLE-RECORD (flat) COA approve path.
 *
 * Regression cover for a real, measured hole: produceCoa's document INSERT
 * omitted `extended_metadata` entirely, so a plain one-product COA persisted
 * NO extraction tables. The multi-product and records producers both write
 * them. Consequence on prod: `bin/recheck-spec-limits` reads
 * documents.extended_metadata and could examine only 81 of 561 documents for
 * a tenant — every single-record COA was invisible to the retro spec checker.
 *
 * Verifies:
 *   1. Approving a flat COA that HAS tables writes {"tables":[...]} into
 *      documents.extended_metadata, byte-shape-identical to the multi-product
 *      path.
 *   2. Approving a flat COA with NO tables leaves extended_metadata NULL —
 *      the other paths store NULL rather than an empty object, and this path
 *      must not start writing `{}` for table-less documents.
 *   3. The pure builder degrades to NULL on absent / empty / unparseable
 *      input rather than throwing inside an approve.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { seedTestData, generateTestId } from '../helpers/db';
import { onRequestPut as updateQueueItem } from '../../functions/api/queue/[id]';
import { buildFlatExtendedMetadata } from '../../functions/lib/kinds/coa';

let seed: Awaited<ReturnType<typeof seedTestData>>;
const db = env.DB;

const TABLES = [
  {
    name: 'Microbiological Results',
    headers: ['Test', 'Result', 'Spec', 'Units'],
    rows: [
      ['Coliform', '10', '<100', 'CFU/g'],
      ['Standard Plate Count', '2500', '<10000', 'CFU/g'],
    ],
  },
];

beforeAll(async () => {
  seed = await seedTestData(db);
}, 30_000);

function makePutContext(
  id: string,
  body: Record<string, unknown>,
  user: { id: string; role: string; tenant_id: string | null }
) {
  const request = new Request(`http://localhost/api/queue/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return {
    request,
    env,
    data: { user },
    params: { id },
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
    functionPath: `/api/queue/${id}`,
  } as unknown as Parameters<typeof updateQueueItem>[0];
}

async function ensureDocumentType(tenantId: string): Promise<string> {
  const existing = await db
    .prepare('SELECT id FROM document_types WHERE tenant_id = ? AND slug = ?')
    .bind(tenantId, 'coa')
    .first<{ id: string }>();
  if (existing) return existing.id;
  const id = generateTestId();
  await db
    .prepare(
      `INSERT INTO document_types (id, tenant_id, name, slug, active)
       VALUES (?, ?, 'COA', 'coa', 1)`
    )
    .bind(id, tenantId)
    .run();
  return id;
}

/** Seed a pending FLAT (non-records, single-product) COA queue item. */
async function seedFlatQueueItem(
  tenantId: string,
  userId: string,
  tables: unknown[] | null
): Promise<string> {
  const id = generateTestId();
  const r2Key = `queue/${id}/coa.pdf`;
  const docTypeId = await ensureDocumentType(tenantId);

  await env.FILES.put(r2Key, new TextEncoder().encode('%PDF-1.4 fake'), {
    httpMetadata: { contentType: 'application/pdf' },
  });

  await db
    .prepare(
      `INSERT INTO processing_queue
       (id, tenant_id, document_type_id, file_r2_key, file_name, file_size, mime_type,
        processing_status, status, created_by,
        extracted_text, ai_fields, ai_confidence, confidence_score, tables)
       VALUES (?, ?, ?, ?, ?, 12, 'application/pdf',
               'ready', 'pending', ?, ?, ?, 'high', 0.9, ?)`
    )
    .bind(
      id,
      tenantId,
      docTypeId,
      r2Key,
      'coa.pdf',
      userId,
      'raw coa text',
      JSON.stringify({ supplier_name: 'Andersen Dairy', lot_number: 'L-900', product_name: 'Cream' }),
      tables === null ? null : JSON.stringify(tables)
    )
    .run();

  return id;
}

async function extendedMetadataFor(queueItemId: string): Promise<string | null> {
  const row = await db
    .prepare('SELECT extended_metadata FROM documents WHERE external_ref = ?')
    .bind(`queue-${queueItemId}`)
    .first<{ extended_metadata: string | null }>();
  expect(row).toBeTruthy();
  return row!.extended_metadata;
}

describe('PUT /api/queue/:id — flat COA approve persists extraction tables', () => {
  it('writes { tables } into documents.extended_metadata for a single-record COA', async () => {
    const queueId = await seedFlatQueueItem(seed.tenantId, seed.orgAdminId, TABLES);
    const user = { id: seed.orgAdminId, role: 'org_admin', tenant_id: seed.tenantId };

    const response = await updateQueueItem(
      makePutContext(
        queueId,
        {
          status: 'approved',
          fields: { supplier_name: 'Andersen Dairy', lot_number: 'L-900' },
          product_name: 'Cream',
        },
        user
      )
    );
    expect(response.status).toBe(200);

    const stored = await extendedMetadataFor(queueId);
    expect(stored).toBeTruthy();
    // Same key name and same shape the multi-product producer writes.
    expect(JSON.parse(stored!)).toEqual({ tables: TABLES });
  });

  it('leaves extended_metadata NULL when the item carries no tables', async () => {
    const queueId = await seedFlatQueueItem(seed.tenantId, seed.orgAdminId, null);
    const user = { id: seed.orgAdminId, role: 'org_admin', tenant_id: seed.tenantId };

    const response = await updateQueueItem(
      makePutContext(
        queueId,
        {
          status: 'approved',
          fields: { supplier_name: 'Andersen Dairy', lot_number: 'L-901' },
        },
        user
      )
    );
    expect(response.status).toBe(200);

    expect(await extendedMetadataFor(queueId)).toBeNull();
  });

  it('leaves extended_metadata NULL for an empty table list', async () => {
    const queueId = await seedFlatQueueItem(seed.tenantId, seed.orgAdminId, []);
    const user = { id: seed.orgAdminId, role: 'org_admin', tenant_id: seed.tenantId };

    const response = await updateQueueItem(
      makePutContext(
        queueId,
        {
          status: 'approved',
          fields: { supplier_name: 'Andersen Dairy', lot_number: 'L-902' },
        },
        user
      )
    );
    expect(response.status).toBe(200);

    expect(await extendedMetadataFor(queueId)).toBeNull();
  });
});

/**
 * Migration 0081 defined `documents.classification_status` and
 * `functions/lib/requirement-gaps.ts` counts by it, but nothing wrote it — so
 * the unclassified bucket was COUNT(*) on every tenant, forever. Approval is
 * the main door; these pin that it writes, and that it names the approver.
 */
describe('PUT /api/queue/:id — approve records the classification (0081)', () => {
  async function classificationFor(queueItemId: string) {
    const row = await db
      .prepare(
        `SELECT classification_status AS status,
                classification_reviewed_at AS at,
                classification_reviewed_by AS by
           FROM documents WHERE external_ref = ?`,
      )
      .bind(`queue-${queueItemId}`)
      .first<{ status: string; at: string | null; by: string | null }>();
    expect(row).toBeTruthy();
    return row!;
  }

  it('classifies the document and names the approver when the item has a type', async () => {
    const queueId = await seedFlatQueueItem(seed.tenantId, seed.orgAdminId, null);
    const user = { id: seed.orgAdminId, role: 'org_admin', tenant_id: seed.tenantId };

    const response = await updateQueueItem(
      makePutContext(queueId, { status: 'approved', product_name: 'Cream' }, user),
    );
    expect(response.status).toBe(200);

    const row = await classificationFor(queueId);
    expect(row.status).toBe('classified');
    expect(row.by).toBe(seed.orgAdminId);
    expect(row.at).toBeTruthy();
  });

  it('leaves an approved-but-untyped document in the needs-review backlog', async () => {
    const queueId = await seedFlatQueueItem(seed.tenantId, seed.orgAdminId, null);
    // The classifier did not resolve to one of this tenant's types.
    await db
      .prepare('UPDATE processing_queue SET document_type_id = NULL WHERE id = ?')
      .bind(queueId)
      .run();
    const user = { id: seed.orgAdminId, role: 'org_admin', tenant_id: seed.tenantId };

    const response = await updateQueueItem(
      makePutContext(queueId, { status: 'approved', product_name: 'Cream' }, user),
    );
    expect(response.status).toBe(200);

    const row = await classificationFor(queueId);
    expect(row.status).toBe('needs_review');
    // No stamp: the reviewer ruled on the extraction, not the classification.
    expect(row.by).toBeNull();
    expect(row.at).toBeNull();
  });
});

describe('buildFlatExtendedMetadata', () => {
  it('wraps a table array under the `tables` key', () => {
    expect(buildFlatExtendedMetadata(JSON.stringify(TABLES))).toBe(
      JSON.stringify({ tables: TABLES })
    );
  });

  it('accepts an already-parsed array', () => {
    expect(buildFlatExtendedMetadata(TABLES)).toBe(JSON.stringify({ tables: TABLES }));
  });

  it('returns null for null, empty string, empty array and non-arrays', () => {
    expect(buildFlatExtendedMetadata(null)).toBeNull();
    expect(buildFlatExtendedMetadata(undefined)).toBeNull();
    expect(buildFlatExtendedMetadata('')).toBeNull();
    expect(buildFlatExtendedMetadata('   ')).toBeNull();
    expect(buildFlatExtendedMetadata('[]')).toBeNull();
    expect(buildFlatExtendedMetadata([])).toBeNull();
    expect(buildFlatExtendedMetadata('{"tables":[]}')).toBeNull();
  });

  it('degrades to null on unparseable JSON instead of throwing', () => {
    expect(buildFlatExtendedMetadata('{not json')).toBeNull();
  });
});
