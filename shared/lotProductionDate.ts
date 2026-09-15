/**
 * A lot row's production date: read it, say where it came from, and refuse to
 * guess (migration 0106; AJ Conner, Any-Field COA Retrieval, R3 / R8).
 *
 * THREE RULES, in the order they bite:
 *
 *   1. EXTRACTION BEATS INFERENCE. The record's own production-date field is
 *      the source. A code date is not one — except in the single, evidenced case
 *      `legacyCodeDateAsProduction` handles, and that value is labelled as such
 *      forever after ('extracted_code_date_legacy').
 *   2. A VALUE THAT READS TWO WAYS IS NOT A DATE. "04-05-2026" is April 5 or
 *      May 4. It is stored raw with a NULL day and status 'ambiguous'. The only
 *      narrowing allowed is evidence on the same record: another date there
 *      whose day is unmistakable proves the order (searchDates.
 *      inferDocumentDateOrder) — the rule Phase 1 search already applies.
 *   3. DISAGREEMENT IS REPORTED, NOT RESOLVED. Two certificates naming the same
 *      lot with different days, or one field holding two days, is 'conflict'
 *      with both values in `raw`. Nothing in code picks the winner.
 *
 * Pure. Imports only ./searchDates (itself import-free), so it bundles for the
 * bin/ backfill (`npm run build:worker-shared`).
 */

import {
  findStoredDateSpans,
  inferDocumentDateOrder,
  readStoredDates,
  type StoredDateReading,
} from './searchDates';

export type ProductionDateSource = 'extracted' | 'extracted_code_date_legacy' | 'reviewer';
export type ProductionDateStatus = 'resolved' | 'ambiguous' | 'unparseable' | 'conflict';

export interface ProductionDateResolution {
  /** ISO day, or null unless status is 'resolved'. */
  iso: string | null;
  raw: string;
  status: ProductionDateStatus;
  source: ProductionDateSource;
  /** The field the value was read from ('production_date', 'code_date', ...). */
  field: string;
  /** Plain words: how the day was settled, or why it was not. */
  note: string | null;
}

/** The record keys that ARE a production date. Pack date is not one of them. */
export const PRODUCTION_DATE_KEYS = [
  'production_date',
  'mfg_date',
  'manufacture_date',
  'manufacturing_date',
  'date_of_manufacture',
  'prod_date',
] as const;

/** Every date-bearing key on a record, for the order evidence in rule 2. */
const ORDER_EVIDENCE_KEYS = [
  ...PRODUCTION_DATE_KEYS,
  'code_date',
  'expiration_date',
  'best_by_date',
  'ship_date',
  'pack_date',
  'packaging_date',
];

function str(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === 'string') return v.trim() || null;
  if (typeof v === 'number') return String(v);
  return null;
}

function fromReadings(
  raw: string,
  readings: StoredDateReading[],
  field: string,
  source: ProductionDateSource,
): ProductionDateResolution {
  const base = { raw, field, source };
  if (readings.length === 0) {
    return { ...base, iso: null, status: 'unparseable', note: `"${raw}" is not a date that can be read.` };
  }
  const days = new Set(readings.map((r) => (r.kind === 'exact' ? r.iso : `${r.mdy}|${r.dmy}`)));
  if (days.size > 1) {
    return { ...base, iso: null, status: 'conflict', note: `"${raw}" holds more than one date.` };
  }
  const r = readings[0];
  // Did the record's order evidence actually decide anything? Only when the
  // value on its own reads two ways.
  const decidedByOrder = r.kind === 'exact' && !!r.order
    && readStoredDates(raw).some((x) => x.kind === 'ambiguous');
  if (r.kind === 'ambiguous') {
    return {
      ...base,
      iso: null,
      status: 'ambiguous',
      note: `"${raw}" could be ${r.mdy} or ${r.dmy}; nothing on the record says which.`,
    };
  }
  return {
    ...base,
    iso: r.iso,
    status: 'resolved',
    note: decidedByOrder && r.kind === 'exact'
      ? `"${raw}" read as ${r.order === 'mdy' ? 'month/day' : 'day/month'} because the record writes its other dates that way.`
      : null,
  };
}

