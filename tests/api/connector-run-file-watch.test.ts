/**
 * API tests for POST /api/connectors/:id/run — universal manual-upload door.
 *
 * Phase B0: the run endpoint is the universal manual-upload door — any
 * active connector accepts a multipart `file` upload and dispatches it
 * through the file_watch executor, which persists orders + customers +
 * a connector_runs row via the shared orchestrator.
 *
 * Coverage:
 *  - Happy path: CSV upload -> orders + customer rows land in D1, a run
 *    row is created with correct counts, and the response exposes the
 *    same numbers.
 *  - Per-row errors (missing order_number) are skipped with records_errored
 *    incremented, but the run continues and partial results land.
 *  - Oversized files are rejected with 400 (file too large).
 *  - Unsupported extensions are rejected with 400.
 *  - Inactive connectors reject with 400.
 *  - Readers / non-admin roles get a 403-ish.
 *  - Cross-tenant access is rejected.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { seedTestData, generateTestId } from '../helpers/db';
import { onRequestPost as runConnector } from '../../functions/api/connectors/[id]/run';

let seed: Awaited<ReturnType<typeof seedTestData>>;
const db = env.DB;

beforeAll(async () => {
  seed = await seedTestData(db);
}, 30_000);

/**
 * Minimal v2 field_mappings config that claims the columns our test CSV
 * uses. Enabling order_number, customer_number, customer_name, po_number
 * as core fields covers the parseCSVAttachment happy path.
 */
function defaultMappings() {
  return {
    version: 2,
    core: {
      order_number: {
        enabled: true,
        required: true,
        source_labels: ['Order #', 'order_number', 'OrderNumber'],
      },
      po_number: {
        enabled: true,
        required: false,
        source_labels: ['PO Number', 'po_number'],
      },
      customer_number: {
        enabled: true,
        required: false,
        source_labels: ['Cust #', 'customer_number'],
      },
      customer_name: {
        enabled: true,
        required: false,
        source_labels: ['Customer Name', 'customer_name'],
      },
    },
    extended: [],
  };
}

async function insertConnector(opts: {
  tenantId: string;
  active?: number;
  mappings?: unknown;
}): Promise<string> {
  const id = generateTestId();
  await db
    .prepare(
      `INSERT INTO connectors (id, tenant_id, name, system_type, config, field_mappings, active, created_at, updated_at)
       VALUES (?, ?, ?, 'erp', '{}', ?, ?, datetime('now'), datetime('now'))`,
    )
    .bind(
      id,
      opts.tenantId,
      `run-test-${id}`,
      JSON.stringify(opts.mappings ?? defaultMappings()),
      opts.active ?? 1,
    )
    .run();
  return id;
}

function makeContext(
  id: string,
  request: Request,
  user: { id: string; role: string; tenant_id: string | null },
) {
  return {
    request,
    env,
    data: { user },
    params: { id },
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
    functionPath: `/api/connectors/${id}/run`,
  } as any;
}

function multipartRequest(id: string, file: File | null): Request {
  const form = new FormData();
  if (file) form.append('file', file);
  return new Request(`http://localhost/api/connectors/${id}/run`, {
    method: 'POST',
    body: form,
  });
}

describe('POST /api/connectors/:id/run — manual-upload happy path', () => {
  it('parses a CSV, inserts orders + customer, writes a connector_runs row', async () => {
    const connectorId = await insertConnector({ tenantId: seed.tenantId });
    const user = { id: seed.orgAdminId, role: 'org_admin', tenant_id: seed.tenantId };

    const csv = `Order #,Cust #,Customer Name,PO Number
SO-RUN-1,K-R001,Acme Foods,PO-R-100
SO-RUN-2,K-R001,Acme Foods,PO-R-101
SO-RUN-3,K-R002,Beta Ice,PO-R-200`;
    const file = new File([csv], 'orders.csv', { type: 'text/csv' });
    const response = await runConnector(makeContext(connectorId, multipartRequest(connectorId, file), user));

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      run_id: string;
      status: string;
      rows_processed: number;
      rows_inserted: number;
      rows_skipped: number;
      customers_created: number;
    };
    expect(body.run_id).toBeTruthy();
    expect(body.status).toBe('success');
    expect(body.rows_inserted).toBe(3);
    expect(body.rows_skipped).toBe(0);
    expect(body.customers_created).toBe(2);

    // Verify orders actually landed in D1 with the right tenant scope.
    const ordersRow = await db
      .prepare(
        `SELECT COUNT(*) as count FROM orders
         WHERE tenant_id = ? AND connector_id = ? AND order_number LIKE 'SO-RUN-%'`,
      )
      .bind(seed.tenantId, connectorId)
      .first<{ count: number }>();
    expect(ordersRow?.count).toBe(3);

    // Verify customers table has both entries.
    const customersRow = await db
      .prepare(
        `SELECT COUNT(*) as count FROM customers
         WHERE tenant_id = ? AND customer_number IN ('K-R001', 'K-R002')`,
      )
      .bind(seed.tenantId)
      .first<{ count: number }>();
    expect(customersRow?.count).toBe(2);

    // Verify connector_runs row exists with the expected shape.
    const runRow = await db
      .prepare(
        `SELECT status, records_found, records_created, records_errored
         FROM connector_runs WHERE id = ?`,
      )
      .bind(body.run_id)
      .first<{
        status: string;
        records_found: number;
        records_created: number;
        records_errored: number;
      }>();
    expect(runRow).toBeTruthy();
    expect(runRow!.status).toBe('success');
    expect(runRow!.records_errored).toBe(0);
  });

  it('skips rows missing order_number but keeps the valid ones', async () => {
    const connectorId = await insertConnector({ tenantId: seed.tenantId });
    const user = { id: seed.orgAdminId, role: 'org_admin', tenant_id: seed.tenantId };

    // Row 2 has no order number — parseCSVAttachment should push an error
    // and move on. Row 1 + row 3 should still land.
    const csv = `Order #,Cust #,Customer Name,PO Number
SO-PARTIAL-1,K-P001,Acme Foods,PO-P-1
,K-P002,No Order Co,PO-P-2
SO-PARTIAL-3,K-P003,Gamma LLC,PO-P-3`;
    const file = new File([csv], 'partial.csv', { type: 'text/csv' });
    const response = await runConnector(makeContext(connectorId, multipartRequest(connectorId, file), user));

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      rows_inserted: number;
      rows_skipped: number;
      status: string;
    };
    expect(body.rows_inserted).toBe(2);
    expect(body.rows_skipped).toBeGreaterThanOrEqual(1);
    // Partial status because some rows errored but at least one landed.
    expect(body.status).toBe('partial');
  });
});

