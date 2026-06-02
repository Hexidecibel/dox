/**
 * Producer for the `shipment` doc-kind — the WMS hop (Phase P4).
 *
 * A shipment is the binding the warehouse provides: "for order N, product P, we
 * picked lot L". That binding is the missing middle of the cross-document chain:
 *
 *     order line  ──(shipment)──▶  lot  ──(COA)──▶  certificate
 *
 * The connector/order producer writes order lines (often with no lot yet). The
 * COA pipeline writes documents that certify a lot. Neither side knows which
 * physical lot was shipped against a given order line until the WMS says so.
 * `produceShipment` consumes those WMS statements: it finds the order line,
 * resolves/creates the lot, writes `order_items.lot_id`, and then runs the lot
 * matcher so any COA already on file for that lot binds immediately.
 *
 * Out-of-order race: shipments routinely arrive before the order is ingested
 * (the order email and the WMS export are independent intakes). When the order
 * line isn't found yet, the shipment is recorded as `unmatched` — NOT an error.
 * The matcher is idempotent and lot-keyed, so when the order (or the COA) lands
 * later it will bind on its own pass. We never throw on a missing order.
 *
 * Idempotent: re-running the same shipment resolves to the same lot row
 * (findOrCreateLot collapses by normalized key) and the same UPDATE/match, so
 * no duplicates and no double-binding.
 *
 * Matching is NOT reimplemented here — it reuses entities/{lots,linkage}.ts.
 */

import type { D1Database } from '@cloudflare/workers-types';
import type { ParsedShipment } from '../../../shared/connectorOutput';
import { findOrCreateLot } from '../entities/lots';
import { runLinkageForLot } from '../entities/linkage';

export interface ProduceShipmentContext {
  tenantId: string;
  sourceId?: string | null;
  connectorRunId?: string | null;
}

export interface ProduceShipmentResult {
  /** Shipments that bound a lot onto an existing order line. */
  bound: number;
  /** Shipments whose lot match produced a weak suggestion (no auto-bind). */
  suggested: number;
  /** Shipments whose order line wasn't found yet (out-of-order race). */
  unmatched: number;
  /** Hard errors (DB failures, etc.). */
  errors: number;
}

interface OrderItemRow {
  id: string;
  order_id: string;
  product_id: string | null;
  product_code: string | null;
  product_name: string | null;
  lot_id: string | null;
}

/**
 * Resolve the single best order_item for a shipment line.
 *
 * Join key: order_number + (product_code OR product_name). If multiple lines
 * match (e.g. same product on the order twice), prefer an exact product_code
 * hit; otherwise take the first. Returns null when nothing matches — the order
 * isn't ingested yet (the out-of-order race).
 */
async function resolveOrderItem(
  db: D1Database,
  tenantId: string,
  ship: ParsedShipment
): Promise<OrderItemRow | null> {
  const productCode = ship.product_code ?? null;
  const productName = ship.product_name ?? null;

  const rows = await db
    .prepare(
      `SELECT oi.id, oi.order_id, oi.product_id, oi.product_code, oi.product_name, oi.lot_id
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       WHERE o.tenant_id = ?
         AND o.order_number = ?
         AND (
           (? IS NOT NULL AND oi.product_code = ?)
           OR (? IS NOT NULL AND LOWER(oi.product_name) = LOWER(?))
         )`
    )
    .bind(
      tenantId,
      ship.order_number,
      productCode,
      productCode,
      productName,
      productName
    )
    .all<OrderItemRow>();

  const candidates = rows.results ?? [];
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  // Multiple matches: prefer the exact product_code hit.
  if (productCode) {
    const byCode = candidates.find((c) => c.product_code === productCode);
    if (byCode) return byCode;
  }
  return candidates[0];
}

/**
 * Process a batch of WMS shipment lines. See module header for the contract.
 */
export async function produceShipment(
  db: D1Database,
  shipments: ParsedShipment[],
  ctx: ProduceShipmentContext
): Promise<ProduceShipmentResult> {
  const { tenantId } = ctx;
  let bound = 0;
  let suggested = 0;
  let unmatched = 0;
  let errors = 0;

  for (const ship of shipments) {
    try {
      if (!ship.order_number || !ship.lot_number) {
        // Can't bind without both an order ref and a lot. Treat as unmatched
        // rather than an error — a malformed WMS row shouldn't fail the batch.
        unmatched++;
        continue;
      }

      // 1. Find the order line this shipment fulfills.
      const orderItem = await resolveOrderItem(db, tenantId, ship);
      if (!orderItem) {
        // Out-of-order race: the order hasn't been ingested yet. Record it and
        // move on — the idempotent matcher will bind later when the order or
        // the COA arrives. Do NOT throw.
        unmatched++;
        continue;
      }

      // 2. Resolve/create the lot the WMS says was shipped. Keyed by
      //    (tenant, product, normalized lot key) so re-runs collapse.
      const lot = await findOrCreateLot(db, tenantId, {
        lotNumber: ship.lot_number,
        productId: orderItem.product_id,
        source: 'shipment',
      });
      if (!lot) {
        // lot_number normalized to empty — nothing to bind.
        unmatched++;
        continue;
      }

      // 3. Write the WMS binding onto the order line. Idempotent: re-running
      //    sets the same lot_id. We do NOT clobber a coa_document_id here —
      //    the matcher in step 4 owns strong-link writes.
      await db
        .prepare(`UPDATE order_items SET lot_id = ? WHERE id = ?`)
        .bind(lot.id, orderItem.id)
        .run();

      // 4. Run the lot-keyed linkage rules. With orderItemId set, this
      //    dispatches order_item→COA matching: a strong match writes
      //    coa_document_id onto the line; a weak match records a suggestion.
      await runLinkageForLot(db, tenantId, {
        lotId: lot.id,
        orderItemId: orderItem.id,
        productId: orderItem.product_id,
      });

      // 5. Tally the outcome by reading back the order line's match state.
      const after = await db
        .prepare(
          `SELECT coa_document_id, coa_match_status FROM order_items WHERE id = ?`
        )
        .bind(orderItem.id)
        .first<{ coa_document_id: string | null; coa_match_status: string | null }>();

      if (after?.coa_document_id) {
        bound++;
      } else {
        // No strong link. If a pending suggestion now exists for this line,
        // count it as suggested; otherwise the lot bound but no COA is on file.
        const sugg = await db
          .prepare(
            `SELECT 1 FROM lot_match_suggestions
             WHERE tenant_id = ? AND order_item_id = ? AND status = 'pending'
             LIMIT 1`
          )
          .bind(tenantId, orderItem.id)
          .first<{ 1: number }>();
        if (sugg) suggested++;
        // (lot bound, no COA yet) is a successful no-op — not counted as bound
        // or unmatched; the COA will bind when it arrives.
      }
    } catch (err) {
      console.warn(
        `[shipment] produceShipment failed for order ${ship.order_number} / lot ${ship.lot_number}:`,
        err instanceof Error ? err.message : String(err)
      );
      errors++;
    }
  }

  return { bound, suggested, unmatched, errors };
}
