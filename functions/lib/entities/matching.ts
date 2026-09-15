/**
 * Lot-based matching engine (Phase 2 entity graph).
 *
 * The lot is the join key between the two halves of the system. This module
 * links order lines (order_items, written by connectors) to COA documents
 * (written by smart-upload / ingest) by their normalized lot key.
 *
 * Policy — EVERY MATCH IS A SUGGESTION (changed 14 Sep 2026):
 *   The engine never writes a COA onto an order line. Every candidate pairing,
 *   however strong the evidence, becomes a `lot_match_suggestions` row carrying
 *   its `match_basis` and `match_confidence`, and a person accepts it in one
 *   click (POST /api/lot-matches/:id). Only that accept writes
 *   `order_items.coa_document_id` / `coa_match_status = 'matched'`.
 *
 *   Why: the client's rule (AJ, IDP request §7) is "It does not assert a
 *   lot-to-shipment match as established fact. It presents the evidence and I
 *   make the call." A lot-to-shipment link is what a customer COA report is
 *   built on, so it is a claim the business makes to its customer; a number in
 *   a matcher is not the business making it. The Phase 2 design auto-linked
 *   STRONG matches (product or distributor code agrees). That tier still
 *   exists, as `classifyMatch(...).strong`, but it now means "high-confidence
 *   suggestion" and changes only how the suggestion is ranked and shown.
 *
 *   Rows that the old policy already wrote as `matched` are history and are
 *   left alone here; see bin/audit-asserted-lot-matches for the read-only
 *   report (and its opt-in conversion).
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
import type { ProductionDateResolution } from '../../../shared/lotProductionDate';
import {
  findOrCreateLot,
  normalizeLotNumber,
  type LotSchemeInput,
} from './lots';
import { loadProductCatalog } from '../product-identifiers';
import type { PreparedCatalog } from '../../../shared/productIdentity';
import {
  bridgeEvidenceFromMetadata,
  resolveSupplierProduct,
  type BridgeResolution,
} from '../../../shared/supplierProductBridge';

// Confidence thresholds. "Strong" requires the product OR the distributor code
// to agree (basis includes product or code). "Weak" is lot_only.
export const CONFIDENCE_LOT_PRODUCT_SUPPLIER = 0.95;
export const CONFIDENCE_LOT_PRODUCT = 0.85;
// Distributor-code agreement (leading parenthesized title prefix === order
// product_code). The SKU is the reliable cross-side key even when product
// names — and thus product_ids — diverge.
export const CONFIDENCE_LOT_CODE = 0.9;
export const CONFIDENCE_LOT_ONLY = 0.5;
// Product agreement that exists ONLY because an unconfirmed product identifier
// bridged the two sides. Still a suggestion, ranked below anything a person has
// stood behind, and its note says which identifier to confirm.
export const CONFIDENCE_LOT_PRODUCT_UNCONFIRMED = 0.7;

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
 * A match is STRONG (a high-confidence suggestion) when the two sides agree on
 * EITHER the product (resolved product_id) OR the distributor code (order
 * product_code vs the COA title's leading parenthesized SKU). Product names
 * diverge across the two halves of the system, so the distributor SKU is the
 * reliable join. Supplier agreement (when both are known) bumps confidence but
 * is never required. Strong or weak, the result is a suggestion a person
 * accepts; see the module header.
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
 * Record a candidate match as a pending suggestion, for a person to accept.
 *
 *   - New pair → INSERT at 'pending' with its basis and confidence.
 *   - Existing PENDING pair with lower confidence → raised to the new evidence
 *     (e.g. a product map taught since the last run upgrades lot_only to
 *     lot+product). The reviewer should see the best case for the pair.
 *   - Existing ACCEPTED or REJECTED pair → untouched. A human decision is never
 *     reopened or re-ranked by the matcher; a rejection stays rejected.
 *   - Order line already linked to THIS document (an accepted suggestion, or a
 *     row the pre-14-Sep policy auto-linked) → nothing to suggest.
 *
 * Idempotent via UNIQUE(order_item_id, document_id).
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
    /** The product bridge's words (ambiguity, unconfirmed identifier), or null. */
    note?: string | null;
  }
): Promise<void> {
  const { tenantId, orderItemId, documentId, lotId, confidence, basis } = args;
  const note = args.note ?? null;
  const linked = await db
    .prepare('SELECT coa_document_id FROM order_items WHERE id = ?')
    .bind(orderItemId)
    .first<{ coa_document_id: string | null }>();
  if (linked?.coa_document_id === documentId) return;

  await db
    .prepare(
      `INSERT INTO lot_match_suggestions
         (id, tenant_id, order_item_id, document_id, lot_id, match_confidence, match_basis, match_note, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')
       ON CONFLICT(order_item_id, document_id) DO UPDATE SET
         match_confidence = excluded.match_confidence,
         match_basis = excluded.match_basis,
         match_note = excluded.match_note,
         lot_id = COALESCE(lot_match_suggestions.lot_id, excluded.lot_id)
       WHERE lot_match_suggestions.status = 'pending'
         AND (lot_match_suggestions.match_confidence IS NULL
              OR lot_match_suggestions.match_confidence < excluded.match_confidence
              OR (lot_match_suggestions.match_confidence = excluded.match_confidence
                  AND lot_match_suggestions.match_basis = excluded.match_basis))`
    )
    .bind(generateId(), tenantId, orderItemId, documentId, lotId, confidence, basis, note)
    .run();
}

