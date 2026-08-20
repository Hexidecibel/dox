/**
 * Spec-limit checking for COA test-result tables.
 *
 * WHY: `shared/extractionInvariants.ts` answers "did the model read the document
 * correctly?". This module answers a different question the portal has never
 * asked: "is the *result* acceptable?" A COA whose coliform count is 40 CFU/g
 * against a ≤10 limit is a food-safety event, and today it lands in the review
 * queue looking exactly like a clean one.
 *
 * TWO SOURCES OF TRUTH, deliberately separate:
 *
 *   source: 'printed'  The COA's own Specification / Pass-Fail columns. Needs no
 *                      configuration and works on every supplier from day one.
 *                      `functions/lib/llm.ts` already captures these verbatim and
 *                      explicitly forbids the model deriving conformance itself —
 *                      so the comparison happens HERE, in code we can test.
 *
 *   source: 'limit'    OUR configured acceptance limit (`spec_limits`), which is
 *                      often TIGHTER than what the supplier certifies against.
 *                      This is the one that catches what the paper doesn't.
 *
 * THREE-STATE, AND THAT IS THE WHOLE SAFETY ARGUMENT. Measured extraction
 * accuracy is ~90.6% and the results table is exactly where the known defects
 * live (multi-record collapse, misreads). A spec engine converts extraction
 * error into safety-signal error, and a FALSE NEGATIVE here is worse than having
 * shipped nothing at all — by then the buyer has been taught that the portal
 * catches this. So every row we had a limit for but could not honestly compare
 * comes back `not_checked` with a reason, never a silent pass.
 *
 * WARN, NEVER BLOCK — same contract as the invariant checks. Nothing in this
 * file can refuse an approval.
 *
 * PURE. No D1, no network, no clock. The caller resolves limits and hands them
 * in; that keeps this unit-testable the way `extractionInvariants.ts` is.
 */

import type { ExtractedTable } from './types';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type SpecOperator = '<' | '<=' | '>' | '>=' | 'between' | '==' | 'absent';

export type SpecVerdictKind = 'in_spec' | 'out_of_spec' | 'not_checked';

export type MeasuredKind =
  | 'numeric'
  | 'censored_lt'
  | 'censored_gt'
  | 'qualitative'
  | 'unparseable';

/** Canonical qualitative outcomes. `tntc` = too numerous to count. */
export type Qualifier = 'absent' | 'present' | 'tntc';

export interface MeasuredValue {
  kind: MeasuredKind;
  /** Magnitude for numeric / censored kinds, in the unit named by `unit`. */
  value: number | null;
  qualifier: Qualifier | null;
  /** Unit as printed alongside the value, when it carried one. */
  unit: string | null;
  raw: string;
}

/**
 * An acceptance limit, from either source. `min`/`max` are inclusive bounds in
 * the unit named by `unit`; a `<` / `>` operator is represented by an exclusive
 * bound (see `compareToLimit`).
 */
export interface SpecLimit {
  operator: SpecOperator;
  min: number | null;
  max: number | null;
  unit: string | null;
  /** How the limit was written, for display. */
  raw: string;
  /** Set when this came from a configured `spec_limits` row. */
  limit_id?: string | null;
  spec_test_id?: string | null;
  /** Sample basis a qualitative limit is stated over, in grams ("Absent/25g"). */
  basis_grams?: number | null;
}

/**
 * Where inside a scope a verdict lives. COAs carry test results in two shapes
 * and both are in production: free-form `tables` straight off the extractor, and
 * the records assembler's structured `groups`, whose `CoaResultCell` already
 * splits value / unit / spec. The review tile renders both, so both are checked.
 */
export type SpecTarget =
  | { kind: 'table'; table_index: number; row_index: number; table_name: string }
  | { kind: 'group'; group: string; cell: string };

export interface SpecVerdict {
  /** Which bundle the result lives in: 'ai_fields' | 'page_metadata' | 'record[N]'. */
  scope: string;
  target: SpecTarget;
  /** Test name exactly as the supplier printed it. */
  test_name_raw: string;
  value_raw: string;
  unit_raw: string | null;
  verdict: SpecVerdictKind;
  source: 'printed' | 'limit';
  /** Human rendering of what this row was judged against. */
  limit_text: string | null;
  /** Terse machine-ish explanation. Used by reports and the register. */
  reason: string;
  /**
   * One-line plain-English sentence for the reviewer. This is what the UI
   * renders — never a code. Same rule as the invariant checks: if it can't be
   * said in one line, the check shouldn't ship.
   */
  message: string;
  spec_test_id?: string | null;
  limit_id?: string | null;
  /** Normalized numeric value, when one could be derived. For the register. */
  value_num?: number | null;
}

/** Stable identity for a verdict, so UI state survives refetch. */
export function specVerdictKey(v: SpecVerdict): string {
  const where =
    v.target.kind === 'table'
      ? `t${v.target.table_index}r${v.target.row_index}`
      : `g${v.target.group}/${v.target.cell}`;
  return `${v.scope}::${where}::${v.source}`;
}

// ---------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------

/**
 * A unit resolved into a comparable form. `family` must match for two values to
 * be compared at all — CFU and MPN are different enumeration methods and CFU/g
 * and CFU/mL are different bases, so neither pair is convertible. Getting this
 * wrong is precisely the false-negative failure mode this module exists to avoid.
 */
export interface UnitInfo {
  /** 'cfu:mass', 'cfu:volume', 'mpn:mass', 'percent', 'ph', 'temp', 'plain'. */
  family: string;
  /**
   * Divisor that converts the printed magnitude to a per-one-basis quantity.
   * "CFU/100g" → 100, so 500 CFU/100g normalizes to 5 per gram.
   */
  perBasis: number;
  canonical: string;
}

