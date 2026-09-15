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
import {
  legacyLotSchemeSpec,
  legacyResolvedScheme,
  lotIdentity,
  productionDateFromLot,
  type ResolvedLotScheme,
} from '../../../shared/lotScheme';

/**
 * The pure normalization rules now live in `shared/lotNormalize.ts` so the
 * review-time invariant checks (`shared/extractionInvariants.ts`) and the bin/
 * scripts bundled from it use the EXACT same matching semantics as the lot
 * writer below — previously they were hand-mirrored CommonJS copies. Re-exported
 * here so every existing `from '.../entities/lots'` import is unchanged.
 */
export { normalizeLotNumber, normalizeSubLotCode, normalizeProductNameKey };

/**
 * Per-supplier lot numbering scheme (migration 0075), the legacy enum:
 *   - 'auto' / 'plain' / 'lims_combined' : lot as written + sublot (one behaviour)
 *   - 'date_code' : the leading MMDDYY (6-digit) run, sublot forced '' (CMF
 *                   '061626WHO' -> '061626'); a key with no leading 6 digits is kept.
 *
 * Since 0109 a supplier may DECLARE its lot format instead (supplier_lot_schemes,
 * shared/lotScheme.ts); the enum values are expressed as equivalent specs so
 * there is one engine and their keys are byte-identical.
 */
export type LotScheme = 'auto' | 'date_code' | 'lims_combined' | 'plain';

/**
 * Combine a normalized base lot key + sublot code into the stored `lot_key`
 * under a LEGACY enum value. Pure; runs the spec engine on
 * `legacyLotSchemeSpec(scheme)`. Kept for its existing callers and tests.
 */
export function applyLotScheme(
  scheme: LotScheme | null | undefined,
  baseLotKey: string,
  subLotCode: string
): { lotKey: string; subLotCode: string } {
  return lotIdentity(legacyLotSchemeSpec(scheme), baseLotKey, subLotCode);
}

/** A legacy enum value or a resolved (possibly declared) scheme, as callers hold them. */
export type LotSchemeInput = LotScheme | ResolvedLotScheme | null | undefined;

