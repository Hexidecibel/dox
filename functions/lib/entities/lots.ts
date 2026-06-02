/**
 * Shared lot resolution + creation logic (Phase 2 entity graph).
 *
 * A "lot" is the join key between the two halves of the system: connectors
 * write orders/order_items that carry a free-text `lot_number`, and
 * smart-upload/ingest write COA documents that certify a lot. Both sides
 * funnel through `findOrCreateLot` so the same physical lot collapses to ONE
 * row per (tenant, product, normalized lot key), regardless of entry point or
 * how the lot number was punctuated.
 *
 * Mirrors the structure of functions/lib/suppliers.ts#findOrCreateSupplier and
 * functions/lib/entities/products.ts#findOrCreateProduct.
 */

import type { D1Database } from '@cloudflare/workers-types';
import { generateId } from '../db';

/**
 * Normalize a raw lot number into a stable matching key.
 *
 * Rules (applied in order):
 *   1. Uppercase + trim.
 *   2. Strip a leading "LOT", "LOT#", "LOT #", "LOT:" or bare "#" token (with
 *      any surrounding whitespace/colon/hash) — these are noise prefixes that
 *      reviewers and suppliers add inconsistently.
 *   3. Strip ALL non-alphanumeric characters (dashes, spaces, dots, slashes).
 *      Internal whitespace therefore collapses too.
 *
 * Examples (all → "061926LC3"):
 *   "Lot# 061926LC3"
 *   "  061926lc3 "
 *   "LOT 061926-LC3"
 *   "#061926 LC3"
 *
 * Returns "" when the input is empty/whitespace or normalizes to nothing.
 */
export function normalizeLotNumber(raw: string | null | undefined): string {
  if (!raw) return '';
  let s = String(raw).toUpperCase().trim();
  if (!s) return '';

  // Strip a leading LOT / LOT# / LOT: / # token plus surrounding separators.
  s = s.replace(/^(?:LOT\b|#)\s*[#:]?\s*/i, '').trim();

  // Drop every non-alphanumeric char (this also collapses internal whitespace,
  // dashes, dots, slashes, etc.).
  s = s.replace(/[^A-Z0-9]/g, '');

  return s;
}

export interface FindOrCreateLotOpts {
  lotNumber: string | null | undefined;
  supplierId?: string | null;
  productId?: string | null;
  codeDate?: string | null;
  expirationDate?: string | null;
  mfgDate?: string | null;
  metadata?: string | null;
  source?: string | null;
}

export interface FindOrCreateLotResult {
  id: string;
}

/**
 * Resolve a lot by identity (tenant_id, product_id, lot_key), creating it if
 * absent. Returns null when `lotNumber` normalizes to empty.
 *
 * NULL-product identity: SQLite treats NULLs as distinct in unique indexes, so
 * two NULL-product lots with the same key would NOT collide on
 * `idx_lots_identity`. To collapse them to one row per (tenant, key) we do the
 * SELECT with explicit IS-NULL matching rather than `product_id = ?`.
 *
 * Backfill: when an existing row is found, any currently-NULL
 * supplier_id / product_id / date columns are filled in from the new info.
 * Non-null values are never overwritten.
 */
export async function findOrCreateLot(
  db: D1Database,
  tenantId: string,
  opts: FindOrCreateLotOpts
): Promise<FindOrCreateLotResult | null> {
  const lotKey = normalizeLotNumber(opts.lotNumber);
  if (!lotKey) return null;

  const rawLot = String(opts.lotNumber).trim();
  const supplierId = opts.supplierId ?? null;
  const productId = opts.productId ?? null;
  const codeDate = opts.codeDate ?? null;
  const expirationDate = opts.expirationDate ?? null;
  const mfgDate = opts.mfgDate ?? null;
  const metadata = opts.metadata ?? null;
  const source = opts.source ?? null;

  // 1. Lookup by identity. Handle the NULL-product case explicitly so two
  //    NULL-product lots with the same key map to a single row.
  const existing = productId
    ? await db
        .prepare(
          'SELECT id, supplier_id, product_id, code_date, expiration_date, mfg_date FROM lots WHERE tenant_id = ? AND lot_key = ? AND product_id = ?'
        )
        .bind(tenantId, lotKey, productId)
        .first<LotRow>()
    : await db
        .prepare(
          'SELECT id, supplier_id, product_id, code_date, expiration_date, mfg_date FROM lots WHERE tenant_id = ? AND lot_key = ? AND product_id IS NULL'
        )
        .bind(tenantId, lotKey)
        .first<LotRow>();

  if (existing) {
    // Backfill NULL columns only — never overwrite a deliberate value.
    const sets: string[] = [];
    const binds: (string | null)[] = [];
    if (supplierId && !existing.supplier_id) {
      sets.push('supplier_id = ?');
      binds.push(supplierId);
    }
    if (productId && !existing.product_id) {
      sets.push('product_id = ?');
      binds.push(productId);
    }
    if (codeDate && !existing.code_date) {
      sets.push('code_date = ?');
      binds.push(codeDate);
    }
    if (expirationDate && !existing.expiration_date) {
      sets.push('expiration_date = ?');
      binds.push(expirationDate);
    }
    if (mfgDate && !existing.mfg_date) {
      sets.push('mfg_date = ?');
      binds.push(mfgDate);
    }
    if (sets.length > 0) {
      sets.push("updated_at = datetime('now')");
      binds.push(existing.id);
      await db
        .prepare(`UPDATE lots SET ${sets.join(', ')} WHERE id = ?`)
        .bind(...binds)
        .run();
    }
    return { id: existing.id };
  }

  // 2. Create.
  const id = generateId();
  await db
    .prepare(
      `INSERT INTO lots
         (id, tenant_id, supplier_id, product_id, lot_number, lot_key,
          code_date, expiration_date, mfg_date, primary_metadata, first_seen_source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      id,
      tenantId,
      supplierId,
      productId,
      rawLot,
      lotKey,
      codeDate,
      expirationDate,
      mfgDate,
      metadata,
      source
    )
    .run();

  return { id };
}

interface LotRow {
  id: string;
  supplier_id: string | null;
  product_id: string | null;
  code_date: string | null;
  expiration_date: string | null;
  mfg_date: string | null;
}