/**
 * The COA side of the product bridge (migration 0113 retired
 * `supplier_product_map`): which of OUR products this certificate is, read from
 * the product identifier graph by `resolveSupplierProduct`
 * (shared/supplierProductBridge.ts) — supplier item / customer item number
 * first, then supplier name + pack, then a supplier name that names exactly one
 * product. Evidence is the document's own metadata; `productName` (a split
 * record's own name) outranks the metadata name, `fallbackProductName` (the
 * linked product's name) is used only when the metadata has none.
 */
async function resolveCoaProduct(
  db: D1Database,
  tenantId: string,
  catalog: PreparedCatalog | null,
  args: {
    documentId: string;
    supplierId: string | null;
    productName: string | null | undefined;
    fallbackProductName?: string | null;
  }
): Promise<BridgeResolution> {
  if (!catalog) return resolveSupplierProduct(null, bridgeEvidenceFromMetadata({}, { supplierId: null }));
  const doc = await db
    .prepare(
      `SELECT supplier_id, primary_metadata,
              CASE WHEN json_valid(extended_metadata) THEN json_remove(extended_metadata, '$.tables') END AS extended_lite
         FROM documents WHERE id = ? AND tenant_id = ?`
    )
    .bind(args.documentId, tenantId)
    .first<{ supplier_id: string | null; primary_metadata: string | null; extended_lite: string | null }>();
  const metadata = { ...parseJsonObject(doc?.extended_lite), ...parseJsonObject(doc?.primary_metadata) };
  const metadataName = typeof metadata.product_name === 'string' && metadata.product_name.trim() ? metadata.product_name : null;
  return resolveSupplierProduct(
    catalog,
    bridgeEvidenceFromMetadata(metadata, {
      supplierId: args.supplierId ?? doc?.supplier_id ?? null,
      productName: args.productName || metadataName || args.fallbackProductName || null,
    })
  );
}

