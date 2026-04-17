/**
 * Tests the PUT /api/queue/:id/results endpoint accepts the new VLM
 * dual-run columns added by migration 0034_vlm_extraction_fields.sql.
 *
 * Specifically asserts:
 *   1. A payload WITHOUT any vlm_* fields still works (backward compat).
 *   2. A payload WITH vlm_* fields persists them to the right columns.
 *   3. Partial vlm_* payloads (e.g. error-only) work.
 *   4. The primary extraction columns are untouched when the worker also
 *      sends vlm_* alongside.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { seedTestData, generateTestId } from '../helpers/db';
import { onRequestPut as updateQueueResults } from '../../functions/api/queue/[id]/results';

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
  const request = new Request(`http://localhost/api/queue/${id}/results`, {
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
    functionPath: `/api/queue/${id}/results`,
  } as unknown as Parameters<typeof updateQueueResults>[0];
}

async function insertQueueItem(tenantId: string, userId: string): Promise<string> {
  const id = generateTestId();
  await db
    .prepare(
      `INSERT INTO processing_queue
       (id, tenant_id, document_type_id, file_r2_key, file_name, file_size, mime_type, processing_status, status, created_by)
       VALUES (?, ?, NULL, ?, ?, 1024, 'application/pdf', 'processing', 'pending', ?)`
    )
    .bind(id, tenantId, `queue/${id}/test.pdf`, 'test.pdf', userId)
    .run();
  return id;
}

describe('PUT /api/queue/:id/results — VLM dual-run columns', () => {
  it('accepts a payload without any vlm_* fields (backward compat)', async () => {
    const queueId = await insertQueueItem(seed.tenantId, seed.userId);
    const user = { id: seed.userId, role: 'user', tenant_id: seed.tenantId };

    const response = await updateQueueResults(
      makePutContext(
        queueId,
        {
          processing_status: 'ready',
          extracted_text: 'Hello world',
          ai_fields: JSON.stringify({ supplier_name: 'ACME' }),
          ai_confidence: 'high',
          confidence_score: 0.9,
        },
        user
      )
    );

    expect(response.status).toBe(200);

    const row = await db
      .prepare('SELECT * FROM processing_queue WHERE id = ?')
      .bind(queueId)
      .first<Record<string, unknown>>();

    expect(row).not.toBeNull();
    expect(row!.processing_status).toBe('ready');
    expect(row!.extracted_text).toBe('Hello world');
    // All VLM columns remain null — the flag was off.
    expect(row!.vlm_extracted_fields).toBeNull();
    expect(row!.vlm_extracted_tables).toBeNull();
    expect(row!.vlm_confidence).toBeNull();
    expect(row!.vlm_error).toBeNull();
    expect(row!.vlm_model).toBeNull();
    expect(row!.vlm_duration_ms).toBeNull();
    expect(row!.vlm_extracted_at).toBeNull();
  });

  it('persists a successful VLM dual-run result alongside the text path', async () => {
    const queueId = await insertQueueItem(seed.tenantId, seed.userId);
    const user = { id: seed.userId, role: 'user', tenant_id: seed.tenantId };

    const vlmFields = { supplier_name: 'ACME Dairy', lot_number: 'L26-0001' };
    const vlmTables = [{ name: 'test_results', headers: ['test', 'result'], rows: [['Fat', '81.2']] }];
    const extractedAt = '2026-04-13T10:00:00.000Z';

    const response = await updateQueueResults(
      makePutContext(
        queueId,
        {
          processing_status: 'ready',
          extracted_text: 'text path output',
          ai_fields: JSON.stringify({ supplier_name: 'ACME' }),
          ai_confidence: 'medium',
          confidence_score: 0.65,
          // VLM dual-run extras
          vlm_extracted_fields: JSON.stringify(vlmFields),
          vlm_extracted_tables: JSON.stringify(vlmTables),
          vlm_confidence: 0.9,
          vlm_model: 'qwen2.5-vl-7b',
          vlm_duration_ms: 12_500,
          vlm_extracted_at: extractedAt,
        },
        user
      )
    );

    expect(response.status).toBe(200);

    const row = await db
      .prepare('SELECT * FROM processing_queue WHERE id = ?')
      .bind(queueId)
      .first<Record<string, unknown>>();

    // Primary path values unchanged
    expect(row!.ai_fields).toBe(JSON.stringify({ supplier_name: 'ACME' }));
    expect(row!.confidence_score).toBe(0.65);

    // VLM path persisted to its own columns
    expect(row!.vlm_extracted_fields).toBe(JSON.stringify(vlmFields));
    expect(row!.vlm_extracted_tables).toBe(JSON.stringify(vlmTables));
    expect(row!.vlm_confidence).toBe(0.9);
    expect(row!.vlm_model).toBe('qwen2.5-vl-7b');
    expect(row!.vlm_duration_ms).toBe(12_500);
    expect(row!.vlm_extracted_at).toBe(extractedAt);
    expect(row!.vlm_error).toBeNull();
  });

  it('persists a VLM failure (error only, no fields)', async () => {
    const queueId = await insertQueueItem(seed.tenantId, seed.userId);
    const user = { id: seed.userId, role: 'user', tenant_id: seed.tenantId };

    const response = await updateQueueResults(
      makePutContext(
        queueId,
        {
          processing_status: 'ready',
          extracted_text: 'text path output',
          ai_fields: JSON.stringify({ supplier_name: 'ACME' }),
          ai_confidence: 'high',
          confidence_score: 0.85,
          // VLM failure: error + timing + model, no fields/tables
          vlm_extracted_fields: null,
          vlm_extracted_tables: null,
          vlm_confidence: null,
          vlm_error: 'VLM skipped: PDF has 12 pages, exceeds cap of 5',
          vlm_model: 'qwen2.5-vl-7b',
          vlm_duration_ms: 42,
          vlm_extracted_at: '2026-04-13T10:05:00.000Z',
        },
        user
      )
    );

    expect(response.status).toBe(200);

    const row = await db
      .prepare('SELECT * FROM processing_queue WHERE id = ?')
      .bind(queueId)
      .first<Record<string, unknown>>();

    // Text path values are the source of truth for this item
    expect(row!.ai_fields).toBe(JSON.stringify({ supplier_name: 'ACME' }));
    expect(row!.confidence_score).toBe(0.85);

    // VLM error recorded, no silent success
    expect(row!.vlm_error).toMatch(/exceeds cap of 5/);
    expect(row!.vlm_extracted_fields).toBeNull();
    expect(row!.vlm_extracted_tables).toBeNull();
    expect(row!.vlm_model).toBe('qwen2.5-vl-7b');
    expect(row!.vlm_duration_ms).toBe(42);
  });

  it('leaves existing vlm_* columns untouched when a later PUT omits them', async () => {
    // First PUT sets the VLM columns...
    const queueId = await insertQueueItem(seed.tenantId, seed.userId);
    const user = { id: seed.userId, role: 'user', tenant_id: seed.tenantId };

    await updateQueueResults(
      makePutContext(
        queueId,
        {
          processing_status: 'ready',
          extracted_text: 'first',
          vlm_extracted_fields: JSON.stringify({ lot_number: 'L-FIRST' }),
          vlm_model: 'qwen2.5-vl-7b',
          vlm_duration_ms: 1000,
        },
        user
      )
    );

    // ...then a second PUT updates only the primary extraction
    // (simulates a retry of the text path without a fresh VLM call).
    await updateQueueResults(
      makePutContext(
        queueId,
        {
          processing_status: 'ready',
          extracted_text: 'second',
          ai_fields: JSON.stringify({ supplier_name: 'ACME' }),
        },
        user
      )
    );

    const row = await db
      .prepare('SELECT * FROM processing_queue WHERE id = ?')
      .bind(queueId)
      .first<Record<string, unknown>>();

    expect(row!.extracted_text).toBe('second');
    expect(row!.ai_fields).toBe(JSON.stringify({ supplier_name: 'ACME' }));
    // VLM columns untouched by the second PUT
    expect(row!.vlm_extracted_fields).toBe(JSON.stringify({ lot_number: 'L-FIRST' }));
    expect(row!.vlm_model).toBe('qwen2.5-vl-7b');
    expect(row!.vlm_duration_ms).toBe(1000);
  });
});
