/**
 * Phase P4: produceShipment (the WMS hop).
 *
 *   - Binds order_item.lot_id and sets coa_document_id when a COA already
 *     certifies the shipped lot (strong match: product agrees).
 *   - Records `unmatched` (no throw) when the order isn't ingested yet —
 *     the out-of-order race.
 *   - Idempotent on re-run.
 *   - Weak match (product disagrees) → suggestion, not a strong bind.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { seedTestData, generateTestId } from '../helpers/db';
import { produceShipment } from '../../functions/lib/kinds/shipment';
import { findOrCreateProduct } from '../../functions/lib/entities/products';
import { findOrCreateLot } from '../../functions/lib/entities/lots';
import { attachLotToCoaDocument } from '../../functions/lib/entities/matching';

let seed: Awaited<ReturnType<typeof seedTestData>>;
const db = env.DB;

beforeAll(async () => {
  seed = await seedTestData(db);
}, 30_000);

async function seedOrderWithItem(
  tenantId: string,
  orderNumber: string,
  item: { product_name: string; product_code: string; product_id: string | null }
): Promise<{ orderId: string; itemId: string }> {
  const orderId = generateTestId();
  await db
    .prepare(`INSERT INTO orders (id, tenant_id, order_number, source_data) VALUES (?, ?, ?, '{}')`)
    .bind(orderId, tenantId, orderNumber)
    .run();
  const itemId = generateTestId();
  await db
    .prepare(
      `INSERT INTO order_items (id, order_id, product_id, product_name, product_code)
       VALUES (?, ?, ?, ?, ?)`
    )
    .bind(itemId, orderId, item.product_id, item.product_name, item.product_code)
    .run();
  return { orderId, itemId };
}

async function seedCoaDocumentForLot(
  tenantId: string,
  lotNumber: string,
  productId: string | null
): Promise<string> {
  const docId = generateTestId();
  await db
    .prepare(
      `INSERT INTO documents (id, tenant_id, title, created_by)
       VALUES (?, ?, 'COA', ?)`
    )
    .bind(docId, tenantId, seed.userId)
    .run();
  // Attach the lot to the COA document (creates lot + document_lots, runs matcher).
  await attachLotToCoaDocument(db, tenantId, {
    documentId: docId,
    lotNumber,
    productId,
    supplierId: null,
    source: 'coa',
  });
  return docId;
}

describe('produceShipment — WMS hop', () => {
  it('binds order_item.lot_id and sets coa_document_id when a matching COA lot exists', async () => {
    const tenantId = seed.tenantId;
    const product = await findOrCreateProduct(db, tenantId, 'Ascorbic Acid');

    // COA already on file for lot AA-1 / this product.
    const coaDocId = await seedCoaDocumentForLot(tenantId, 'AA-1', product.id);

    // Order line for the same product, no lot yet.
    const { itemId } = await seedOrderWithItem(tenantId, 'ORD-BIND', {
      product_name: 'Ascorbic Acid',
      product_code: 'AA',
      product_id: product.id,
    });

    const result = await produceShipment(
      db,
      [{ order_number: 'ORD-BIND', product_code: 'AA', lot_number: 'AA-1', quantity: 3 }],
      { tenantId }
    );

    expect(result.bound).toBe(1);
    expect(result.unmatched).toBe(0);
    expect(result.errors).toBe(0);

    const item = await db
      .prepare('SELECT lot_id, coa_document_id, coa_match_status FROM order_items WHERE id = ?')
      .bind(itemId)
      .first<{ lot_id: string | null; coa_document_id: string | null; coa_match_status: string }>();
    expect(item!.lot_id).not.toBeNull();
    expect(item!.coa_document_id).toBe(coaDocId);
    expect(item!.coa_match_status).toBe('matched');
  });

  it('records unmatched (no throw) when the order is not ingested yet', async () => {
    const tenantId = seed.tenantId;

    const result = await produceShipment(
      db,
      [{ order_number: 'ORD-DOES-NOT-EXIST', product_code: 'ZZ', lot_number: 'ZZ-9' }],
      { tenantId }
    );

    expect(result.unmatched).toBe(1);
    expect(result.bound).toBe(0);
    expect(result.errors).toBe(0);
  });

  it('is idempotent on re-run (same lot, no duplicate binding)', async () => {
    const tenantId = seed.tenantId;
    const product = await findOrCreateProduct(db, tenantId, 'Sodium Citrate');
    const coaDocId = await seedCoaDocumentForLot(tenantId, 'SC-2', product.id);
    const { itemId } = await seedOrderWithItem(tenantId, 'ORD-IDEM', {
      product_name: 'Sodium Citrate',
      product_code: 'SC',
      product_id: product.id,
    });

    const ship = { order_number: 'ORD-IDEM', product_code: 'SC', lot_number: 'SC-2' };

    const r1 = await produceShipment(db, [ship], { tenantId });
    expect(r1.bound).toBe(1);
    const lotIdAfter1 = (
      await db.prepare('SELECT lot_id FROM order_items WHERE id = ?').bind(itemId).first<{ lot_id: string }>()
    )!.lot_id;

    const r2 = await produceShipment(db, [ship], { tenantId });
    expect(r2.bound).toBe(1); // still binds (same strong match), no error
    const lotIdAfter2 = (
      await db.prepare('SELECT lot_id FROM order_items WHERE id = ?').bind(itemId).first<{ lot_id: string }>()
    )!.lot_id;
    expect(lotIdAfter2).toBe(lotIdAfter1);

    // Exactly one lot row for this key, and one document_lots edge.
    const lots = await db
      .prepare('SELECT COUNT(*) AS n FROM lots WHERE tenant_id = ? AND lot_key = ?')
      .bind(tenantId, 'SC2')
      .first<{ n: number }>();
    expect(lots!.n).toBe(1);
    const edges = await db
      .prepare('SELECT COUNT(*) AS n FROM document_lots WHERE document_id = ?')
      .bind(coaDocId)
      .first<{ n: number }>();
    expect(edges!.n).toBe(1);
  });

  it('weak match (product disagrees) → suggestion, not a strong bind', async () => {
    const tenantId = seed.tenantId;
    const coaProduct = await findOrCreateProduct(db, tenantId, 'Product Alpha');
    const orderProduct = await findOrCreateProduct(db, tenantId, 'Product Beta');

    // COA lot belongs to Product Alpha.
    await seedCoaDocumentForLot(tenantId, 'WK-3', coaProduct.id);

    // Order line is for Product Beta — same lot number, different product.
    const { itemId } = await seedOrderWithItem(tenantId, 'ORD-WEAK', {
      product_name: 'Product Beta',
      product_code: 'PB',
      product_id: orderProduct.id,
    });

    const result = await produceShipment(
      db,
      [{ order_number: 'ORD-WEAK', product_code: 'PB', lot_number: 'WK-3' }],
      { tenantId }
    );

    expect(result.bound).toBe(0);
    expect(result.suggested).toBe(1);

    const item = await db
      .prepare('SELECT lot_id, coa_document_id FROM order_items WHERE id = ?')
      .bind(itemId)
      .first<{ lot_id: string | null; coa_document_id: string | null }>();
    // Lot bound (WMS provided it) but COA NOT auto-linked (weak).
    expect(item!.lot_id).not.toBeNull();
    expect(item!.coa_document_id).toBeNull();

    const sugg = await db
      .prepare(
        `SELECT match_basis FROM lot_match_suggestions
         WHERE tenant_id = ? AND order_item_id = ? AND status = 'pending'`
      )
      .bind(tenantId, itemId)
      .first<{ match_basis: string }>();
    expect(sugg).not.toBeNull();
    expect(sugg!.match_basis).toBe('lot_only');
  });
});
