/**
 * A connector re-ingesting an order a person has worked on.
 *
 * `ingestOrders` used to make its line write idempotent by deleting every line
 * of the order and inserting the connector's. On an order whose lines a person
 * picked a certificate for (migration 0134), or whose engine suggestion a
 * person accepted, that DELETE hits `lot_match_suggestions.order_item_id` --
 * a foreign key with no ON DELETE action -- and the whole order came back as
 * "Order upsert failed ... FOREIGN KEY constraint failed". The person's work
 * survived only because the delete could not run, and the connector's update
 * was lost with it. (The same failure hit any line that merely had a PENDING
 * suggestion, which the matcher writes by itself.)
 *
 * THE RULE NOW
 *   - header fields update, as before;
 *   - a connector line is matched to an existing line by what it IS (product
 *     code or name, and lot) and that line is updated in place, keeping its id;
 *   - a connector line with no match is added;
 *   - a line a PERSON decided -- picked, or an accepted / rejected suggestion --
 *     is never deleted and never overwritten, whether or not the connector
 *     still lists it;
 *   - a line the connector no longer lists that nobody decided is removed, as
 *     before, with its undecided suggestions;
 *   - when person-decided lines were kept, the result says so in plain words.
 *
 * AN ORDER NOBODY TOUCHED IS UNCHANGED: with no person-decided line and no
 * suggestion row, the old delete-and-insert path runs exactly as it did.
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { runMigrations, seedTestData, cleanTables, generateTestId } from '../helpers/db';
import { ingestOrders } from '../../functions/lib/kinds/order';
import type { ConnectorOutput } from '../../functions/lib/connectors/types';

const db = env.DB;
let seed: Awaited<ReturnType<typeof seedTestData>>;

const ORDER = '1650438';

interface Line { product_name: string; product_code?: string; quantity?: number; lot_number?: string }

function output(lines: Line[], po = 'PO-70017'): ConnectorOutput {
  return {
    orders: [{ order_number: ORDER, po_number: po, customer_number: 'P00417', customer_name: 'Zebrafinch Bakery', items: lines, source_data: {} }],
    customers: [{ customer_number: 'P00417', name: 'Zebrafinch Bakery' }],
    errors: [],
    info: [],
  } as unknown as ConnectorOutput;
}

const ingest = (lines: Line[], po?: string) =>
  ingestOrders(db, output(lines, po), { tenantId: seed.tenantId, connectorId: null, connectorRunId: null });

async function lines() {
  const res = await db
    .prepare(
      `SELECT oi.id, oi.product_name, oi.product_code, oi.quantity, oi.lot_number, oi.coa_document_id, oi.picked_by, oi.coa_match_status
         FROM order_items oi JOIN orders o ON o.id = oi.order_id
        WHERE o.tenant_id = ? AND o.order_number = ? ORDER BY oi.product_code, oi.lot_number`,
    )
    .bind(seed.tenantId, ORDER)
    .all<any>();
  return res.results ?? [];
}

async function makeDocument(): Promise<string> {
  const id = `doc-${generateTestId()}`;
  await db
    .prepare(
      `INSERT INTO documents (id, tenant_id, title, tags, current_version, status, created_by)
       VALUES (?, ?, 'COA', '[]', 1, 'active', ?)`,
    )
    .bind(id, seed.tenantId, seed.orgAdminId)
    .run();
  return id;
}

async function suggest(itemId: string, documentId: string, status: 'pending' | 'accepted' | 'rejected', basis = 'lot_exact') {
  await db
    .prepare(
      `INSERT INTO lot_match_suggestions (id, tenant_id, order_item_id, document_id, match_basis, match_confidence, status)
       VALUES (?, ?, ?, ?, ?, 0.9, ?)`,
    )
    .bind(`lms-${generateTestId()}`, seed.tenantId, itemId, documentId, basis, status)
    .run();
}

/** What a person's pick writes (functions/lib/order-items.ts): the certificate, who, when, and an accepted 'manual_pick' row. */
async function pick(itemId: string, documentId: string) {
  await db
    .prepare(
      `UPDATE order_items SET coa_document_id = ?, lot_matched = 1, coa_match_status = 'matched',
              coa_matched_at = datetime('now'), picked_by = ?, picked_at = datetime('now') WHERE id = ?`,
    )
    .bind(documentId, seed.orgAdminId, itemId)
    .run();
  await suggest(itemId, documentId, 'accepted', 'manual_pick');
}

const BUTTER: Line = { product_name: 'BUTTER BULK', product_code: '4410', quantity: 10, lot_number: 'L-100' };
const CREAM: Line = { product_name: 'HEAVY CREAM', product_code: '5520', quantity: 4, lot_number: 'L-200' };
const MILK: Line = { product_name: 'WHOLE MILK', product_code: '6630', quantity: 7, lot_number: 'L-300' };

beforeAll(async () => {
  await runMigrations(db);
}, 30_000);

