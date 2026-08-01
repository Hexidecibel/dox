/**
 * PUT /api/queue/:id — rejection reason + R2 retention + approve-with-warnings.
 *
 * Before migration 0083, rejecting an item wrote `{"file_name": "..."}` to the
 * audit log and DELETED the R2 object. The 2026-08-01 study could not grade 9
 * of 132 rejected items for exactly that reason — the source PDF was gone, so
 * "we extracted it wrongly" and "the OCR was garbage" are permanently
 * indistinguishable for those. These tests pin both halves of the fix.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { runMigrations, seedTestData, cleanTables, generateTestId } from '../helpers/db';
import { onRequestPut as updateQueueItem } from '../../functions/api/queue/[id]';
import { onRequestGet as listQueue } from '../../functions/api/queue/index';

const db = env.DB;
const files = env.FILES;
let seed: Awaited<ReturnType<typeof seedTestData>>;

beforeEach(async () => {
  await runMigrations(db);
  await cleanTables(db);
  seed = await seedTestData(db);
}, 30_000);

/** The Andersen COA header that produced two APPROVED bad extractions. */
const ANDERSEN_TEXT = `ANDERSEN DAIRY, INC.
Phone: 360-687-7171
BUFFER LOT#: 151262C   EXP: 2027-09-01
Item #: 40122
Lot: 061926LC3`;

async function makeQueueItem(
  fields: Record<string, unknown> | null,
  text: string | null = ANDERSEN_TEXT
): Promise<{ id: string; r2Key: string }> {
  const id = generateTestId();
  const r2Key = `pending/${id}.pdf`;
  await files.put(r2Key, new TextEncoder().encode('%PDF-1.4 fake coa'), {
    httpMetadata: { contentType: 'application/pdf' },
  });
  await db
    .prepare(
      `INSERT INTO processing_queue
         (id, tenant_id, document_type_id, file_r2_key, file_name, file_size, mime_type,
          extracted_text, ai_fields, processing_status, output_kind, status, created_by, created_at)
       VALUES (?, ?, NULL, ?, ?, ?, 'application/pdf', ?, ?, 'ready', 'coa', 'pending', ?, datetime('now'))`
    )
    .bind(
      id,
      seed.tenantId,
      r2Key,
      `${id}.pdf`,
      17,
      text,
      fields ? JSON.stringify(fields) : null,
      seed.userId
    )
    .run();
  return { id, r2Key };
}

function putContext(queueId: string, body: unknown): any {
  return {
    request: new Request(`http://localhost/api/queue/${queueId}`, {
      method: 'PUT',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    }),
    env,
    data: { user: { id: seed.orgAdminId, role: 'org_admin', tenant_id: seed.tenantId } },
    params: { id: queueId },
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
    functionPath: '/api/queue/[id]',
  };
}

function listContext(qs: string): any {
  return {
    request: new Request(`http://localhost/api/queue?${qs}`),
    env,
    data: { user: { id: seed.orgAdminId, role: 'org_admin', tenant_id: seed.tenantId } },
    params: {},
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
    functionPath: '/api/queue',
  };
}

async function auditRows(action: string) {
  const res = await db
    .prepare('SELECT action, details FROM audit_log WHERE action = ? ORDER BY id DESC')
    .bind(action)
    .all<{ action: string; details: string }>();
  return res.results ?? [];
}

describe('reject persists a reason', () => {
  it('stores the enum + note on the row and in the audit log', async () => {
    const { id } = await makeQueueItem({ lot_number: '061926LC3' });

    const res = await updateQueueItem(
      putContext(id, {
        status: 'rejected',
        rejection_reason: 'extraction_defect',
        rejection_note: 'reagent lot in plant_number',
      })
    );
    expect(res.status).toBe(200);

    const row = await db
      .prepare('SELECT status, rejection_reason, rejection_note FROM processing_queue WHERE id = ?')
      .bind(id)
      .first<{ status: string; rejection_reason: string; rejection_note: string }>();
    expect(row?.status).toBe('rejected');
    expect(row?.rejection_reason).toBe('extraction_defect');
    expect(row?.rejection_note).toBe('reagent lot in plant_number');

    const audit = await auditRows('queue_item.rejected');
    expect(audit).toHaveLength(1);
    expect(JSON.parse(audit[0].details).rejection_reason).toBe('extraction_defect');
  });

  it('coerces an unknown reason to "other" instead of losing the rejection', async () => {
    const { id } = await makeQueueItem(null);
    const res = await updateQueueItem(
      putContext(id, { status: 'rejected', rejection_reason: 'banana' })
    );
    expect(res.status).toBe(200);
    const row = await db
      .prepare('SELECT rejection_reason, rejection_note FROM processing_queue WHERE id = ?')
      .bind(id)
      .first<{ rejection_reason: string; rejection_note: string }>();
    expect(row?.rejection_reason).toBe('other');
    expect(row?.rejection_note).toContain('banana');
  });

  it('still accepts a reasonless reject from an older client (reason stays NULL)', async () => {
    const { id } = await makeQueueItem(null);
    const res = await updateQueueItem(putContext(id, { status: 'rejected' }));
    expect(res.status).toBe(200);
    const row = await db
      .prepare('SELECT status, rejection_reason FROM processing_queue WHERE id = ?')
      .bind(id)
      .first<{ status: string; rejection_reason: string | null }>();
    expect(row?.status).toBe('rejected');
    // NULL means "no reason recorded" — never conflate with 'other'.
    expect(row?.rejection_reason).toBeNull();
  });
});