const UNKNOWN_UNIT: UnitInfo = { family: 'unknown', perBasis: 1, canonical: '' };

/** Strip to lowercase alphanumerics — the comparison key for names and units. */
function norm(s: unknown): string {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/**
 * Parse a unit string into a comparable family. Returns `unknown` for anything
 * unrecognised, which the comparator treats as "assume it matches" rather than
 * as a mismatch — COAs routinely print the unit once in a header column, and
 * refusing to compare whenever a cell omits it would make the feature useless.
 */
export function normalizeUnit(raw: unknown): UnitInfo {
  const s = String(raw ?? '').trim();
  if (!s) return UNKNOWN_UNIT;
  const n = norm(s);
  if (!n) return UNKNOWN_UNIT;

  if (n === 'ph') return { family: 'ph', perBasis: 1, canonical: 'pH' };
  if (n === 'percent' || n === 'pct' || s.includes('%')) {
    return { family: 'percent', perBasis: 1, canonical: '%' };
  }
  if (n === 'c' || n === 'degc' || n === 'f' || n === 'degf') {
    return { family: 'temp', perBasis: 1, canonical: s };
  }

  // Enumeration units: <method>/<amount><basis>, e.g. CFU/g, cfu/100 g, MPN/mL.
  const m = /^(cfu|mpn|apc|spc|tpc|count|ct)(per|\/)?(\d+)?(g|gram|grams|ml|milliliter|milliliters|l|liter|liters|oz)?$/.exec(
    n
  );
  if (m) {
    const method = m[1] === 'cfu' || m[1] === 'mpn' ? m[1] : 'cfu';
    const amount = m[3] ? Number(m[3]) : 1;
    const basisRaw = m[4] ?? '';
    const basis = basisRaw.startsWith('g') ? 'mass' : basisRaw ? 'volume' : '';
    if (!basis) return { family: `${method}:unspecified`, perBasis: amount, canonical: s };
    // Normalise larger volume/mass units onto the base one.
    let perBasis = amount;
    if (basisRaw === 'l' || basisRaw.startsWith('liter')) perBasis = amount * 1000;
    if (basisRaw === 'oz') perBasis = amount * 28.3495;
    return { family: `${method}:${basis}`, perBasis, canonical: s };
  }

  return { family: `other:${n}`, perBasis: 1, canonical: s };
}

/**
 * Are these two units comparable, and if so what factor converts a magnitude in
 * `from` to the same footing as `to`? `null` means "do not compare".
 *
 * An unknown unit on either side is treated as agreement — see `normalizeUnit`.
 */
export function unitFactor(from: UnitInfo, to: UnitInfo): number | null {
  if (from.family === 'unknown' || to.family === 'unknown') return 1;
  if (from.family === to.family) return to.perBasis / from.perBasis;
  // An unspecified basis still tells us the method; allow it against either basis.
  const fMethod = from.family.split(':')[0];
  const tMethod = to.family.split(':')[0];
  const fUnspec = from.family.endsWith(':unspecified');
  const tUnspec = to.family.endsWith(':unspecified');
  if (fMethod === tMethod && (fUnspec || tUnspec)) return to.perBasis / from.perBasis;
  return null;
}

// ---------------------------------------------------------------------------
// Value parsing
// ---------------------------------------------------------------------------

/**
 * Result tokens meaning "nothing found". Deliberately EXCLUDES pass/conforms/
 * acceptable: those are conformance verdicts, not measurements, and reading
 * "Pass" as an absence would let a row assert its own compliance. The verdict
 * column handles them — see `PASS_VERDICT_TOKENS`.
 */
const ABSENT_TOKENS = new Set([
  'absent',
  'negative',
  'neg',
  'nd',
  'nondetect',
  'nondetected',
  'notdetected',
  'nonedetected',
  'none',
  'nil',
  'nonedetect',
  'nodetection',
]);

const PRESENT_TOKENS = new Set(['present', 'positive', 'pos', 'detected']);

const TNTC_TOKENS = new Set(['tntc', 'toonumeroustocount', 'countless', 'overgrown', 'confluent']);

/** Tokens that mean "this cell says nothing" — never a finding, never a warning. */
const EMPTY_TOKENS = new Set([
  '',
  'na',
  'n',
  'none',
  'null',
  'nil',
  'notapplicable',
  'notested',
  'nottested',
  'notrequired',
  'report',
  'reportonly',
  'seespec',
  'seespecification',
  'tbd',
  'pending',
  'x',
]);

/**
 * Is this cell blank / a placeholder? `none` and `nil` are deliberately in BOTH
 * this set and the absent set: as a *result* they mean "none detected", as a
 * *spec* they mean "nothing stated". Callers disambiguate by position.
 */
function isEmptyCell(raw: unknown): boolean {
  const s = String(raw ?? '').trim();
  if (!s) return true;
  if (/^[-–—.·*]+$/.test(s)) return true;
  return EMPTY_TOKENS.has(norm(s)) && !/\d/.test(s);
}

/** Pull a trailing unit off a value string ("40 CFU/g" → "CFU/g"). */
function trailingUnit(s: string): string | null {
  const m = /([a-zA-Z%][a-zA-Z0-9/%.\s]*)$/.exec(s.trim());
  if (!m) return null;
  const u = m[1].trim();
  if (!u || /^(est|estimated|approx|max|min)$/i.test(u)) return null;
  return u;
}

/** Parse scientific shorthand the labs actually print: 3.0x10^2, 1.2e3, 2×10³. */
function parseScientific(s: string): number | null {
  const cleaned = s.replace(/\s+/g, '').replace(/×/g, 'x').replace(/[²³⁴⁵⁶⁷⁸⁹]/g, (c) => {
    const map: Record<string, string> = {
      '²': '2', '³': '3', '⁴': '4', '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9',
    };
    return `^${map[c]}`;
  });
  const m = /^([+-]?\d*\.?\d+)x10\^?([+-]?\d+)$/i.exec(cleaned);
  if (m) return Number(m[1]) * Math.pow(10, Number(m[2]));
  const e = /^([+-]?\d*\.?\d+)e([+-]?\d+)$/i.exec(cleaned);
  if (e) return Number(e[1]) * Math.pow(10, Number(e[2]));
  return null;
}

/**
 * Parse a measured result cell. The zoo here is real, taken from COAs already in
 * the corpus: `<10`, `≤1`, `<1 est`, `40`, `40 CFU/g`, `3.0x10^2`, `>1000`,
 * `TNTC`, `Absent/25g`, `Negative`, `ND`, `< 10 est.`.
 */
export function parseMeasuredValue(raw: unknown): MeasuredValue {
  const s = String(raw ?? '').trim();
  const base: MeasuredValue = { kind: 'unparseable', value: null, qualifier: null, unit: null, raw: s };
  if (!s) return base;

  const n = norm(s);
  if (TNTC_TOKENS.has(n)) return { ...base, kind: 'qualitative', qualifier: 'tntc' };

  // "Absent/25g", "Negative in 25 g" — qualitative with a sample basis. Matched
  // against the ORIGINAL string so the word boundary survives ("Absent in 25 g"
  // collapses to "Absentin25g" once whitespace is stripped, and stops matching).
  const qualBasis = /^(absent|negative|neg|nd|not\s*detected|none\s*detected|present|positive|detected)\b/i.exec(s);
  if (qualBasis && !/\d+\s*(cfu|mpn)/i.test(s)) {
    const q = norm(qualBasis[1]);
    const qualifier: Qualifier = PRESENT_TOKENS.has(q) ? 'present' : 'absent';
    return { ...base, kind: 'qualitative', qualifier, unit: null };
  }

  if (ABSENT_TOKENS.has(n)) return { ...base, kind: 'qualitative', qualifier: 'absent' };
  if (PRESENT_TOKENS.has(n)) return { ...base, kind: 'qualitative', qualifier: 'present' };

  // Censored: <10, ≤ 10, <10 est, less than 10
  const cens = /^(<=|<|≤|>=|>|≥|lessthan|greaterthan)\s*(.+)$/i.exec(s.replace(/\s*(less\s+than)\s*/i, 'lessthan').replace(/\s*(greater\s+than)\s*/i, 'greaterthan'));
  if (cens) {
    const rest = cens[2].trim();
    const num = parseLeadingNumber(rest);
    if (num !== null) {
      const op = cens[1].toLowerCase();
      const isLt = op === '<' || op === '<=' || op === '≤' || op === 'lessthan';
      return {
        kind: isLt ? 'censored_lt' : 'censored_gt',
        value: num,
        qualifier: null,
        unit: trailingUnit(rest),
        raw: s,
      };
    }
  }

  const num = parseLeadingNumber(s);
  if (num !== null) return { kind: 'numeric', value: num, qualifier: null, unit: trailingUnit(s), raw: s };

  return base;
}

/** Leading magnitude of a string, honouring scientific shorthand and commas. */
function parseLeadingNumber(s: string): number | null {
  const sci = parseScientific(s.replace(/,/g, ''));
  if (sci !== null) return sci;
  const m = /^([+-]?[\d,]*\.?\d+)/.exec(s.trim().replace(/^[+]/, ''));
  if (!m) return null;
  const v = Number(m[1].replace(/,/g, ''));
  return Number.isFinite(v) ? v : null;
}

/**
 * Parse a limit as the document prints it: `<10`, `≤ 10`, `max 20000`,
 * `10 max`, `80-85`, `3.5 - 4.2`, `Absent/25g`, `NMT 100`, `Negative`.
 * Returns null when the cell states no limit at all ("N/A", "Report", "—").
 */
export function parseLimitExpression(raw: unknown): SpecLimit | null {
  const s = String(raw ?? '').trim();
  if (!s || isEmptyCell(s)) return null;
  const unit = trailingUnit(s);
  const n = norm(s);

  if (ABSENT_TOKENS.has(n) || /^(absent|negative|nd|not\s*detected|none\s*detected)\b/i.test(s)) {
    return { operator: 'absent', min: null, max: null, unit: null, raw: s, basis_grams: basisGrams(s) };
  }

  // Range: "80-85", "3.5 to 4.2", "between 6.4 and 6.8"
  const range = /([+-]?[\d,]*\.?\d+)\s*(?:-|–|—|to|and)\s*([+-]?[\d,]*\.?\d+)/i.exec(s);
  if (range && !/^</.test(s) && !/^>/.test(s)) {
    const lo = Number(range[1].replace(/,/g, ''));
    const hi = Number(range[2].replace(/,/g, ''));
    if (Number.isFinite(lo) && Number.isFinite(hi) && hi >= lo) {
      return { operator: 'between', min: lo, max: hi, unit, raw: s };
    }
  }

  // "NMT 100" (not more than), "max 20000", "100 max", "<= 10".
  // Word-boundaried against the ORIGINAL string: a substring test on the
  // normalized form reads "Vitamin A 100" as a minimum, because "vitamin"
  // contains "min".
  const nmt = /\b(nmt|not\s*more\s*than|max|maximum|up\s*to|no\s*more\s*than)\b/i.test(s);
  const nlt = /\b(nlt|not\s*less\s*than|min|minimum|at\s*least|no\s*less\s*than)\b/i.test(s);
  const lead = /^(<=|<|≤|>=|>|≥)/.exec(s);
  const num = parseLeadingNumber(s.replace(/^(<=|<|≤|>=|>|≥)\s*/, '').replace(/^[a-z\s.]+/i, ''));
  const anyNum = num !== null ? num : parseLeadingNumber(s);
  if (anyNum === null) return null;

  if (lead) {
    const op = lead[1];
    if (op === '<') return { operator: '<', min: null, max: anyNum, unit, raw: s };
    if (op === '<=' || op === '≤') return { operator: '<=', min: null, max: anyNum, unit, raw: s };
    if (op === '>') return { operator: '>', min: anyNum, max: null, unit, raw: s };
    return { operator: '>=', min: anyNum, max: null, unit, raw: s };
  }
  if (nmt) return { operator: '<=', min: null, max: anyNum, unit, raw: s };
  if (nlt) return { operator: '>=', min: anyNum, max: null, unit, raw: s };

  // A bare number in a spec column is conventionally a ceiling for counts, but
  // guessing is exactly how a false negative gets manufactured. Refuse it.
  return null;
}

/** "Absent/25g" → 25. Null when no sample basis is stated. */
function basisGrams(s: string): number | null {
  const m = /(\d+(?:\.\d+)?)\s*(g|gram|grams)\b/i.exec(s);
  return m ? Number(m[1]) : null;
}

/** Human rendering of a limit, for the message and the register. */
export function formatLimit(limit: SpecLimit): string {
  const u = limit.unit ? ` ${limit.unit}` : '';
  switch (limit.operator) {
    case 'absent':
      return limit.basis_grams ? `absent in ${limit.basis_grams} g` : 'absent';
    case 'between':
      return `${limit.min}–${limit.max}${u}`;
    case '<':
      return `<${limit.max}${u}`;
    case '<=':
      return `≤${limit.max}${u}`;
    case '>':
      return `>${limit.min}${u}`;
    case '>=':
      return `≥${limit.min}${u}`;
    case '==':
      return `${limit.min}${u}`;
    default:
      return limit.raw;
  }
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

export interface Comparison {
  verdict: SpecVerdictKind;
  reason: string;
  /** Value converted onto the limit's footing, when that was possible. */
  value_num: number | null;
}

/**
 * Judge one measured value against one limit.
 *
 * The cases that must be right, in order of how badly getting them wrong hurts:
 *
 *  - `<10` against `≤10`  → in spec. The censored bound clears the limit.
 *  - `<50` against `≤10`  → NOT CHECKED. The true value could be 2 or 49; calling
 *                           this a pass is the false negative that discredits the
 *                           whole feature, and calling it a fail is a lie.
 *  - `TNTC` against any ceiling → out of spec. Uncountable exceeds any count.
 *  - CFU/mL against CFU/g → NOT CHECKED. Different basis, not convertible.
 */
export function compareToLimit(value: MeasuredValue, limit: SpecLimit): Comparison {
  if (value.kind === 'unparseable') {
    return { verdict: 'not_checked', reason: `result "${value.raw}" could not be read as a value`, value_num: null };
  }

  // Qualitative limits (absent / negative).
  if (limit.operator === 'absent') {
    if (value.kind === 'qualitative') {
      if (value.qualifier === 'absent') {
        const vb = basisGrams(value.raw);
        if (limit.basis_grams && vb && vb < limit.basis_grams) {
          return {
            verdict: 'not_checked',
            reason: `tested absent in ${vb} g but the limit requires absence in ${limit.basis_grams} g — a smaller sample is a weaker test`,
            value_num: null,
          };
        }
        return { verdict: 'in_spec', reason: 'reported absent', value_num: null };
      }
      if (value.qualifier === 'present') {
        return { verdict: 'out_of_spec', reason: 'reported present where the limit requires absence', value_num: null };
      }
      return { verdict: 'out_of_spec', reason: 'too numerous to count where the limit requires absence', value_num: null };
    }
    // A count against an absence limit: anything above zero is a detection.
    if (value.value !== null) {
      if (value.kind === 'censored_lt') {
        return { verdict: 'not_checked', reason: `reported as <${value.value}, which cannot confirm absence`, value_num: value.value };
      }
      return value.value > 0
        ? { verdict: 'out_of_spec', reason: `detected at ${value.value} where the limit requires absence`, value_num: value.value }
        : { verdict: 'in_spec', reason: 'reported as zero', value_num: 0 };
    }
    return { verdict: 'not_checked', reason: 'no comparable result', value_num: null };
  }

  // Qualitative result against a numeric limit.
  if (value.kind === 'qualitative') {
    if (value.qualifier === 'tntc') {
      const ceiling = limit.operator === '<' || limit.operator === '<=' || limit.operator === 'between';
      return ceiling
        ? { verdict: 'out_of_spec', reason: 'too numerous to count, which exceeds any numeric ceiling', value_num: null }
        : { verdict: 'not_checked', reason: 'too numerous to count, and the limit is not a ceiling', value_num: null };
    }
    if (value.qualifier === 'absent') {
      // "Absent"/"ND" against a ceiling is comfortably inside it.
      if (limit.operator === '<' || limit.operator === '<=') {
        return { verdict: 'in_spec', reason: 'reported absent, below the ceiling', value_num: null };
      }
      return { verdict: 'not_checked', reason: 'qualitative result against a non-ceiling limit', value_num: null };
    }
    return { verdict: 'not_checked', reason: 'qualitative result against a numeric limit', value_num: null };
  }

  // Numeric and censored values need a unit that lines up.
  const vu = normalizeUnit(value.unit);
  const lu = normalizeUnit(limit.unit);
  const factor = unitFactor(vu, lu);
  if (factor === null) {
    return {
      verdict: 'not_checked',
      reason: `result is in ${vu.canonical || 'an unknown unit'} but the limit is in ${lu.canonical || 'another unit'} — not comparable`,
      value_num: null,
    };
  }
  const v = (value.value as number) * factor;

  const exceedsCeiling = (bound: number, inclusive: boolean) => (inclusive ? v > bound : v >= bound);
  const belowFloor = (bound: number, inclusive: boolean) => (inclusive ? v < bound : v <= bound);

  switch (limit.operator) {
    case '<':
    case '<=': {
      const bound = limit.max as number;
      const inclusive = limit.operator === '<=';
      if (value.kind === 'censored_lt') {
        // "<X" clears the limit only when X itself already clears it. This holds
        // for both `<` and `<=`: a value strictly under 10 satisfies "<10" and
        // "≤10" alike, so the bound is inclusive either way.
        if (v <= bound) {
          return { verdict: 'in_spec', reason: `reported below ${value.value}, which clears the limit`, value_num: v };
        }
        return {
          verdict: 'not_checked',
          reason: `reported as <${value.value}, which straddles the ${bound} limit — the true value could fall either side`,
          value_num: v,
        };
      }
      if (value.kind === 'censored_gt') {
        return exceedsCeiling(bound, inclusive)
          ? { verdict: 'out_of_spec', reason: `reported above ${value.value}, past the ${bound} limit`, value_num: v }
          : { verdict: 'not_checked', reason: `reported as >${value.value}, which straddles the ${bound} limit`, value_num: v };
      }
      return exceedsCeiling(bound, inclusive)
        ? { verdict: 'out_of_spec', reason: `${v} exceeds the ${bound} limit`, value_num: v }
        : { verdict: 'in_spec', reason: `${v} is within the ${bound} limit`, value_num: v };
    }
    case '>':
    case '>=': {
      const bound = limit.min as number;
      const inclusive = limit.operator === '>=';
      if (value.kind === 'censored_gt') {
        return v >= bound
          ? { verdict: 'in_spec', reason: `reported above ${value.value}, which clears the minimum`, value_num: v }
          : { verdict: 'not_checked', reason: `reported as >${value.value}, which straddles the ${bound} minimum`, value_num: v };
      }
      if (value.kind === 'censored_lt') {
        return belowFloor(bound, inclusive)
          ? { verdict: 'out_of_spec', reason: `reported below ${value.value}, under the ${bound} minimum`, value_num: v }
          : { verdict: 'not_checked', reason: `reported as <${value.value}, which straddles the ${bound} minimum`, value_num: v };
      }
      return belowFloor(bound, inclusive)
        ? { verdict: 'out_of_spec', reason: `${v} is below the ${bound} minimum`, value_num: v }
        : { verdict: 'in_spec', reason: `${v} meets the ${bound} minimum`, value_num: v };
    }
    case 'between': {
      const lo = limit.min as number;
      const hi = limit.max as number;
      if (value.kind !== 'numeric') {
        return { verdict: 'not_checked', reason: `a censored result cannot be placed inside the ${lo}–${hi} range`, value_num: v };
      }
      return v < lo || v > hi
        ? { verdict: 'out_of_spec', reason: `${v} falls outside the ${lo}–${hi} range`, value_num: v }
        : { verdict: 'in_spec', reason: `${v} is inside the ${lo}–${hi} range`, value_num: v };
    }
    case '==': {
      const target = limit.min as number;
      if (value.kind !== 'numeric') {
        return { verdict: 'not_checked', reason: 'a censored result cannot be matched to an exact target', value_num: v };
      }
      return v === target
        ? { verdict: 'in_spec', reason: `${v} matches the target`, value_num: v }
        : { verdict: 'out_of_spec', reason: `${v} does not match the ${target} target`, value_num: v };
    }
    default:
      return { verdict: 'not_checked', reason: 'unsupported limit operator', value_num: v };
  }
}

// ---------------------------------------------------------------------------
// Table shape detection
// ---------------------------------------------------------------------------

const HEADER_SYNONYMS: Record<string, string[]> = {
  test: ['test', 'testname', 'analysis', 'analyte', 'parameter', 'attribute', 'property', 'description', 'item', 'characteristic', 'component'],
  spec: ['specification', 'spec', 'specs', 'limit', 'limits', 'requirement', 'requirements', 'acceptablerange', 'acceptancecriteria', 'standard', 'range', 'target', 'speclimit', 'tolerance'],
  result: ['result', 'results', 'value', 'measured', 'measuredvalue', 'actual', 'finding', 'findings', 'reading', 'testresult', 'analysisresult'],
  unit: ['unit', 'units', 'unitofmeasure', 'uom', 'measure'],
  verdict: ['passfail', 'pass', 'fail', 'status', 'conformance', 'conforms', 'judgment', 'judgement', 'verdict', 'disposition', 'resultstatus', 'compliance'],
};

export interface TableShape {
  test: number;
  spec: number;
  result: number;
  unit: number;
  verdict: number;
}

/**
 * Locate the meaningful columns of a test-results table. -1 for anything absent.
 * The test-name column falls back to column 0, which is where every COA in the
 * corpus puts it when the header is unlabelled.
 */
export function detectTableShape(headers: string[]): TableShape {
  const normed = headers.map(norm);
  const find = (key: string): number => {
    const syns = HEADER_SYNONYMS[key];
    let exact = -1;
    let partial = -1;
    normed.forEach((h, i) => {
      if (!h) return;
      if (syns.includes(h) && exact === -1) exact = i;
      if (partial === -1 && syns.some((s) => h.includes(s) && s.length > 3)) partial = i;
    });
    return exact !== -1 ? exact : partial;
  };
  // A column can only play one role. Result wins every tie — misreading the
  // measured value is the expensive mistake; misreading a label is not.
  const result = find('result');
  let spec = find('spec');
  if (spec === result) spec = -1;
  let test = find('test');
  if (test === result || test === spec) test = -1;
  // Every COA in the corpus puts the analyte in column 0 when the header is
  // unlabelled — but only claim it if nothing else already owns it.
  if (test === -1 && headers.length > 0 && result !== 0 && spec !== 0) test = 0;
  return { test, spec, result, unit: find('unit'), verdict: find('verdict') };
}

const FAIL_VERDICT_TOKENS = new Set([
  'fail',
  'failed',
  'failure',
  'out',
  'outofspec',
  'outofspecification',
  'reject',
  'rejected',
  'nonconforming',
  'nonconformance',
  'noncompliant',
  'ncr',
  'unsatisfactory',
  'no',
]);

const PASS_VERDICT_TOKENS = new Set([
  'pass',
  'passed',
  'ok',
  'yes',
  'conforms',
  'conforming',
  'compliant',
  'satisfactory',
  'accept',
  'accepted',
  'withinspec',
  'meetsspec',
]);

// ---------------------------------------------------------------------------
// Phase 0 — the document's own printed spec
// ---------------------------------------------------------------------------

export interface SpecSource {
  /** 'ai_fields' | 'page_metadata' | 'record[N]'. */
  scope: string;
  /** Free-form tables straight off the extractor. */
  tables?: ExtractedTable[];
  /**
   * The records assembler's structured groups (`CoaRecord.groups`), whose cells
   * already carry value / unit / spec separately. Shape mirrors
   * `Record<string, Record<string, CoaResultCell>>` without importing it, so
   * this module stays dependency-free.
   */
  groups?: Record<string, Record<string, { value?: string | null; unit?: string | null; spec?: string | null }>>;
}

/** One row or cell, reduced to the four things a judgement needs. */
interface PrintedRow {
  testName: string;
  resultRaw: string;
  specRaw: string;
  verdictRaw: string;
  unitRaw: string;
}

/**
 * Judge one printed row. Returns null when there is nothing worth saying —
 * which is most rows, and deliberately so.
 *
 * NOISE CONTRACT: only `out_of_spec` is reported, plus the narrow slice of
 * `not_checked` where BOTH a limit and a result parsed but the comparison was
 * blocked (straddling censored value, incompatible units). A spec cell reading
 * "N/A" or "Report" produces nothing at all — the supplier stated no limit, so
 * there is nothing for a reviewer to act on.
 */
function judgePrinted(scope: string, target: SpecTarget, row: PrintedRow): SpecVerdict | null {
  const { testName, resultRaw, specRaw, verdictRaw, unitRaw } = row;
  if (!testName) return null;

  const base = {
    scope,
    target,
    test_name_raw: testName,
    value_raw: resultRaw,
    unit_raw: unitRaw || null,
    source: 'printed' as const,
  };

  // 1. The document's own verdict — which some COAs put in a dedicated column
  //    and others put in the result column itself ("Coliform | <10 | Pass").
  //    Both are the document asserting conformance, not a measurement, so
  //    neither is ever parsed as a value.
  const verdictCell = verdictRaw || resultRaw;
  const printedFail = !!verdictCell && FAIL_VERDICT_TOKENS.has(norm(verdictCell));
  const printedPass = !!verdictCell && PASS_VERDICT_TOKENS.has(norm(verdictCell));
  const resultIsVerdict = !verdictRaw && !!resultRaw && (printedFail || printedPass);

  // 2. Result against the printed specification.
  const limit = parseLimitExpression(specRaw);
  const value = parseMeasuredValue(applyRowUnit(resultRaw, unitRaw));
  const comparable = !!limit && !resultIsVerdict && !isBlankResult(resultRaw);
  const cmp = comparable ? compareToLimit(value, withUnit(limit as SpecLimit, unitRaw)) : null;

  if (printedFail) {
    return {
      ...base,
      verdict: 'out_of_spec',
      limit_text: limit ? formatLimit(limit) : specRaw || null,
      reason: `document's own pass/fail column reads "${verdictCell}"`,
      message: `${testName}: the COA's own pass/fail column says "${verdictCell}".`,
      value_num: cmp?.value_num ?? null,
    };
  }

  if (!cmp) return null;
  const limitText = formatLimit(limit as SpecLimit);

  if (cmp.verdict === 'out_of_spec') {
    return {
      ...base,
      verdict: 'out_of_spec',
      limit_text: limitText,
      reason: cmp.reason,
      message: printedPass
        ? `${testName} is ${resultRaw} against the COA's own printed limit of ${limitText}, but the row is marked "${verdictCell}" — the document contradicts itself.`
        : `${testName} is ${resultRaw}, outside the COA's own printed limit of ${limitText}.`,
      value_num: cmp.value_num,
    };
  }

  if (cmp.verdict === 'not_checked') {
    return {
      ...base,
      verdict: 'not_checked',
      limit_text: limitText,
      reason: cmp.reason,
      message: `${testName} could not be judged against the printed limit of ${limitText} — ${cmp.reason}.`,
      value_num: cmp.value_num,
    };
  }

  return null;
}

/**
 * Check every extracted test result against the limit the COA itself prints,
 * plus its own pass/fail column. Needs no configuration and runs on every
 * supplier from day one.
 *
 * Covers both shapes COAs arrive in: free-form `tables`, and the records
 * assembler's structured `groups`.
 */
export function checkPrintedSpecs(sources: SpecSource[]): SpecVerdict[] {
  const out: SpecVerdict[] = [];
  for (const src of sources) {
    (src.tables ?? []).forEach((table, ti) => {
      const shape = detectTableShape(table.headers || []);
      // Nothing to judge without a result column or a verdict column.
      if (shape.result === -1 && shape.verdict === -1) return;
      (table.rows || []).forEach((row, ri) => {
        const cell = (i: number) => (i >= 0 ? String(row[i] ?? '').trim() : '');
        const v = judgePrinted(
          src.scope,
          { kind: 'table', table_index: ti, row_index: ri, table_name: table.name || '' },
          {
            testName: cell(shape.test),
            resultRaw: cell(shape.result),
            specRaw: cell(shape.spec),
            verdictRaw: cell(shape.verdict),
            unitRaw: cell(shape.unit),
          }
        );
        if (v) out.push(v);
      });
    });

    for (const [groupName, cells] of Object.entries(src.groups ?? {})) {
      if (!cells || typeof cells !== 'object') continue;
      for (const [cellName, cell] of Object.entries(cells)) {
        if (!cell || typeof cell !== 'object') continue;
        const v = judgePrinted(
          src.scope,
          { kind: 'group', group: groupName, cell: cellName },
          {
            // The cell key IS the analyte name in the records payload.
            testName: cellName.replace(/_/g, ' '),
            resultRaw: String(cell.value ?? '').trim(),
            specRaw: String(cell.spec ?? '').trim(),
            verdictRaw: '',
            unitRaw: String(cell.unit ?? '').trim(),
          }
        );
        if (v) out.push(v);
      }
    }
  }
  return out;
}

/**
 * Is this RESULT cell empty? Narrower than `isEmptyCell`, which is for spec
 * cells: "None" and "Nil" in a result column mean *none detected*, which is a
 * finding, not a blank.
 */
function isBlankResult(raw: unknown): boolean {
  const s = String(raw ?? '').trim();
  if (!s) return true;
  if (/^[-–—.·*]+$/.test(s)) return true;
  return ['na', 'notapplicable', 'notested', 'nottested', 'notrequired', 'pending', 'tbd'].includes(
    norm(s)
  );
}

/** Attach the row's unit column to a bare value so the comparator can see it. */
function applyRowUnit(value: string, unit: string): string {
  if (!unit || !value) return value;
  if (trailingUnit(value)) return value;
  return `${value} ${unit}`;
}

/** A printed limit inherits the row's unit column when it states none itself. */
function withUnit(limit: SpecLimit, unit: string): SpecLimit {
  if (limit.unit || !unit) return limit;
  return { ...limit, unit };
}

// ---------------------------------------------------------------------------
// Phase 1 — OUR configured limits
// ---------------------------------------------------------------------------

/** A `spec_tests` row: the canonical analyte plus the names suppliers print. */
export interface SpecTestDef {
  id: string;
  name: string;
  aliases: string[];
  default_unit?: string | null;
}

/** A `spec_limits` row, joined to its analyte. */
export interface ConfiguredLimit {
  id: string;
  spec_test_id: string;
  operator: SpecOperator;
  value_min: number | null;
  value_max: number | null;
  unit: string | null;
  severity: 'warn' | 'alert';
  active: boolean;
  supplier_id: string | null;
  document_type_id: string | null;
  product_id: string | null;
  /** Tie-breaker when two limits are equally specific. */
  updated_at?: string | null;
}

/** What the document being reviewed is, for scope resolution. */
export interface LimitContext {
  supplier_id?: string | null;
  document_type_id?: string | null;
  product_ids?: string[];
}

/**
 * Score how specifically a limit targets this document. Higher wins.
 * Product (4) outranks supplier (2) outranks document type (1), so a
 * product-pinned limit beats a supplier-wide one even when the supplier row
 * also names a doctype.
 */
function specificity(l: ConfiguredLimit): number {
  return (l.product_id ? 4 : 0) + (l.supplier_id ? 2 : 0) + (l.document_type_id ? 1 : 0);
}

/** Does this limit's stated scope apply to this document? NULL means "any". */
function applies(l: ConfiguredLimit, ctx: LimitContext): boolean {
  if (!l.active) return false;
  if (l.supplier_id && l.supplier_id !== ctx.supplier_id) return false;
  if (l.document_type_id && l.document_type_id !== ctx.document_type_id) return false;
  if (l.product_id && !(ctx.product_ids || []).includes(l.product_id)) return false;
  return true;
}

/**
 * Pick the one limit that governs each analyte for this document: most specific
 * applicable row wins, ties broken by most recently updated.
 *
 * A tenant-wide row (every scope column NULL) is a legitimate winner and is what
 * makes the feature work on day one, before a single supplier is configured.
 */
export function resolveSpecLimits(
  limits: ConfiguredLimit[],
  ctx: LimitContext
): Map<string, ConfiguredLimit> {
  const best = new Map<string, ConfiguredLimit>();
  for (const l of limits) {
    if (!applies(l, ctx)) continue;
    const incumbent = best.get(l.spec_test_id);
    if (!incumbent) {
      best.set(l.spec_test_id, l);
      continue;
    }
    const ds = specificity(l) - specificity(incumbent);
    if (ds > 0 || (ds === 0 && (l.updated_at || '') > (incumbent.updated_at || ''))) {
      best.set(l.spec_test_id, l);
    }
  }
  return best;
}

/**
 * Match a printed test name to a configured analyte.
 *
 * EXACT ON THE NORMALIZED FORM ONLY — name first, then aliases. No substring or
 * fuzzy matching, deliberately: "Coliform" would substring-match "Fecal
 * Coliform", which is a different test with a different limit, and applying the
 * wrong limit is the same class of error as applying none while claiming
 * otherwise. An unmatched name is reported as unmatched, which is visible and
 * fixable by adding an alias; a mismatched name is invisible and wrong.
 */
export function matchSpecTest(testName: string, tests: SpecTestDef[]): SpecTestDef | null {
  const key = norm(testName);
  if (!key) return null;
  for (const t of tests) {
    if (norm(t.name) === key) return t;
  }
  for (const t of tests) {
    if ((t.aliases || []).some((a) => norm(a) === key)) return t;
  }
  return null;
}

/** Turn a stored limit row into the comparator's shape. */
export function toSpecLimit(l: ConfiguredLimit, test: SpecTestDef): SpecLimit {
  return {
    operator: l.operator,
    min: l.value_min,
    max: l.value_max,
    unit: l.unit || test.default_unit || null,
    raw: '',
    limit_id: l.id,
    spec_test_id: l.spec_test_id,
    basis_grams: null,
  };
}

export interface ConfiguredCheckResult {
  verdicts: SpecVerdict[];
  /**
   * Printed test names that matched no configured analyte. NOT warnings — a test
   * we hold no limit for is out of scope, and flagging each one would drown a
   * tenant with three limits under a fourteen-row COA. Surfaced as a quiet count
   * so the gap is discoverable without being noisy.
   */
  unmatched: string[];
}

/**
 * Check every extracted test result against OUR configured limits.
 *
 * `includePasses` controls whether `in_spec` verdicts come back. The review
 * queue does not want them (silence is the signal that a row is fine); the
 * approve-time register does, because "we checked this and it passed" is
 * precisely the record a QA buyer is paying for.
 */
export function checkConfiguredLimits(
  sources: SpecSource[],
  tests: SpecTestDef[],
  limits: ConfiguredLimit[],
  ctx: LimitContext,
  opts: { includePasses?: boolean } = {}
): ConfiguredCheckResult {
  const resolved = resolveSpecLimits(limits, ctx);
  const verdicts: SpecVerdict[] = [];
  const unmatched = new Set<string>();
  if (tests.length === 0) return { verdicts, unmatched: [] };

  const judge = (
    scope: string,
    target: SpecTarget,
    testName: string,
    valueRaw: string,
    unitRaw: string
  ) => {
    if (!testName) return;
    const test = matchSpecTest(testName, tests);
    if (!test) {
      unmatched.add(testName);
      return;
    }
    const configured = resolved.get(test.id);
    if (!configured) {
      unmatched.add(testName);
      return;
    }
    if (isBlankResult(valueRaw)) return;

    const limit = toSpecLimit(configured, test);
    const value = parseMeasuredValue(applyRowUnit(valueRaw, unitRaw));
    const cmp = compareToLimit(value, withUnit(limit, unitRaw));
    if (cmp.verdict === 'in_spec' && !opts.includePasses) return;

    const limitText = formatLimit(limit);
    const base = {
      scope,
      target,
      test_name_raw: testName,
      value_raw: valueRaw,
      unit_raw: unitRaw || null,
      source: 'limit' as const,
      limit_text: limitText,
      spec_test_id: test.id,
      limit_id: configured.id,
      value_num: cmp.value_num,
      reason: cmp.reason,
    };

    if (cmp.verdict === 'out_of_spec') {
      verdicts.push({
        ...base,
        verdict: 'out_of_spec',
        message: `${test.name} is ${valueRaw}, outside our limit of ${limitText}.`,
      });
    } else if (cmp.verdict === 'not_checked') {
      verdicts.push({
        ...base,
        verdict: 'not_checked',
        message: `${test.name} could not be judged against our limit of ${limitText} — ${cmp.reason}.`,
      });
    } else {
      verdicts.push({
        ...base,
        verdict: 'in_spec',
        message: `${test.name} is ${valueRaw}, within our limit of ${limitText}.`,
      });
    }
  };

  for (const src of sources) {
    (src.tables ?? []).forEach((table, ti) => {
      const shape = detectTableShape(table.headers || []);
      if (shape.result === -1) return;
      (table.rows || []).forEach((row, ri) => {
        const cell = (i: number) => (i >= 0 ? String(row[i] ?? '').trim() : '');
        judge(
          src.scope,
          { kind: 'table', table_index: ti, row_index: ri, table_name: table.name || '' },
          cell(shape.test),
          cell(shape.result),
          cell(shape.unit)
        );
      });
    });

    for (const [groupName, cells] of Object.entries(src.groups ?? {})) {
      if (!cells || typeof cells !== 'object') continue;
      for (const [cellName, cell] of Object.entries(cells)) {
        if (!cell || typeof cell !== 'object') continue;
        judge(
          src.scope,
          { kind: 'group', group: groupName, cell: cellName },
          cellName.replace(/_/g, ' '),
          String(cell.value ?? '').trim(),
          String(cell.unit ?? '').trim()
        );
      }
    }
  }

  return { verdicts, unmatched: [...unmatched] };
}

/**
 * Validate an operator/bounds combination before it is stored.
 *
 * Worth doing at write time rather than tolerating at read time: a limit row
 * with a missing bound cannot judge anything, and a limit that silently never
 * fires is the exact failure this feature is supposed to prevent. Returns a
 * reviewer-readable message, or null when the shape is sound.
 */
export function validateLimitShape(input: {
  operator: string;
  value_min?: number | null;
  value_max?: number | null;
}): string | null {
  const { operator } = input;
  const min = input.value_min ?? null;
  const max = input.value_max ?? null;
  const num = (v: number | null) => v !== null && Number.isFinite(v);

  switch (operator) {
    case '<':
    case '<=':
      return num(max) ? null : 'A maximum value is required for a "less than" limit.';
    case '>':
    case '>=':
      return num(min) ? null : 'A minimum value is required for a "greater than" limit.';
    case '==':
      return num(min) ? null : 'A target value is required for an "equals" limit.';
    case 'between':
      if (!num(min) || !num(max)) return 'A range needs both a minimum and a maximum.';
      return (min as number) <= (max as number)
        ? null
        : 'The minimum of a range must not exceed its maximum.';
    case 'absent':
      return null;
    default:
      return `Unknown operator "${operator}".`;
  }
}
