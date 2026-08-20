/**
 * shared/extractionInvariants.ts — the single source of truth for "is this
 * extracted value self-evidently wrong?", with NO model and NO answer key.
 *
 * The idea: a lot of extraction failure is detectable from the document ALONE.
 * If the model reports a lot number that appears nowhere in the document's own
 * text, that value was fabricated or borrowed from a neighbouring page. If it
 * reports an expiration before the production date, or a "product code" that is
 * the supplier's phone number, or a "plant number" that the document itself
 * labels `BUFFER LOT#`, that is wrong without anyone needing to open the PDF.
 *
 * TWO CONSUMERS, ONE COPY:
 *   1. `bin/check-extraction-invariants` — corpus-scale READ-ONLY audit. It
 *      consumes the esbuild bundle at `bin/lib/shared/extractionInvariants.js`
 *      (regenerate with `npm run build:worker-shared`).
 *   2. `functions/api/queue/*` — computes the same failures per queue item and
 *      returns them as `invariant_warnings`, so the Review Queue can put the
 *      warning on the specific field at the moment a human is looking at it.
 *
 * WARN, NEVER BLOCK. Every check here is a heuristic with a real false-positive
 * rate (a `net_weight` of "300 Gallon Tote" reads oddly but reviewers correctly
 * accept it — which is exactly why there is no net_weight check). A reviewer
 * must always be able to look at a warning, disagree, and approve anyway. A
 * hard gate would just train reviewers to fight the tool.
 *
 * WHAT THIS DOES NOT TELL YOU: whether a value that passes every invariant is
 * the RIGHT value. A lot number that occurs in the document but belongs to a
 * different line item passes `lot_in_text`. Treat failure counts as a FLOOR on
 * the error rate, never as an accuracy figure.
 *
 * Dependency rule: this module must stay pure and import nothing but
 * `./lotNormalize`, because it is bundled for plain Node.
 */

import { normalizeLotNumber, normalizeSubLotCode } from './lotNormalize';

// ---------------------------------------------------------------------------
// Field keys we know how to check.
// ---------------------------------------------------------------------------

const LOT_KEYS = ['lot_number', 'lot_code', 'buffer_lot'];
const SUBLOT_KEYS = ['sub_lot_code', 'sub_lot_number', 'sublot_code'];
const DATE_KEYS = [
  'code_date',
  'expiration_date',
  'production_date',
  'mfg_date',
  'best_by_date',
  'ship_date',
  'delivery_date',
  'invoice_date',
  'issue_date',
  'date_of_issue',
  'packaging_date',
  'test_date',
  'buffer_exp',
];
/** Dates that must not precede the production date. */
const PRODUCTION_KEYS = ['production_date', 'mfg_date', 'packaging_date'];

/** Records-mode envelope keys that are structure, not extracted values. */
const ENVELOPE_KEYS = new Set([
  'records',
  'record_cardinality',
  'record_key_basis',
  'page_metadata',
]);

const PLAUSIBLE_MIN_YEAR = 2015;
const PLAUSIBLE_MAX_YEAR = 2035;
/** Longer than this between production and expiry is not a dairy shelf life. */
const MAX_SHELF_LIFE_DAYS = 730;

const DAY = 86400000;

export const CHECKS = [
  'no_placeholder_value',
  'single_value_per_field',
  'lot_in_text',
  'lot_not_a_date',
  'sublot_shape',
  'dates_parse',
  'dates_plausible',
  'date_ordering',
  'product_code_not_phone',
  'product_code_in_text',
  'supplier_in_text',
  'field_label_mismatch',
  'supplier_not_self',
] as const;

export type InvariantCheck = (typeof CHECKS)[number];

