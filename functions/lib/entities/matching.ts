/**
 * Lot-based matching engine (Phase 2 entity graph).
 *
 * The lot is the join key between the two halves of the system. This module
 * links order lines (order_items, written by connectors) to COA documents
 * (written by smart-upload / ingest) by their normalized lot key.
 *
 * Policy (decided in the Phase 2 design):
 *   - STRONG match (basis includes product) → AUTO-LINK: write the COA ref
 *     onto the order_item row.
 *   - WEAK match (lot number only, ambiguous because product/supplier disagree
 *     or are unknown) → SUGGEST: write a lot_match_suggestions row for human
 *     review; do NOT auto-link.
 *
 * Supplier is often unknown on the order side — that's acceptable. The COA side
 * supplies it. Supplier therefore only ever UPGRADES confidence; it never
 * blocks a match.
 *
 * Both entry points (`linkCoaToOrders` and `linkOrderToCoas`) are keyed on
 * `lots.lot_key`. Callers wrap these in try/catch so a matching hiccup never
 * blocks ingestion.
 */

import type { D1Database } from '@cloudflare/workers-types';
import { generateId } from '../db';
import { findOrCreateLot, normalizeLotNumber } from './lots';

// Confidence thresholds. "Strong" requires the product OR the distributor code
// to agree (basis includes product or code). "Weak" is lot_only.
export const CONFIDENCE_LOT_PRODUCT_SUPPLIER = 0.95;
export const CONFIDENCE_LOT_PRODUCT = 0.85;
// Distributor-code agreement (leading parenthesized title prefix === order
// product_code). The SKU is the reliable cross-side key even when product
// names — and thus product_ids — diverge.
export const CONFIDENCE_LOT_CODE = 0.9;
export const CONFIDENCE_LOT_ONLY = 0.5;

export type MatchBasis =
  | 'lot+product+supplier'
  | 'lot+product'
  | 'lot+code'
  | 'lot_only';

export interface MatchClassification {
  basis: MatchBasis;
  confidence: number;
  strong: boolean;
}

/**
 * Normalize a distributor code for comparison: trim + uppercase. Empty → null.
 */
function normalizeCode(c: string | null | undefined): string | null {
  if (c == null) return null;
  const s = String(c).trim().toUpperCase();
  return s === '' ? null : s;
}

/**
 * Extract the distributor code from a COA document title: the leading
 * parenthesized prefix, e.g.
 *   "(1167) 76187-29125 CF LIQ WHOLE EGG 2-20# LOT 6141 07-02-26" → "1167".
 * Returns the trimmed inner code, or null when the title has no such prefix.
 *
 * NOTE: this is the DISTRIBUTOR SKU, deliberately NOT the COA's extracted
 * `product_code` field (which is the manufacturer code like "76187-29125-00").
 */
export function parseDistributorCode(
  title: string | null | undefined
): string | null {
  if (title == null) return null;
  const m = /^\s*\(([0-9A-Za-z][0-9A-Za-z\-]*)\)/.exec(String(title));
  if (!m) return null;
  const code = m[1].trim();
  return code === '' ? null : code;
}

/**
 * Two distributor codes agree when their normalized forms are equal, with a
 * leading-zero-stripped fallback so "0708" and "708" still match.
 */
