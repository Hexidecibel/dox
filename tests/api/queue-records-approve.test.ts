/**
 * Review Queue v2: producing order/shipment on HUMAN approve from EDITED records.
 *
 * order/shipment items no longer auto-produce on the worker callback. The
 * producer (ingestOrders / produceShipment) runs on PUT /api/queue/:id with
 * { status:'approved', records: <payload> }, against the human-edited records.
 *
 * Also covers GET /api/lot-matches (list pending suggestions, filter by
 * order_number).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { seedTestData, generateTestId } from '../helpers/db';
import { onRequestPut as approveQueueItem } from '../../functions/api/queue/[id]';
import { onRequestGet as listLotMatches } from '../../functions/api/lot-matches/index';

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
  } as unknown as Parameters<typeof approveQueueItem>[0];
}

function makeGetContext(
  query: string,
  user: { id: string; role: string; tenant_id: string | null }
) {
  const request = new Request(`http://localhost/api/lot-matches${query}`, { method: 'GET' });
  return {
    request,
    env,
    data: { user },
    params: {},
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
    functionPath: '/api/lot-matches',
  } as unknown as Parameters<typeof listLotMatches>[0];
}

async function seedQueueItem(
  tenantId: string,
  userId: string,
  opts: { outputKind: string; sourceId?: string | null; connectorRunId?: string | null; aiRecords?: string | null }
): Promise<string> {
  const id = generateTestId();
  const r2Key = `queue/${id}/file.csv`;
  await db
    .prepare(
      `INSERT INTO processing_queue
       (id, tenant_id, file_r2_key, file_name, file_size, mime_type,
        processing_status, status, created_by, output_kind, source_id, connector_run_id, ai_records)
       VALUES (?, ?, ?, 'file.csv', 12, 'text/csv', 'ready', 'pending', ?, ?, ?, ?, ?)`
    )
    .bind(
      id,
      tenantId,
      r2Key,
      userId,
      opts.outputKind,
      opts.sourceId ?? null,
      opts.connectorRunId ?? null,
      opts.aiRecords ?? null
    )
    .run();
  return id;
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

describe('PUT /api/queue/:id — approve order/shipment from edited records', () => {
  it('approve order with body.records ingests orders + customers from the edited records', async () => {
    const tenantId = seed.tenantId;
    const user = { id: seed.orgAdminId, role: 'org_admin', tenant_id: tenantId };
    const { connectorId, runId } = await seedConnectorAndRun(tenantId);

    // Worker wrote one set of records; the reviewer EDITS them before approve.
    const workerRecords = JSON.stringify({
      customers: [{ customer_number: 'C-EDIT', name: 'Wrong Name' }],
      orders: [{ order_number: 'ORD-EDIT', items: [], source_data: {} }],
    });
    const queueId = await seedQueueItem(tenantId, seed.userId, {
      outputKind: 'order',
      sourceId: connectorId,
      connectorRunId: runId,
      aiRecords: workerRecords,
    });

    const editedRecords = {
      customers: [{ customer_number: 'C-EDIT', name: 'Corrected Co', email: 'fix@acme.test' }],
      orders: [
        {
          order_number: 'ORD-EDIT',
          customer_number: 'C-EDIT',
          items: [{ product_name: 'Citric Acid', product_code: 'CA-9', quantity: 3, lot_number: 'L-EDIT' }],
          source_data: {},
        },
      ],
    };

    const response = await approveQueueItem(
      makePutContext(queueId, { status: 'approved', records: editedRecords }, user)
    );
    expect(response.status).toBe(200);

    // Order + customer created from the EDITED records.
    const order = await db
      .prepare('SELECT id FROM orders WHERE tenant_id = ? AND order_number = ?')
      .bind(tenantId, 'ORD-EDIT')
      .first<{ id: string }>();
    expect(order).not.toBeNull();
    const customer = await db
      .prepare('SELECT id, name, email FROM customers WHERE tenant_id = ? AND customer_number = ?')
      .bind(tenantId, 'C-EDIT')
      .first<{ id: string; name: string; email: string }>();
    expect(customer).not.toBeNull();
    expect(customer!.name).toBe('Corrected Co'); // edited value won
    expect(customer!.email).toBe('fix@acme.test');

    // Order item came from the edited line.
    const oi = await db
      .prepare('SELECT product_code FROM order_items WHERE order_id = ?')
      .bind(order!.id)
      .first<{ product_code: string }>();
    expect(oi!.product_code).toBe('CA-9');

    // ai_records was overwritten with the corrected payload.
    const row = await db
      .prepare('SELECT status, reviewed_by, ai_records FROM processing_queue WHERE id = ?')
      .bind(queueId)
      .first<{ status: string; reviewed_by: string; ai_records: string }>();
    expect(row!.status).toBe('approved');
    expect(row!.reviewed_by).toBe(user.id);
    expect(JSON.parse(row!.ai_records).customers[0].name).toBe('Corrected Co');

    // Run rollup happened on approve.
    const run = await db
      .prepare('SELECT records_created, status FROM connector_runs WHERE id = ?')
      .bind(runId)
      .first<{ records_created: number; status: string }>();
    expect(run!.records_created).toBeGreaterThanOrEqual(2);
    expect(run!.status).toBe('success');
  });

  it('approve order falls back to item.ai_records when body.records is absent', async () => {
    const tenantId = seed.tenantId;
    const user = { id: seed.orgAdminId, role: 'org_admin', tenant_id: tenantId };

    const stored = JSON.stringify({
      customers: [],
      orders: [{ order_number: 'ORD-FALLBACK', items: [], source_data: {} }],
    });
    const queueId = await seedQueueItem(tenantId, seed.userId, {
      outputKind: 'order',
      aiRecords: stored,
    });

    const response = await approveQueueItem(
      makePutContext(queueId, { status: 'approved' }, user)
    );
    expect(response.status).toBe(200);

    const order = await db
      .prepare('SELECT id FROM orders WHERE tenant_id = ? AND order_number = ?')
      .bind(tenantId, 'ORD-FALLBACK')
      .first<{ id: string }>();
    expect(order).not.toBeNull();
  });

  it('approve order with malformed records returns 400', async () => {
    const tenantId = seed.tenantId;
    const user = { id: seed.orgAdminId, role: 'org_admin', tenant_id: tenantId };
    const queueId = await seedQueueItem(tenantId, seed.userId, { outputKind: 'order' });

    const response = await approveQueueItem(
      makePutContext(queueId, { status: 'approved', records: { orders: 'not-an-array' } }, user)
    );
    expect(response.status).toBe(400);

    // Item NOT approved.
    const row = await db
      .prepare('SELECT status FROM processing_queue WHERE id = ?')
      .bind(queueId)
      .first<{ status: string }>();
    expect(row!.status).toBe('pending');
  });

  it('approve shipment with body.records binds the order line lot via produceShipment', async () => {
    const tenantId = seed.tenantId;
    const user = { id: seed.orgAdminId, role: 'org_admin', tenant_id: tenantId };

    // Seed an order + order_item with NO lot yet.
    const orderId = generateTestId();
    await db
      .prepare(`INSERT INTO orders (id, tenant_id, order_number, source_data) VALUES (?, ?, 'ORD-SH2', '{}')`)
      .bind(orderId, tenantId)
      .run();
    const itemId = generateTestId();
    await db
      .prepare(`INSERT INTO order_items (id, order_id, product_name, product_code) VALUES (?, ?, 'Sodium Benzoate', 'SB-2')`)
      .bind(itemId, orderId)
      .run();

    const queueId = await seedQueueItem(tenantId, seed.userId, { outputKind: 'shipment' });

    const response = await approveQueueItem(
      makePutContext(
        queueId,
        {
          status: 'approved',
          records: {
            shipments: [
              { order_number: 'ORD-SH2', product_code: 'SB-2', lot_number: 'LOT-XYZ', quantity: 4, status: 'shipped' },
            ],
          },
        },
        user
      )
    );
    expect(response.status).toBe(200);

    const item = await db
      .prepare('SELECT lot_id FROM order_items WHERE id = ?')
      .bind(itemId)
      .first<{ lot_id: string | null }>();
    expect(item!.lot_id).not.toBeNull();

    const row = await db
      .prepare('SELECT status FROM processing_queue WHERE id = ?')
      .bind(queueId)
      .first<{ status: string }>();
    expect(row!.status).toBe('approved');
  });
});

describe('GET /api/lot-matches — list pending suggestions', () => {
  it('returns seeded pending suggestions and filters by order_number', async () => {
    const tenantId = seed.tenantId;
    const user = { id: seed.orgAdminId, role: 'org_admin', tenant_id: tenantId };

    // Build the join graph: order → order_item, lot, document, suggestion.
    const orderId = generateTestId();
    await db
      .prepare(`INSERT INTO orders (id, tenant_id, order_number, source_data) VALUES (?, ?, 'ORD-LM', '{}')`)
      .bind(orderId, tenantId)
      .run();
    const itemId = generateTestId();
    await db
      .prepare(`INSERT INTO order_items (id, order_id, product_name) VALUES (?, ?, 'Ascorbic Acid')`)
      .bind(itemId, orderId)
      .run();
    const lotId = generateTestId();
    await db
      .prepare(`INSERT INTO lots (id, tenant_id, lot_number, lot_key) VALUES (?, ?, 'LOT-LM', 'lotlm')`)
      .bind(lotId, tenantId)
      .run();
    // Minimal document row (title is what the list returns).
    const docId = generateTestId();
    await db
      .prepare(
        `INSERT INTO documents (id, tenant_id, title, status, created_by, created_at, updated_at)
         VALUES (?, ?, 'COA for Ascorbic Acid', 'active', ?, datetime('now'), datetime('now'))`
      )
      .bind(docId, tenantId, seed.userId)
      .run();
    const suggId = generateTestId();
    await db
      .prepare(
        `INSERT INTO lot_match_suggestions
         (id, tenant_id, order_item_id, document_id, lot_id, match_confidence, match_basis, status)
         VALUES (?, ?, ?, ?, ?, 0.5, 'lot_only', 'pending')`
      )
      .bind(suggId, tenantId, itemId, docId, lotId)
      .run();

    // Default (pending) list includes our suggestion with the joined fields.
    const res = await listLotMatches(makeGetContext('?status=pending', user));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { suggestions: Array<Record<string, unknown>> };
    const found = body.suggestions.find((s) => s.id === suggId);
    expect(found).toBeTruthy();
    expect(found!.document_title).toBe('COA for Ascorbic Acid');
    expect(found!.lot_number).toBe('LOT-LM');
    expect(found!.product_name).toBe('Ascorbic Acid');
    expect(found!.match_basis).toBe('lot_only');
    expect(found!.match_confidence).toBe(0.5);
    expect(found!.order_item_id).toBe(itemId);
    expect(found!.document_id).toBe(docId);
    expect(found!.lot_id).toBe(lotId);
    expect(found!.status).toBe('pending');

    // Filter by order_number narrows to this order.
    const res2 = await listLotMatches(makeGetContext('?status=pending&order_number=ORD-LM', user));
    const body2 = (await res2.json()) as { suggestions: Array<Record<string, unknown>> };
    expect(body2.suggestions.some((s) => s.id === suggId)).toBe(true);

    // A non-matching order_number excludes it.
    const res3 = await listLotMatches(makeGetContext('?status=pending&order_number=NOPE-000', user));
    const body3 = (await res3.json()) as { suggestions: Array<Record<string, unknown>> };
    expect(body3.suggestions.some((s) => s.id === suggId)).toBe(false);
  });
});