export function toResolvedScheme(scheme: LotSchemeInput): ResolvedLotScheme {
  return scheme && typeof scheme === 'object' ? scheme : legacyResolvedScheme(scheme ?? 'auto');
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
   * The supplier's lot scheme: a legacy 0075 enum value, or the resolved scheme
   * (`loadResolvedLotScheme`, 0109) which may be a DECLARED format. Decides how
   * the lot and sublot combine into the stored lot_key; a declared
   * production-role format also supplies a labelled fallback production date
   * (never over a stated one). Omitted/null → 'auto' (today's behavior).
   */
  lotScheme?: LotSchemeInput;
  /** The document the lot is being attached from, for a decoded date's provenance. */
  documentId?: string | null;
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

  // Option B: sub_lot_code is the 2-digit code ('' when none); lot_key embeds it
  // so the matcher anchor (product_code + lot_key) lines up with the WMS
  // combined lot. The supplier's scheme decides the combine: the legacy enum
  // keeps the historical concat ('date_code' strips to the bare MMDDYY), and a
  // DECLARED format (0109) splits a composite by its declared widths — so
  // '10426203-03' with no sublot field is lot 10426203, sublot 03 — and falls
  // back to the historical concat for a lot that does not fit.
  const resolvedScheme = toResolvedScheme(opts.lotScheme);
  const identity = lotIdentity(resolvedScheme.spec, opts.lotNumber, opts.subLotCode);
  const lotKey = identity.lotKey;
  const subLotCode = identity.subLotCode;
  if (!lotKey) return null;

  // R3: the stated production date is authoritative; a declared production-role
  // format fills in only when nothing is stated, and a disagreement becomes
  // 'conflict' carrying both values (shared/lotScheme.ts productionDateFromLot).
  const statedPd = opts.productionDate ?? null;
  const decision = productionDateFromLot(resolvedScheme, opts.lotNumber, opts.subLotCode, statedPd);
  const productionDate: ProductionDateWrite | null = decision.resolution
    ? {
        ...decision.resolution,
        documentId: statedPd?.documentId ?? opts.documentId ?? null,
        schemeId: decision.scheme_id,
      }
    : null;

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
          'SELECT id, supplier_id, product_id, code_date, expiration_date, mfg_date, production_date, production_date_raw, production_date_source, production_date_status FROM lots WHERE tenant_id = ? AND lot_key = ? AND sub_lot_code = ? AND product_id = ?'
        )
        .bind(tenantId, lotKey, subLotCode, productId)
        .first<LotRow>()
    : await db
        .prepare(
          'SELECT id, supplier_id, product_id, code_date, expiration_date, mfg_date, production_date, production_date_raw, production_date_source, production_date_status FROM lots WHERE tenant_id = ? AND lot_key = ? AND sub_lot_code = ? AND product_id IS NULL'
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
    const production = productionDateSets(existing, productionDate);
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
  const pd = productionDate;
  await db
    .prepare(
      `INSERT INTO lots
         (id, tenant_id, supplier_id, product_id, lot_number, sub_lot_code, lot_key,
          code_date, expiration_date, mfg_date, primary_metadata, first_seen_source,
          production_date, production_date_raw, production_date_source, production_date_status,
          production_date_document_id, production_date_scheme_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
      pd ? pd.documentId : null,
      pd ? (pd.schemeId ?? null) : null
    )
    .run();

  return { id };
}

/** What findOrCreateLot hands the production-date writer: the value, its document, its declaration. */
export type ProductionDateWrite = ProductionDateResolution & { documentId: string | null; schemeId?: string | null };

const NO_SETS: { sets: string[]; binds: (string | null)[] } = { sets: [], binds: [] };

/**
 * The production-date columns to set on an EXISTING lot (migrations 0106, 0109).
 *
 *   - nothing stored yet            -> store the new value as given
 *   - same day already resolved     -> leave it (the first certificate stays
 *                                      the named source)
 *   - a different stated value      -> 'conflict': the day is cleared, raw names
 *                                      both, and nothing picks between them
 *   - already 'conflict'            -> the new value is appended to raw if new
 *
 * An unresolved new value never displaces a resolved one, but one that cannot
 * be the stored day (an ambiguous reading that excludes it) is a conflict too.
 *
 * A LOT-CODE DECODE ('lot_decode', 0109) is a fallback and a validator, never an
 * authority:
 *   - it never displaces anything a certificate stated; if it disagrees with a
 *     stated resolved day the row becomes 'conflict' with both in raw
 *   - a stated value arriving on a decoded row replaces the decode when it is
 *     the same day (extraction confirms it) or does not read as one day (what
 *     the page printed outranks an inference); a different stated day is a
 *     conflict
 */
export function productionDateSets(
  existing: Pick<LotRow, 'production_date' | 'production_date_raw' | 'production_date_status'> & { production_date_source?: string | null },
  next: ProductionDateWrite | null
): { sets: string[]; binds: (string | null)[] } {
  if (!next) return NO_SETS;
  const schemeId = next.schemeId ?? null;
  const storeAll = {
    sets: [
      'production_date = ?',
      'production_date_raw = ?',
      'production_date_source = ?',
      'production_date_status = ?',
      'production_date_document_id = ?',
      'production_date_scheme_id = ?',
    ],
    binds: [next.iso, next.raw, next.source, next.status, next.documentId, schemeId],
  };
  if (!existing.production_date_status) return storeAll;
  const oldRaw = existing.production_date_raw ?? '';
  const conflict = () => ({
    sets: ['production_date = NULL', "production_date_status = 'conflict'", 'production_date_raw = ?'],
    binds: [oldRaw ? `${oldRaw} | ${next.raw}` : next.raw],
  });
  const existingIsDecode = existing.production_date_source === 'lot_decode';

  if (next.source === 'lot_decode') {
    if (existingIsDecode) {
      // Decode against decode: a re-declared format reads the lot differently.
      // No document disagrees with anything — the newer reading replaces the older.
      return existing.production_date === next.iso ? NO_SETS : storeAll;
    }
    if (existing.production_date_status === 'resolved') {
      return existing.production_date === next.iso ? NO_SETS : conflict();
    }
    if (existing.production_date_status === 'conflict' && !oldRaw.split(' | ').includes(next.raw)) return conflict();
    // A stated but unreadable value: a decode does not settle what a page printed.
    return NO_SETS;
  }

  if (existingIsDecode && existing.production_date_status === 'resolved') {
    if (next.status === 'resolved' && next.iso !== existing.production_date) return conflict();
    return storeAll;
  }

  const sameRaw = oldRaw.split(' | ').includes(next.raw);
  if (existing.production_date_status === 'resolved' && next.status === 'resolved' && next.iso === existing.production_date) {
    return NO_SETS;
  }
  if (sameRaw) return NO_SETS;
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
        'production_date_scheme_id = ?',
      ],
      binds: [next.iso, next.raw, next.source, next.documentId, schemeId],
    };
  }
  if (existing.production_date_status === 'resolved' && next.status === 'unparseable') {
    return NO_SETS;
  }
  if (existing.production_date_status === 'resolved' && next.status === 'ambiguous' && existing.production_date
    && next.raw && ambiguousCouldBe(next.raw, existing.production_date)) {
    return NO_SETS;
  }
  return conflict();
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
  production_date_source: string | null;
  production_date_status: string | null;
}