describe('reject no longer destroys the evidence', () => {
  it('keeps the R2 object and stamps a retention date', async () => {
    const { id, r2Key } = await makeQueueItem(null);
    await updateQueueItem(putContext(id, { status: 'rejected', rejection_reason: 'duplicate' }));

    const obj = await files.get(r2Key);
    expect(obj).not.toBeNull();

    const row = await db
      .prepare('SELECT file_retain_until FROM processing_queue WHERE id = ?')
      .bind(id)
      .first<{ file_retain_until: string | null }>();
    expect(row?.file_retain_until).toBeTruthy();
    expect(new Date(`${row!.file_retain_until!.replace(' ', 'T')}Z`).getTime()).toBeGreaterThan(
      Date.now()
    );
  });

  it('still forces a terminal processing_status so no worker spins on it', async () => {
    const { id } = await makeQueueItem(null);
    await db
      .prepare("UPDATE processing_queue SET processing_status = 'queued' WHERE id = ?")
      .bind(id)
      .run();
    await updateQueueItem(putContext(id, { status: 'rejected', rejection_reason: 'unreadable' }));
    const row = await db
      .prepare('SELECT processing_status FROM processing_queue WHERE id = ?')
      .bind(id)
      .first<{ processing_status: string }>();
    expect(row?.processing_status).toBe('error');
  });
});

describe('invariant warnings reach the reviewer', () => {
  it('the queue list returns per-field warnings for a known-bad extraction', async () => {
    await makeQueueItem({
      plant_number: '151262C', // the BUFFER reagent lot
      product_code: '360-687-7171', // the supplier's phone number
    });

    const res = await listQueue(listContext('status=pending'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{ invariant_warnings: Array<{ check: string; field: string; message: string }> }>;
    };
    const warnings = body.items[0].invariant_warnings;

    const plant = warnings.find((w) => w.field === 'plant_number');
    expect(plant?.check).toBe('field_label_mismatch');
    expect(plant?.message).toContain('BUFFER LOT#');

    const code = warnings.find((w) => w.field === 'product_code');
    expect(code?.check).toBe('product_code_not_phone');
    expect(code?.message).toMatch(/phone|fax/i);
  });

  it('returns no warnings for a clean extraction', async () => {
    await makeQueueItem({ lot_number: '061926LC3', product_code: '40122' });
    const res = await listQueue(listContext('status=pending'));
    const body = (await res.json()) as { items: Array<{ invariant_warnings: unknown[] }> };
    expect(body.items[0].invariant_warnings).toEqual([]);
  });
});

describe('approving over a warning is allowed but recorded', () => {
  it('logs queue_item.approved_with_warnings when the reviewer waves one through', async () => {
    const { id } = await makeQueueItem({ plant_number: '151262C' });

    const res = await updateQueueItem(
      putContext(id, {
        status: 'approved',
        // The reviewer approves the bad value unchanged.
        fields: { plant_number: '151262C', product_name: 'CREAM HG' },
        supplier_name: 'Andersen Dairy, Inc.',
        product_name: 'CREAM HG',
      })
    );
    // Never blocked.
    expect(res.status).toBe(200);

    const audit = await auditRows('queue_item.approved_with_warnings');
    expect(audit).toHaveLength(1);
    const details = JSON.parse(audit[0].details);
    expect(details.warning_count).toBeGreaterThan(0);
    expect(details.warnings[0].field).toBe('plant_number');
  });

  it('logs nothing when the reviewer FIXED the value before approving', async () => {
    const { id } = await makeQueueItem({ plant_number: '151262C' });

    const res = await updateQueueItem(
      putContext(id, {
        status: 'approved',
        fields: { plant_number: '53-98', product_name: 'CREAM HG' },
        supplier_name: 'Andersen Dairy, Inc.',
        product_name: 'CREAM HG',
      })
    );
    expect(res.status).toBe(200);
    expect(await auditRows('queue_item.approved_with_warnings')).toHaveLength(0);
  });
});
