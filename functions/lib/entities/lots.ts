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
import {
  normalizeLotNumber,
  normalizeSubLotCode,
  normalizeProductNameKey,
} from '../../../shared/lotNormalize';
import type { ProductionDateResolution } from '../../../shared/lotProductionDate';

/**
 * The pure normalization rules now live in `shared/lotNormalize.ts` so the
 * review-time invariant checks (`shared/extractionInvariants.ts`) and the bin/
 * scripts bundled from it use the EXACT same matching semantics as the lot
 * writer below — previously they were hand-mirrored CommonJS copies. Re-exported
 * here so every existing `from '.../entities/lots'` import is unchanged.
 */
export { normalizeLotNumber, normalizeSubLotCode, normalizeProductNameKey };

/**
 * Per-supplier lot numbering scheme (migration 0075). Decides how a raw lot
 * key + sublot code combine into the stored `lot_key`:
 *   - 'auto'  : no transform (default; today's behavior). Sublot concat if present.
 *   - 'plain' : identity (+ sublot concat if extracted). Same as 'auto' at storage.
 *   - 'lims_combined' : baseLotKey + normalizeSubLotCode(subLotCode) (Darigold-style).
 *   - 'date_code'     : strip to the leading MMDDYY (6-digit) date; drop any
 *                       trailing alpha item-code, and force subLotCode='' (the
 *                       suffix is the item, NOT a 2-digit sublot). e.g. CMF
 *                       '061626WHO' → '061626'. Non-conforming keys (no leading
 *                       6 digits) keep the full key — defensive, never drop.
 */
export type LotScheme = 'auto' | 'date_code' | 'lims_combined' | 'plain';

/**
 * Combine a normalized base lot key + sublot code into the stored `lot_key`,
 * per the supplier's scheme. Pure; runs AFTER normalizeLotNumber /
 * normalizeSubLotCode. Returns the final { lotKey, subLotCode } — date_code may
 * rewrite both (it forces subLotCode='').
 */
export function applyLotScheme(
  scheme: LotScheme | null | undefined,
  baseLotKey: string,
  subLotCode: string
): { lotKey: string; subLotCode: string } {
  switch (scheme) {
    case 'date_code': {
      // Strip to the leading 6-digit date; trailing alpha code is the item, not
      // a sublot. Non-conforming (no leading 6 digits) → keep full key.
      const m = /^(\d{6})/.exec(baseLotKey);
      return { lotKey: m ? m[1] : baseLotKey, subLotCode: '' };
    }
    case 'lims_combined':
      return { lotKey: baseLotKey + subLotCode, subLotCode };
    case 'plain':
    case 'auto':
    default:
      // Identity, plus the sublot concat when a sublot was extracted.
      return { lotKey: baseLotKey + subLotCode, subLotCode };
  }
}

/**
 * Suggest a LotScheme from a sample of raw/normalized lot keys. SUGGESTION
 * ONLY — consumed by the supplier UI prefill and the backfill report; nothing
 * writes it automatically (a human pins the real scheme). Returns 'date_code'
 * when a clear majority of non-empty samples look like MMDDYY + a trailing
 * alpha code (the Country-Morning shape); otherwise 'auto'.
 */
export function detectLotScheme(samples: string[]): LotScheme {
  const keys = (samples ?? [])
    .map((s) => normalizeLotNumber(s))
    .filter((s) => s.length > 0);
  if (keys.length === 0) return 'auto';
  // date_code shape: 6 leading digits then at least one alpha char.
  const dateCodeLike = keys.filter((k) => /^\d{6}[A-Z]/.test(k)).length;
  return dateCodeLike / keys.length >= 0.6 ? 'date_code' : 'auto';
}

export interface FindOrCreateLotOpts {
  lotNumber: string | null | undefined;
  /**
   * Sublot code (Option B). Concatenated onto the normalized lot number to form
   * `lot_key` and stored separately on `lots.sub_lot_code`. Omitted/empty →
   * main-lot-only ('' sentinel).
   */
  subLotCode?: string | null;
  supplierId?: string | null;
  productId?: string | null;
  codeDate?: string | null;
  expirationDate?: string | null;
  mfgDate?: string | null;
  /**
   * The lot row's production date as the certificate states it (migration
   * 0106), with its provenance. Written onto a lot that has none; a lot that
   * already holds a DIFFERENT day becomes 'conflict' rather than either value
   * winning. See writeProductionDate.
   */
  productionDate?: (ProductionDateResolution & { documentId: string | null }) | null;
  metadata?: string | null;
  source?: string | null;
  /**
   * Per-supplier lot numbering scheme (migration 0075). Decides how baseLotKey
   * + subLotCode combine into the stored lot_key. Omitted/null → 'auto'
   * (today's behavior). See applyLotScheme.
   */
  lotScheme?: LotScheme | null;
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
  const baseLotKey = normalizeLotNumber(opts.lotNumber);
  if (!baseLotKey) return null;

