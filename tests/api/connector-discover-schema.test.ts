/**
 * API test for POST /api/connectors/discover-schema.
 *
 * Drives the handler directly (no SELF.fetch) mirroring the pattern used in
 * connector-email-ingest.test.ts. Exercises the full happy path:
 *  - CSV buffer uploaded to R2 under tmp/connector-samples/<tenant>/<id>
 *  - detected_fields populated with type inference + candidate targets
 *  - suggested_mappings ready to seed the Review step
 *  - Non-CSV source_type returns 501 (not 500)
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { env } from 'cloudflare:test';
import { seedTestData } from '../helpers/db';
import { onRequestPost as discoverSchema } from '../../functions/api/connectors/discover-schema';
import { installQwenMock, uninstallQwenMock } from '../helpers/qwen-mock';
import { loadWeeklyMasterXlsx, loadCoaOrdersPdf } from '../helpers/fixtures-binary';

let seed: Awaited<ReturnType<typeof seedTestData>>;
const db = env.DB;

beforeAll(async () => {
  seed = await seedTestData(db);
}, 30_000);

function buildFormRequest(parts: Record<string, Blob | string>): Request {
  const form = new FormData();
  for (const [k, v] of Object.entries(parts)) {
    form.append(k, v as Blob | string);
  }
  return new Request('http://localhost/api/connectors/discover-schema', {
    method: 'POST',
    body: form,
  });
}

function makeContext(
  request: Request,
  user: { id: string; role: string; tenant_id: string | null },
) {
  return {
    request,
    env,
    data: { user },
    params: {},
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
    functionPath: '/api/connectors/discover-schema',
  } as any;
}

describe('POST /api/connectors/discover-schema — CSV happy path', () => {
  it('uploads the sample to R2 and returns detected_fields + suggested_mappings', async () => {
    const csv = `Order #,Cust #,Customer Name,PO Number,Ship Date,Route
SO-1001,K00123,Acme Corp,PO-500,2026-04-15,R705
SO-1002,K00124,Beta Inc,PO-600,2026-04-16,R505
SO-1003,K00123,Acme Corp,PO-700,2026-04-17,R705`;
    const file = new File([csv], 'sample-orders.csv', { type: 'text/csv' });
    const request = buildFormRequest({
      file,
      source_type: 'csv',
      tenant_id: seed.tenantId,
    });

    const user = { id: seed.orgAdminId, role: 'org_admin', tenant_id: seed.tenantId };
    const response = await discoverSchema(makeContext(request, user));

    expect(response.status).toBe(200);
    const data = await response.json() as {
      sample_id: string;
      detected_fields: Array<{ name: string; candidate_target?: string }>;
      sample_rows: Array<Record<string, string>>;
      suggested_mappings: {
        version: number;
        core: Record<string, { enabled: boolean; source_labels: string[] }>;
        extended: Array<{ key: string; source_labels: string[] }>;
      };
      warnings: string[];
    };

    expect(data.sample_id).toMatch(/^tmp\/connector-samples\//);
    expect(data.sample_id).toContain(seed.tenantId);

    // Detected fields correspond 1:1 with CSV headers.
    expect(data.detected_fields.map(f => f.name)).toEqual([
      'Order #', 'Cust #', 'Customer Name', 'PO Number', 'Ship Date', 'Route',
    ]);

    // Core fields were auto-suggested.
    const byName = Object.fromEntries(data.detected_fields.map(f => [f.name, f]));
    expect(byName['Order #'].candidate_target).toBe('order_number');
    expect(byName['Cust #'].candidate_target).toBe('customer_number');
    expect(byName['Customer Name'].candidate_target).toBe('customer_name');
    expect(byName['PO Number'].candidate_target).toBe('po_number');

    // Ship Date + Route became extended fields because no core matches.
    const extKeys = data.suggested_mappings.extended.map(e => e.key);
    expect(extKeys).toContain('ship_date');
    expect(extKeys).toContain('route');

    // Suggested v2 mapping is fully formed.
    expect(data.suggested_mappings.version).toBe(2);
    expect(data.suggested_mappings.core.order_number.enabled).toBe(true);

    // Sample rows include 3 data rows.
    expect(data.sample_rows).toHaveLength(3);

    // R2 upload actually happened — re-fetch the object and verify bytes.
    const obj = await env.FILES.get(data.sample_id);
    expect(obj).not.toBeNull();
    const retrievedText = await obj!.text();
    expect(retrievedText).toContain('SO-1001');
    expect(obj!.customMetadata?.source_type).toBe('csv');
    expect(obj!.customMetadata?.tenant_id).toBe(seed.tenantId);
  });

  it('returns 400 when file field is missing', async () => {
    const request = buildFormRequest({ source_type: 'csv', tenant_id: seed.tenantId });
    const user = { id: seed.orgAdminId, role: 'org_admin', tenant_id: seed.tenantId };
    const response = await discoverSchema(makeContext(request, user));
    expect(response.status).toBe(400);
  });

  it('blocks a non-admin user (reader) with a role error', async () => {
    const csv = 'order_number\nSO-1';
    const file = new File([csv], 'sample.csv', { type: 'text/csv' });
    const request = buildFormRequest({ file, source_type: 'csv', tenant_id: seed.tenantId });
    const user = { id: seed.readerId, role: 'reader', tenant_id: seed.tenantId };
    const response = await discoverSchema(makeContext(request, user));
    expect(response.status).toBeGreaterThanOrEqual(400);
  });
});

describe('POST /api/connectors/discover-schema — XLSX', () => {
  it('discovers fields from the Weekly Master workbook with sheet_name stamps', async () => {
    const xlsxBuffer = loadWeeklyMasterXlsx();
    const file = new File([xlsxBuffer], 'weekly-master.xlsx', {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    const request = buildFormRequest({
      file,
      source_type: 'xlsx',
      tenant_id: seed.tenantId,
    });
    const user = { id: seed.orgAdminId, role: 'org_admin', tenant_id: seed.tenantId };
    const response = await discoverSchema(makeContext(request, user));

    expect(response.status).toBe(200);
    const data = await response.json() as {
      sample_id: string;
      source_type: string;
      detected_fields: Array<{ name: string; sheet_name?: string; candidate_target?: string }>;
      warnings: string[];
      layout_hint: string;
    };
    expect(data.source_type).toBe('xlsx');
    expect(data.detected_fields.length).toBeGreaterThan(0);

    // Every field has a sheet_name.
    for (const f of data.detected_fields) {
      expect(typeof f.sheet_name).toBe('string');
    }

    // Block-per-customer detection surfaced a customer_number field.
    expect(
      data.detected_fields.some(
        (f) => f.name === 'customer_number' && f.candidate_target === 'customer_number',
      ),
    ).toBe(true);

    // INACTIVE sheet was skipped (warning present).
    expect(data.warnings.some((w) => /inactive/i.test(w))).toBe(true);

    // R2 object was uploaded with xlsx metadata.
    const obj = await env.FILES.get(data.sample_id);
    expect(obj).not.toBeNull();
    expect(obj!.customMetadata?.source_type).toBe('xlsx');
  });
});

describe('POST /api/connectors/discover-schema — PDF (with Qwen mock)', () => {
  beforeEach(() => {
    installQwenMock(((bodyText: string) => {
      if (/Source kind: pdf/i.test(bodyText) || /Summary Order Status/i.test(bodyText)) {
        return {
          orders: [],
          customers: [],
          detected_fields: [
            {
              name: 'Order #',
              inferred_type: 'id',
              sample_values: ['1784767'],
              inferred_aliases: [],
              candidate_target: 'order_number',
              confidence: 0.95,
            },
            {
              name: 'Customer',
              inferred_type: 'string',
              sample_values: ['CHUCKANUT BAY FOODS'],
              inferred_aliases: [],
              candidate_target: 'customer_name',
              confidence: 0.85,
            },
          ],
          layout_hint: 'tabular',
          warnings: [],
        };
      }
      return undefined;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any);
  });

  afterEach(() => {
    uninstallQwenMock();
  });

  it('discovers fields from a COA PDF via Qwen', async () => {
    const pdfBuffer = loadCoaOrdersPdf();
    const file = new File([pdfBuffer], 'coa-orders.pdf', { type: 'application/pdf' });
    const request = buildFormRequest({
      file,
      source_type: 'pdf',
      tenant_id: seed.tenantId,
    });
    const user = { id: seed.orgAdminId, role: 'org_admin', tenant_id: seed.tenantId };
    // The endpoint reads env.QWEN_URL to decide whether to call Qwen.
    // The test env has QWEN_URL set (mocked via fetch).
    const ctx = makeContext(request, user);
    ctx.env = { ...env, QWEN_URL: 'https://qwen.test', QWEN_SECRET: 'test' };
    const response = await discoverSchema(ctx);
    expect(response.status).toBe(200);
    const data = await response.json() as {
      detected_fields: Array<{ name: string; candidate_target?: string }>;
      source_type: string;
      layout_hint: string;
    };
    expect(data.source_type).toBe('pdf');
    expect(data.detected_fields.length).toBeGreaterThan(0);
    expect(data.layout_hint).toBe('tabular');
  });
});

describe('POST /api/connectors/discover-schema — email auto-detect from .txt', () => {
  beforeEach(() => {
    installQwenMock(((bodyText: string) => {
      if (/Source kind: email/i.test(bodyText) || /Daily COA Report/i.test(bodyText)) {
        return {
          orders: [],
          customers: [],
          detected_fields: [
            {
              name: 'Order',
              inferred_type: 'id',
              sample_values: ['1784767'],
              inferred_aliases: ['order_number'],
              candidate_target: 'order_number',
              confidence: 0.9,
            },
          ],
          layout_hint: 'key_value',
          warnings: [],
        };
      }
      return undefined;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any);
  });

  afterEach(() => {
    uninstallQwenMock();
  });

  it('auto-routes an email-shaped .txt file to the email parser', async () => {
    // This is the exact failure case: a .txt file whose contents are a raw
    // email. The CSV parser would shred `Subject: Daily COA Report - April 6, 2026`
    // on the comma. With content-sniffing the backend detects email headers
    // and re-dispatches to discoverFromEmail instead.
    const emailText = `Subject: Daily COA Report - April 6, 2026
From: orders@medosweet.test
To: ingest@dox.test
Date: Mon, 06 Apr 2026 08:15:00 -0700

Please process the following orders:

Order: 1784767  Customer: K00166 - CHUCKANUT BAY FOODS  PO: PO-500
`;
    const file = new File([emailText], 'daily-coa-report.txt', { type: 'text/plain' });
    const request = buildFormRequest({
      file,
      source_type: 'text',
      tenant_id: seed.tenantId,
    });
    const user = { id: seed.orgAdminId, role: 'org_admin', tenant_id: seed.tenantId };
    const ctx = makeContext(request, user);
    ctx.env = { ...env, QWEN_URL: 'https://qwen.test', QWEN_SECRET: 'test' };
    const response = await discoverSchema(ctx);
    expect(response.status).toBe(200);
    const data = await response.json() as {
      source_type: string;
      detected_fields: Array<{ name: string; candidate_target?: string }>;
      warnings: string[];
    };
    // Backend flipped to eml.
    expect(data.source_type).toBe('eml');
    // Auto-detection warning is present.
    expect(data.warnings.some((w) => /auto-routing to email parser/i.test(w))).toBe(true);
    // Email discovery ran successfully (via Qwen mock).
    expect(data.detected_fields.length).toBeGreaterThan(0);
    expect(data.detected_fields[0].candidate_target).toBe('order_number');
  });

  it('does NOT re-route a real CSV that happens to have a colon in a value', async () => {
    const csv = `Order #,Notes
SO-1001,"Subject: do not ship"
SO-1002,"From: warehouse"`;
    const file = new File([csv], 'orders.csv', { type: 'text/csv' });
    const request = buildFormRequest({
      file,
      source_type: 'csv',
      tenant_id: seed.tenantId,
    });
    const user = { id: seed.orgAdminId, role: 'org_admin', tenant_id: seed.tenantId };
    const response = await discoverSchema(makeContext(request, user));
    expect(response.status).toBe(200);
    const data = await response.json() as {
      source_type: string;
      warnings: string[];
    };
    // Still CSV — the header row starts with `Order #,Notes`, not with
    // a known email header name.
    expect(data.source_type).toBe('csv');
    expect(data.warnings.some((w) => /auto-routing/i.test(w))).toBe(false);
  });
});

describe('POST /api/connectors/discover-schema — EML (with Qwen mock)', () => {
  beforeEach(() => {
    installQwenMock(((bodyText: string) => {
      if (/Source kind: email/i.test(bodyText) || /Daily Order Batch/i.test(bodyText)) {
        return {
          orders: [],
          customers: [],
          detected_fields: [
            {
              name: 'Order',
              inferred_type: 'id',
              sample_values: ['1784767'],
              inferred_aliases: ['order_number'],
              candidate_target: 'order_number',
              confidence: 0.9,
            },
          ],
          layout_hint: 'key_value',
          warnings: [],
        };
      }
      return undefined;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any);
  });

  afterEach(() => {
    uninstallQwenMock();
  });

  it('discovers fields from an .eml file', async () => {
    const eml = `From: orders@medosweet.test
Subject: Daily Order Batch 2026-04-10
Content-Type: text/plain

Order: 1784767  Customer: K00166 - CHUCKANUT BAY FOODS  PO: PO-500
`;
    const file = new File([eml], 'batch.eml', { type: 'message/rfc822' });
    const request = buildFormRequest({
      file,
      source_type: 'eml',
      tenant_id: seed.tenantId,
    });
    const user = { id: seed.orgAdminId, role: 'org_admin', tenant_id: seed.tenantId };
    const ctx = makeContext(request, user);
    ctx.env = { ...env, QWEN_URL: 'https://qwen.test', QWEN_SECRET: 'test' };
    const response = await discoverSchema(ctx);
    expect(response.status).toBe(200);
    const data = await response.json() as {
      source_type: string;
      detected_fields: Array<{ name: string; candidate_target?: string }>;
    };
    expect(data.source_type).toBe('eml');
    expect(data.detected_fields.length).toBeGreaterThan(0);
    expect(data.detected_fields[0].candidate_target).toBe('order_number');
  });
});
