/**
 * API tests for PUT /api/queue/:id — Phase 2 reviewer-decision capture.
 *
 * Verifies that field_picks, dismissals, and table_edits in the approve
 * payload land in reviewer_field_picks, reviewer_field_dismissals, and
 * reviewer_table_edits respectively. Capture failures must never block
 * the approve flow (covered by ensuring the rest of the response is OK
 * across all variants).
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
      JSON.stringify([{ name: 'results', headers: ['a', 'b'], rows: [['1', '2']] }]),
      JSON.stringify({ supplier_name: 'ACME CORPORATION', lot_number: 'L-VLM' }),
      JSON.stringify([{ name: 'results', headers: ['a', 'b'], rows: [['1', '2']] }]),
      0.92,
      'qwen2.5-vl-7b',
      12_500,
      '2026-04-13T10:00:00.000Z'
    )
    .run();

  return id;
}

describe('PUT /api/queue/:id — Phase 2 reviewer-decision capture', () => {
  it('persists field_picks rows with chosen_source values', async () => {
    const queueId = await seedDualQueueItem(seed.tenantId, seed.orgAdminId);
    const user = { id: seed.orgAdminId, role: 'org_admin', tenant_id: seed.tenantId };

    const response = await updateQueueItem(
      makePutContext(
        queueId,
        {
          status: 'approved',
          fields: { supplier_name: 'ACME CORPORATION', lot_number: 'L-EDITED' },
          selected_source: 'vlm',
          field_picks: [
            { field_key: 'supplier_name', text_value: 'ACME', vlm_value: 'ACME CORPORATION', chosen_source: 'vlm', final_value: 'ACME CORPORATION' },
            { field_key: 'lot_number', text_value: 'L-TEXT', vlm_value: 'L-VLM', chosen_source: 'edited', final_value: 'L-EDITED' },
          ],
        },
        user
      )
    );
    expect(response.status).toBe(200);

    const picks = await db
      .prepare('SELECT field_key, chosen_source, text_value, vlm_value, final_value FROM reviewer_field_picks WHERE queue_item_id = ? ORDER BY field_key')
      .bind(queueId)
      .all<{ field_key: string; chosen_source: string; text_value: string | null; vlm_value: string | null; final_value: string | null }>();

    expect(picks.results).toHaveLength(2);
    expect(picks.results[0].field_key).toBe('lot_number');
    expect(picks.results[0].chosen_source).toBe('edited');
    expect(picks.results[0].final_value).toBe('L-EDITED');
    expect(picks.results[1].field_key).toBe('supplier_name');
    expect(picks.results[1].chosen_source).toBe('vlm');
    expect(picks.results[1].final_value).toBe('ACME CORPORATION');
  });

  it('persists dismissals rows', async () => {
    const queueId = await seedDualQueueItem(seed.tenantId, seed.orgAdminId);
    const user = { id: seed.orgAdminId, role: 'org_admin', tenant_id: seed.tenantId };

    const response = await updateQueueItem(
      makePutContext(
        queueId,
        {
          status: 'approved',
          fields: { supplier_name: 'ACME' },
          dismissals: [
            { field_key: 'lot_number', action: 'dismissed' },
            { field_key: 'product_code', action: 'extended' },
          ],
        },
        user
      )
    );
    expect(response.status).toBe(200);

    const rows = await db
      .prepare('SELECT field_key, action FROM reviewer_field_dismissals WHERE queue_item_id = ? ORDER BY field_key')
      .bind(queueId)
      .all<{ field_key: string; action: string }>();

    expect(rows.results).toHaveLength(2);
    expect(rows.results[0]).toMatchObject({ field_key: 'lot_number', action: 'dismissed' });
    expect(rows.results[1]).toMatchObject({ field_key: 'product_code', action: 'extended' });
  });

  it('persists table_edits rows with JSON detail', async () => {
    const queueId = await seedDualQueueItem(seed.tenantId, seed.orgAdminId);
    const user = { id: seed.orgAdminId, role: 'org_admin', tenant_id: seed.tenantId };

    const response = await updateQueueItem(
      makePutContext(
        queueId,
        {
          status: 'approved',
          fields: { supplier_name: 'ACME' },
          table_edits: [
            { table_idx: 0, operation: 'column_excluded', detail: { column_idx: 1, header: 'b' } },
            { table_idx: 0, operation: 'header_renamed', detail: { column_idx: 0, from: 'a', to: 'lot' } },
          ],
        },
        user
      )
    );
    expect(response.status).toBe(200);

    const rows = await db
      .prepare('SELECT table_idx, operation, detail FROM reviewer_table_edits WHERE queue_item_id = ? ORDER BY operation')
      .bind(queueId)
      .all<{ table_idx: number; operation: string; detail: string }>();

    expect(rows.results).toHaveLength(2);
    expect(rows.results[0].operation).toBe('column_excluded');
    expect(JSON.parse(rows.results[0].detail)).toEqual({ column_idx: 1, header: 'b' });
    expect(rows.results[1].operation).toBe('header_renamed');
    expect(JSON.parse(rows.results[1].detail)).toEqual({ column_idx: 0, from: 'a', to: 'lot' });
  });

  it('handles all three capture arrays in the same approve', async () => {
    const queueId = await seedDualQueueItem(seed.tenantId, seed.orgAdminId);
    const user = { id: seed.orgAdminId, role: 'org_admin', tenant_id: seed.tenantId };

    const response = await updateQueueItem(
      makePutContext(
        queueId,
        {
          status: 'approved',
          fields: { supplier_name: 'ACME CORPORATION' },
          field_picks: [
            { field_key: 'supplier_name', text_value: 'ACME', vlm_value: 'ACME CORPORATION', chosen_source: 'vlm', final_value: 'ACME CORPORATION' },
          ],
          dismissals: [
            { field_key: 'lot_number', action: 'dismissed' },
          ],
          table_edits: [
            { table_idx: 0, operation: 'table_excluded', detail: {} },
          ],
        },
        user
      )
    );
    expect(response.status).toBe(200);

    const pickCount = await db.prepare('SELECT COUNT(*) as c FROM reviewer_field_picks WHERE queue_item_id = ?').bind(queueId).first<{ c: number }>();
    const dismissCount = await db.prepare('SELECT COUNT(*) as c FROM reviewer_field_dismissals WHERE queue_item_id = ?').bind(queueId).first<{ c: number }>();
    const editCount = await db.prepare('SELECT COUNT(*) as c FROM reviewer_table_edits WHERE queue_item_id = ?').bind(queueId).first<{ c: number }>();
    expect(pickCount!.c).toBe(1);
    expect(dismissCount!.c).toBe(1);
    expect(editCount!.c).toBe(1);
  });

  it('approves cleanly with no captures (back-compat)', async () => {
    const queueId = await seedDualQueueItem(seed.tenantId, seed.orgAdminId);
    const user = { id: seed.orgAdminId, role: 'org_admin', tenant_id: seed.tenantId };

    const response = await updateQueueItem(
      makePutContext(
        queueId,
        {
          status: 'approved',
          fields: { supplier_name: 'ACME' },
        },
        user
      )
    );
    expect(response.status).toBe(200);

    const pickCount = await db.prepare('SELECT COUNT(*) as c FROM reviewer_field_picks WHERE queue_item_id = ?').bind(queueId).first<{ c: number }>();
    expect(pickCount!.c).toBe(0);
  });

  it('captures on multi-product approve', async () => {
    const queueId = await seedDualQueueItem(seed.tenantId, seed.orgAdminId);
    const user = { id: seed.orgAdminId, role: 'org_admin', tenant_id: seed.tenantId };

    const response = await updateQueueItem(
      makePutContext(
        queueId,
        {
          status: 'approved',
          shared_fields: { supplier_name: 'ACME CORPORATION' },
          products: [
            { product_name: 'P1', fields: { lot_number: 'L1' } },
            { product_name: 'P2', fields: { lot_number: 'L2' } },
          ],
          table_edits: [
            { table_idx: 1, operation: 'column_excluded', detail: { column_idx: 0 } },
          ],
        },
        user
      )
    );
    expect(response.status).toBe(200);

    const rows = await db
      .prepare('SELECT table_idx, operation FROM reviewer_table_edits WHERE queue_item_id = ?')
      .bind(queueId)
      .all<{ table_idx: number; operation: string }>();
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0].table_idx).toBe(1);
  });
});
