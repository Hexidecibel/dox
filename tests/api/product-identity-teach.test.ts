/**
 * Review-time teach writes PRODUCT IDENTIFIERS (migration 0113 retired
 * supplier_product_map). A reviewer mapping a certificate record to one of our
 * products at approval writes a confirmed supplier_name identifier, the
 * record's supplier item number, and the picked product's order code — each
 * audited — and the record is re-matched so the teach counts for this approval.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { runMigrations, seedTestData, cleanTables, generateTestId } from '../helpers/db';
import { onRequestPut as updateQueueItem } from '../../functions/api/queue/[id]';
import { findOrCreateLot } from '../../functions/lib/entities/lots';
import { insertProductIdentifier } from '../../functions/lib/product-identifiers';
import type { CoaRecordsPayload } from '../../shared/types';

const db = env.DB;
const files = env.FILES;
let seed: Awaited<ReturnType<typeof seedTestData>>;

beforeEach(async () => {
  await runMigrations(db);
  await cleanTables(db);
  seed = await seedTestData(db);
}, 30_000);

async function makeSupplier(name: string): Promise<string> {
  const id = generateTestId();
  await db.prepare('INSERT INTO suppliers (id, tenant_id, name, slug) VALUES (?, ?, ?, ?)')
    .bind(id, seed.tenantId, name, `s-${id.slice(0, 8)}`).run();
  return id;
}

async function makeProduct(name: string): Promise<string> {
  const id = generateTestId();
  await db.prepare('INSERT INTO products (id, tenant_id, name, slug, active) VALUES (?, ?, ?, ?, 1)')
    .bind(id, seed.tenantId, name, `p-${id.slice(0, 8)}`).run();
  return id;
}

async function makeQueueItem(payload: CoaRecordsPayload): Promise<string> {
  const id = generateTestId();
  const r2Key = `pending/${id}.pdf`;
  await files.put(r2Key, new TextEncoder().encode('%PDF-1.4 fake coa'), { httpMetadata: { contentType: 'application/pdf' } });
  await db
    .prepare(
      `INSERT INTO processing_queue
         (id, tenant_id, document_type_id, file_r2_key, file_name, file_size, mime_type,
          ai_records, processing_status, output_kind, status, created_by, created_at)
       VALUES (?, ?, NULL, ?, ?, 17, 'application/pdf', ?, 'ready', 'coa', 'pending', ?, datetime('now'))`,
    )
    .bind(id, seed.tenantId, r2Key, `${id}.pdf`, JSON.stringify(payload), seed.userId)
    .run();
  return id;
}

function ctx(queueId: string, body: unknown): any {
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

const CREAM = 'Cream - Heavy Whipping 40%';

function payload(): CoaRecordsPayload {
  return {
    record_cardinality: 'multi_lot',
    record_key_basis: 'lot',
    page_metadata: { manufacturer: 'Country Morning Farms' },
    records: [
      { record_index: 0, fields: { lot_code: '061626', product_name: CREAM, product_code: '50903' } },
      { record_index: 1, fields: { lot_code: '061627', product_name: CREAM, product_code: '30904' } },
      { record_index: 2, fields: { lot_code: '061628', product_name: 'Milk - Whole', product_code: '50900' } },
    ],
  } as CoaRecordsPayload;
}

describe('COA approve: product_maps teach writes identifiers', () => {
  it('writes confirmed supplier_name + supplier_item + our_sku, audits each, skips a number confirmed elsewhere, ignores held records, and re-matches', async () => {
    const supplierId = await makeSupplier('Country Morning Farms');
    const tote = await makeProduct('40% CREAM 300GL');
    const bag = await makeProduct('WHIP 5 GL BAG (1/CS), M');
    const whole = await makeProduct('MS WHOLE 5 GL BAG');
    // The tote's item number is already known and confirmed.
    await insertProductIdentifier(db, seed.tenantId, tote, { kind: 'supplier_item', value: '30904', supplier_id: supplierId, confirmed: true, source: 'seed' }, null);

    // The 0801 bag order line on lot 061626, before the certificate arrives.
    const bagLot = await findOrCreateLot(db, seed.tenantId, { lotNumber: '061626', productId: bag });
    const orderId = generateTestId();
    await db.prepare(`INSERT INTO orders (id, tenant_id, order_number, source_data) VALUES (?, ?, '1794420', '{}')`).bind(orderId, seed.tenantId).run();
    const lineId = generateTestId();
    await db.prepare(`INSERT INTO order_items (id, order_id, product_id, product_code, lot_id, lot_number) VALUES (?, ?, ?, '0801', ?, '061626')`)
      .bind(lineId, orderId, bag, bagLot!.id).run();

    const queueId = await makeQueueItem(payload());
    const res = await updateQueueItem(ctx(queueId, {
      status: 'approved',
      supplier_id: supplierId,
      records: payload(),
      record_decisions: { '2': 'hold' },
      product_maps: {
        '0': { coa_product: CREAM, order_product_id: bag, distributor_sku: '0801' },
        // Wrong on purpose: 30904 is the tote's confirmed number.
        '1': { coa_product: CREAM, order_product_id: bag, distributor_sku: '0801' },
        // Held record: must not be taught.
        '2': { coa_product: 'Milk - Whole', order_product_id: whole, distributor_sku: '0417' },
      },
    }));
    expect(res.status).toBe(200);

    const rows = await db
      .prepare('SELECT product_id, kind, value, supplier_id, confirmed, source, created_by, confirmed_by FROM product_identifiers WHERE tenant_id = ? ORDER BY product_id, kind, value')
      .bind(seed.tenantId)
      .all<Record<string, unknown>>();
    const onBag = (rows.results ?? []).filter((r) => r.product_id === bag);
    expect(onBag.map((r) => [r.kind, r.value]).sort()).toEqual([
      ['our_sku', '0801'],
      ['supplier_item', '50903'],
      ['supplier_name', CREAM],
    ]);
    for (const r of onBag) {
      expect(r).toMatchObject({ confirmed: 1, source: 'reviewer', created_by: seed.orgAdminId, confirmed_by: seed.orgAdminId });
    }
    // 30904 was NOT copied onto the bag; the held record taught nothing.
    expect((rows.results ?? []).filter((r) => r.value === '30904').map((r) => r.product_id)).toEqual([tote]);
    expect((rows.results ?? []).some((r) => r.product_id === whole)).toBe(false);

    // No supplier_product_map row is written any more.
    const legacy = await db.prepare('SELECT COUNT(*) AS n FROM supplier_product_map').first<{ n: number }>();
    expect(legacy!.n).toBe(0);

    const audit = await db
      .prepare(`SELECT action, details FROM audit_log WHERE tenant_id = ? AND action LIKE 'product_identifier.%' ORDER BY id`)
      .bind(seed.tenantId)
      .all<{ action: string; details: string }>();
    const added = (audit.results ?? []).filter((a) => a.action === 'product_identifier.added');
    expect(added).toHaveLength(3);
    for (const a of added) expect(JSON.parse(a.details)).toMatchObject({ via: 'review_teach', queue_item_id: queueId });
    const skipped = (audit.results ?? []).filter((a) => a.action === 'product_identifier.teach_skipped');
    expect(skipped).toHaveLength(1);
    expect(JSON.parse(skipped[0].details).skipped[0]).toMatchObject({ kind: 'supplier_item', value: '30904' });

    // The teach counted for THIS approval: record 0's certificate is now a
    // lot+product suggestion on the 0801 line, never a link.
    const sugg = await db
      .prepare('SELECT match_basis, status FROM lot_match_suggestions WHERE order_item_id = ?')
      .bind(lineId)
      .all<{ match_basis: string; status: string }>();
    expect(sugg.results).toEqual([{ match_basis: 'lot+product', status: 'pending' }]);
    const line = await db.prepare('SELECT coa_document_id FROM order_items WHERE id = ?').bind(lineId).first<{ coa_document_id: string | null }>();
    expect(line!.coa_document_id).toBeNull();
  });

  it('confirms an existing unconfirmed identifier instead of duplicating it', async () => {
    const supplierId = await makeSupplier('Country Morning Farms');
    const bag = await makeProduct('WHIP 5 GL BAG (1/CS), M');
    await insertProductIdentifier(db, seed.tenantId, bag, { kind: 'supplier_name', value: CREAM, supplier_id: supplierId, confirmed: false, source: 'extracted' }, null);

    const one: CoaRecordsPayload = { ...payload(), records: [payload().records[0]] };
    const queueId = await makeQueueItem(one);
    const res = await updateQueueItem(ctx(queueId, {
      status: 'approved',
      supplier_id: supplierId,
      records: one,
      product_maps: { '0': { coa_product: CREAM, order_product_id: bag } },
    }));
    expect(res.status).toBe(200);

    const names = await db
      .prepare(`SELECT confirmed, source, confirmed_by FROM product_identifiers WHERE product_id = ? AND kind = 'supplier_name'`)
      .bind(bag)
      .all<Record<string, unknown>>();
    expect(names.results).toEqual([{ confirmed: 1, source: 'extracted', confirmed_by: seed.orgAdminId }]);
    const confirmed = await db
      .prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'product_identifier.confirmed' AND tenant_id = ?`)
      .bind(seed.tenantId)
      .first<{ n: number }>();
    expect(confirmed!.n).toBe(1);
  });
});