beforeEach(async () => {
  await cleanTables(db);
  seed = await seedTestData(db);
});

describe('an order nobody touched re-ingests exactly as before', () => {
  it('replaces the line set with the connector\'s, with no note', async () => {
    await ingest([BUTTER, CREAM]);
    const before = await lines();
    expect(before.map((l) => l.product_code)).toEqual(['4410', '5520']);

    const result = await ingest([{ ...BUTTER, quantity: 12 }, MILK], 'PO-70018');

    expect(result.errors).toBe(0);
    expect(result.notes).toEqual([]);
    const after = await lines();
    expect(after.map((l) => [l.product_code, l.quantity, l.lot_number])).toEqual([['4410', 12, 'L-100'], ['6630', 7, 'L-300']]);
    // The old path: every line is a fresh row.
    expect(after.map((l) => l.id).some((id) => before.map((l) => l.id).includes(id))).toBe(false);
    const order = await db.prepare('SELECT po_number FROM orders WHERE tenant_id = ? AND order_number = ?').bind(seed.tenantId, ORDER).first<any>();
    expect(order.po_number).toBe('PO-70018');
  });

  it('an order with no lines in the new file keeps the lines it had (unchanged rule)', async () => {
    await ingest([BUTTER]);
    const result = await ingest([]);
    expect(result.errors).toBe(0);
    expect((await lines()).map((l) => l.product_code)).toEqual(['4410']);
  });
});

describe('a line a person picked a certificate for', () => {
  it('survives the re-ingest untouched while the header updates, a new line is added and a stale one is removed', async () => {
    await ingest([BUTTER, CREAM]);
    const [butter, cream] = await lines();
    const coa = await makeDocument();
    await pick(butter.id, coa);

    // The connector now says: butter (a different quantity), milk (new); cream is gone.
    const result = await ingest([{ ...BUTTER, quantity: 99 }, MILK], 'PO-70018');

    expect(result.errorMessages).toEqual([]);
    expect(result.errors).toBe(0);
    const after = await lines();
    expect(after.map((l) => l.product_code)).toEqual(['4410', '6630']);

    // The picked line: same row, same certificate, same picker, and NOT overwritten.
    const kept = after.find((l) => l.product_code === '4410');
    expect(kept).toMatchObject({ id: butter.id, coa_document_id: coa, picked_by: seed.orgAdminId, coa_match_status: 'matched', quantity: 10 });
    const sugg = await db.prepare(`SELECT status, match_basis FROM lot_match_suggestions WHERE order_item_id = ?`).bind(butter.id).first<any>();
    expect(sugg).toEqual({ status: 'accepted', match_basis: 'manual_pick' });

    // The stale line nobody decided is gone; the header moved.
    expect(after.find((l) => l.id === cream.id)).toBeUndefined();
    const order = await db.prepare('SELECT po_number FROM orders WHERE tenant_id = ? AND order_number = ?').bind(seed.tenantId, ORDER).first<any>();
    expect(order.po_number).toBe('PO-70018');

    // ...and the run says what it did, in words.
    expect(result.notes).toHaveLength(1);
    expect(result.notes[0]).toBe(
      `Order ${ORDER}: kept 1 line a person had decided (not changed by this file). The file listed 2 lines: 1 added, 1 removed, 0 updated.`,
    );
  });

  it('is kept even when the connector no longer lists it at all', async () => {
    await ingest([BUTTER, CREAM]);
    const [butter] = await lines();
    await pick(butter.id, await makeDocument());

    const result = await ingest([MILK]);

    expect(result.errors).toBe(0);
    const after = await lines();
    expect(after.map((l) => l.product_code)).toEqual(['4410', '6630']);
    expect(after[0].id).toBe(butter.id);
    expect(result.notes[0]).toContain('kept 1 line a person had decided');
  });

  it('a different LOT of the same product is a different line: the pick stays, the new lot is added beside it', async () => {
    await ingest([BUTTER]);
    const [butter] = await lines();
    await pick(butter.id, await makeDocument());

    await ingest([{ ...BUTTER, lot_number: 'L-101' }]);

    const after = await lines();
    expect(after.map((l) => [l.product_code, l.lot_number, l.picked_by])).toEqual([
      ['4410', 'L-100', seed.orgAdminId],
      ['4410', 'L-101', null],
    ]);
  });
});

