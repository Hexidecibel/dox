/**
 * Linkage rule registry (Phase P4).
 *
 * A THIN, declarative orchestration layer over `matching.ts`. The actual
 * matching SQL — strong/weak classification, applyStrongLink, recordSuggestion
 * — lives in `matching.ts` and stays the single source of truth. This module
 * exists so that *adding a new cross-document linkage* later is additive: you
 * append a rule entry to LINKAGE_RULES, you don't edit the producers
 * (shipment.ts / coa.ts / order.ts) that drive linkage.
 *
 * The lot is the join key. Both directions of the order↔COA linkage are keyed
 * on `lots.lot_key`, so the registry dispatches by the entity that just landed
 * (`onEntity: 'lot'`) and lets each rule decide which matcher to invoke based
 * on what the caller supplied (an order_item just got a lot → linkOrderToCoas;
 * a COA document just got a lot → linkCoaToOrders).
 */

import type { D1Database } from '@cloudflare/workers-types';
import { linkOrderToCoas, linkCoaToOrders } from './matching';

/**
 * Context passed to a lot-keyed linkage rule. All ids beyond `lotId` are
 * optional — a rule inspects which ones are present to decide whether (and
 * how) it applies. e.g. `orderItemId` present ⇒ an order line just gained a
 * lot; `documentId` present ⇒ a COA just gained a lot.
 */
export interface LotLinkageContext {
  lotId: string;
  orderItemId?: string | null;
  documentId?: string | null;
  productId?: string | null;
  supplierId?: string | null;
}

export interface LinkageRule {
  /** Human-readable rule name (shows up in logs / docs). */
  name: string;
  /** The entity whose arrival triggers this rule. Currently only 'lot'. */
  onEntity: 'lot';
  /**
   * When does this rule fire for a given context? Keeps `apply` focused —
   * the dispatcher skips rules whose `when` returns false.
   */
  when: (ctx: LotLinkageContext) => boolean;
  /** Run the underlying matcher(s). Best-effort; may throw (caller guards). */
  apply: (db: D1Database, tenantId: string, ctx: LotLinkageContext) => Promise<void>;
}

/**
 * The declarative rule set. To add a new linkage later, append an entry here
 * — do NOT edit the producers.
 *
 * NOTE: product↔supplier provenance is already established inside
 * `findOrCreateProduct` (it upserts `product_suppliers`). It is documented
 * here as a rule-in-spirit (it's not lot-keyed, so it doesn't dispatch through
 * this registry) to keep the full linkage map discoverable in one place.
 */
export const LINKAGE_RULES: LinkageRule[] = [
  {
    name: 'order_item→coa (by lot)',
    onEntity: 'lot',
    // An order line just resolved to a lot: find COAs certifying that lot.
    when: (ctx) => !!ctx.orderItemId,
    apply: (db, tenantId, ctx) =>
      linkOrderToCoas(db, tenantId, {
        orderItemId: ctx.orderItemId!,
        lotId: ctx.lotId,
        productId: ctx.productId ?? null,
      }),
  },
  {
    name: 'coa→order_item (by lot)',
    onEntity: 'lot',
    // A COA document just resolved to a lot: find order lines for that lot.
    when: (ctx) => !!ctx.documentId,
    apply: (db, tenantId, ctx) =>
      linkCoaToOrders(db, tenantId, {
        documentId: ctx.documentId!,
        lotId: ctx.lotId,
        productId: ctx.productId ?? null,
        supplierId: ctx.supplierId ?? null,
      }),
  },
  // product↔supplier provenance: handled in findOrCreateProduct
  // (product_suppliers upsert). Not lot-keyed; listed for documentation only.
];

/**
 * Dispatch every lot-keyed linkage rule whose `when` matches the given
 * context. Each rule is wrapped so one matcher hiccup never blocks the others
 * (mirrors the best-effort policy the producers already follow). This is the
 * single entry point producers call after resolving a lot.
 */
export async function runLinkageForLot(
  db: D1Database,
  tenantId: string,
  ctx: LotLinkageContext
): Promise<void> {
  for (const rule of LINKAGE_RULES) {
    if (rule.onEntity !== 'lot') continue;
    if (!rule.when(ctx)) continue;
    try {
      await rule.apply(db, tenantId, ctx);
    } catch (err) {
      console.warn(
        `[linkage] rule "${rule.name}" failed for lot ${ctx.lotId}:`,
        err instanceof Error ? err.message : String(err)
      );
    }
  }
}