function parseJsonObject(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const ROUTE_WORDS: Record<NonNullable<BridgeResolution['route']>, string> = {
  supplier_item: "the supplier's item number",
  customer_item: 'the customer item number',
  name_pack: "the supplier's product name and pack",
  name: "the supplier's product name",
};

export interface BridgedPairJudgement {
  /**
   * True when OUR CONFIRMED identifier graph names the certificate, by a
   * printed NUMBER, as a different product from the order line's (and neither
   * the certificate's own product nor a product code agrees with the line): no
   * suggestion is recorded. Never true on a name, a pack, or anything
   * unconfirmed — those stay suggestions and say what they saw.
   */
  skip: boolean;
  classification: MatchClassification;
  note: string | null;
}

/**
 * Classify one (certificate, order line) pair with the product bridge applied.
 * Pure. With an empty bridge resolution (`product_id` and `note` null) this is
 * exactly `classifyMatch` on the certificate's own product.
 */
export function judgeBridgedPair(args: {
  bridge: BridgeResolution;
  coaProductId: string | null;
  orderProductId: string | null;
  coaSupplierId: string | null;
  titleProductCode: string | null;
  orderProductCode: string | null;
}): BridgedPairJudgement {
  const { bridge, coaProductId, orderProductId, coaSupplierId, titleProductCode, orderProductCode } = args;
  const bridgedCode =
    bridge.our_skus.find((sku) => codesAgree(sku, orderProductCode)) ?? bridge.our_skus[0] ?? null;
  const coaProductCode = titleProductCode ?? bridgedCode;
  const classification = classifyMatch({
    coaProductId: bridge.product_id ?? coaProductId,
    orderProductId,
    coaSupplierId,
    orderSupplierId: null, // order side rarely knows the supplier
    coaProductCode,
    orderProductCode,
  });

  const bridgedElsewhere =
    !!bridge.product_id && !!orderProductId && bridge.product_id !== orderProductId;
  if (
    bridgedElsewhere &&
    bridge.confirmed &&
    (bridge.route === 'supplier_item' || bridge.route === 'customer_item') &&
    coaProductId !== orderProductId &&
    !codesAgree(coaProductCode, orderProductCode)
  ) {
    return { skip: true, classification, note: null };
  }

  let cls = classification;
  const notes: string[] = [];
  if (bridgedElsewhere) {
    notes.push(
      `This certificate reads as ${bridge.product_label} by ${ROUTE_WORDS[bridge.route!]}, not this line's product.`
    );
  }
  if (
    bridge.product_id &&
    !bridge.confirmed &&
    bridge.product_id === orderProductId &&
    coaProductId !== orderProductId &&
    cls.confidence > CONFIDENCE_LOT_PRODUCT_UNCONFIRMED
  ) {
    cls = { ...cls, confidence: CONFIDENCE_LOT_PRODUCT_UNCONFIRMED, strong: false };
  }
  if (bridge.note) notes.push(bridge.note);
  return { skip: false, classification: cls, note: notes.length ? notes.join(' ') : null };
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
 * lot matches (by lot_key) and records each pairing as a suggestion.
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
    /**
     * The COA's product name, for the product bridge (shared/supplierProductBridge.ts,
     * over product_identifiers). When the certificate's item number, customer
     * item number, or supplier name (+ pack) resolves to one of our products,
     * that product is substituted into classifyMatch, so a name-divergent
     * supplier (e.g. Country Morning) is suggested at lot+product confidence
     * instead of lot_only. No identifiers for the tenant: identical to
     * classifying on the COA's own product.
     */
    coaProductName?: string | null;
  }
): Promise<void> {
  const { documentId, lotId, productId, supplierId, coaProductName } = args;

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
  const titleProductCode = parseDistributorCode(doc?.title);

  // Product bridge over product_identifiers (0107/0113): which of our products
  // this certificate is, if its own evidence says so unambiguously.
  const catalog = await loadProductCatalog(db, tenantId);
  const bridge = await resolveCoaProduct(db, tenantId, catalog, {
    documentId,
    supplierId: coaSupplierId,
    productName: coaProductName,
  });

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

    const judged = judgeBridgedPair({
      bridge,
      coaProductId: productId,
      orderProductId: oi.product_id,
      coaSupplierId,
      titleProductCode,
      orderProductCode: oi.product_code,
    });
    if (judged.skip) continue;

    await recordSuggestion(db, {
      tenantId,
      orderItemId: oi.id,
      documentId,
      lotId,
      confidence: judged.classification.confidence,
      basis: judged.classification.basis,
      note: judged.note,
    });
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
 * Keys we accept as a SUBLOT code from a fields map / metadata blob, in
 * priority order. Mirrors SUBLOT_KEYS in bin/lib/coaRecords.js and
 * COA_RECORD_SUBLOT_KEYS in kinds/coa.ts — keep the three in sync.
 */
const SUBLOT_FIELD_KEYS = [
  'sub_lot_code',
  'sub_lot_number',
  'sub_lot',
  'sub_lot_no',
  'sublot_code',
  'sublot_number',
  'sublot',
];

/**
 * Pull the first non-empty SUBLOT code out of a loose key/value map (approved
 * fields, primary_metadata, per-product fields). Returns null when none found.
 *
 * D1: the flat extraction schema now carries `sub_lot_code`, so the flat
 * (single-record) approve path can build the SAME combined lot_key
 * (norm(lot_number) + sub_lot_code) that the records path already builds via
 * computeRecordLotKey. Without this the sublot was extracted and then dropped
 * at storage time, keying order⇄COA matching on the bare main lot.
 */
export function extractSubLotCode(
  source: Record<string, unknown> | null | undefined
): string | null {
  if (!source) return null;
  for (const key of SUBLOT_FIELD_KEYS) {
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
    /** Sublot code (Option B); '' / omitted = main-lot-only. */
    subLotCode?: string | null;
    productId: string | null;
    supplierId: string | null;
    codeDate?: string | null;
    expirationDate?: string | null;
    mfgDate?: string | null;
    /**
     * The row's production date with its provenance (migration 0106). Callers
     * build it with `resolveProductionDate` from shared/lotProductionDate.ts;
     * it is NEVER folded into `codeDate` (a code date is not a production date).
     */
    productionDate?: ProductionDateResolution | null;
    source?: string;
    /**
     * Supplier's lot scheme — the legacy 0075 enum or the resolved (possibly
     * declared, 0110) format, from `loadResolvedLotScheme`. Threaded into
     * findOrCreateLot so the stored lot_key matches the order side, and so a
     * declared production-role format can supply a labelled fallback production
     * date. Omitted/null → 'auto' (today's behavior).
     */
    lotScheme?: LotSchemeInput;
    /** COA product name, for the product bridge over product_identifiers. */
    coaProductName?: string | null;
  }
): Promise<string | null> {
  try {
    const lot = await findOrCreateLot(db, tenantId, {
      lotNumber: args.lotNumber,
      subLotCode: args.subLotCode ?? null,
      supplierId: args.supplierId,
      productId: args.productId,
      codeDate: args.codeDate ?? null,
      expirationDate: args.expirationDate ?? null,
      mfgDate: args.mfgDate ?? null,
      productionDate: args.productionDate ? { ...args.productionDate, documentId: args.documentId } : null,
      source: args.source ?? 'coa',
      lotScheme: args.lotScheme ?? null,
      documentId: args.documentId,
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
      coaProductName: args.coaProductName ?? null,
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
  coa_product_name: string | null;
}

/**
 * Called after a connector creates an order line with a lot. Finds COA
 * documents (via document_lots → lots on matching lot_key) and records each
 * pairing as a suggestion for the order line.
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
  // Pull the COA candidate's product NAME (the product bridge's fallback when
  // the document's metadata names none) via document_products → products. A
  // doc may carry several product links; MIN keeps the result deterministic.
  const rows = await db
    .prepare(
      `SELECT dl.document_id, l.id AS lot_id, l.product_id,
              COALESCE(l.supplier_id, d.supplier_id) AS supplier_id, d.title,
              (SELECT MIN(p.name)
                 FROM document_products dp
                 JOIN products p ON p.id = dp.product_id
                WHERE dp.document_id = dl.document_id) AS coa_product_name
       FROM document_lots dl
       JOIN lots l ON l.id = dl.lot_id
       JOIN documents d ON d.id = dl.document_id
       WHERE l.tenant_id = ? AND l.lot_key = ?`
    )
    .bind(tenantId, lotKey)
    .all<CoaCandidate>();

  const catalog = (rows.results ?? []).length > 0 ? await loadProductCatalog(db, tenantId) : null;
  for (const coa of rows.results ?? []) {
    // Product bridge over product_identifiers for this certificate: its own
    // metadata name first, the linked product's name when metadata has none.
    const bridge = await resolveCoaProduct(db, tenantId, catalog, {
      documentId: coa.document_id,
      supplierId: coa.supplier_id,
      productName: null,
      fallbackProductName: coa.coa_product_name,
    });
    const judged = judgeBridgedPair({
      bridge,
      coaProductId: coa.product_id,
      orderProductId: productId,
      coaSupplierId: coa.supplier_id,
      titleProductCode: parseDistributorCode(coa.title),
      orderProductCode,
    });
    if (judged.skip) continue;

    await recordSuggestion(db, {
      tenantId,
      orderItemId,
      documentId: coa.document_id,
      // Prefer the order's own lot row for the FK; both resolve to the same key.
      lotId,
      confidence: judged.classification.confidence,
      basis: judged.classification.basis,
      note: judged.note,
    });
  }
}
