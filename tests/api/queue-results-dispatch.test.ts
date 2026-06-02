/**
 * Review Queue v2: PUT /api/queue/:id/results NO LONGER auto-produces.
 *
 *   - output_kind='order'    + ai_records → persisted; NO orders/customers
 *                                           created; item stays pending.
 *   - output_kind='shipment' + ai_records → persisted; NO lot binding; pending.
 *   - output_kind='coa'/null              → existing COA template path,
 *                                           NOT the producer dispatch.
 *
 * Production now happens on human approve (see queue-records-approve.test.ts).
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

async function seedConnectorAndRun(tenantId: string): Promise<{ connectorId: string; runId: string }> {
  const connectorId = generateTestId();
  await db
    .prepare(
      `INSERT INTO connectors (id, tenant_id, name, slug, output_kind, active)
       VALUES (?, ?, 'WMS Feed', ?, 'order', 1)`
    )
    .bind(connectorId, tenantId, `wms-${connectorId.slice(0, 8)}`)
    .run();
  const runId = generateTestId();
  await db
    .prepare(
      `INSERT INTO connector_runs (id, connector_id, tenant_id, status)
       VALUES (?, ?, ?, 'running')`
    )
    .bind(runId, connectorId, tenantId)
    .run();
  return { connectorId, runId };
}

async function seedQueueItem(
  tenantId: string,
  userId: string,
  opts: { outputKind: string | null; sourceId?: string | null; connectorRunId?: string | null }
): Promise<string> {
  const id = generateTestId();
  const r2Key = `queue/${id}/file.csv`;
  await db
    .prepare(
      `INSERT INTO processing_queue
       (id, tenant_id, file_r2_key, file_name, file_size, mime_type,
        processing_status, status, created_by, output_kind, source_id, connector_run_id)
       VALUES (?, ?, ?, 'file.csv', 12, 'text/csv', 'processing', 'pending', ?, ?, ?, ?)`
    )
    .bind(
      id,
      tenantId,
      r2Key,
      userId,
      opts.outputKind,
      opts.sourceId ?? null,
      opts.connectorRunId ?? null
    )
    .run();
  return id;
}

describe('PUT /api/queue/:id/results — output_kind dispatch (no auto-produce)', () => {
  it("output_kind='order' persists records but produces NOTHING and stays pending", async () => {
    const tenantId = seed.tenantId;
    const user = { id: seed.userId, role: 'user', tenant_id: tenantId };
    const { connectorId, runId } = await seedConnectorAndRun(tenantId);

    const queueId = await seedQueueItem(tenantId, seed.userId, {
      outputKind: 'order',
      sourceId: connectorId,
      connectorRunId: runId,
    });

    const ordersBefore = await db
      .prepare('SELECT COUNT(*) AS n FROM orders WHERE tenant_id = ?')
      .bind(tenantId)
      .first<{ n: number }>();

    const aiRecords = JSON.stringify({
      customers: [{ customer_number: 'C-100', name: 'Acme Foods', email: 'buyer@acme.test' }],
      orders: [
        {
          order_number: 'ORD-900',
          customer_number: 'C-100',
          items: [{ product_name: 'Citric Acid', product_code: 'CA-1', quantity: 5, lot_number: 'L-900' }],
          source_data: {},
        },
      ],
    });

    const response = await updateQueueResults(
      makePutContext(queueId, { processing_status: 'ready', ai_records: aiRecords }, user)
    );
    expect(response.status).toBe(200);

    // NO order/customer produced — production is deferred to human approve.
    const order = await db
      .prepare('SELECT id FROM orders WHERE tenant_id = ? AND order_number = ?')
      .bind(tenantId, 'ORD-900')
      .first<{ id: string }>();
    expect(order).toBeNull();
    const ordersAfter = await db
      .prepare('SELECT COUNT(*) AS n FROM orders WHERE tenant_id = ?')
      .bind(tenantId)
      .first<{ n: number }>();
    expect(ordersAfter!.n).toBe(ordersBefore!.n);
    const customer = await db
      .prepare('SELECT id FROM customers WHERE tenant_id = ? AND customer_number = ?')
      .bind(tenantId, 'C-100')
      .first<{ id: string }>();
    expect(customer).toBeNull();

    // The run rollup is NOT touched on ready (it moves to approve).
    const run = await db
      .prepare('SELECT records_created, status FROM connector_runs WHERE id = ?')
      .bind(runId)
      .first<{ records_created: number | null; status: string }>();
    expect(run!.records_created ?? 0).toBe(0);
    expect(run!.status).toBe('running');

    // Item stays in review: records persisted, status pending, processing ready.
    const row = await db
      .prepare('SELECT status, processing_status, ai_records FROM processing_queue WHERE id = ?')
      .bind(queueId)
      .first<{ status: string; processing_status: string; ai_records: string | null }>();
    expect(row!.status).toBe('pending');
    expect(row!.processing_status).toBe('ready');
    expect(row!.ai_records).toBe(aiRecords);
  });

  it("output_kind='shipment' persists records but binds NO lot and stays pending", async () => {
    const tenantId = seed.tenantId;
    const user = { id: seed.userId, role: 'user', tenant_id: tenantId };
    const { connectorId, runId } = await seedConnectorAndRun(tenantId);

    // Seed an order + order_item with NO lot yet.
    const orderId = generateTestId();
    await db
      .prepare(
        `INSERT INTO orders (id, tenant_id, order_number, source_data)
         VALUES (?, ?, 'ORD-SHIP', '{}')`
      )
      .bind(orderId, tenantId)
      .run();
    const itemId = generateTestId();
    await db
      .prepare(
        `INSERT INTO order_items (id, order_id, product_name, product_code)
         VALUES (?, ?, 'Sodium Benzoate', 'SB-7')`
      )
      .bind(itemId, orderId)
      .run();

    const queueId = await seedQueueItem(tenantId, seed.userId, {
      outputKind: 'shipment',
      sourceId: connectorId,
      connectorRunId: runId,
    });

    const aiRecords = JSON.stringify({
      shipments: [
        { order_number: 'ORD-SHIP', product_code: 'SB-7', lot_number: 'LOT-555', quantity: 10, status: 'shipped' },
      ],
    });

    const response = await updateQueueResults(
      makePutContext(queueId, { processing_status: 'ready', ai_records: aiRecords }, user)
    );
    expect(response.status).toBe(200);

    // NO lot binding on ready — deferred to approve.
    const item = await db
      .prepare('SELECT lot_id FROM order_items WHERE id = ?')
      .bind(itemId)
      .first<{ lot_id: string | null }>();
    expect(item!.lot_id).toBeNull();

    const row = await db
      .prepare('SELECT status, processing_status FROM processing_queue WHERE id = ?')
      .bind(queueId)
      .first<{ status: string; processing_status: string }>();
    expect(row!.status).toBe('pending');
    expect(row!.processing_status).toBe('ready');
  });

  it("output_kind='coa' (null) keeps the COA path — no producer dispatch", async () => {
    const tenantId = seed.tenantId;
    const user = { id: seed.userId, role: 'user', tenant_id: tenantId };

    // No template, no threshold → COA path is a no-op (stays pending). The
    // important assertion is that it does NOT crash and does NOT touch orders.
    await db.prepare('UPDATE tenants SET auto_approve_threshold = NULL WHERE id = ?').bind(tenantId).run();

    const queueId = await seedQueueItem(tenantId, seed.userId, { outputKind: null });

    const ordersBefore = await db
      .prepare('SELECT COUNT(*) AS n FROM orders WHERE tenant_id = ?')
      .bind(tenantId)
      .first<{ n: number }>();

    const response = await updateQueueResults(
      makePutContext(
        queueId,
        {
          processing_status: 'ready',
          ai_fields: JSON.stringify({ supplier_name: 'ACME' }),
          // ai_records present but should be ignored on the COA path.
          ai_records: JSON.stringify({ orders: [{ order_number: 'SHOULD-NOT-INGEST', items: [], source_data: {} }] }),
        },
        user
      )
    );
    expect(response.status).toBe(200);

    const row = await db
      .prepare('SELECT status, processing_status FROM processing_queue WHERE id = ?')
      .bind(queueId)
      .first<{ status: string; processing_status: string }>();
    expect(row!.status).toBe('pending');
    expect(row!.processing_status).toBe('ready');

    // The COA path must NOT have ingested the order embedded in ai_records.
    const ordersAfter = await db
      .prepare('SELECT COUNT(*) AS n FROM orders WHERE tenant_id = ?')
      .bind(tenantId)
      .first<{ n: number }>();
    expect(ordersAfter!.n).toBe(ordersBefore!.n);
    const stray = await db
      .prepare('SELECT id FROM orders WHERE order_number = ?')
      .bind('SHOULD-NOT-INGEST')
      .first();
    expect(stray).toBeNull();
  });

  it('does NOT parse/produce ai_records on ready — even malformed JSON is just stored', async () => {
    const tenantId = seed.tenantId;
    const user = { id: seed.userId, role: 'user', tenant_id: tenantId };
    const { connectorId, runId } = await seedConnectorAndRun(tenantId);

    const queueId = await seedQueueItem(tenantId, seed.userId, {
      outputKind: 'order',
      sourceId: connectorId,
      connectorRunId: runId,
    });

    // ready no longer parses ai_records — no producer runs, so even invalid
    // JSON is persisted verbatim and the item lands in review (200, pending).
    const response = await updateQueueResults(
      makePutContext(queueId, { processing_status: 'ready', ai_records: '{not valid json' }, user)
    );
    expect(response.status).toBe(200);

    const row = await db
      .prepare('SELECT status, processing_status, ai_records FROM processing_queue WHERE id = ?')
      .bind(queueId)
      .first<{ status: string; processing_status: string; ai_records: string | null }>();
    expect(row!.processing_status).toBe('ready');
    expect(row!.status).toBe('pending');
    expect(row!.ai_records).toBe('{not valid json');
  });
});