/** Fields the placeholder / multi-value checks apply to. */
const SCALAR_KEYS = new Set<string>([
  ...LOT_KEYS,
  ...SUBLOT_KEYS,
  ...DATE_KEYS,
  'product_code',
  'supplier_name',
  'po_number',
  'plant_number',
  // A batch printed alongside a separate lot (2026-08-20). Scalar like the
  // rest, and just as capable of arriving as a placeholder or a comma-joined
  // pair, so it gets the same checks.
  'batch_number',
]);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface InvariantFailure {
  /** Which invariant tripped. Stable identifier — safe to key UI state on. */
  check: InvariantCheck;
  /**
   * Where in the extraction the value lives: 'ai_fields' (flat), 'page_metadata'
   * (records-mode shared header) or 'record[N]' (Nth record). The review UI uses
   * this to route the warning to the right card.
   */
  scope: string;
  /** Field key the warning attaches to. */
  field: string;
  /** The observed value, truncated. */
  value: string;
  /** Terse machine-ish explanation. Used by the corpus report. */
  reason: string;
  /**
   * One-line, plain-English sentence for the human reviewer. This is what the
   * Review Queue renders — never the check id. If you add a check, write this
   * so someone who has never read this file understands what to go look at.
   */
  message: string;
}

export interface CheckTally {
  checked: number;
  pass: number;
  fail: number;
  skipped: number;
}

export type InvariantTally = Record<InvariantCheck, CheckTally>;

/** The subset of a `processing_queue` row the checks need. */
export interface ExtractionInput {
  ai_fields?: string | null;
  ai_records?: string | null;
  extracted_text?: string | null;
}

export interface CheckOptions {
  /**
   * Names belonging to the RECEIVING organisation (the tenant, plus any known
   * aliases). Powers `supplier_not_self`: "Medosweet reported as its own
   * supplier" is the 8th-ranked failure mode in the corpus study and is free to
   * detect once you know who "we" are. Omit to skip that check.
   */
  selfNames?: Array<string | null | undefined>;
}

export interface CheckResult {
  failures: InvariantFailure[];
  tally: InvariantTally;
  /** Informational: lots that appear in the text with punctuation intact. */
  verbatimLotHits: number;
  verbatimLotChecks: number;
}

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

function safeParse(raw: unknown): unknown {
  if (raw == null || raw === '') return null;
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(String(raw));
  } catch {
    return undefined; // undefined == present but unparseable
  }
}

interface Bundle {
  scope: string;
  fields: Record<string, unknown> | null;
  unparseable?: boolean;
}

/** Flatten one queue item's extractions into [{scope, fields}]. */
function bundlesFor(item: ExtractionInput): Bundle[] {
  const out: Bundle[] = [];

  const flat = safeParse(item.ai_fields);
  if (flat === undefined) {
    out.push({ scope: 'ai_fields', fields: null, unparseable: true });
  } else if (flat && typeof flat === 'object' && !Array.isArray(flat)) {
    const fields: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(flat as Record<string, unknown>)) {
      // Records-mode items stringify their envelope into ai_fields as
      // "[object Object]" — that is not an extracted value, skip it.
      if (ENVELOPE_KEYS.has(k)) continue;
      fields[k] = v;
    }
    if (Object.keys(fields).length > 0) out.push({ scope: 'ai_fields', fields });
  }

  const rec = safeParse(item.ai_records);
  if (rec === undefined) {
    out.push({ scope: 'ai_records', fields: null, unparseable: true });
  } else if (rec && typeof rec === 'object') {
    const envelope = rec as { page_metadata?: unknown; records?: unknown };
    const pm = envelope.page_metadata;
    if (pm && typeof pm === 'object' && !Array.isArray(pm)) {
      out.push({ scope: 'page_metadata', fields: pm as Record<string, unknown> });
    }
    const records = Array.isArray(envelope.records) ? envelope.records : [];
    records.forEach((r: unknown, i: number) => {
      const f = r && typeof r === 'object' ? (r as { fields?: unknown }).fields : null;
      if (f && typeof f === 'object' && !Array.isArray(f)) {
        out.push({ scope: `record[${i}]`, fields: f as Record<string, unknown> });
      }
    });
  }

  return out;
}

function asString(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return ''; // objects/arrays are not scalar field values
}

