/**
 * Unit tests for the shared intake helper enqueueDocument
 * (functions/lib/intake/enqueue.ts).
 *
 * Connectors → Sources: every intake door (manual upload, drop, email,
 * poll, retry) funnels through this single helper so the processing_queue
 * row shape is identical regardless of how the file arrived. These tests
 * pin the column wiring — especially the connector-only columns
 * (source_id, supplier_id, connector_run_id, output_kind) that the worker
 * + Review Queue route on.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { seedTestData } from '../helpers/db';
import { enqueueDocument } from '../../functions/lib/intake/enqueue';

const db = env.DB;
let seed: Awaited<ReturnType<typeof seedTestData>>;

beforeAll(async () => {
  seed = await seedTestData(db);
}, 30_000);

describe('enqueueDocument', () => {
  it('writes a processing_queue row carrying source/supplier/run/output_kind', async () => {
    const { queueId } = await enqueueDocument(db, {
      tenantId: seed.tenantId,
      documentTypeId: null,
      fileR2Key: 'connector-drops/src-1/2026-06-02-orders.csv',
      fileName: 'orders.csv',
      fileSize: 1234,
      mimeType: 'text/csv',
      checksum: 'abc123',
      createdBy: seed.orgAdminId,
      source: 'manual',
      sourceDetail: 'connector:Acme Feed',
      outputKind: 'order',
      sourceId: 'src-1',
      supplierId: 'sup-9',
      connectorRunId: 'run-7',
    });

    expect(queueId).toBeTruthy();

    const row = await db
      .prepare(
        `SELECT tenant_id, document_type_id, file_r2_key, file_name, file_size,
                mime_type, status, processing_status, checksum, created_by,
                source, source_detail, output_kind, source_id, supplier_id,
                connector_run_id
           FROM processing_queue WHERE id = ?`,
      )
      .bind(queueId)
      .first<Record<string, unknown>>();

    expect(row).toBeTruthy();
    expect(row!.tenant_id).toBe(seed.tenantId);
    expect(row!.document_type_id).toBeNull();
    expect(row!.file_r2_key).toBe('connector-drops/src-1/2026-06-02-orders.csv');
    expect(row!.file_name).toBe('orders.csv');
    expect(row!.file_size).toBe(1234);
    expect(row!.mime_type).toBe('text/csv');
    // Defaulted by the helper.
    expect(row!.status).toBe('pending');
    expect(row!.processing_status).toBe('queued');
    expect(row!.checksum).toBe('abc123');
    expect(row!.created_by).toBe(seed.orgAdminId);
    expect(row!.source).toBe('manual');
    expect(row!.source_detail).toBe('connector:Acme Feed');
    // Connector-only routing columns.
    expect(row!.output_kind).toBe('order');
    expect(row!.source_id).toBe('src-1');
    expect(row!.supplier_id).toBe('sup-9');
    expect(row!.connector_run_id).toBe('run-7');
  });

  it('honors a pre-generated id and nulls the optional connector columns', async () => {
    const preId = 'preid-enqueue-test-0001';
    const { queueId } = await enqueueDocument(db, {
      id: preId,
      tenantId: seed.tenantId,
      documentTypeId: null,
      fileR2Key: 'pending/x/preid/file.pdf',
      fileName: 'file.pdf',
      fileSize: 10,
      mimeType: 'application/pdf',
      checksum: 'deadbeef',
      // Vendor-driven door: created_by null must not blow the FK.
      createdBy: null,
      source: 'api',
      sourceDetail: null,
      outputKind: null,
      sourceId: null,
      // supplierId + connectorRunId omitted entirely.
    });

    expect(queueId).toBe(preId);

    const row = await db
      .prepare(
        `SELECT id, created_by, supplier_id, connector_run_id, source_id, output_kind
           FROM processing_queue WHERE id = ?`,
      )
      .bind(preId)
      .first<Record<string, unknown>>();

    expect(row).toBeTruthy();
    expect(row!.created_by).toBeNull();
    expect(row!.supplier_id).toBeNull();
    expect(row!.connector_run_id).toBeNull();
    expect(row!.source_id).toBeNull();
    expect(row!.output_kind).toBeNull();
  });
});
