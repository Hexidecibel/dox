/**
 * API test for PUT /api/queue/:id — specifically the new `selected_source`
 * field used by the dual-run compare UI in ReviewQueue.
 *
 * Verifies:
 *   1. Approve with selected_source='vlm' succeeds and creates the document.
 *   2. The audit log row records selected_source in its details JSON so we
 *      can later measure reviewer preference across text vs VLM.
 *   3. The default (no selected_source) behaves like 'text' — existing
 *      approves keep working unchanged.
 *   4. Invalid sources are normalized to 'text' (defensive — unknown values
 *      should not crash).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { seedTestData, generateTestId } from '../helpers/db';
import { onRequestPut as updateQueueItem } from '../../functions/api/queue/[id]';

let seed: Awaited<ReturnType<typeof seedTestData>>;
const db = env.DB;

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

/**
 * Seed a pending queue item with both text + VLM extractions populated,
 * plus a pending R2 file so approveQueueItem can read it back.
 */
/**
 * Seed (or reuse) a document_type for the tenant — needed because the
 * approveQueueItem flow writes an extraction_examples row when user fields
 * differ from the AI output, and that table has a NOT NULL on
 * document_type_id.
 */
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

async function seedDualQueueItem(tenantId: string, userId: string): Promise<string> {
  const id = generateTestId();
  const r2Key = `queue/${id}/test.pdf`;
  const docTypeId = await ensureDocumentType(tenantId);

  // Put a minimal PDF blob in R2 — approveQueueItem will read + re-upload it.
  await env.FILES.put(r2Key, new TextEncoder().encode('%PDF-1.4 fake'), {
    httpMetadata: { contentType: 'application/pdf' },
  });

  await db
    .prepare(
      `INSERT INTO processing_queue
       (id, tenant_id, document_type_id, file_r2_key, file_name, file_size, mime_type,
        processing_status, status, created_by,
        extracted_text, ai_fields, ai_confidence, confidence_score,
        tables,
        vlm_extracted_fields, vlm_extracted_tables, vlm_confidence,
        vlm_model, vlm_duration_ms, vlm_extracted_at)
       VALUES (?, ?, ?, ?, ?, 12, 'application/pdf',
               'ready', 'pending', ?,
               ?, ?, ?, ?, ?,
               ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      id,
      tenantId,
      docTypeId,
      r2Key,
      'test.pdf',
      userId,
      'text path output',
      JSON.stringify({ supplier_name: 'ACME', lot_number: 'L-TEXT' }),
      'medium',
      0.7,
      JSON.stringify([{ name: 'results', headers: ['h'], rows: [['v']] }]),
      JSON.stringify({ supplier_name: 'ACME CORPORATION', lot_number: 'L-VLM' }),
      JSON.stringify([{ name: 'results', headers: ['h'], rows: [['v']] }]),
      0.92,
      'qwen2.5-vl-7b',
      12_500,
      '2026-04-13T10:00:00.000Z'
    )
    .run();

  return id;
}

describe('PUT /api/queue/:id — selected_source for VLM dual-run compare', () => {
  it('accepts selected_source="vlm" and records it in the audit log', async () => {
    const queueId = await seedDualQueueItem(seed.tenantId, seed.orgAdminId);
    const user = { id: seed.orgAdminId, role: 'org_admin', tenant_id: seed.tenantId };

    const response = await updateQueueItem(
      makePutContext(
        queueId,
        {
          status: 'approved',
          // Frontend sends the VLM field values (copied via useVlmSource)
          fields: { supplier_name: 'ACME CORPORATION', lot_number: 'L-VLM' },
          selected_source: 'vlm',
        },
        user
      )
    );

    expect(response.status).toBe(200);
    const json = await response.json<{ item: { status: string }; document: { id: string; title: string } }>();
    expect(json.item.status).toBe('approved');
    expect(json.document.id).toBeDefined();

    // Queue item status flipped
    const row = await db
      .prepare('SELECT status, reviewed_by FROM processing_queue WHERE id = ?')
      .bind(queueId)
      .first<{ status: string; reviewed_by: string }>();
    expect(row!.status).toBe('approved');
    expect(row!.reviewed_by).toBe(seed.orgAdminId);

    // Audit log records selected_source='vlm'
    const audit = await db
      .prepare(
        `SELECT details FROM audit_log
         WHERE resource_type = 'processing_queue' AND resource_id = ?
           AND action = 'queue_item.approved'
         ORDER BY created_at DESC LIMIT 1`
      )
      .bind(queueId)
      .first<{ details: string }>();
    expect(audit).not.toBeNull();
    const parsed = JSON.parse(audit!.details) as { selected_source?: string };
    expect(parsed.selected_source).toBe('vlm');

    // The primary_metadata on the created doc reflects the VLM-sourced values
    const doc = await db
      .prepare(
        'SELECT primary_metadata FROM documents WHERE id = ?'
      )
      .bind(json.document.id)
      .first<{ primary_metadata: string }>();
    const metadata = JSON.parse(doc!.primary_metadata) as Record<string, string>;
    expect(metadata.supplier_name).toBe('ACME CORPORATION');
    expect(metadata.lot_number).toBe('L-VLM');
  });

  it('defaults to selected_source="text" when the field is omitted (backwards compat)', async () => {
    const queueId = await seedDualQueueItem(seed.tenantId, seed.orgAdminId);
    const user = { id: seed.orgAdminId, role: 'org_admin', tenant_id: seed.tenantId };

    const response = await updateQueueItem(
      makePutContext(
        queueId,
        {
          status: 'approved',
          fields: { supplier_name: 'ACME', lot_number: 'L-TEXT' },
          // selected_source intentionally absent
        },
        user
      )
    );
    expect(response.status).toBe(200);

    const audit = await db
      .prepare(
        `SELECT details FROM audit_log
         WHERE resource_type = 'processing_queue' AND resource_id = ?
           AND action = 'queue_item.approved'
         ORDER BY created_at DESC LIMIT 1`
      )
      .bind(queueId)
      .first<{ details: string }>();
    const parsed = JSON.parse(audit!.details) as { selected_source?: string };
    expect(parsed.selected_source).toBe('text');
  });

  it('coerces invalid selected_source values back to "text"', async () => {
    const queueId = await seedDualQueueItem(seed.tenantId, seed.orgAdminId);
    const user = { id: seed.orgAdminId, role: 'org_admin', tenant_id: seed.tenantId };

    const response = await updateQueueItem(
      makePutContext(
        queueId,
        {
          status: 'approved',
          fields: { supplier_name: 'ACME' },
          selected_source: 'definitely-not-valid',
        },
        user
      )
    );
    expect(response.status).toBe(200);

    const audit = await db
      .prepare(
        `SELECT details FROM audit_log
         WHERE resource_type = 'processing_queue' AND resource_id = ?
           AND action = 'queue_item.approved'
         ORDER BY created_at DESC LIMIT 1`
      )
      .bind(queueId)
      .first<{ details: string }>();
    const parsed = JSON.parse(audit!.details) as { selected_source?: string };
    expect(parsed.selected_source).toBe('text');
  });

  it('records selected_source on multi-product approve too', async () => {
    const queueId = await seedDualQueueItem(seed.tenantId, seed.orgAdminId);
    const user = { id: seed.orgAdminId, role: 'org_admin', tenant_id: seed.tenantId };

    const response = await updateQueueItem(
      makePutContext(
        queueId,
        {
          status: 'approved',
          shared_fields: { supplier_name: 'ACME CORPORATION' },
          products: [
            { product_name: 'Product A', fields: { lot_number: 'L-A-VLM' } },
            { product_name: 'Product B', fields: { lot_number: 'L-B-VLM' } },
          ],
          selected_source: 'vlm',
        },
        user
      )
    );
    expect(response.status).toBe(200);

    const audit = await db
      .prepare(
        `SELECT details FROM audit_log
         WHERE resource_type = 'processing_queue' AND resource_id = ?
           AND action = 'queue_item.approved'
         ORDER BY created_at DESC LIMIT 1`
      )
      .bind(queueId)
      .first<{ details: string }>();
    const parsed = JSON.parse(audit!.details) as { selected_source?: string; product_count?: number };
    expect(parsed.selected_source).toBe('vlm');
    expect(parsed.product_count).toBe(2);
  });
});
