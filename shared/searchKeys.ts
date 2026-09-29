/**
 * The identifiers and dates a document STATES, as rows search can seek on
 * (migration 0122 `document_search_keys`; search redesign Phase 1).
 *
 * Before this a PO, an invoice number or a code date lived only inside the
 * metadata JSON: reachable as free text, or by judging every document the
 * tenant holds (the capped 5,000-document scan). A key row makes each of them an
 * index seek. It is DERIVED data — one pure function, used by the worker-side
 * writer (functions/lib/search/keys.ts), the backfill script
 * (bin/backfill-search-keys, through the bin/lib/shared mirror) and the judge
 * (shared/searchCoverage.ts reads a subject's identifiers through
 * `deriveSearchKeys` too). So a stale or missing row can only cost a CANDIDATE,
 * never change a verdict: the judge re-reads the document's own metadata.
 *
 * TWO PO NAMESPACES, NEVER MERGED. On prod (2026-09-29) `po_number` on a
 * supplier's certificate is OUR purchase order to that supplier ("K134273",
 * "k134514", "K 135680"); `orders.po_number` is the CUSTOMER's PO
 * ("PO-90001"). They share no value. The document side is `supplier_po`; a
 * `customer_po` printed on a document keeps its own kind; the WMS side is not a
 * key at all (it is read from `orders` at query time).
 *
 * A DATE THAT READS TWO WAYS STORES BOTH READINGS with provenance 'ambiguous'
 * (the seek then finds the document for either day, and the judge — reading
 * the same value — says it cannot be verified). A value no date parser can
 * read is not stored as a date at all.
 *
 * Pure, no I/O.
 */

import type { SearchKeyKind } from './types';
import { inferDocumentDateOrder, readStoredDates } from './searchDates';
import { normalizeLotNumber, normalizeSubLotCode } from './lotNormalize';

export type IdentifierKeyKind = Extract<SearchKeyKind,
  'supplier_po' | 'customer_po' | 'invoice_number' | 'order_number' | 'document_number'
  | 'certificate_number' | 'customer_item_number' | 'product_code' | 'shipment_number'>;

export type DateKeyKind = Extract<SearchKeyKind,
  'production_date' | 'code_date' | 'best_by' | 'expiration_date' | 'document_expires_on' | 'ship_date'>;

/** Metadata keys each identifier kind is read from. */
export const IDENTIFIER_KEY_FIELDS: Record<IdentifierKeyKind, string[]> = {
  // Our purchase order to the supplier, as printed on their paper.
  supplier_po: ['po_number', 'purchase_order', 'purchase_order_number', 'po', 'supplier_po'],
  customer_po: ['customer_po', 'customer_po_number'],
  invoice_number: ['invoice_number', 'invoice_no', 'invoice'],
  order_number: ['order_number', 'sales_order', 'sales_order_number'],
  document_number: ['document_number'],
  certificate_number: ['certificate_number', 'certificate_no'],
  customer_item_number: ['customer_item_number'],
  product_code: ['product_code', 'item_number'],
  shipment_number: ['shipment_number', 'bol_number', 'bill_of_lading'],
};

/**
 * Metadata keys each date kind is read from. `code_date` is NOT best-by
 * (Andersen prints code date 2026-02-14 and expiration 2026-09-17 on one
 * certificate), and `best_by` is not the document's own expiry.
 */
export const DATE_KEY_FIELDS: Record<DateKeyKind, string[]> = {
  production_date: [
    'production_date', 'mfg_date', 'manufacture_date', 'manufacturing_date',
    'date_of_manufacture', 'prod_date', 'pack_date', 'packed_date', 'packaging_date',
  ],
  code_date: ['code_date'],
  best_by: ['best_by', 'best_by_date', 'best_before', 'use_by', 'sell_by'],
  expiration_date: ['expiration_date', 'exp_date'],
  document_expires_on: ['document_expires_on'],
  ship_date: ['ship_date', 'shipping_date', 'date_shipped'],
};

export const IDENTIFIER_KEY_KINDS = Object.keys(IDENTIFIER_KEY_FIELDS) as IdentifierKeyKind[];
export const DATE_KEY_KINDS = Object.keys(DATE_KEY_FIELDS) as DateKeyKind[];