describe('POST /api/connectors/:id/run — file validation', () => {
  it('rejects when no file is attached', async () => {
    const connectorId = await insertConnector({ tenantId: seed.tenantId });
    const user = { id: seed.orgAdminId, role: 'org_admin', tenant_id: seed.tenantId };

    const response = await runConnector(makeContext(connectorId, multipartRequest(connectorId, null), user));
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toMatch(/file is required/i);
  });

  it('rejects an unsupported file extension', async () => {
    const connectorId = await insertConnector({ tenantId: seed.tenantId });
    const user = { id: seed.orgAdminId, role: 'org_admin', tenant_id: seed.tenantId };

    const file = new File(['garbage'], 'weird.docx', { type: 'application/msword' });
    const response = await runConnector(makeContext(connectorId, multipartRequest(connectorId, file), user));
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toMatch(/Unsupported file type/i);
  });

  it('rejects files above the text-size limit', async () => {
    const connectorId = await insertConnector({ tenantId: seed.tenantId });
    const user = { id: seed.orgAdminId, role: 'org_admin', tenant_id: seed.tenantId };

    // 6MB CSV — exceeds the 5MB text-file limit.
    const big = 'A'.repeat(6 * 1024 * 1024);
    const file = new File([big], 'big.csv', { type: 'text/csv' });
    const response = await runConnector(makeContext(connectorId, multipartRequest(connectorId, file), user));
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toMatch(/too large/i);
  });

  it('rejects non-multipart requests', async () => {
    const connectorId = await insertConnector({ tenantId: seed.tenantId });
    const user = { id: seed.orgAdminId, role: 'org_admin', tenant_id: seed.tenantId };

    const request = new Request(`http://localhost/api/connectors/${connectorId}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const response = await runConnector(makeContext(connectorId, request, user));
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toMatch(/multipart/i);
  });
});

describe('POST /api/connectors/:id/run — state + role gating (universal-doors model)', () => {
  it('rejects runs on inactive connectors', async () => {
    const connectorId = await insertConnector({ tenantId: seed.tenantId, active: 0 });
    const user = { id: seed.orgAdminId, role: 'org_admin', tenant_id: seed.tenantId };

    const file = new File(['Order #\nSO-1'], 'orders.csv', { type: 'text/csv' });
    const response = await runConnector(makeContext(connectorId, multipartRequest(connectorId, file), user));
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toMatch(/inactive/i);
  });

  // Phase B0: the historical "rejects email connectors / 501 for
  // webhook connectors" tests are gone. Manual upload is the universal
  // door — ANY active connector accepts it. Email-specific routing
  // happens via the inbound-email webhook, not this endpoint.

  it('rejects readers', async () => {
    const connectorId = await insertConnector({ tenantId: seed.tenantId });
    const user = { id: seed.readerId, role: 'reader', tenant_id: seed.tenantId };

    const file = new File(['Order #\nSO-1'], 'orders.csv', { type: 'text/csv' });
    const response = await runConnector(makeContext(connectorId, multipartRequest(connectorId, file), user));
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
  });

  it('rejects cross-tenant access', async () => {
    const connectorId = await insertConnector({ tenantId: seed.tenantId });
    const user = { id: seed.orgAdmin2Id, role: 'org_admin', tenant_id: seed.tenantId2 };

    const file = new File(['Order #\nSO-1'], 'orders.csv', { type: 'text/csv' });
    const response = await runConnector(makeContext(connectorId, multipartRequest(connectorId, file), user));
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
  });
});