function codesAgree(
  a: string | null | undefined,
  b: string | null | undefined
): boolean {
  const na = normalizeCode(a);
  const nb = normalizeCode(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const stripZeros = (s: string) => s.replace(/^0+/, '') || '0';
  return stripZeros(na) === stripZeros(nb);
}

/**
 * Classify a candidate pairing into a match basis + confidence.
 *
 * A match is STRONG when the two sides agree on EITHER the product (resolved
 * product_id) OR the distributor code (order product_code vs the COA title's
 * leading parenthesized SKU). Product names diverge across the two halves of
 * the system, so the distributor SKU is the reliable join; code agreement
 * alone is enough to auto-link. Supplier agreement (when both are known) bumps
 * confidence but is never required.
 *
 * `coaSupplierId`/`orderSupplierId` may be null (unknown). An unknown supplier
 * does not contradict; it simply can't reach the supplier-confirmed tier.
 */
export function classifyMatch(args: {
  coaProductId: string | null;
  orderProductId: string | null;
  coaSupplierId: string | null;
  orderSupplierId: string | null;
  coaProductCode?: string | null;
  orderProductCode?: string | null;
}): MatchClassification {
  const {
    coaProductId,
    orderProductId,
    coaSupplierId,
    orderSupplierId,
    coaProductCode,
    orderProductCode,
  } = args;

  const productAgrees =
    !!coaProductId && !!orderProductId && coaProductId === orderProductId;
  const codeAgrees = codesAgree(coaProductCode, orderProductCode);
  const supplierAgrees =
    !!coaSupplierId && !!orderSupplierId && coaSupplierId === orderSupplierId;

  // Product agreement and supplier agreement together is the highest tier.
  if (productAgrees && supplierAgrees) {
    return { basis: 'lot+product+supplier', confidence: CONFIDENCE_LOT_PRODUCT_SUPPLIER, strong: true };
  }
  // Distributor codes agree (product_ids may differ because names diverge).
  // Supplier agreement still upgrades to the supplier-confirmed tier.
  if (codeAgrees && !productAgrees) {
    if (supplierAgrees) {
      return { basis: 'lot+product+supplier', confidence: CONFIDENCE_LOT_PRODUCT_SUPPLIER, strong: true };
    }
    return { basis: 'lot+code', confidence: CONFIDENCE_LOT_CODE, strong: true };
  }
  if (productAgrees) {
    return { basis: 'lot+product', confidence: CONFIDENCE_LOT_PRODUCT, strong: true };
  }
  return { basis: 'lot_only', confidence: CONFIDENCE_LOT_ONLY, strong: false };
}

/**
 * Apply a STRONG match to an order_item: write the COA reference and mark it
 * matched. We only write when the item is not already matched OR the new
 * confidence is strictly higher than what's recorded (an upgrade — e.g. a
 * lot+product+supplier match supersedes a prior lot+product one).
 */
async function applyStrongLink(
  db: D1Database,
  args: {
    orderItemId: string;
    documentId: string;
    lotId: string;
    confidence: number;
  }
): Promise<void> {
  const { orderItemId, documentId, lotId, confidence } = args;
  await db
    .prepare(
      `UPDATE order_items
       SET coa_document_id = ?,
           lot_id = ?,
           lot_matched = 1,
           match_confidence = ?,
           coa_match_status = 'matched',
           coa_matched_at = datetime('now')
       WHERE id = ?
         AND (coa_match_status IS NULL
              OR coa_match_status != 'matched'
              OR match_confidence IS NULL
              OR match_confidence < ?)`
    )
    .bind(documentId, lotId, confidence, orderItemId, confidence)
    .run();
}

/**
 * Record a WEAK match as a pending suggestion. Idempotent via the
 * (order_item_id, document_id) unique index.
 */
async function recordSuggestion(
  db: D1Database,
  args: {
    tenantId: string;
    orderItemId: string;
    documentId: string;
    lotId: string | null;
    confidence: number;
    basis: MatchBasis;
  }
): Promise<void> {
  const { tenantId, orderItemId, documentId, lotId, confidence, basis } = args;
  await db
    .prepare(
      `INSERT OR IGNORE INTO lot_match_suggestions
         (id, tenant_id, order_item_id, document_id, lot_id, match_confidence, match_basis, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`
    )
    .bind(generateId(), tenantId, orderItemId, documentId, lotId, confidence, basis)
    .run();
}

interface OrderItemCandidate {
  id: string;
  order_id: string;
  product_id: string | null;
  product_code: string | null;
  lot_id: string | null;
  lot_number: string | null;
}

/**
 * Called after a COA is approved/ingested with a lot. Finds order_items whose
 * lot matches (by lot_key) and applies the strong/weak policy.
 *
 * Candidates are gathered two ways:
 *   1. order_items already resolved to a lot whose lot_key matches.
 *   2. order_items with a raw lot_number (no lot_id yet) whose normalized key
 *      matches — handled by normalizing in JS and filtering.
 */
export async function linkCoaToOrders(
  db: D1Database,
  tenantId: string,
  args: {
    documentId: string;
    lotId: string;
    productId: string | null;
    supplierId: string | null;
  }
): Promise<void> {
  const { documentId, lotId, productId, supplierId } = args;

  // Resolve the COA lot's key + supplier so we can compare against candidates.
  const lot = await db
    .prepare('SELECT lot_key, supplier_id FROM lots WHERE id = ? AND tenant_id = ?')
    .bind(lotId, tenantId)
    .first<{ lot_key: string; supplier_id: string | null }>();
  if (!lot) return;
  const lotKey = lot.lot_key;
  const coaSupplierId = supplierId ?? lot.supplier_id ?? null;

  // The COA's distributor code lives in the document title's leading
  // parenthesized prefix, e.g. "(1167) ... LOT 6141" → "1167".
  const doc = await db
    .prepare('SELECT title FROM documents WHERE id = ? AND tenant_id = ?')
    .bind(documentId, tenantId)
    .first<{ title: string | null }>();
  const coaProductCode = parseDistributorCode(doc?.title);

  // Candidate order_items in this tenant: either already lot-resolved to the
  // same key, or carrying a raw lot_number we still need to normalize.
  const rows = await db
    .prepare(
      `SELECT oi.id, oi.order_id, oi.product_id, oi.product_code, oi.lot_id, oi.lot_number
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       LEFT JOIN lots l ON l.id = oi.lot_id
       WHERE o.tenant_id = ?
         AND (l.lot_key = ? OR (oi.lot_id IS NULL AND oi.lot_number IS NOT NULL))`
    )
    .bind(tenantId, lotKey)
    .all<OrderItemCandidate>();

  for (const oi of rows.results ?? []) {
    // For the raw-lot_number candidates, confirm the normalized key matches.
    if (!oi.lot_id) {
      if (normalizeLotNumber(oi.lot_number) !== lotKey) continue;
    }

    const cls = classifyMatch({
      coaProductId: productId,
      orderProductId: oi.product_id,
      coaSupplierId,
      orderSupplierId: null, // order side rarely knows the supplier
      coaProductCode,
      orderProductCode: oi.product_code,
    });

    if (cls.strong) {
      await applyStrongLink(db, {
        orderItemId: oi.id,
        documentId,
        lotId,
        confidence: cls.confidence,
      });
    } else {
      await recordSuggestion(db, {
        tenantId,
        orderItemId: oi.id,
        documentId,
        lotId,
        confidence: cls.confidence,
        basis: cls.basis,
      });
    }
  }
}

/**
 * Keys we accept as a lot number from a fields map / metadata blob, in
 * priority order.
 */
const LOT_FIELD_KEYS = ['lot_number', 'lot', 'lot_no', 'lot #', 'lot#'];

/**
 * Pull the first non-empty lot value out of a loose key/value map (approved
 * fields, primary_metadata, per-product fields). Returns null when none found.
 */
export function extractLotNumber(
  source: Record<string, unknown> | null | undefined
): string | null {
  if (!source) return null;
  for (const key of LOT_FIELD_KEYS) {
    // Case-insensitive lookup against the source keys.
    for (const [k, v] of Object.entries(source)) {
      if (k.toLowerCase() === key && v != null && String(v).trim() !== '') {
        return String(v).trim();
      }
    }
  }
  return null;
}

/**
 * High-level COA-side wiring used by both queue-approve and ingest. For a
 * resolved lot number it: findOrCreateLot → links document_lots → runs the
 * matching engine. Best-effort; swallows its own errors so it can never block
 * the surrounding ingest/approve flow.
 *
 * Returns the lot id on success, null when there was no lot or on failure.
 */
export async function attachLotToCoaDocument(
  db: D1Database,
  tenantId: string,
  args: {
    documentId: string;
    lotNumber: string | null | undefined;
    productId: string | null;
    supplierId: string | null;
    codeDate?: string | null;
    expirationDate?: string | null;
    mfgDate?: string | null;
    source?: string;
  }
): Promise<string | null> {
  try {
    const lot = await findOrCreateLot(db, tenantId, {
      lotNumber: args.lotNumber,
      supplierId: args.supplierId,
      productId: args.productId,
      codeDate: args.codeDate ?? null,
      expirationDate: args.expirationDate ?? null,
      mfgDate: args.mfgDate ?? null,
      source: args.source ?? 'coa',
    });
    if (!lot) return null;

    await db
      .prepare(
        `INSERT INTO document_lots (id, document_id, lot_id)
         VALUES (?, ?, ?)
         ON CONFLICT(document_id, lot_id) DO NOTHING`
      )
      .bind(generateId(), args.documentId, lot.id)
      .run();

    await linkCoaToOrders(db, tenantId, {
      documentId: args.documentId,
      lotId: lot.id,
      productId: args.productId,
      supplierId: args.supplierId,
    });

    return lot.id;
  } catch (err) {
    console.warn(
      `[matching] attachLotToCoaDocument failed for doc ${args.documentId}:`,
      err instanceof Error ? err.message : String(err)
    );
    return null;
  }
}

interface CoaCandidate {
  document_id: string;
  lot_id: string;
  product_id: string | null;
  supplier_id: string | null;
  title: string | null;
}

/**
 * Called after a connector creates an order line with a lot. Finds COA
 * documents (via document_lots → lots on matching lot_key) and applies the
 * strong/weak policy, writing onto the SAME order_item row / suggestions table.
 */
export async function linkOrderToCoas(
  db: D1Database,
  tenantId: string,
  args: {
    orderItemId: string;
    lotId: string;
    productId: string | null;
  }
): Promise<void> {
  const { orderItemId, lotId, productId } = args;

  const lot = await db
    .prepare('SELECT lot_key FROM lots WHERE id = ? AND tenant_id = ?')
    .bind(lotId, tenantId)
    .first<{ lot_key: string }>();
  if (!lot) return;
  const lotKey = lot.lot_key;

  // The order line's distributor SKU (already populated by connectors).
  const oiRow = await db
    .prepare('SELECT product_code FROM order_items WHERE id = ?')
    .bind(orderItemId)
    .first<{ product_code: string | null }>();
  const orderProductCode = oiRow?.product_code ?? null;

  // COA documents whose linked lot shares the same key in this tenant. Join
  // documents to read each candidate's title (carries the distributor code).
  const rows = await db
    .prepare(
      `SELECT dl.document_id, l.id AS lot_id, l.product_id, l.supplier_id, d.title
       FROM document_lots dl
       JOIN lots l ON l.id = dl.lot_id
       JOIN documents d ON d.id = dl.document_id
       WHERE l.tenant_id = ? AND l.lot_key = ?`
    )
    .bind(tenantId, lotKey)
    .all<CoaCandidate>();

  for (const coa of rows.results ?? []) {
    const cls = classifyMatch({
      coaProductId: coa.product_id,
      orderProductId: productId,
      coaSupplierId: coa.supplier_id,
      orderSupplierId: null,
      coaProductCode: parseDistributorCode(coa.title),
      orderProductCode,
    });

    if (cls.strong) {
      await applyStrongLink(db, {
        orderItemId,
        documentId: coa.document_id,
        // Prefer the order's own lot row for the FK; both resolve to the same key.
        lotId,
        confidence: cls.confidence,
      });
    } else {
      await recordSuggestion(db, {
        tenantId,
        orderItemId,
        documentId: coa.document_id,
        lotId,
        confidence: cls.confidence,
        basis: cls.basis,
      });
    }
  }
}