/** How each identifier kind is named to a reader. */
export const KEY_KIND_LABELS: Record<SearchKeyKind, string> = {
  supplier_po: 'PO number',
  customer_po: 'customer PO',
  invoice_number: 'invoice number',
  order_number: 'order number',
  document_number: 'document number',
  certificate_number: 'certificate number',
  customer_item_number: 'customer item number',
  product_code: 'product code',
  shipment_number: 'shipment number',
  lot: 'lot',
  production_date: 'production date',
  code_date: 'code date',
  best_by: 'best-by date',
  expiration_date: 'expiration date',
  document_expires_on: 'document expiry date',
  ship_date: 'ship date',
};

export interface DerivedSearchKey {
  kind: SearchKeyKind;
  /** The value as stated (one part of a multi-value field). */
  value_raw: string;
  /** Identifiers: upper-case alphanumerics. Dates: the ISO day. Lots: lot + sublot, normalized. */
  value_norm: string;
  /** ISO day for a date kind, else null. */
  value_date: string | null;
  /** 'ambiguous' = one of two readings of a date that reads both ways. */
  provenance: 'stated' | 'ambiguous';
  /** The metadata key (or `lots.<column>`) it came from. */
  source_field: string;
  /** Set when the key comes from a linked lot row. */
  lot_id: string | null;
}

export interface SearchKeyLot {
  lot_id: string | null;
  lot_number: string | null;
  sub_lot_code?: string | null;
  code_date?: string | null;
  expiration_date?: string | null;
}

/** More than this many keys on one document is a collapsed table, not identity. */
export const MAX_KEYS_PER_DOCUMENT = 200;

/**
 * Case, spaces and punctuation fold; leading zeros stay ("K 135680" =
 * "k135680" = "K135680"; "08012" is not "8012").
 */