/**
 * The production date a record's own fields state, or null when it states none.
 * `fields` is the record merged over its page's shared fields — the same map
 * the approve path writes to the document.
 */
export function resolveProductionDate(
  fields: Record<string, unknown>,
  source: ProductionDateSource = 'extracted',
): ProductionDateResolution | null {
  for (const key of PRODUCTION_DATE_KEYS) {
    const raw = str(fields[key]);
    if (!raw) continue;
    const order = inferDocumentDateOrder(ORDER_EVIDENCE_KEYS.map((k) => fields[k]));
    return fromReadings(raw, readStoredDates(raw, order), key, source);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Legacy: a production date an older extraction filed under code_date
// ---------------------------------------------------------------------------

/**
 * A production / manufacture date LABEL. A bare "production" in prose ("produced
 * exclusively from raw milk") is not one; the label has to name the date.
 */
const PRODUCTION_LABEL = /\b(?:production\s+date|prod\.?\s*(?:date|dt)|mfg\.?(?:\s*(?:date|dt))?|manufactur(?:e|ed|ing)\s+date|date\s+of\s+manufacture|manufactured(?:\s+on)?)\b\s*[:#.\-]?/gi;
const CODE_DATE_LABEL = /\bcode\s*(?:date|dt)\b/i;
/** How far after a production label its first value may sit. */
const LABEL_WINDOW = 60;
/**
 * A table serialised row-wise prints the label once and then one date per lot
 * ("Production Date 22-Jul-2026 22-Jul-2026 23-Jul-2026"): each further date
 * belongs to the label while it follows the previous one this closely.
 */
const RUN_GAP = 24;

export type LegacyRefusal =
  | 'has_production_field'
  | 'no_code_date'
  | 'no_text'
  | 'no_production_label'
  | 'document_prints_code_date'
  | 'not_printed_under_production_label';

export const LEGACY_REFUSAL_WORDS: Record<LegacyRefusal, string> = {
  has_production_field: 'the record already has a production date field',
  no_code_date: 'no code date on the record',
  no_text: 'no document text to check the label against',
  no_production_label: 'the document never prints a production / manufacture date label',
  document_prints_code_date: 'the document prints its own "code date" label, so its code date is a code date',
  not_printed_under_production_label: 'the code date value is not printed next to a production / manufacture label',
};

/** Days printed shortly after a production / manufacture label in the text. */
export function datesUnderProductionLabels(text: string): Set<string> {
  const out = new Set<string>();
  if (!text) return out;
  const spans = findStoredDateSpans(text);
  PRODUCTION_LABEL.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PRODUCTION_LABEL.exec(text)) !== null) {
    let cursor = m.index + m[0].length;
    let window = LABEL_WINDOW;
    let chained = false;
    for (const s of spans) {
      if (s.index < cursor) continue;
      if (s.index > cursor + window) break;
      // A further date joins the run only across separators — any word between
      // ("Expiration Date") is another label, and its date is not this one's.
      if (chained && !/^[\s,;|]*$/.test(text.slice(cursor, s.index))) break;
      // The first date may sit behind other header cells, but not behind
      // another DATE label.
      if (!chained && /\b(?:date|dt|exp|best|use\s+by|sell\s+by)\b/i.test(text.slice(cursor, s.index))) break;
      chained = true;
      if (s.reading.kind === 'exact') out.add(s.reading.iso);
      else s.reading.readings.forEach((d) => out.add(d));
      cursor = s.index + s.length;
      window = RUN_GAP;
    }
  }
  return out;
}

/**
 * Is this older record's `code_date` really its production date? Yes only when
 * the PAGE says so: the document prints a production / manufacture label, never
 * prints a code-date label, and the code-date value is printed next to that
 * production label. Anything less is refused with its reason — the backfill
 * reports refusals, it never falls back to assuming.
 *
 * When the stored value reads two ways and exactly one of the two readings is
 * printed under the production label, the page has settled it and that day is
 * used (with a note). When both are printed, it stays ambiguous.
 */
export function legacyCodeDateAsProduction(
  fields: Record<string, unknown>,
  text: string | null | undefined,
): { ok: true; resolution: ProductionDateResolution } | { ok: false; refusal: LegacyRefusal } {
  if (PRODUCTION_DATE_KEYS.some((k) => str(fields[k]))) return { ok: false, refusal: 'has_production_field' };
  const raw = str(fields.code_date);
  if (!raw) return { ok: false, refusal: 'no_code_date' };
  const body = String(text ?? '');
  if (!body.trim()) return { ok: false, refusal: 'no_text' };
  if (CODE_DATE_LABEL.test(body)) return { ok: false, refusal: 'document_prints_code_date' };
  PRODUCTION_LABEL.lastIndex = 0;
  if (!PRODUCTION_LABEL.test(body)) return { ok: false, refusal: 'no_production_label' };
  const labelled = datesUnderProductionLabels(body);

  const readings = readStoredDates(raw);
  const candidates = new Set<string>();
  for (const r of readings) {
    if (r.kind === 'exact') candidates.add(r.iso);
    else r.readings.forEach((d) => candidates.add(d));
  }
  const printed = [...candidates].filter((d) => labelled.has(d));
  if (printed.length === 0) return { ok: false, refusal: 'not_printed_under_production_label' };

  const source: ProductionDateSource = 'extracted_code_date_legacy';
  const base = fromReadings(raw, readings, 'code_date', source);
  if (base.status === 'ambiguous' && printed.length === 1) {
    return {
      ok: true,
      resolution: {
        ...base,
        iso: printed[0],
        status: 'resolved',
        note: `"${raw}" reads two ways; the document prints ${printed[0]} under its production date label.`,
      },
    };
  }
  return { ok: true, resolution: base };
}

// ---------------------------------------------------------------------------
// Combining what several certificates say about one lot
// ---------------------------------------------------------------------------

/**
 * One lot, several documents. Resolved values that agree resolve; an
 * ambiguous one that could be that same day does not contradict it; any real
 * disagreement is 'conflict' with every stated value kept. Extracted values
 * outrank legacy ones only when they AGREE — a legacy value that disagrees with
 * an extracted one is still a disagreement a person has to see.
 */
export function combineProductionDates(
  items: Array<ProductionDateResolution & { document_id: string }>,
): (ProductionDateResolution & { document_id: string }) | null {
  if (items.length === 0) return null;
  if (items.length === 1) return items[0];
  const resolved = items.filter((i) => i.status === 'resolved');
  const days = new Set(resolved.map((i) => i.iso));
  const rawAll = [...new Set(items.map((i) => i.raw))].join(' | ');
  const pick = resolved.find((i) => i.source === 'extracted') ?? resolved[0] ?? items[0];
  const conflict = (note: string) => ({
    ...pick,
    iso: null,
    raw: rawAll,
    status: 'conflict' as const,
    note,
  });
  if (days.size > 1) return conflict(`Certificates on file state different production dates for this lot: ${rawAll}.`);
  if (items.some((i) => i.status === 'conflict')) return conflict(`A certificate on file states more than one production date for this lot: ${rawAll}.`);
  if (days.size === 1) {
    const day = [...days][0] as string;
    const disagreeing = items.filter((i) => i.status === 'ambiguous' && !readStoredDates(i.raw).some((r) => r.kind === 'ambiguous' && r.readings.includes(day)));
    if (disagreeing.length > 0) return conflict(`Certificates on file state different production dates for this lot: ${rawAll}.`);
    return pick;
  }
  // Nothing resolved: ambiguous / unparseable only. Report the first, raw names all.
  return { ...items[0], raw: rawAll };
}
