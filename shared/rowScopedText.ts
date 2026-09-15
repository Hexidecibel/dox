/**
 * The text ONE lot row of a multi-row certificate is searched on (migration
 * 0106, `document_versions.search_text`; AJ Conner, D3).
 *
 * Approval splits a multi-lot certificate into one document per row, and every
 * one of them carries the whole certificate's text — on Darigold's layout all
 * four rows sit in one table on one page, so no page-scoping can separate them.
 * Search then matched the 23-Jul row's document on "22-Jul", because the
 * 22-Jul rows are printed on the same page.
 *
 * WHAT THIS DOES: take the certificate text and blank the identifiers that
 * belong to the OTHER rows and not to this one:
 *   - their lot numbers (a different base lot, or the composite / dashed /
 *     spaced form of a different sublot), and
 *   - their dates (production, expiration, code), when this row does not state
 *     the same day.
 * Everything the rows SHARE stays: supplier, PO, order and shipment numbers,
 * product words, test names, results. A sublot printed alone ("Sub Lot 03") is
 * left too — two digits on their own cannot be told from a result, and the
 * coverage check reads the row's sublot from its lot record, never from text.
 *
 * WHY BLANK INSTEAD OF CUT OUT THE ROW: extracted text is a single line on
 * production (no row boundaries survive), so there is no row to cut out. And
 * the displayed text stays the file's text — `extracted_text` is not touched;
 * this is only what the index reads.
 *
 * Returns null when there is nothing to scope (no siblings, no text, or nothing
 * to blank), so ordinary documents keep `search_text` NULL.
 *
 * Pure. Imports ./searchDates and ./lotNormalize only, both import-free.
 */

import { findStoredDateSpans } from './searchDates';
import { normalizeLotNumber, normalizeSubLotCode } from './lotNormalize';

const LOT_KEYS = ['lot_number', 'lot_code', 'lot', 'batch_number'];
const SUBLOT_KEYS = ['sub_lot_code', 'sub_lot_number', 'sublot_code', 'sublot'];
const DATE_KEYS = [
  'production_date', 'mfg_date', 'manufacture_date', 'manufacturing_date', 'date_of_manufacture', 'prod_date',
  'expiration_date', 'best_by_date', 'best_by', 'code_date', 'pack_date', 'packaging_date', 'ship_date',
];

function str(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === 'string') return v.trim() || null;
  if (typeof v === 'number') return String(v);
  return null;
}

interface RowIdentity {
  base: string;
  sub: string;
  days: Set<string>;
}

function identityOf(fields: Record<string, unknown>): RowIdentity {
  const lotRaw = LOT_KEYS.map((k) => str(fields[k])).find(Boolean) ?? '';
  const subRaw = SUBLOT_KEYS.map((k) => str(fields[k])).find(Boolean) ?? '';
  const days = new Set<string>();
  for (const k of DATE_KEYS) {
    const v = str(fields[k]);
    if (!v) continue;
    for (const s of findStoredDateSpans(v)) {
      if (s.reading.kind === 'exact') days.add(s.reading.iso);
      else s.reading.readings.forEach((d) => days.add(d));
    }
  }
  return { base: normalizeLotNumber(lotRaw), sub: normalizeSubLotCode(subRaw), days };
}

export interface RowScopedText {
  text: string;
  /** How many spans were blanked — reported by the backfill. */
  blanked: number;
}

export function rowScopedSearchText(
  text: string | null | undefined,
  own: Record<string, unknown>,
  siblings: Array<Record<string, unknown>>,
): RowScopedText | null {
  const body = String(text ?? '');
  if (!body.trim() || siblings.length === 0) return null;
  const me = identityOf(own);
  const others = siblings.map(identityOf);

  const foreignLots = new Set<string>();
  const foreignDays = new Set<string>();
  for (const o of others) {
    if (o.base) {
      if (o.base !== me.base) foreignLots.add(o.base);
      if (o.sub && (o.base !== me.base || o.sub !== me.sub)) foreignLots.add(o.base + o.sub);
    }
    for (const d of o.days) if (!me.days.has(d)) foreignDays.add(d);
  }
  if (foreignLots.size === 0 && foreignDays.size === 0) return null;

  const spans: Array<[number, number]> = [];

  // Dates first, so a date is never half-read as a lot token.
  for (const s of findStoredDateSpans(body)) {
    const readings = s.reading.kind === 'exact' ? [s.reading.iso] : s.reading.readings;
    // An ambiguous printed date is blanked only if EVERY reading is another
    // row's and none is this row's — otherwise it might be ours.
    if (readings.every((d) => foreignDays.has(d))) spans.push([s.index, s.index + s.length]);
  }

  const overlaps = (a: number, b: number) => spans.some(([s, e]) => a < e && b > s);
  // Lot tokens: "10426204", "1042620413", "10426204-13". A spaced pair
  // ("10426204 13") is two tokens; the base is blanked when it is foreign, and
  // the composite check below catches the pair when the base is shared.
  const tokenRe = /[A-Za-z0-9][A-Za-z0-9\-./#]*/g;
  const tokens: Array<{ start: number; end: number; norm: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(body)) !== null) {
    const raw = m[0].replace(/[.\-/#]+$/, '');
    tokens.push({ start: m.index, end: m.index + raw.length, norm: normalizeLotNumber(raw) });
  }
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.norm.length < 4 || overlaps(t.start, t.end)) continue;
    if (foreignLots.has(t.norm)) {
      spans.push([t.start, t.end]);
      continue;
    }
    const next = tokens[i + 1];
    if (next && /^\s+$/.test(body.slice(t.end, next.start)) && foreignLots.has(t.norm + next.norm) && t.norm === me.base) {
      spans.push([next.start, next.end]);
      i += 1;
    }
  }

  if (spans.length === 0) return null;
  spans.sort((a, b) => a[0] - b[0]);
  let out = '';
  let pos = 0;
  for (const [s, e] of spans) {
    if (s < pos) continue;
    out += body.slice(pos, s) + ' ';
    pos = e;
  }
  out += body.slice(pos);
  return { text: out, blanked: spans.length };
}