export function normalizeKeyValue(v: unknown): string {
  return String(v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * "PO K134273" / "PO# 4500" / "invoice: 261149" -> the number. A keyword only
 * counts when a space, '#' or ':' separates it: "PO-90001" IS the customer's
 * PO as the WMS stores it, and stripping its "PO" would search for "-90001".
 */
export function stripKeyword(raw: string, kind: 'po' | 'invoice'): string {
  const re = kind === 'po' ? /^p\.?o\.?(?:\s*[#:]\s*|\s+)/i : /^inv(?:oice)?\.?(?:\s*[#:]\s*|\s+)/i;
  return raw.trim().replace(re, '').trim();
}

/**
 * A CUSTOMER's PO (orders.po_number) as compared: a leading "PO", "PO-",
 * "PO#" or "PO " (any case) is folded away and the rest kept exactly, so
 * "90001" = "PO-90001" = "po#90001" but "9000" != "90001". Only for the WMS
 * namespace: our PO on a supplier's paper ("K134273") is never folded.
 */
export function foldCustomerPo(raw: unknown): string {
  return String(raw ?? '').trim().replace(/^po(?:\s*[-#]\s*|\s+|(?=\d))/i, '').trim();
}

/** The spellings a customer PO may be stored under, for an index IN-list. */
export function customerPoSpellings(raw: string): string[] {
  const f = foldCustomerPo(raw);
  if (!f) return [];
  const out = new Set<string>([f]);
  for (const p of ['PO', 'po', 'Po']) for (const sep of ['-', ' ', '#', '', '# ', ' - ']) out.add(`${p}${sep}${f}`);
  return [...out];
}

function scalar(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === 'string') return v.trim() || null;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return null;
}

/** A field can hold several values ("K134273, K134274"). */
function parts(v: unknown): string[] {
  const values = Array.isArray(v) ? v.map(scalar) : [scalar(v)];
  return values
    .filter((x): x is string => !!x)
    .flatMap((x) => x.split(/[,;\n]+/))
    .map((x) => x.trim())
    .filter(Boolean);
}

/** The document's own identifiers of the given kinds (what the judge compares on). */
export function identifierKeys(metadata: Record<string, unknown>, kinds: readonly IdentifierKeyKind[] = IDENTIFIER_KEY_KINDS): DerivedSearchKey[] {
  const out: DerivedSearchKey[] = [];
  const seen = new Set<string>();
  for (const kind of kinds) {
    for (const field of IDENTIFIER_KEY_FIELDS[kind]) {
      for (const raw of parts(metadata[field])) {
        const norm = normalizeKeyValue(raw);
        if (norm.length < 2) continue;
        const id = `${kind}|${norm}`;
        if (seen.has(id)) continue;
        seen.add(id);
        out.push({ kind, value_raw: raw, value_norm: norm, value_date: null, provenance: 'stated', source_field: field, lot_id: null });
      }
    }
  }
  return out;
}

function dateKeys(
  kind: DateKeyKind,
  field: string,
  value: unknown,
  order: ReturnType<typeof inferDocumentDateOrder>,
  lotId: string | null,
  out: DerivedSearchKey[],
  seen: Set<string>,
): void {
  for (const raw of parts(value)) {
    for (const r of readStoredDates(raw, order)) {
      const readings: Array<{ iso: string; provenance: 'stated' | 'ambiguous' }> = r.kind === 'exact'
        ? [{ iso: r.iso, provenance: 'stated' }]
        : [{ iso: r.mdy, provenance: 'ambiguous' }, { iso: r.dmy, provenance: 'ambiguous' }];
      for (const x of readings) {
        const id = `${kind}|${x.iso}|${lotId ?? ''}`;
        if (seen.has(id)) continue;
        seen.add(id);
        out.push({ kind, value_raw: raw, value_norm: x.iso, value_date: x.iso, provenance: x.provenance, source_field: field, lot_id: lotId });
      }
    }
  }
}

/**
 * Every key a document states: its printed identifiers and dates (from
 * `primary_metadata` over `extended_metadata`, tables removed — the caller
 * merges), its lots (linked rows and the metadata lot), and the code / expiry
 * dates its linked lot rows carry.
 */
export function deriveSearchKeys(metadata: Record<string, unknown>, lots: SearchKeyLot[] = []): DerivedSearchKey[] {
  const out: DerivedSearchKey[] = identifierKeys(metadata);
  const seen = new Set<string>();

  // One date order per document, proven by its own unambiguous dates.
  const allDateValues = DATE_KEY_KINDS.flatMap((k) => DATE_KEY_FIELDS[k].map((f) => metadata[f])).filter((v) => v != null);
  const order = inferDocumentDateOrder(allDateValues);
  for (const kind of DATE_KEY_KINDS) {
    for (const field of DATE_KEY_FIELDS[kind]) dateKeys(kind, field, metadata[field], order, null, out, seen);
  }

  const lotSeen = new Set<string>();
  const pushLot = (lotNumber: string, sub: string, field: string, lotId: string | null) => {
    const base = normalizeLotNumber(lotNumber);
    if (!base) return;
    const norm = base + normalizeSubLotCode(sub);
    if (lotSeen.has(norm)) return;
    lotSeen.add(norm);
    out.push({ kind: 'lot', value_raw: sub ? `${lotNumber} ${sub}` : lotNumber, value_norm: norm, value_date: null, provenance: 'stated', source_field: field, lot_id: lotId });
  };
  for (const l of lots) {
    if (l.lot_number) pushLot(l.lot_number, l.sub_lot_code ?? '', 'lots.lot_number', l.lot_id);
    const lotOrder = inferDocumentDateOrder([l.code_date, l.expiration_date]);
    if (l.code_date) dateKeys('code_date', 'lots.code_date', l.code_date, lotOrder ?? order, l.lot_id, out, seen);
    if (l.expiration_date) dateKeys('expiration_date', 'lots.expiration_date', l.expiration_date, lotOrder ?? order, l.lot_id, out, seen);
  }
  const metaLot = parts(metadata.lot_number ?? metadata.lot_code ?? metadata.lot);
  const metaSub = scalar(metadata.sub_lot_code) ?? scalar(metadata.sub_lot_number) ?? scalar(metadata.sublot) ?? '';
  for (const p of metaLot) pushLot(p, metaLot.length === 1 ? metaSub : '', 'lot_number', null);

  return out.slice(0, MAX_KEYS_PER_DOCUMENT);
}
