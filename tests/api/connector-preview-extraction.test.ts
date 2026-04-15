/**
 * API test for POST /api/connectors/preview-extraction.
 *
 * Calls the handler directly (no SELF.fetch) after seeding an R2 sample.
 * Verifies:
 *  - Rows come back with primary_metadata + extended_metadata populated per
 *    the field_mappings config
 *  - NO orders/customers/runs get written to D1 (pure preview)
 *  - Invalid sample_id path rejections
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { env } from 'cloudflare:test';
import { seedTestData, generateTestId } from '../helpers/db';
import { onRequestPost as previewExtraction } from '../../functions/api/connectors/preview-extraction';
import { defaultFieldMappings } from '../../shared/fieldMappings';
import { installQwenMock, uninstallQwenMock, MOCK_PDF_ORDERS_RESPONSE } from '../helpers/qwen-mock';
import { loadWeeklyMasterXlsx, loadCoaOrdersPdf } from '../helpers/fixtures-binary';

let seed: Awaited<ReturnType<typeof seedTestData>>;
const db = env.DB;

beforeAll(async () => {
  seed = await seedTestData(db);
}, 30_000);

function makeContext(body: unknown, user: { id: string; role: string; tenant_id: string | null }) {
  const request = new Request('http://localhost/api/connectors/preview-extraction', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return {
    request,
    env,
    data: { user },
    params: {},
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
    functionPath: '/api/connectors/preview-extraction',
  } as any;
}

async function seedCsvSample(tenantId: string, csv: string): Promise<string> {
  const sampleId = `tmp/connector-samples/${tenantId}/${generateTestId()}`;
  await env.FILES.put(sampleId, new TextEncoder().encode(csv), {
    httpMetadata: { contentType: 'text/csv' },
    customMetadata: {
      source_type: 'csv',
      tenant_id: tenantId,
      original_name: 'preview.csv',
      expires_at: String(Date.now() + 3600_000),
    },
  });
  return sampleId;
}

describe('POST /api/connectors/preview-extraction — CSV', () => {
  it('returns projected rows with primary + extended metadata', async () => {
    const csv = `Order #,Cust #,Customer Name,Ship Date,Route
SO-1001,K00123,Acme Corp,2026-04-15,R705
SO-1002,K00124,Beta Inc,2026-04-16,R505`;
    const sampleId = await seedCsvSample(seed.tenantId, csv);

    // Build a v2 field_mappings that maps 3 core fields + 2 extended ones.
    const mappings = defaultFieldMappings();
    mappings.core.order_number.source_labels = ['Order #'];
    mappings.core.customer_number.source_labels = ['Cust #'];
    mappings.core.customer_name.source_labels = ['Customer Name'];
    mappings.extended = [
      { key: 'ship_date', label: 'Ship Date', source_labels: ['Ship Date'] },
      { key: 'route', label: 'Route', source_labels: ['Route'] },
    ];

    // Snapshot order count before the preview to verify nothing was written.
    const ordersBefore = await db.prepare(
      'SELECT COUNT(*) as c FROM orders WHERE tenant_id = ?'
    ).bind(seed.tenantId).first<{ c: number }>();

    const user = { id: seed.orgAdminId, role: 'org_admin', tenant_id: seed.tenantId };
    const response = await previewExtraction(makeContext({
      sample_id: sampleId,
      field_mappings: mappings,
      connector_type: 'email',
      limit: 10,
    }, user));

    expect(response.status).toBe(200);
    const data = await response.json() as {
      rows: Array<{
        order_number: string;
        customer_number?: string;
        customer_name?: string;
        primary_metadata?: Record<string, unknown>;
        extended_metadata?: Record<string, unknown>;
      }>;
      errors: unknown[];
      duration_ms: number;
      total_rows_in_sample: number;
    };

    expect(data.rows).toHaveLength(2);
    expect(data.rows[0].order_number).toBe('SO-1001');
    expect(data.rows[0].customer_number).toBe('K00123');
    expect(data.rows[0].customer_name).toBe('Acme Corp');
    expect(data.rows[0].primary_metadata).toBeDefined();
    expect(data.rows[0].primary_metadata!.order_number).toBe('SO-1001');
    expect(data.rows[0].extended_metadata).toBeDefined();
    expect(data.rows[0].extended_metadata!.ship_date).toBe('2026-04-15');
    expect(data.rows[0].extended_metadata!.route).toBe('R705');

    expect(data.errors).toEqual([]);
    expect(typeof data.duration_ms).toBe('number');
    expect(data.total_rows_in_sample).toBe(2);

    // Critical: no D1 writes happened.
    const ordersAfter = await db.prepare(
      'SELECT COUNT(*) as c FROM orders WHERE tenant_id = ?'
    ).bind(seed.tenantId).first<{ c: number }>();
    expect(ordersAfter!.c).toBe(ordersBefore!.c);
  });

  it('respects the limit parameter (clamps to max 10)', async () => {
    const rows = Array.from({ length: 12 }, (_, i) => `SO-${i + 1},K001,Acme`).join('\n');
    const csv = `Order #,Cust #,Customer Name\n${rows}`;
    const sampleId = await seedCsvSample(seed.tenantId, csv);

    const mappings = defaultFieldMappings();
    mappings.core.order_number.source_labels = ['Order #'];
    mappings.core.customer_number.source_labels = ['Cust #'];
    mappings.core.customer_name.source_labels = ['Customer Name'];

    const user = { id: seed.orgAdminId, role: 'org_admin', tenant_id: seed.tenantId };
    const response = await previewExtraction(makeContext({
      sample_id: sampleId,
      field_mappings: mappings,
      limit: 50, // should be clamped to 10
    }, user));

    expect(response.status).toBe(200);
    const data = await response.json() as { rows: unknown[]; total_rows_in_sample: number };
    expect(data.rows).toHaveLength(10);
    expect(data.total_rows_in_sample).toBe(12);
  });

  it('rejects a sample_id that does not start with tmp/connector-samples/', async () => {
    const user = { id: seed.orgAdminId, role: 'org_admin', tenant_id: seed.tenantId };
    const response = await previewExtraction(makeContext({
      sample_id: 'documents/not-a-sample',
      field_mappings: defaultFieldMappings(),
    }, user));
    expect(response.status).toBe(400);
  });

  it('returns 404 for a missing sample', async () => {
    const user = { id: seed.orgAdminId, role: 'org_admin', tenant_id: seed.tenantId };
    const response = await previewExtraction(makeContext({
      sample_id: `tmp/connector-samples/${seed.tenantId}/does-not-exist`,
      field_mappings: defaultFieldMappings(),
    }, user));
    expect(response.status).toBe(404);
  });

  it('rejects invalid field_mappings (order_number disabled)', async () => {
    const csv = `Order #\nSO-1`;
    const sampleId = await seedCsvSample(seed.tenantId, csv);

    const mappings = defaultFieldMappings();
    mappings.core.order_number.enabled = false;

    const user = { id: seed.orgAdminId, role: 'org_admin', tenant_id: seed.tenantId };
    const response = await previewExtraction(makeContext({
      sample_id: sampleId,
      field_mappings: mappings,
    }, user));
    expect(response.status).toBe(400);
  });
});

async function seedBinarySample(
  tenantId: string,
  buffer: ArrayBuffer,
  sourceType: 'xlsx' | 'pdf',
  fileName: string,
  contentType: string,
): Promise<string> {
  const sampleId = `tmp/connector-samples/${tenantId}/${generateTestId()}`;
  await env.FILES.put(sampleId, buffer, {
    httpMetadata: { contentType },
    customMetadata: {
      source_type: sourceType,
      tenant_id: tenantId,
      original_name: fileName,
      expires_at: String(Date.now() + 3600_000),
    },
  });
  return sampleId;
}

describe('POST /api/connectors/preview-extraction — XLSX', () => {
  beforeEach(() => {
    installQwenMock();
  });
  afterEach(() => {
    uninstallQwenMock();
  });

  it('runs the XLSX path through the email connector and returns customers', async () => {
    const buffer = loadWeeklyMasterXlsx();
    const sampleId = await seedBinarySample(
      seed.tenantId,
      buffer,
      'xlsx',
      'weekly-master.xlsx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );

    const mappings = defaultFieldMappings();

    const user = { id: seed.orgAdminId, role: 'org_admin', tenant_id: seed.tenantId };
    const ctx = makeContext({
      sample_id: sampleId,
      field_mappings: mappings,
      connector_type: 'email',
      limit: 5,
    }, user);
    ctx.env = { ...env, QWEN_URL: 'https://qwen.test', QWEN_SECRET: 'test' };

    const response = await previewExtraction(ctx);
    expect(response.status).toBe(200);
    const data = await response.json() as {
      rows: unknown[];
      customers: Array<{ customer_number: string }>;
      total_customers_in_sample: number;
    };
    // XLSX registry mock returns zero orders, multiple customers per call.
    // After merge-dedupe we expect at least one customer.
    expect(data.total_customers_in_sample).toBeGreaterThan(0);
    expect(data.customers.length).toBeGreaterThan(0);
  });
});

describe('POST /api/connectors/preview-extraction — PDF', () => {
  beforeEach(() => {
    installQwenMock();
  });
  afterEach(() => {
    uninstallQwenMock();
  });

  it('runs the PDF path and returns extracted orders', async () => {
    const buffer = loadCoaOrdersPdf();
    const sampleId = await seedBinarySample(
      seed.tenantId,
      buffer,
      'pdf',
      'coa-orders.pdf',
      'application/pdf',
    );

    const mappings = defaultFieldMappings();

    const user = { id: seed.orgAdminId, role: 'org_admin', tenant_id: seed.tenantId };
    const ctx = makeContext({
      sample_id: sampleId,
      field_mappings: mappings,
      limit: 10,
    }, user);
    ctx.env = { ...env, QWEN_URL: 'https://qwen.test', QWEN_SECRET: 'test' };

    const response = await previewExtraction(ctx);
    expect(response.status).toBe(200);
    const data = await response.json() as {
      rows: Array<{ order_number: string }>;
      total_rows_in_sample: number;
    };
    expect(data.total_rows_in_sample).toBe(MOCK_PDF_ORDERS_RESPONSE.orders.length);
    expect(data.rows.length).toBe(Math.min(10, data.total_rows_in_sample));
    expect(data.rows[0].order_number).toBe('1784767');
  });
});