/** Loose date parse: ISO, US slash, and "Mon DD, YYYY". Returns Date or null. */
function parseDate(raw: unknown): Date | null {
  const s = asString(raw);
  if (!s) return null;
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return mkDate(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$/.exec(s);
  if (m) {
    let y = +m[3];
    if (y < 100) y += y < 70 ? 2000 : 1900;
    return mkDate(y, +m[1], +m[2]);
  }
  const t = Date.parse(s);
  if (!Number.isNaN(t)) {
    const d = new Date(t);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return null;
}

function mkDate(y: number, mo: number, d: number): Date | null {
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) {
    return null;
  }
  return dt;
}

/** NANP-shaped phone: 10 digits (or 11 leading 1) with phone punctuation. */
function looksLikePhone(raw: unknown): boolean {
  const s = asString(raw);
  if (!s) return false;
  const digits = s.replace(/\D/g, '');
  if (digits.length !== 10 && !(digits.length === 11 && digits[0] === '1')) return false;
  // Require phone-ish punctuation or spacing so a bare 10-digit SKU is not
  // accused. "360-687-7171", "(360) 687-7171", "360.687.7171" qualify.
  return /^\+?1?[\s.(-]*\d{3}[\s.)-]+\d{3}[\s.-]+\d{4}$/.test(s);
}

/** A calendar date sitting in a lot field, e.g. "7/15/26". */
function looksLikeCalendarDate(raw: unknown): boolean {
  const s = asString(raw);
  if (!s) return false;
  return /^\d{1,2}[/\-.]\d{1,2}[/\-.]\d{2,4}$/.test(s) || /^\d{4}-\d{2}-\d{2}$/.test(s);
}

/** Uppercase + drop non-alphanumerics, so punctuation drift cannot cause a miss. */
function alnum(s: unknown): string {
  return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * Sentinel strings the model emits instead of a value. These are NOT
 * fabrications and must not be scored as such — they are a distinct (and
 * milder) defect: the field should have been omitted.
 */
const PLACEHOLDERS = new Set([
  'MULTIPLE',
  'VARIOUS',
  'SEE ATTACHED',
  'SEE BELOW',
  'N/A',
  'NA',
  'NONE',
  'NULL',
  'UNKNOWN',
  'MISSING',
  '(MISSING)',
  'NOT AVAILABLE',
  'NOT PROVIDED',
  'NOT SPECIFIED',
  'TBD',
  '-',
  '--',
  'X',
  '?',
]);

function isPlaceholder(raw: unknown): boolean {
  const s = asString(raw).toUpperCase().trim();
  if (!s) return false;
  return PLACEHOLDERS.has(s);
}

/**
 * Split a comma/semicolon-joined value into parts. Only ever called AFTER the
 * whole string has already failed its single-value test, so legitimately
 * comma-bearing values ("Sep 5, 2026", "Darigold, Inc.") are never split.
 * Returns null when the value is not a list.
 */
function splitMulti(raw: unknown): string[] | null {
  const s = asString(raw);
  if (!/[,;]/.test(s)) return null;
  const parts = s
    .split(/\s*[,;]\s*/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  return parts.length >= 2 ? parts : null;
}

// ---------------------------------------------------------------------------
// field_label_mismatch — the role-confusion check
// ---------------------------------------------------------------------------
//
// The dominant defect in the corpus is NOT fabrication (27 instances) — it is
// role confusion: 584 instances of a real value from the document landing in
// the wrong field. Every text-grounding check is blind to it, because the value
// really is in the document.
//
// But the document usually SAYS what the value is. The Andersen Dairy COAs that
// were approved with 3M plate reagent lots in `plant_number` have those values
// printed under `BUFFER LOT#` / `CC LOT#` headers. So: find the value in the
// text, read the label immediately to its left, and if that label belongs to a
// DIFFERENT field family than the field it was filed under, say so.
//
// False-positive control:
//   - The value must occur as a standalone token (not a substring of a longer
//     one).
//   - If ANY occurrence carries the field's OWN label, the field passes. Only a
//     value whose every labelled occurrence contradicts the field is flagged.
//   - A value with no label context anywhere is SKIPPED, never accused.

type LabelFamily = 'lot' | 'plant' | 'item' | 'po' | 'phone';

const LABEL_PATTERNS: Array<{ family: LabelFamily; re: RegExp }> = [
  // The optional leading token keeps the QUALIFIER in the reported label —
  // "BUFFER LOT#" and "CC LOT#" tell a reviewer far more than a bare "LOT#",
  // and on the Andersen form the qualifier IS the whole point (those are
  // reagent lots, not the product's).
  { family: 'lot', re: /\b(?:[A-Z][A-Z0-9]{0,9}\s+)?(?:LOT|BATCH)\s*(?:#|NOS?\.?|NUMBERS?|CODES?)?\s*[#:.\-]*\s*$/ },
  { family: 'plant', re: /\b(?:PLANT|EST|ESTAB|ESTABLISHMENT)\s*(?:#|NOS?\.?|NUMBERS?)?\s*[#:.\-]*\s*$/ },
  { family: 'item', re: /\b(?:ITEM|SKU|MATERIAL|PART|PRODUCT\s+CODE)\s*(?:#|NOS?\.?|NUMBERS?|CODES?)?\s*[#:.\-]*\s*$/ },
  { family: 'po', re: /\b(?:P\.?\s?O\.?|PURCHASE\s+ORDER)\s*(?:#|NOS?\.?|NUMBERS?)?\s*[#:.\-]*\s*$/ },
  { family: 'phone', re: /\b(?:PHONE|TELEPHONE|TEL|FAX|PH)\s*[#:.\-]*\s*$/ },
];

/** Which family a field is SUPPOSED to hold. Fields absent here aren't checked. */
const FIELD_FAMILY: Record<string, LabelFamily> = {
  lot_number: 'lot',
  lot_code: 'lot',
  buffer_lot: 'lot',
  plant_number: 'plant',
  product_code: 'item',
  po_number: 'po',
};

const FAMILY_NOUN: Record<LabelFamily, string> = {
  lot: 'a lot number',
  plant: 'a plant / establishment number',
  item: 'an item or product code',
  po: 'a purchase order number',
  phone: 'a phone or fax number',
};

interface LabelHit {
  family: LabelFamily;
  /** The literal label text found in the document, for the reviewer message. */
  label: string;
}

/**
 * Every labelled occurrence of `value` in `text`. Unlabelled occurrences are
 * simply absent from the result (so "no labels anywhere" → empty array → skip).
 */
function labelHitsFor(text: string, value: string): LabelHit[] {
  const hits: LabelHit[] = [];
  if (!text || value.length < 3) return hits;
  const upperText = text.toUpperCase();
  const needle = value.toUpperCase();
  let from = 0;
  // Cap the scan: a pathological value + huge text should not spin.
  for (let guard = 0; guard < 50; guard++) {
    const at = upperText.indexOf(needle, from);
    if (at < 0) break;
    from = at + needle.length;
    // Standalone-token test — "40122" must not match inside "9940122X".
    const before = at > 0 ? upperText[at - 1] : ' ';
    const after = from < upperText.length ? upperText[from] : ' ';
    if (/[A-Z0-9]/.test(before) || /[A-Z0-9]/.test(after)) continue;
    const context = upperText.slice(Math.max(0, at - 40), at);
    for (const { family, re } of LABEL_PATTERNS) {
      const m = re.exec(context);
      if (m) {
        hits.push({ family, label: m[0].trim().replace(/\s+/g, ' ') });
        break; // one family per occurrence — first pattern wins
      }
    }
  }
  return hits;
}

// ---------------------------------------------------------------------------
// Tally plumbing
// ---------------------------------------------------------------------------

export function newTally(): InvariantTally {
  const t = {} as InvariantTally;
  for (const c of CHECKS) t[c] = { checked: 0, pass: 0, fail: 0, skipped: 0 };
  return t;
}

export function mergeTally(into: InvariantTally, from: InvariantTally): void {
  for (const c of CHECKS) {
    into[c].checked += from[c].checked;
    into[c].pass += from[c].pass;
    into[c].fail += from[c].fail;
    into[c].skipped += from[c].skipped;
  }
}

function bump(tally: InvariantTally, check: InvariantCheck, outcome: 'pass' | 'fail' | 'skip'): void {
  const t = tally[check];
  if (outcome === 'skip') {
    t.skipped += 1;
    return;
  }
  t.checked += 1;
  if (outcome === 'pass') t.pass += 1;
  else t.fail += 1;
}

/** Human-facing field label: "plant_number" → "Plant number". */
function label(field: string): string {
  const words = field.replace(/_/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// ---------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------

/**
 * Run every invariant over one extraction. Pure — same input, same output.
 */
export function checkExtraction(item: ExtractionInput, opts: CheckOptions = {}): CheckResult {
  const failures: InvariantFailure[] = [];
  const tally = newTally();
  const text = item.extracted_text || '';
  const textAlnum = alnum(text);
  const textUpper = text.toUpperCase();
  const hasText = textAlnum.length > 0;
  let verbatimLotHits = 0;
  let verbatimLotChecks = 0;

  const selfKeys = (opts.selfNames || [])
    .map((n) => alnum(n))
    .filter((n) => n.length >= 5);

  const fail = (
    check: InvariantCheck,
    field: string,
    scope: string,
    value: unknown,
    reason: string,
    message: string
  ) => {
    failures.push({
      check,
      field,
      scope,
      value: String(value).slice(0, 120),
      reason,
      message,
    });
  };

  for (const bundle of bundlesFor(item)) {
    if (bundle.unparseable) {
      failures.push({
        check: 'dates_parse',
        field: bundle.scope,
        scope: bundle.scope,
        value: '',
        reason: 'extraction JSON is unparseable',
        message: `The stored extraction for ${bundle.scope} is not valid JSON — nothing here can be trusted.`,
      });
      continue;
    }
    const f = bundle.fields as Record<string, unknown>;
    const scope = bundle.scope;

    // --- no_placeholder_value ---------------------------------------------
    // Run FIRST. A sentinel like "Multiple" is a real defect but it is NOT a
    // fabricated value, so it is scored here and excluded from every other
    // check below rather than double-counted as a hallucinated lot.
    const placeholder = new Set<string>();
    for (const key of SCALAR_KEYS) {
      const raw = asString(f[key]);
      if (!raw) continue;
      if (isPlaceholder(raw)) {
        placeholder.add(key);
        bump(tally, 'no_placeholder_value', 'fail');
        fail(
          'no_placeholder_value',
          key,
          scope,
          raw,
          'sentinel string instead of a value (field should be omitted)',
          `${label(key)} is the placeholder "${raw}", not a real value — clear the field or type the real one.`
        );
      } else {
        bump(tally, 'no_placeholder_value', 'pass');
      }
    }

    // --- lot_in_text + lot_not_a_date -------------------------------------
    for (const key of LOT_KEYS) {
      const raw = asString(f[key]);
      if (!raw || placeholder.has(key)) continue;

      if (looksLikeCalendarDate(raw)) {
        bump(tally, 'lot_not_a_date', 'fail');
        fail(
          'lot_not_a_date',
          key,
          scope,
          raw,
          'lot field holds a calendar date',
          `${label(key)} is a calendar date ("${raw}"), which is almost never a lot number.`
        );
      } else {
        bump(tally, 'lot_not_a_date', 'pass');
      }

      const norm = normalizeLotNumber(raw);
      if (!norm || !hasText) {
        bump(tally, 'lot_in_text', 'skip');
        continue;
      }
      verbatimLotChecks += 1;
      if (textUpper.includes(raw.toUpperCase())) verbatimLotHits += 1;

      // Deliberately the LOOSE test: the normalized lot must occur in the
      // fully-normalized text. This under-reports fabrication (a normalized
      // needle can span two unrelated tokens) but never accuses a value that
      // merely differs in punctuation. A failure here is a strong signal.
      if (textAlnum.includes(norm)) {
        bump(tally, 'lot_in_text', 'pass');
        bump(tally, 'single_value_per_field', 'pass');
        continue;
      }

      // Whole-string miss. Before calling it fabricated, check whether the
      // model crammed several real lots into one field — a different (and
      // much more common) defect, scored separately so the fabrication
      // number stays honest.
      const parts = splitMulti(raw);
      const partsFound = parts
        ? parts.filter((p) => {
            const pn = normalizeLotNumber(p);
            return pn && textAlnum.includes(pn);
          })
        : [];
      if (parts && partsFound.length >= 2) {
        bump(tally, 'single_value_per_field', 'fail');
        fail(
          'single_value_per_field',
          key,
          scope,
          raw,
          `${parts.length} values crammed into one field (${partsFound.length} of them do occur in the text)`,
          `${label(key)} holds ${parts.length} values in one field — this document probably needs ${parts.length} separate records.`
        );
        // Not a fabrication — the parts are grounded. Score lot_in_text on
        // whether EVERY part was found.
        if (partsFound.length === parts.length) {
          bump(tally, 'lot_in_text', 'pass');
        } else {
          bump(tally, 'lot_in_text', 'fail');
          fail(
            'lot_in_text',
            key,
            scope,
            raw,
            `${parts.length - partsFound.length} of ${parts.length} listed lots occur nowhere in extracted_text`,
            `${parts.length - partsFound.length} of the ${parts.length} lot numbers listed in ${label(key)} do not appear anywhere in the document text.`
          );
        }
      } else {
        bump(tally, 'single_value_per_field', 'pass');
        bump(tally, 'lot_in_text', 'fail');
        fail(
          'lot_in_text',
          key,
          scope,
          raw,
          `normalized "${norm}" occurs nowhere in extracted_text`,
          `This ${label(key).toLowerCase()} ("${raw}") does not appear anywhere in the document text.`
        );
      }
    }

    // --- sublot_shape ------------------------------------------------------
    for (const key of SUBLOT_KEYS) {
      const raw = asString(f[key]);
      if (!raw || placeholder.has(key)) continue;
      const norm = normalizeSubLotCode(raw);
      if (/^\d{2}$/.test(norm)) {
        bump(tally, 'sublot_shape', 'pass');
      } else {
        bump(tally, 'sublot_shape', 'fail');
        fail(
          'sublot_shape',
          key,
          scope,
          raw,
          `normalizes to "${norm}" (expected exactly 2 digits)`,
          `Sublot codes are always 2 digits; "${raw}" is not — the lot will not match the WMS side.`
        );
      }
    }

    // --- dates_parse / dates_plausible -------------------------------------
    const parsed: Record<string, Date> = {};
    for (const key of DATE_KEYS) {
      const raw = asString(f[key]);
      if (!raw || placeholder.has(key)) continue;
      const d = parseDate(raw);
      if (!d) {
        // Same multi-value guard as lots: only after the whole string has
        // failed do we try splitting, so "Sep 5, 2026" is never split.
        const parts = splitMulti(raw);
        const parsedParts = parts ? parts.filter((p) => parseDate(p)) : [];
        if (parts && parsedParts.length >= 2) {
          bump(tally, 'single_value_per_field', 'fail');
          fail(
            'single_value_per_field',
            key,
            scope,
            raw,
            `${parts.length} dates crammed into one field (${parsedParts.length} parse)`,
            `${label(key)} holds ${parts.length} dates in one field — this document probably needs ${parts.length} separate records.`
          );
          if (parsedParts.length === parts.length) {
            bump(tally, 'dates_parse', 'pass');
          } else {
            bump(tally, 'dates_parse', 'fail');
            fail(
              'dates_parse',
              key,
              scope,
              raw,
              `${parts.length - parsedParts.length} of ${parts.length} listed values do not parse`,
              `${parts.length - parsedParts.length} of the ${parts.length} values in ${label(key)} are not readable as dates.`
            );
          }
          bump(tally, 'dates_plausible', 'skip');
          continue;
        }
        bump(tally, 'single_value_per_field', 'pass');
        bump(tally, 'dates_parse', 'fail');
        bump(tally, 'dates_plausible', 'skip');
        fail(
          'dates_parse',
          key,
          scope,
          raw,
          'does not parse as a date',
          `${label(key)} ("${raw}") is not readable as a date.`
        );
        continue;
      }
      bump(tally, 'single_value_per_field', 'pass');
      bump(tally, 'dates_parse', 'pass');
      parsed[key] = d;
      const y = d.getUTCFullYear();
      if (y < PLAUSIBLE_MIN_YEAR || y > PLAUSIBLE_MAX_YEAR) {
        bump(tally, 'dates_plausible', 'fail');
        fail(
          'dates_plausible',
          key,
          scope,
          raw,
          `year ${y} outside ${PLAUSIBLE_MIN_YEAR}-${PLAUSIBLE_MAX_YEAR}`,
          `${label(key)} is in ${y} — that is outside the plausible range for this document.`
        );
      } else {
        bump(tally, 'dates_plausible', 'pass');
      }
    }

    // --- date_ordering -----------------------------------------------------
    const prodKey = PRODUCTION_KEYS.find((k) => parsed[k]);
    const prod = prodKey ? parsed[prodKey] : null;
    const exp = parsed.expiration_date || parsed.best_by_date || null;
    if (prod && exp) {
      const days = (exp.getTime() - prod.getTime()) / DAY;
      const expField = f.expiration_date ? 'expiration_date' : 'best_by_date';
      const expValue = asString(f.expiration_date || f.best_by_date);
      if (days < 0) {
        bump(tally, 'date_ordering', 'fail');
        fail(
          'date_ordering',
          expField,
          scope,
          expValue,
          `expires ${Math.round(-days)}d BEFORE ${prodKey}`,
          `This product expires ${Math.round(-days)} days BEFORE it was made — one of these two dates is wrong.`
        );
      } else if (days === 0) {
        bump(tally, 'date_ordering', 'fail');
        fail(
          'date_ordering',
          expField,
          scope,
          expValue,
          `expiration equals ${prodKey} (zero shelf life)`,
          `Expiry and production date are the same day (zero shelf life) — one of these two dates is wrong.`
        );
      } else if (days > MAX_SHELF_LIFE_DAYS) {
        bump(tally, 'date_ordering', 'fail');
        fail(
          'date_ordering',
          expField,
          scope,
          expValue,
          `${Math.round(days)}d shelf life (> ${MAX_SHELF_LIFE_DAYS}d)`,
          `That is a ${Math.round(days)}-day shelf life — far too long for dairy. This may be a reagent's expiry, not the product's.`
        );
      } else {
        bump(tally, 'date_ordering', 'pass');
      }
    } else if (prod && parsed.code_date) {
      const days = (parsed.code_date.getTime() - prod.getTime()) / DAY;
      if (days < 0) {
        bump(tally, 'date_ordering', 'fail');
        fail(
          'date_ordering',
          'code_date',
          scope,
          asString(f.code_date),
          `code date precedes ${prodKey}`,
          `The code date is before the production date — one of these two is wrong.`
        );
      } else {
        bump(tally, 'date_ordering', 'pass');
      }
    } else {
      bump(tally, 'date_ordering', 'skip');
    }

    // --- product_code_not_phone -------------------------------------------
    const pc = placeholder.has('product_code') ? '' : asString(f.product_code);
    if (pc) {
      const digits = pc.replace(/\D/g, '');
      let reason: string | null = null;
      if (looksLikePhone(pc)) reason = 'formatted as a phone number';
      else if (
        digits.length >= 10 &&
        new RegExp(
          `(?:phone|tel|telephone|fax|ph\\b|call)\\D{0,24}${digits.slice(0, 3)}\\D?${digits.slice(3, 6)}\\D?${digits.slice(6, 10)}`,
          'i'
        ).test(text)
      ) {
        reason = 'digits appear in a phone/fax context in the document text';
      }
      if (reason) {
        bump(tally, 'product_code_not_phone', 'fail');
        fail(
          'product_code_not_phone',
          'product_code',
          scope,
          pc,
          reason,
          `"${pc}" looks like the supplier's phone or fax number, not a product code.`
        );
      } else {
        bump(tally, 'product_code_not_phone', 'pass');
      }
    }

    // --- product_code_in_text ----------------------------------------------
    //
    // THE FABRICATION THIS EXISTS FOR. `lot_in_text` and `supplier_in_text`
    // already ground their fields; product_code did not, and that is precisely
    // why a fabricated code passed silently while the same class of defect was
    // caught on lots.
    //
    // Observed on real documents: the model emitted product_code "64917" on
    // Country Morning COAs whose ITEM # cell is BLANK. The value came out of
    // the few-shot PREVIOUS CORRECTIONS block — an example from another
    // document. The 122B fabricates the identical value, so this is not a
    // capacity problem to be solved with a bigger model; it is an ungrounded
    // value, and grounding is what catches it.
    //
    // Grounding also covers the other source of the same defect (a value
    // lifted from the FILENAME, which is not part of extracted_text) without
    // needing to know where the value came from. That is the point of checking
    // the output rather than policing the input.
    if (pc && hasText) {
      const pcn = alnum(pc);
      // Very short codes normalize to noise and would substring-match almost
      // any document. Skip rather than false-accuse — as with supplier names.
      if (pcn.length < 3) {
        bump(tally, 'product_code_in_text', 'skip');
      } else if (textAlnum.includes(pcn)) {
        // Deliberately the LOOSE test, matching lot_in_text: a normalized
        // needle can span two unrelated tokens, so this UNDER-reports
        // fabrication and never accuses a value that merely differs in
        // punctuation. A failure here is therefore a strong signal.
        bump(tally, 'product_code_in_text', 'pass');
      } else {
        bump(tally, 'product_code_in_text', 'fail');
        fail(
          'product_code_in_text',
          'product_code',
          scope,
          pc,
          'code occurs nowhere in extracted_text',
          `The product code "${pc}" does not appear anywhere in the document text — it may have been copied from a previous example rather than read off this document.`
        );
      }
    } else if (pc) {
      bump(tally, 'product_code_in_text', 'skip');
    }

    // --- supplier_in_text --------------------------------------------------
    const sup = placeholder.has('supplier_name') ? '' : asString(f.supplier_name);
    if (sup && hasText) {
      const n = alnum(sup);
      // Very short names normalize to noise; skip rather than false-accuse.
      if (n.length < 4) {
        bump(tally, 'supplier_in_text', 'skip');
      } else if (textAlnum.includes(n)) {
        bump(tally, 'supplier_in_text', 'pass');
      } else {
        bump(tally, 'supplier_in_text', 'fail');
        fail(
          'supplier_in_text',
          'supplier_name',
          scope,
          sup,
          'name occurs nowhere in extracted_text',
          `The supplier name "${sup}" does not appear anywhere in the document text.`
        );
      }
    } else if (sup) {
      bump(tally, 'supplier_in_text', 'skip');
    }

    // --- supplier_not_self -------------------------------------------------
    // "Medosweet reported as its own supplier" — 8th-ranked failure mode. The
    // supplier is whoever SENT the certificate; it is never the receiving org.
    if (sup && selfKeys.length > 0) {
      const n = alnum(sup);
      const clash = selfKeys.some((self) => n === self || n.includes(self) || self.includes(n));
      if (clash) {
        bump(tally, 'supplier_not_self', 'fail');
        fail(
          'supplier_not_self',
          'supplier_name',
          scope,
          sup,
          'supplier name matches the receiving organisation',
          `"${sup}" is your own organisation — the supplier is the company that SENT this document, not the one receiving it.`
        );
      } else {
        bump(tally, 'supplier_not_self', 'pass');
      }
    } else if (sup) {
      bump(tally, 'supplier_not_self', 'skip');
    }

    // --- field_label_mismatch ---------------------------------------------
    // The role-confusion check. See the block comment above LABEL_PATTERNS.
    if (hasText) {
      for (const [key, ownFamily] of Object.entries(FIELD_FAMILY)) {
        const raw = placeholder.has(key) ? '' : asString(f[key]);
        if (!raw || raw.length < 3) continue;
        const hits = labelHitsFor(text, raw);
        if (hits.length === 0) {
          bump(tally, 'field_label_mismatch', 'skip');
          continue;
        }
        if (hits.some((h) => h.family === ownFamily)) {
          bump(tally, 'field_label_mismatch', 'pass');
          continue;
        }
        const wrong = hits[0];
        bump(tally, 'field_label_mismatch', 'fail');
        fail(
          'field_label_mismatch',
          key,
          scope,
          raw,
          `labelled "${wrong.label}" in the document (${wrong.family}), filed as ${key} (${ownFamily})`,
          `In the document, "${raw}" is printed under "${wrong.label}" — that is ${FAMILY_NOUN[wrong.family]}, not ${FAMILY_NOUN[ownFamily]}.`
        );
      }
    }
  }

  return { failures, tally, verbatimLotHits, verbatimLotChecks };
}