describe('a line whose engine suggestion a person decided', () => {
  it('an ACCEPTED suggestion: the line and its match are kept, not overwritten', async () => {
    await ingest([BUTTER, CREAM]);
    const [butter] = await lines();
    const coa = await makeDocument();
    await db.prepare(`UPDATE order_items SET coa_document_id = ?, lot_matched = 1, coa_match_status = 'matched' WHERE id = ?`).bind(coa, butter.id).run();
    await suggest(butter.id, coa, 'accepted');

    const result = await ingest([{ ...BUTTER, quantity: 99 }, CREAM]);

    expect(result.errors).toBe(0);
    const kept = (await lines()).find((l) => l.id === butter.id);
    expect(kept).toMatchObject({ coa_document_id: coa, coa_match_status: 'matched', quantity: 10 });
    expect(result.notes[0]).toContain('kept 1 line a person had decided');
  });

  it('a REJECTED suggestion is a decision too: the line and the rejection survive', async () => {
    await ingest([BUTTER]);
    const [butter] = await lines();
    const coa = await makeDocument();
    await suggest(butter.id, coa, 'rejected');

    const result = await ingest([MILK]);

    expect(result.errors).toBe(0);
    expect((await lines()).map((l) => l.id)).toContain(butter.id);
    const sugg = await db.prepare(`SELECT status FROM lot_match_suggestions WHERE order_item_id = ?`).bind(butter.id).first<any>();
    expect(sugg.status).toBe('rejected');
  });
});

describe('a line that only has a PENDING suggestion (the matcher\'s own, nobody decided)', () => {
  it('no longer fails the re-ingest: a line still listed keeps its id and its suggestion and takes the new values', async () => {
    await ingest([BUTTER, CREAM]);
    const [butter, cream] = await lines();
    const coa = await makeDocument();
    await suggest(butter.id, coa, 'pending');
    await suggest(cream.id, coa, 'pending');

    const result = await ingest([{ ...BUTTER, quantity: 12 }, MILK]);

    expect(result.errorMessages).toEqual([]);
    const after = await lines();
    expect(after.map((l) => l.product_code)).toEqual(['4410', '6630']);
    expect(after[0]).toMatchObject({ id: butter.id, quantity: 12 });
    const kept = await db.prepare(`SELECT COUNT(*) AS n FROM lot_match_suggestions WHERE order_item_id = ?`).bind(butter.id).first<{ n: number }>();
    expect(kept!.n).toBe(1);
    // The line the file dropped is removed with its undecided suggestion.
    const gone = await db.prepare(`SELECT COUNT(*) AS n FROM lot_match_suggestions WHERE order_item_id = ?`).bind(cream.id).first<{ n: number }>();
    expect(gone!.n).toBe(0);
    // Nobody had decided anything, so there is nothing to announce.
    expect(result.notes).toEqual([]);
  });
});

describe('through the Review Queue: the approval says what it kept', () => {
  it('puts the note in the response, the audit row and the connector run', async () => {
    const { onRequestPut: approveQueueItem } = await import('../../functions/api/queue/[id]');
    await ingest([BUTTER, CREAM]);
    const [butter] = await lines();
    await pick(butter.id, await makeDocument());

    const connectorId = generateTestId();
    await db
      .prepare(`INSERT INTO connectors (id, tenant_id, name, slug, output_kind, active) VALUES (?, ?, 'WMS Feed', ?, 'order', 1)`)
      .bind(connectorId, seed.tenantId, `wms-${connectorId.slice(0, 8)}`)
      .run();
    const runId = generateTestId();
    await db.prepare(`INSERT INTO connector_runs (id, connector_id, tenant_id, status) VALUES (?, ?, ?, 'running')`).bind(runId, connectorId, seed.tenantId).run();
    const queueId = generateTestId();
    await db
      .prepare(
        `INSERT INTO processing_queue
           (id, tenant_id, file_r2_key, file_name, file_size, mime_type, processing_status, status, created_by, output_kind, source_id, connector_run_id)
         VALUES (?, ?, ?, 'orders.csv', 12, 'text/csv', 'ready', 'pending', ?, 'order', ?, ?)`,
      )
      .bind(queueId, seed.tenantId, `queue/${queueId}/orders.csv`, seed.userId, connectorId, runId)
      .run();

    const res = await approveQueueItem({
      request: new Request(`http://localhost/api/queue/${queueId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'approved', records: { customers: [], orders: [{ order_number: ORDER, items: [MILK], source_data: {} }] } }),
      }),
      env, data: { user: { id: seed.orgAdminId, role: 'org_admin', tenant_id: seed.tenantId } }, params: { id: queueId },
      waitUntil: () => {}, passThroughOnException: () => {}, next: async () => new Response(null), functionPath: `/api/queue/${queueId}`,
    } as any);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    const note = `Order ${ORDER}: kept 1 line a person had decided (not changed by this file). The file listed 1 line: 1 added, 1 removed, 0 updated.`;
    expect(body.notes).toEqual([note]);

    const audit = await db
      .prepare(`SELECT details FROM audit_log WHERE action = 'queue_item.approved' AND resource_id = ?`)
      .bind(queueId)
      .first<{ details: string }>();
    expect(JSON.parse(audit!.details).notes).toEqual([note]);
    const run = await db.prepare(`SELECT details FROM connector_runs WHERE id = ?`).bind(runId).first<{ details: string }>();
    expect(JSON.parse(run!.details).notes).toEqual([note]);

    // The pick is still there.
    expect((await lines()).find((l) => l.id === butter.id)?.picked_by).toBe(seed.orgAdminId);
  });
});