  // Option B: sublot is verbatim-concatenated onto the normalized lot number.
  // sub_lot_code is the 2-digit code ('' when none); lot_key embeds it so the
  // matcher anchor (product_code + lot_key) lines up with the WMS combined lot.
  // The supplier's lot_scheme (0075) decides the combine — 'auto'/'plain' keep
  // the historical concat; 'date_code' strips to the bare MMDDYY date and
  // forces sub_lot_code=''.
  const rawSubLotCode = normalizeSubLotCode(opts.subLotCode);
  const scheme = applyLotScheme(opts.lotScheme, baseLotKey, rawSubLotCode);
  const lotKey = scheme.lotKey;
  const subLotCode = scheme.subLotCode;

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
          'SELECT id, supplier_id, product_id, code_date, expiration_date, mfg_date, production_date, production_date_raw, production_date_status FROM lots WHERE tenant_id = ? AND lot_key = ? AND sub_lot_code = ? AND product_id = ?'
        )
        .bind(tenantId, lotKey, subLotCode, productId)
        .first<LotRow>()
    : await db
        .prepare(
          'SELECT id, supplier_id, product_id, code_date, expiration_date, mfg_date, production_date, production_date_raw, production_date_status FROM lots WHERE tenant_id = ? AND lot_key = ? AND sub_lot_code = ? AND product_id IS NULL'
        )
        .bind(tenantId, lotKey, subLotCode)
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
    const production = productionDateSets(existing, opts.productionDate ?? null);
    sets.push(...production.sets);
    binds.push(...production.binds);
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
  const pd = opts.productionDate ?? null;
  await db
    .prepare(
      `INSERT INTO lots
         (id, tenant_id, supplier_id, product_id, lot_number, sub_lot_code, lot_key,
          code_date, expiration_date, mfg_date, primary_metadata, first_seen_source,
          production_date, production_date_raw, production_date_source, production_date_status,
          production_date_document_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      id,
      tenantId,
      supplierId,
      productId,
      rawLot,
      subLotCode,
      lotKey,
      codeDate,
      expirationDate,
      mfgDate,
      metadata,
      source,
      pd ? pd.iso : null,
      pd ? pd.raw : null,
      pd ? pd.source : null,
      pd ? pd.status : null,
      pd ? pd.documentId : null
    )
    .run();

  return { id };
}

/**
 * The production-date columns to set on an EXISTING lot (migration 0106).
 *
 *   - nothing stored yet            -> store the new value as stated
 *   - same day already resolved     -> leave it (the first certificate stays
 *                                      the named source)
 *   - a different stated value      -> 'conflict': the day is cleared, raw names
 *                                      both, and nothing picks between them
 *   - already 'conflict'            -> the new value is appended to raw if new
 *
 * An unresolved new value never displaces a resolved one, but one that cannot
 * be the stored day (an ambiguous reading that excludes it) is a conflict too.
 */
export function productionDateSets(
  existing: Pick<LotRow, 'production_date' | 'production_date_raw' | 'production_date_status'>,
  next: (ProductionDateResolution & { documentId: string | null }) | null
): { sets: string[]; binds: (string | null)[] } {
  if (!next) return { sets: [], binds: [] };
  if (!existing.production_date_status) {
    return {
      sets: [
        'production_date = ?',
        'production_date_raw = ?',
        'production_date_source = ?',
        'production_date_status = ?',
        'production_date_document_id = ?',
      ],
      binds: [next.iso, next.raw, next.source, next.status, next.documentId],
    };
  }
  const oldRaw = existing.production_date_raw ?? '';
  const sameRaw = oldRaw.split(' | ').includes(next.raw);
  if (existing.production_date_status === 'resolved' && next.status === 'resolved' && next.iso === existing.production_date) {
    return { sets: [], binds: [] };
  }
  if (sameRaw) return { sets: [], binds: [] };
  // A later certificate that states plainly one of the two days an earlier
  // ambiguous value could be: the page has answered the question.
  if (existing.production_date_status === 'ambiguous' && next.status === 'resolved' && next.iso
    && ambiguousCouldBe(oldRaw, next.iso)) {
    return {
      sets: [
        'production_date = ?',
        'production_date_raw = ?',
        'production_date_source = ?',
        "production_date_status = 'resolved'",
        'production_date_document_id = ?',
      ],
      binds: [next.iso, next.raw, next.source, next.documentId],
    };
  }
  if (existing.production_date_status === 'resolved' && next.status === 'unparseable') {
    return { sets: [], binds: [] };
  }
  if (existing.production_date_status === 'resolved' && next.status === 'ambiguous' && existing.production_date
    && next.raw && ambiguousCouldBe(next.raw, existing.production_date)) {
    return { sets: [], binds: [] };
  }
  return {
    sets: ['production_date = NULL', "production_date_status = 'conflict'", 'production_date_raw = ?'],
    binds: [oldRaw ? `${oldRaw} | ${next.raw}` : next.raw],
  };
}

function ambiguousCouldBe(raw: string, iso: string): boolean {
  const m = /^\s*(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})\s*$/.exec(raw);
  if (!m) return false;
  const y = m[3].length === 2 ? `20${m[3]}` : m[3];
  const pad = (n: string) => n.padStart(2, '0');
  return iso === `${y}-${pad(m[1])}-${pad(m[2])}` || iso === `${y}-${pad(m[2])}-${pad(m[1])}`;
}

interface LotRow {
  id: string;
  supplier_id: string | null;
  product_id: string | null;
  code_date: string | null;
  expiration_date: string | null;
  mfg_date: string | null;
  production_date: string | null;
  production_date_raw: string | null;
  production_date_status: string | null;
}
