/**
 * R1.3 — connector-run review surface.
 *
 * Covers:
 *   - GET /api/connectors/:id/runs/:runId/staged lists only staged
 *     orders for the supplied run
 *   - committed orders + cross-run orders are excluded
 *   - POST /api/orders/:id/approve-staged clears staged_at on order +
 *     items (no overrides)
 *   - approve with field overrides applies them
 *   - approve with { items: [{id, _delete: true}] } removes that item
 *   - approve with { items: [{...}] } (no id) inserts a new item
 *   - approve on a non-staged order returns 400
 *   - GET returns 403 when caller can't access the connector's tenant
 *   - DELETE /api/orders/:id cascade-deletes order_items even when the
 *     order is staged (sanity check on the reject path that the UI
 *     uses — see CLAUDE.md / plan notes)
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { seedTestData, generateTestId } from '../helpers/db';
import { onRequestGet as stagedGet } from '../../functions/api/sources/[id]/runs/[runId]/staged';
import { onRequestPost as approveStagedPost } from '../../functions/api/orders/[id]/approve-staged';
import { onRequestDelete as orderDelete } from '../../functions/api/orders/[id]';

let seed: Awaited<ReturnType<typeof seedTestData>>;
const db = env.DB;

beforeAll(async () => {
  seed = await seedTestData(db);
}, 30_000);

interface User {
  id: string;
  email: string;
  name: string;
  role: 'super_admin' | 'org_admin' | 'user' | 'reader';
  tenant_id: string | null;
  active: number;
}

const orgAdmin: User = {
  id: 'user-org-admin',
  email: 'orgadmin@test.com',
  name: 'Org Admin',
  role: 'org_admin',
  tenant_id: 'test-tenant-001',
  active: 1,
};

const orgAdminOther: User = {
  id: 'user-org-admin-2',
  email: 'orgadmin2@test.com',
  name: 'Other Org Admin',
  role: 'org_admin',
  tenant_id: 'test-tenant-002',
  active: 1,
};

async function insertConnector(tenantId = seed.tenantId): Promise<string> {
  const id = generateTestId();
  await db
    .prepare(
      `INSERT INTO connectors (id, tenant_id, name, slug, config, field_mappings, active,
                               created_at, updated_at)
       VALUES (?, ?, ?, ?, '{}', '{}', 1, datetime('now'), datetime('now'))`,
    )
    .bind(id, tenantId, `review-${id}`, `review-${id.slice(0, 8)}`)
    .run();
  return id;
}

async function insertRun(connectorId: string, tenantId = seed.tenantId): Promise<string> {
  const id = generateTestId();
  await db
    .prepare(
      `INSERT INTO connector_runs (id, connector_id, tenant_id, status,
                                   started_at, completed_at,
                                   records_found, records_created, records_staged)
       VALUES (?, ?, ?, 'partial', datetime('now'), datetime('now'),
               2, 2, 1)`,
    )
    .bind(id, connectorId, tenantId)
    .run();
  return id;
}

interface OrderOpts {
  staged: boolean;
  orderNumber?: string;
  customerNumber?: string | null;
  customerName?: string | null;
  customerId?: string | null;
  confidence?: number | null;
  tenantId?: string;
}

async function insertOrder(
  connectorId: string,
  runId: string,
  opts: OrderOpts,
): Promise<string> {
  const id = generateTestId();
  const stagedAt = opts.staged ? '2026-05-01 12:00:00' : null;
  await db
    .prepare(
      `INSERT INTO orders (id, tenant_id, connector_id, connector_run_id, order_number,
                           customer_number, customer_id, customer_name,
                           confidence, staged_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      opts.tenantId ?? seed.tenantId,
      connectorId,
      runId,
      opts.orderNumber ?? `SO-${id.slice(0, 6)}`,
      opts.customerNumber === null ? null : (opts.customerNumber ?? 'CUST-1'),
      opts.customerId ?? null,
      opts.customerName === null ? null : (opts.customerName ?? 'Acme Foods'),
      opts.confidence ?? (opts.staged ? 0.45 : 0.95),
      stagedAt,
    )
    .run();
  return id;
}

async function insertItem(
  orderId: string,
  productName = 'Widget',
  staged = true,
): Promise<string> {
  const id = generateTestId();
  await db
    .prepare(
      `INSERT INTO order_items (id, order_id, product_name, product_code, quantity, lot_number,
                                confidence, staged_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      orderId,
      productName,
      'WGT-1',
      10,
      'LOT-A',
      0.62,
      staged ? '2026-05-01 12:00:00' : null,
    )
    .run();
  return id;
}

function getStagedContext(connectorId: string, runId: string, user: User) {
  return {
    request: new Request(
      `http://localhost/api/connectors/${connectorId}/runs/${runId}/staged`,
    ),
    env,
    data: { user },
    params: { id: connectorId, runId },
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
    functionPath: `/api/connectors/${connectorId}/runs/${runId}/staged`,
  } as unknown as Parameters<typeof stagedGet>[0];
}

function approveContext(
  orderId: string,
  user: User,
  body: unknown = {},
) {
  const json = JSON.stringify(body);
  return {
    request: new Request(`http://localhost/api/orders/${orderId}/approve-staged`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'content-length': String(json.length) },
      body: json,
    }),
    env,
    data: { user },
    params: { id: orderId },
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
    functionPath: `/api/orders/${orderId}/approve-staged`,
  } as unknown as Parameters<typeof approveStagedPost>[0];
}

function deleteContext(orderId: string, user: User) {
  return {
    request: new Request(`http://localhost/api/orders/${orderId}`, { method: 'DELETE' }),
    env,
    data: { user },
    params: { id: orderId },
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
    functionPath: `/api/orders/${orderId}`,
  } as unknown as Parameters<typeof orderDelete>[0];
}

describe('GET /api/connectors/:id/runs/:runId/staged', () => {
  it('returns only staged orders for the supplied run with their items', async () => {
    const connectorId = await insertConnector();
    const runId = await insertRun(connectorId);

    const stagedOrder = await insertOrder(connectorId, runId, { staged: true });
    await insertItem(stagedOrder, 'StagedWidget');
    const committedOrder = await insertOrder(connectorId, runId, {
      staged: false,
      orderNumber: 'SO-committed',
    });
    await insertItem(committedOrder, 'CommittedWidget', false);

    const resp = await stagedGet(getStagedContext(connectorId, runId, orgAdmin));
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { run: { id: string }; orders: Array<{ id: string; items: unknown[] }> };
    expect(body.run.id).toBe(runId);
    expect(body.orders.length).toBe(1);
    expect(body.orders[0].id).toBe(stagedOrder);
    expect(body.orders[0].items.length).toBe(1);
  });

  it('excludes staged orders from a different run', async () => {
    const connectorId = await insertConnector();
    const runA = await insertRun(connectorId);
    const runB = await insertRun(connectorId);

    await insertOrder(connectorId, runA, { staged: true });
    const targetOrder = await insertOrder(connectorId, runB, {
      staged: true,
      orderNumber: 'SO-only-in-B',
    });

    const resp = await stagedGet(getStagedContext(connectorId, runB, orgAdmin));
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { orders: Array<{ id: string }> };
    expect(body.orders.length).toBe(1);
    expect(body.orders[0].id).toBe(targetOrder);
  });

  it('returns 403 when caller cannot access the connector tenant', async () => {
    const connectorId = await insertConnector();
    const runId = await insertRun(connectorId);
    await insertOrder(connectorId, runId, { staged: true });

    const resp = await stagedGet(getStagedContext(connectorId, runId, orgAdminOther));
    expect(resp.status).toBe(403);
  });

  it('returns 404 when the run does not belong to the connector', async () => {
    const connectorA = await insertConnector();
    const connectorB = await insertConnector();
    const runOfA = await insertRun(connectorA);
    const resp = await stagedGet(getStagedContext(connectorB, runOfA, orgAdmin));
    expect(resp.status).toBe(404);
  });
});

describe('POST /api/orders/:id/approve-staged', () => {
  it('clears staged_at on the order AND its items when no overrides are sent', async () => {
    const connectorId = await insertConnector();
    const runId = await insertRun(connectorId);
    const orderId = await insertOrder(connectorId, runId, { staged: true });
    const itemId = await insertItem(orderId);

    const resp = await approveStagedPost(approveContext(orderId, orgAdmin));
    expect(resp.status).toBe(200);

    const order = await db
      .prepare(`SELECT staged_at FROM orders WHERE id = ?`)
      .bind(orderId)
      .first<{ staged_at: string | null }>();
    expect(order?.staged_at).toBeNull();

    const item = await db
      .prepare(`SELECT staged_at FROM order_items WHERE id = ?`)
      .bind(itemId)
      .first<{ staged_at: string | null }>();
    expect(item?.staged_at).toBeNull();
  });

  it('applies field overrides on the order row', async () => {
    const connectorId = await insertConnector();
    const runId = await insertRun(connectorId);
    const orderId = await insertOrder(connectorId, runId, { staged: true });
    await insertItem(orderId);

    const resp = await approveStagedPost(
      approveContext(orderId, orgAdmin, {
        order_number: 'SO-REVISED',
        customer_name: 'Fixed Name LLC',
      }),
    );
    expect(resp.status).toBe(200);

    const order = await db
      .prepare(`SELECT order_number, customer_name, staged_at FROM orders WHERE id = ?`)
      .bind(orderId)
      .first<{ order_number: string; customer_name: string; staged_at: string | null }>();
    expect(order?.order_number).toBe('SO-REVISED');
    expect(order?.customer_name).toBe('Fixed Name LLC');
    expect(order?.staged_at).toBeNull();
  });

  it('deletes an item when { id, _delete: true } is sent', async () => {
    const connectorId = await insertConnector();
    const runId = await insertRun(connectorId);
    const orderId = await insertOrder(connectorId, runId, { staged: true });
    const keepId = await insertItem(orderId, 'Keep');
    const dropId = await insertItem(orderId, 'Drop');

    const resp = await approveStagedPost(
      approveContext(orderId, orgAdmin, {
        items: [{ id: dropId, _delete: true }],
      }),
    );
    expect(resp.status).toBe(200);

    const remaining = await db
      .prepare(`SELECT id FROM order_items WHERE order_id = ?`)
      .bind(orderId)
      .all<{ id: string }>();
    const ids = (remaining.results ?? []).map((r) => r.id);
    expect(ids).toContain(keepId);
    expect(ids).not.toContain(dropId);
  });

  it('inserts a new item when an entry without id is supplied', async () => {
    const connectorId = await insertConnector();
    const runId = await insertRun(connectorId);
    const orderId = await insertOrder(connectorId, runId, { staged: true });
    await insertItem(orderId);

    const resp = await approveStagedPost(
      approveContext(orderId, orgAdmin, {
        items: [
          {
            product_name: 'NEW LINE',
            product_code: 'NEW-1',
            quantity: 7,
            lot_number: 'LOT-NEW',
          },
        ],
      }),
    );
    expect(resp.status).toBe(200);

    const all = await db
      .prepare(`SELECT product_name FROM order_items WHERE order_id = ? ORDER BY product_name`)
      .bind(orderId)
      .all<{ product_name: string }>();
    const names = (all.results ?? []).map((r) => r.product_name);
    expect(names).toContain('NEW LINE');
    expect(names).toContain('Widget');
  });

  it('returns 400 when the order is not staged', async () => {
    const connectorId = await insertConnector();
    const runId = await insertRun(connectorId);
    const orderId = await insertOrder(connectorId, runId, {
      staged: false,
      orderNumber: 'SO-already-committed',
    });

    const resp = await approveStagedPost(approveContext(orderId, orgAdmin));
    expect(resp.status).toBe(400);
  });

  it('returns 403 when the caller cannot access the order tenant', async () => {
    const connectorId = await insertConnector();
    const runId = await insertRun(connectorId);
    const orderId = await insertOrder(connectorId, runId, { staged: true });

    const resp = await approveStagedPost(approveContext(orderId, orgAdminOther));
    expect(resp.status).toBe(403);
  });

  it('writes a corrections row when the user edits fields (R1.5 learning signal)', async () => {
    const connectorId = await insertConnector();
    const runId = await insertRun(connectorId);
    const orderId = await insertOrder(connectorId, runId, {
      staged: true,
      customerNumber: 'CUST-OLD',
      customerName: 'Old Name',
    });

    const resp = await approveStagedPost(
      approveContext(orderId, orgAdmin, {
        customer_number: 'CUST-CORRECTED',
        customer_name: 'Corrected Name',
      }),
    );
    expect(resp.status).toBe(200);

    const correction = await db
      .prepare(
        `SELECT order_id, connector_id, connector_run_id, customer_number,
                reviewer_id, diffs
           FROM connector_extraction_corrections WHERE order_id = ?`,
      )
      .bind(orderId)
      .first<{
        order_id: string;
        connector_id: string;
        connector_run_id: string;
        customer_number: string;
        reviewer_id: string;
        diffs: string;
      }>();
    expect(correction).not.toBeNull();
    expect(correction?.connector_id).toBe(connectorId);
    expect(correction?.connector_run_id).toBe(runId);
    expect(correction?.customer_number).toBe('CUST-CORRECTED');
    expect(correction?.reviewer_id).toBe(orgAdmin.id);

    const diffs = JSON.parse(correction!.diffs) as Array<Record<string, unknown>>;
    expect(diffs).toHaveLength(2);
    const byField = new Map(diffs.map((d) => [d.field, d]));
    expect(byField.get('customer_number')).toMatchObject({
      entity: 'order',
      op: 'update',
      original: 'CUST-OLD',
      corrected: 'CUST-CORRECTED',
    });
    expect(byField.get('customer_name')).toMatchObject({
      entity: 'order',
      op: 'update',
      original: 'Old Name',
      corrected: 'Corrected Name',
    });
  });

  it('does NOT write a corrections row on approve-as-is (no edits)', async () => {
    const connectorId = await insertConnector();
    const runId = await insertRun(connectorId);
    const orderId = await insertOrder(connectorId, runId, { staged: true });

    const resp = await approveStagedPost(approveContext(orderId, orgAdmin));
    expect(resp.status).toBe(200);

    const correction = await db
      .prepare(`SELECT id FROM connector_extraction_corrections WHERE order_id = ?`)
      .bind(orderId)
      .first();
    expect(correction).toBeNull();
  });

  it('re-resolves customer_id when customer_number changes', async () => {
    const connectorId = await insertConnector();
    const runId = await insertRun(connectorId);

    // Seed a customer the new customer_number should resolve to.
    const customerId = generateTestId();
    await db
      .prepare(
        `INSERT INTO customers (id, tenant_id, customer_number, name, active,
                                 created_at, updated_at)
         VALUES (?, ?, 'CUST-NEW', 'New Cust', 1, datetime('now'), datetime('now'))`,
      )
      .bind(customerId, seed.tenantId)
      .run();

    const orderId = await insertOrder(connectorId, runId, {
      staged: true,
      customerNumber: 'CUST-OLD',
      customerId: null,
    });

    const resp = await approveStagedPost(
      approveContext(orderId, orgAdmin, { customer_number: 'CUST-NEW' }),
    );
    expect(resp.status).toBe(200);

    const order = await db
      .prepare(`SELECT customer_id, customer_number FROM orders WHERE id = ?`)
      .bind(orderId)
      .first<{ customer_id: string | null; customer_number: string }>();
    expect(order?.customer_number).toBe('CUST-NEW');
    expect(order?.customer_id).toBe(customerId);
  });
});

describe('DELETE /api/orders/:id (reject path for staged orders)', () => {
  it('cascade-deletes order_items when the order is staged', async () => {
    const connectorId = await insertConnector();
    const runId = await insertRun(connectorId);
    const orderId = await insertOrder(connectorId, runId, { staged: true });
    const itemId = await insertItem(orderId);

    const resp = await orderDelete(deleteContext(orderId, orgAdmin));
    expect(resp.status).toBe(200);

    const order = await db
      .prepare(`SELECT id FROM orders WHERE id = ?`)
      .bind(orderId)
      .first();
    expect(order).toBeNull();

    const item = await db
      .prepare(`SELECT id FROM order_items WHERE id = ?`)
      .bind(itemId)
      .first();
    expect(item).toBeNull();
  });
});
