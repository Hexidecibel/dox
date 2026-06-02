/**
 * COA auto-ingest has been REMOVED. The former Doc-R1 confidence-threshold
 * auto-approve no longer fires: PUT /api/queue/:id/results never approves /
 * ingests a COA item, regardless of worker-posted `confidence` or the tenant's
 * `auto_approve_threshold`. Every COA item stays in review.
 *
 * This file now guards that removal:
 *   - confidence >= threshold → STILL stays pending (no doc created, no audit).
 *   - confidence < threshold / threshold null / confidence null → stays pending.
 *   - errored worker payload → stays pending.
 *   - clamped (out-of-range) confidence is still persisted, item stays pending.
 *
 * Confidence is still persisted on the queue item as review-assist; only the
 * automatic approval was removed.
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

async function ensureDocumentType(tenantId: string): Promise<string> {
  const existing = await db
    .prepare('SELECT id FROM document_types WHERE tenant_id = ? AND slug = ?')
    .bind(tenantId, 'coa-auto-approve')
    .first<{ id: string }>();
  if (existing) return existing.id;
  const id = generateTestId();
  await db
    .prepare(
      `INSERT INTO document_types (id, tenant_id, name, slug, active)
       VALUES (?, ?, 'COA-auto', 'coa-auto-approve', 1)`
    )
    .bind(id, tenantId)
    .run();
  return id;
}

async function seedPendingQueueItem(tenantId: string, userId: string): Promise<string> {
  const id = generateTestId();
  const r2Key = `queue/${id}/auto-approve.pdf`;
  const docTypeId = await ensureDocumentType(tenantId);

  // approveQueueItem reads + re-uploads the pending file, so we need a body.
  await env.FILES.put(r2Key, new TextEncoder().encode('%PDF-1.4 fake'), {
    httpMetadata: { contentType: 'application/pdf' },
  });

  await db
    .prepare(
      `INSERT INTO processing_queue
       (id, tenant_id, document_type_id, file_r2_key, file_name, file_size, mime_type,
        processing_status, status, created_by)
       VALUES (?, ?, ?, ?, 'auto-approve.pdf', 12, 'application/pdf',
               'processing', 'pending', ?)`
    )
    .bind(id, tenantId, docTypeId, r2Key, userId)
    .run();
  return id;
}

async function setTenantThreshold(tenantId: string, threshold: number | null): Promise<void> {
  await db
    .prepare('UPDATE tenants SET auto_approve_threshold = ? WHERE id = ?')
    .bind(threshold, tenantId)
    .run();
}

describe('PUT /api/queue/:id/results — COA auto-approve removed', () => {
  it('does NOT auto-approve even when confidence >= tenant threshold (stays pending, no doc, no audit)', async () => {
    const tenantId = seed.tenantId;
    await setTenantThreshold(tenantId, 0.7);
    const queueId = await seedPendingQueueItem(tenantId, seed.userId);
    const user = { id: seed.userId, role: 'user', tenant_id: tenantId };

    const response = await updateQueueResults(
      makePutContext(
        queueId,
        {
          processing_status: 'ready',
          extracted_text: 'COA body',
          ai_fields: JSON.stringify({ supplier_name: 'ACME', lot_number: 'L-1' }),
          ai_confidence: 'high',
          confidence_score: 0.9,
          confidence: 0.95,
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
    // Confidence is still persisted as review assist...
    expect(row!.confidence).toBeCloseTo(0.95, 5);
    // ...but the item stays in review — NOT approved, NOT ingested.
    expect(row!.status).toBe('pending');
    expect(row!.auto_ingested ?? 0).toBe(0);
    expect(row!.reviewed_by ?? null).toBeNull();

    // No document row was created.
    const doc = await db
      .prepare("SELECT id, supplier_id FROM documents WHERE external_ref = ?")
      .bind(`queue-${queueId}`)
      .first<{ id: string; supplier_id: string | null }>();
    expect(doc).toBeNull();

    // No threshold auto-approve audit entry was written.
    const audit = await db
      .prepare(
        `SELECT action FROM audit_log
         WHERE resource_type = 'processing_queue' AND resource_id = ?
           AND action = 'queue_item.auto_approve_threshold'`
      )
      .bind(queueId)
      .first<{ action: string }>();
    expect(audit).toBeNull();
  });

  it('stays pending when confidence < tenant threshold', async () => {
    const tenantId = seed.tenantId;
    await setTenantThreshold(tenantId, 0.7);
    const queueId = await seedPendingQueueItem(tenantId, seed.userId);
    const user = { id: seed.userId, role: 'user', tenant_id: tenantId };

    const response = await updateQueueResults(
      makePutContext(
        queueId,
        {
          processing_status: 'ready',
          extracted_text: 'COA body',
          ai_fields: JSON.stringify({ supplier_name: 'ACME' }),
          ai_confidence: 'low',
          confidence_score: 0.4,
          confidence: 0.5,
        },
        user
      )
    );
    expect(response.status).toBe(200);

    const row = await db
      .prepare('SELECT status, auto_ingested, confidence FROM processing_queue WHERE id = ?')
      .bind(queueId)
      .first<{ status: string; auto_ingested: number | null; confidence: number | null }>();
    expect(row!.status).toBe('pending');
    expect(row!.auto_ingested ?? 0).toBe(0);
    expect(row!.confidence).toBeCloseTo(0.5, 5);
  });

  it('stays pending when tenant threshold is null (auto-approve disabled)', async () => {
    const tenantId = seed.tenantId;
    await setTenantThreshold(tenantId, null);
    const queueId = await seedPendingQueueItem(tenantId, seed.userId);
    const user = { id: seed.userId, role: 'user', tenant_id: tenantId };

    const response = await updateQueueResults(
      makePutContext(
        queueId,
        {
          processing_status: 'ready',
          extracted_text: 'COA body',
          ai_fields: JSON.stringify({ supplier_name: 'ACME' }),
          ai_confidence: 'high',
          confidence_score: 0.95,
          confidence: 0.95,
        },
        user
      )
    );
    expect(response.status).toBe(200);

    const row = await db
      .prepare('SELECT status, auto_ingested, confidence FROM processing_queue WHERE id = ?')
      .bind(queueId)
      .first<{ status: string; auto_ingested: number | null; confidence: number | null }>();
    expect(row!.status).toBe('pending');
    expect(row!.auto_ingested ?? 0).toBe(0);
    // The numeric confidence is still persisted even though we didn't approve.
    expect(row!.confidence).toBeCloseTo(0.95, 5);
  });

  it('stays pending when confidence is null (no signal to compare)', async () => {
    const tenantId = seed.tenantId;
    await setTenantThreshold(tenantId, 0.7);
    const queueId = await seedPendingQueueItem(tenantId, seed.userId);
    const user = { id: seed.userId, role: 'user', tenant_id: tenantId };

    const response = await updateQueueResults(
      makePutContext(
        queueId,
        {
          processing_status: 'ready',
          extracted_text: 'COA body',
          ai_fields: JSON.stringify({ supplier_name: 'ACME' }),
          ai_confidence: 'high',
          confidence_score: 0.9,
          confidence: null,
        },
        user
      )
    );
    expect(response.status).toBe(200);

    const row = await db
      .prepare('SELECT status, auto_ingested, confidence FROM processing_queue WHERE id = ?')
      .bind(queueId)
      .first<{ status: string; auto_ingested: number | null; confidence: number | null }>();
    expect(row!.status).toBe('pending');
    expect(row!.auto_ingested ?? 0).toBe(0);
    expect(row!.confidence).toBeNull();
  });

  it('does NOT auto-approve when worker reports an error, even if confidence is high', async () => {
    const tenantId = seed.tenantId;
    await setTenantThreshold(tenantId, 0.7);
    const queueId = await seedPendingQueueItem(tenantId, seed.userId);
    const user = { id: seed.userId, role: 'user', tenant_id: tenantId };

    // Error path: processing_status='error' + an error_message — gate should
    // skip auto-approve regardless of the confidence value.
    const response = await updateQueueResults(
      makePutContext(
        queueId,
        {
          processing_status: 'error',
          error_message: 'Qwen call failed',
          confidence: 0.99,
        },
        user
      )
    );
    expect(response.status).toBe(200);

    const row = await db
      .prepare('SELECT status, auto_ingested, processing_status FROM processing_queue WHERE id = ?')
      .bind(queueId)
      .first<{ status: string; auto_ingested: number | null; processing_status: string }>();
    expect(row!.status).toBe('pending');
    expect(row!.auto_ingested ?? 0).toBe(0);
    expect(row!.processing_status).toBe('error');
  });

  it('clamps out-of-range confidence values to [0, 1] when persisting, but still does NOT auto-approve', async () => {
    const tenantId = seed.tenantId;
    await setTenantThreshold(tenantId, 0.7);
    const queueId = await seedPendingQueueItem(tenantId, seed.userId);
    const user = { id: seed.userId, role: 'user', tenant_id: tenantId };

    // 1.5 clamps to 1.0 when persisted; with auto-ingest removed the item
    // still stays pending regardless.
    const response = await updateQueueResults(
      makePutContext(
        queueId,
        {
          processing_status: 'ready',
          extracted_text: 'COA body',
          ai_fields: JSON.stringify({ supplier_name: 'ACME' }),
          confidence: 1.5,
        },
        user
      )
    );
    expect(response.status).toBe(200);

    const row = await db
      .prepare('SELECT status, confidence FROM processing_queue WHERE id = ?')
      .bind(queueId)
      .first<{ status: string; confidence: number | null }>();
    expect(row!.confidence).toBeCloseTo(1, 5);
    expect(row!.status).toBe('pending');
  });
});
