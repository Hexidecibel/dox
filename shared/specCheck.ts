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
 * ONE SETTING CAN CHANGE A VERDICT, and it announces itself. `UnitPolicy` lets a
 * tenant declare that CFU/mL and CFU/g are the same number for its products (a
 * fluid-dairy QA judgement, off by default). Any verdict it made reachable says
 * so in its reason, its message and a flag — never a bare "in spec". See the
 * type's own comment for the full argument and the lines it does NOT cross.
 *
 * WARN, NEVER BLOCK — same contract as the invariant checks. Nothing in this
 * file can refuse an approval.
 *
 * PURE. No D1, no network, no clock. The caller resolves limits and hands them
 * in; that keeps this unit-testable the way `extractionInvariants.ts` is.
 */

import type { ExtractedTable } from './types';
import { parseSpecCriticality } from './specCriticality';
import type { SpecCriticality } from './specCriticality';

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
  | {
      kind: 'table';
      table_index: number;
      row_index: number;
      table_name: string;
      /**
       * Which column the result came from. Only set for a CROSSTAB table, where
       * one row carries several analytes and `row_index` alone no longer
       * identifies a result. Absent for the ordinary one-analyte-per-row shape,
       * so existing keys are unchanged.
       */
      col_index?: number;
      /** The crosstab row's own label ("Product", "Buffer"), when it has one. */
      row_label?: string;
    }
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
  /**
   * True when this verdict was only reachable because the tenant equates
   * volume and mass bases (`UnitPolicy.volume_mass_equivalent`). `reason` and
   * `message` both say so in words; this is the flag the register freezes and
   * the UI can badge. Absent means the units lined up on their own.
   */
  unit_equivalence_applied?: boolean;
  /**
   * The unit conversion this comparison rested on — original unit, the unit it
   * was judged in, and the operation. Present on EVERY verdict whose printed
   * magnitude was scaled or equated, whatever the outcome; absent when the value
   * was compared as printed. See `UnitConversion`.
   */
  conversion?: UnitConversion;
  /**
   * Where the unit came from, when it was NOT printed on the result or in the
   * row's own unit column and had to be read off the page instead (a column
   * header, a units row). Absent means the result carried its own unit, or
   * none was found and none was invented.
   *
   * Recorded because an inferred unit is a weaker fact than a printed one: it
   * is the difference between "the lab wrote CFU/g beside this number" and "the
   * only place on this page that says CFU/g is the heading three rows up".
   * `reason` and `message` both say so in words; this is the machine-readable
   * copy for the register and the UI.
   */
  unit_inferred_from?: UnitOrigin;
  /**
   * The conformance word the LAB printed where a number belongs ("Pass",
   * "Fail"). Set only on `not_checked` verdicts from the configured-limit path:
   * we know what the lab concluded, we just have no measurement to compare to
   * our own limit or to trend. NEVER converted into `in_spec` / `out_of_spec` —
   * see the `lab_verdict` branch in `checkConfiguredLimits`.
   */
  lab_verdict?: 'pass' | 'fail';
  /**
   * How much the configured limit behind this verdict MATTERS (migration 0095).
   * Carried so the reviewer UI can rank a load-stopping failure above a tracked
   * one without re-resolving limits it never loaded — it is NOT an input to the
   * verdict, which is decided from the numbers alone.
   *
   * Absent on `source: 'printed'` verdicts: those are judged against the COA's
   * own text, and we hold no configured limit to rank them by. A reader treats
   * absent as `DEFAULT_SPEC_CRITICALITY`.
   */
  criticality?: SpecCriticality;
  /**
   * Set when the governing limit is a supplier WATCH with a review-by date
   * (migration 0109). The limit applied either way; `review_overdue` says the
   * period ended and a person should extend or remove it.
   */
  watch?: WatchStatus;
}

/**
 * Stable identity for one RESULT — a place in the payload, independent of which
 * limit judged it. Two verdicts on the same row (the COA's own printed limit and
 * ours) share this key, which is what lets the catch metric line a judgement up
 * against what the document claimed for the same cell.
 */
export function specResultKey(scope: string, target: SpecTarget): string {
  const where =
    target.kind === 'table'
      ? `t${target.table_index}r${target.row_index}${
          target.col_index === undefined ? '' : `c${target.col_index}`
        }`
      : `g${target.group}/${target.cell}`;
  return `${scope}::${where}`;
}

/** Stable identity for a verdict, so UI state survives refetch. */
export function specVerdictKey(v: SpecVerdict): string {
  return `${specResultKey(v.scope, v.target)}::${v.source}`;
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
 *
 * A PLACEHOLDER unit cell ("N/A", "none", "—") is the same statement as a blank
 * one: the row carries no unit. It must resolve to `unknown` for exactly the
 * reason above — classifying "N/A" as a unit in its own right made it mismatch
 * every real unit, so a placeholder was judged HARDER than a blank and 45 of the
 * 74 unjudgeable rows in the prod sample were nothing but this. The placeholder
 * vocabulary lives in one place, `isEmptyCell`; do not restate it here.
 */
export function normalizeUnit(raw: unknown): UnitInfo {
  const s = String(raw ?? '').trim();
  if (!s) return UNKNOWN_UNIT;

  // PERCENT FIRST, and the ordering is the whole point. `norm` keeps only
  // alphanumerics, so a bare "%" — by far the commonest way a percent is
  // printed — normalizes to the empty string, which made both the placeholder
  // test and the empty-key bail below fire on it and return `unknown`, i.e.
  // "assume it matches". A prod COA ("100/1OZ CUP CREAM CH SPRD - RASKAS") had a
  // micro specification misfiled onto its FAT row, and 24.26% was then compared
  // against a ≤10 CFU/g limit and reported OUT OF SPEC. Resolved properly, a
  // percent and a count are incomparable, which is `not_checked` — the honest
  // answer. A "%" is never a placeholder, so testing it first takes nothing
  // away from the placeholder rule below.
  const n = norm(s);
  if (n === 'percent' || n === 'pct' || s.includes('%')) {
    // "% w/w" and "% v/v" are different quantities for any product whose
    // density is not 1, so the basis is kept when the lab states one. A bare
    // "%" states none and stays `percent`, agreeing with any of them — the same
    // rule an unspecified CFU basis already follows.
    const basis = percentBasis(s);
    return basis
      ? { family: `percent:${basis}`, perBasis: 1, canonical: `% ${basis}` }
      : { family: 'percent', perBasis: 1, canonical: '%' };
  }

  if (isEmptyCell(s)) return UNKNOWN_UNIT;
  // Anything else with no alphanumerics left says nothing either.
  if (!n) return UNKNOWN_UNIT;

  if (n === 'ph') return { family: 'ph', perBasis: 1, canonical: 'pH' };
  if (n === 'c' || n === 'degc' || n === 'f' || n === 'degf') {
    return { family: 'temp', perBasis: 1, canonical: s };
  }

  // Enumeration units: <method>/<amount><basis>, e.g. CFU/g, cfu/100 g, MPN/mL.
  const m = parseEnumerationUnit(s);
  if (m) {
    const method = m.method === 'cfu' || m.method === 'mpn' ? m.method : 'cfu';
    const amount = m.amount;
    const basisRaw = m.basis;
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

/** The stated basis of a percentage, or null when it states none. */
function percentBasis(raw: string): 'w/w' | 'v/v' | 'w/v' | null {
  const t = raw.toLowerCase().replace(/\s+/g, '');
  if (/w\/v|wt\/vol|m\/v/.test(t)) return 'w/v';
  if (/w\/w|wt\/wt|m\/m/.test(t)) return 'w/w';
  if (/v\/v|vol\/vol/.test(t)) return 'v/v';
  return null;
}

const ENUMERATION_METHOD_RE =/^(cfu|mpn|apc|spc|tpc|count|ct)(per)?$/;
const ENUMERATION_BASIS_RE = /^(g|gram|grams|ml|milliliter|milliliters|l|liter|liters|oz)?$/;

/**
 * Split an enumeration unit into method, sample amount and basis.
 *
 * THE AMOUNT IS READ BEFORE ANYTHING IS NORMALIZED, and that ordering is the
 * fix for a 10x misread. `norm` keeps only alphanumerics, so "cfu/0.1g" used to
 * become "cfu01g", whose amount parsed as `01` = 1: a result of 5 CFU per 0.1 g
 * (50 per gram) was judged as 5 per gram and passed a ≤10 limit it fails five
 * times over. The number is therefore located on the RAW string, decimal point
 * intact, and only the text either side of it is normalized.
 *
 * The number must sit AFTER the method ("cfu/0.1g", "CFU per 0.1 g"); a number
 * in front of it ("10 cfu/g") is a value that leaked into the unit cell, not a
 * sample basis, and is not claimed as one. An amount of zero cannot be a basis
 * (it would divide by zero) and is refused. Returns null for anything that is
 * not an enumeration unit.
 */
function parseEnumerationUnit(raw: string): { method: string; amount: number; basis: string } | null {
  const lower = raw.toLowerCase();
  const num = /(\d*\.\d+|\d+)/.exec(lower);
  if (!num) {
    const m = /^(cfu|mpn|apc|spc|tpc|count|ct)(per)?(g|gram|grams|ml|milliliter|milliliters|l|liter|liters|oz)?$/.exec(
      norm(lower)
    );
    return m ? { method: m[1], amount: 1, basis: m[3] ?? '' } : null;
  }
  const head = ENUMERATION_METHOD_RE.exec(norm(lower.slice(0, num.index)));
  const tail = ENUMERATION_BASIS_RE.exec(norm(lower.slice(num.index + num[0].length)));
  if (!head || !tail) return null;
  const amount = Number(num[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return { method: head[1], amount, basis: tail[1] ?? '' };
}

/**
 * PER-TENANT UNIT POLICY — the one place a configured setting is allowed to
 * change a verdict, and it is deliberately narrow.
 *
 * `volume_mass_equivalent` lets `CFU/mL` be judged against a `CFU/g` limit (and
 * `MPN/mL` against `MPN/g`) at 1:1. OFF BY DEFAULT, and it must stay that way:
 * for a powder, per-gram and per-millilitre are genuinely different quantities
 * and refusing to compare them is the correct answer.
 *
 * WHY IT EXISTS. A fluid-dairy tenant's COAs print `cfu/mL` on the majority of
 * results while every limit on file is written in `CFU/g` — on production, 370
 * results against 265, so the majority unit matched no limit and came back
 * `not_checked`. The QA lead who wrote those limits states them as
 * "≤ 10 CFU/g (CFU/mL for fluid)": for milk and cream the density difference is
 * about 3%, immaterial against a 20,000 CFU ceiling. He considers them the same
 * number. That is a QA judgement about a product range, so it is a setting a
 * person makes, not an assumption code makes for them.
 *
 * WHAT IT IS NOT. It is not "ignore units". A percent against a CFU/g limit
 * stays `not_checked` — that is a real misalignment and it has already caught a
 * genuine extraction bug (a micro specification misfiled onto a FAT row). CFU
 * against MPN stays refused too: different enumeration methods, not a basis
 * difference. Only volume-vs-mass WITHIN one method is in scope.
 *
 * AND IT IS NEVER SILENT. Every verdict this setting made reachable says so in
 * its own reason text and carries `unit_equivalence_applied`, because an
 * equivalence that hides in a config table and produces a bare "in spec" is
 * exactly the false confidence the three-state design exists to prevent.
 */
export interface UnitPolicy {
  /** Judge `cfu:volume` against `cfu:mass` (and `mpn:*` likewise) at 1:1. */
  volume_mass_equivalent?: boolean;
}

/** Today's behaviour: nothing equated. The default everywhere. */
export const STRICT_UNIT_POLICY: UnitPolicy = {};

/** The outcome of lining two units up. */
export interface UnitMatch {
  /** Multiplier that puts a magnitude in `from` onto `to`'s footing. */
  factor: number;
  /**
   * True ONLY when the units are of genuinely different bases and the tenant's
   * `volume_mass_equivalent` setting is the sole reason they compared. A verdict
   * carrying this must say so in its reason.
   */
  equated: boolean;
}

/**
 * Are these two units comparable, and if so what factor converts a magnitude in
 * `from` to the same footing as `to`? `null` means "do not compare".
 *
 * An unknown unit on either side is treated as agreement — see `normalizeUnit`.
 */
export function resolveUnits(
  from: UnitInfo,
  to: UnitInfo,
  policy: UnitPolicy = STRICT_UNIT_POLICY
): UnitMatch | null {
  if (from.family === 'unknown' || to.family === 'unknown') return { factor: 1, equated: false };
  if (from.family === to.family) return { factor: to.perBasis / from.perBasis, equated: false };

  // Percentages: a stated w/w against a stated v/v is product-dependent and is
  // refused outright. No tenant setting reaches this — 0093 is volume-vs-mass
  // for COUNTS only. A bare "%" states no basis and agrees with either.
  if (from.family.startsWith('percent') && to.family.startsWith('percent')) {
    return from.family === 'percent' || to.family === 'percent' ? { factor: 1, equated: false } : null;
  }

  // An unspecified basis still tells us the method; allow it against either basis.
  const [fMethod, fBasis] = from.family.split(':');
  const [tMethod, tBasis] = to.family.split(':');
  if (fMethod !== tMethod) return null;
  if (fBasis === 'unspecified' || tBasis === 'unspecified') {
    return { factor: to.perBasis / from.perBasis, equated: false };
  }

  // The ONE case the tenant setting reaches. Note the method has already had to
  // match, so CFU-against-MPN and percent-against-CFU never arrive here.
  const volumeVsMass =
    (fBasis === 'volume' && tBasis === 'mass') || (fBasis === 'mass' && tBasis === 'volume');
  if (volumeVsMass && policy.volume_mass_equivalent) {
    return { factor: to.perBasis / from.perBasis, equated: true };
  }
  return null;
}

/**
 * The factor alone, for callers that do not care how it was reached. Anything
 * that renders a reason to a human should use `resolveUnits` instead, so an
 * equated comparison can name itself.
 */
export function unitFactor(
  from: UnitInfo,
  to: UnitInfo,
  policy: UnitPolicy = STRICT_UNIT_POLICY
): number | null {
  const m = resolveUnits(from, to, policy);
  return m ? m.factor : null;
}

/**
 * How an equated comparison explains itself. One phrasing, used by the reason
 * text and by the reviewer-facing message, so the register and the queue read
 * the same.
 */
export function unitEquivalenceNote(value: UnitInfo, limit: UnitInfo): string {
  const v = value.canonical || 'the printed unit';
  const l = limit.canonical || 'the limit unit';
  return `${v} judged as ${l}, per this tenant's setting`;
}

// ---------------------------------------------------------------------------
// Conversions are shown, never silent
// ---------------------------------------------------------------------------

/**
 * Which rule put a printed magnitude onto the limit's footing.
 *
 * `sample_basis`        arithmetic on the stated sample amount — CFU/100 g to
 *                       CFU/g, CFU/0.1 g to CFU/g, CFU/L to CFU/mL. True for
 *                       every product, so it needs no setting.
 * `tenant_volume_mass`  a per-mL result judged as per-g (or the reverse) because
 *                       THIS tenant said so (migration 0093). Product-dependent,
 *                       which is why it is a setting at all.
 */
export type UnitConversionRule = 'sample_basis' | 'tenant_volume_mass';

/**
 * A conversion applied to ONE compared value (SME ruling, 2026-09-14: "any unit
 * conversion applied to a comparison must be a visible attribute of the
 * compared value, not a log line"). Carried on the verdict, frozen into
 * `limit_snapshot`, and rendered as a chip beside the value in the review queue
 * and the register. Absent means the printed magnitude was compared as printed.
 */
export interface UnitConversion {
  /** The unit as printed on the result ("cfu/mL", "CFU/100g"). */
  from: string;
  /** The unit it was judged in — the limit's ("CFU/g"). */
  to: string;
  rule: UnitConversionRule;
  /** Multiplier applied to the printed magnitude. 1 for a pure equivalence. */
  factor: number;
  /** The operation in words: "÷ 100", "× 10", "1:1". */
  operation: string;
}

function roundFactor(x: number): number {
  return Number(x.toPrecision(6));
}

/**
 * Describe the conversion `resolveUnits` made, or null when none was made (the
 * units already agreed, or one side stated none — neither is a conversion).
 */
export function describeUnitConversion(
  from: UnitInfo,
  to: UnitInfo,
  match: UnitMatch
): UnitConversion | null {
  const scaled = Math.abs(match.factor - 1) > 1e-9;
  if (!match.equated && !scaled) return null;
  const operation = !scaled
    ? '1:1'
    : match.factor < 1
      ? `÷ ${roundFactor(1 / match.factor)}`
      : `× ${roundFactor(match.factor)}`;
  return {
    from: from.canonical || 'the printed unit',
    to: to.canonical || 'the limit unit',
    rule: match.equated ? 'tenant_volume_mass' : 'sample_basis',
    factor: roundFactor(match.factor),
    operation,
  };
}

/**
 * A conversion in a sentence, for `reason` and `message`. An equivalence keeps
 * the wording 0093 shipped with ("cfu/mL judged as CFU/g, per this tenant's
 * setting") so the register reads the same before and after this field.
 */
export function unitConversionNote(c: UnitConversion): string {
  if (c.rule === 'tenant_volume_mass') {
    return `${c.from} judged as ${c.to}, per this tenant's setting${c.operation === '1:1' ? '' : `, ${c.operation}`}`;
  }
  return `${c.from} converted to ${c.to}, ${c.operation}`;
}

/**
 * The one label for a conversion, used by every surface that shows one so the
 * review queue and the register read the same: "Converted: cfu/mL → CFU/g
 * (tenant setting)", "Converted: CFU/100g → CFU/g (÷ 100)".
 */
export function formatUnitConversion(c: UnitConversion): string {
  const how =
    c.rule === 'tenant_volume_mass'
      ? c.operation === '1:1'
        ? 'tenant setting'
        : `tenant setting, ${c.operation}`
      : c.operation;
  return `Converted: ${c.from} → ${c.to} (${how})`;
}

/**
 * Why two units were NOT compared, in words, from the rule that refused them.
 * Appended to the "not comparable" reason so a reviewer reading "could not
 * check" knows whether to verify by hand or to fix a setting.
 */
export function unitRefusalNote(from: UnitInfo, to: UnitInfo): string {
  const [fm, fb] = from.family.split(':');
  const [tm, tb] = to.family.split(':');
  if (fm === 'percent' && tm === 'percent') {
    return ' (a % w/w, % v/v or % w/v comparison depends on the product, so it is left for a person to verify)';
  }
  if (fm === tm && ((fb === 'volume' && tb === 'mass') || (fb === 'mass' && tb === 'volume'))) {
    return (
      ' (per-volume against per-mass depends on the product, so it is left for a person to verify — ' +
      'a tenant whose products make them the same number can say so in Settings › Spec Limits)'
    );
  }
  if (fm !== tm && (fm === 'cfu' || fm === 'mpn') && (tm === 'cfu' || tm === 'mpn')) {
    return ' (different counting methods)';
  }
  return '';
}

// ---------------------------------------------------------------------------
// A unit that is on the PAGE but not on the RESULT
// ---------------------------------------------------------------------------

/**
 * WHERE A UNIT WAS FOUND when the result cell did not carry one.
 *
 * `'column_header'`  the heading of the column the result sits in
 *                    ("Result (CFU/g)", "Aerobic, cfu/mL")
 * `'units_row'`      a row of the same table that declares each column's unit
 *                    rather than reporting a measurement
 *
 * The row's own unit COLUMN is not in this enumeration on purpose: that unit is
 * printed on the result's own line, it has always been read (`applyRowUnit`),
 * and calling it "inferred" would devalue the one case where the lab actually
 * stated the unit for this number.
 */
export type UnitOrigin = 'column_header' | 'units_row';

/**
 * A unit we RECOGNISE, as opposed to one we merely failed to parse.
 *
 * This is the gate on every inferred unit, and it is what keeps inference from
 * becoming invention. `normalizeUnit` returns `other:<text>` for anything it
 * does not understand and `unknown` for a blank or a placeholder; neither is
 * evidence of anything, and attaching one to a number would either refuse a
 * comparison for no reason or — far worse — make it look like the unit question
 * had been settled.
 */
function isKnownUnit(raw: unknown): boolean {
  const u = normalizeUnit(raw);
  return u.family !== 'unknown' && !u.family.startsWith('other:');
}

/**
 * Read a unit off a COLUMN HEADER: "Result (CFU/g)", "Aerobic [cfu/mL]",
 * "Coliform, CFU/g", "Plate count in CFU/g".
 *
 * ONLY FROM A DELIMITED POSITION, and that is the whole safety argument. A
 * heading is mostly prose, so scanning it for anything unit-shaped would read
 * "Coliform Count" as a count-per-unspecified-basis and "Total Plate Count" as
 * one too — a unit conjured out of an analyte's name, which is precisely the
 * invention the brief forbids ("Never assume"). A bracket, a trailing comma
 * clause or a trailing "in ..." is the lab deliberately annotating the column;
 * anything else is left alone. The candidate must then survive `isKnownUnit`,
 * so "Result (dry basis)" and "Aerobic (confirmed)" yield nothing.
 */
function unitFromHeader(header: unknown): string | null {
  const s = String(header ?? '').trim();
  if (!s) return null;
  const m =
    /[([{]([^)\]}]+)[)\]}]\s*$/.exec(s) ||
    /,\s*([^,]+)$/.exec(s) ||
    /\bin\s+([A-Za-z%][A-Za-z0-9/%.\s]*)$/i.exec(s);
  if (!m) return null;
  // "Result (in CFU/g)" — the preposition is part of the annotation, not of the
  // unit, and leaving it on makes `normalizeUnit` fail to recognise a unit it
  // otherwise knows perfectly well.
  const candidate = m[1].trim().replace(/^in\s+/i, '');
  return isKnownUnit(candidate) ? candidate : null;
}

/** How an inferred unit explains itself, in one phrasing used by every reader. */
export function unitInferenceNote(unit: string, from: UnitOrigin): string {
  const where = from === 'column_header' ? 'the column header' : "the table's units row";
  return `unit ${unit} read from ${where}, not printed on the result`;
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
  'nondetectable',
  'notdetected',
  'notdetectable',
  'nonedetected',
  'nonedetectable',
  'none',
  'nil',
  'nonedetect',
  'nodetection',
  'nogrowth',
  'nogrowthdetected',
]);

const PRESENT_TOKENS = new Set(['present', 'positive', 'pos', 'detected', 'detectable']);

/**
 * The absence vocabulary as it is PRINTED, hyphens and spaces intact — the one
 * place the phrasings live, read by both `parseMeasuredValue` (a result) and
 * `parseLimitExpression` (a spec).
 *
 * "Non-detectable" is here because a prod run could not judge
 * `Listeria monocytogenes` against an `absent` limit: the lab printed
 * "Non-detectable for Listeria mono/25g" and the value read as unparseable.
 * That is the pathogen result that matters most, so the phrasing has to be
 * understood — but see `parseMeasuredValue` for the deliberate limits on how
 * far a phrase is trusted.
 *
 * Longest alternatives first so `negative` is not clipped to `neg`.
 */
const ABSENT_PHRASE_SRC =
  'absent|negative|neg|non[\\s-]*detect(?:able|ed)?|not\\s*detect(?:able|ed)?|none\\s*detect(?:able|ed)?|no\\s*growth|no\\s*detection|nd';

const PRESENT_PHRASE_SRC = 'present|positive|detectable|detected|pos';

const ABSENT_PHRASE_RE = new RegExp(`^(?:${ABSENT_PHRASE_SRC})\\b`, 'i');

/**
 * Scan a whole string for qualitative claims, absence FIRST so that "not
 * detected" is consumed as an absence rather than leaving "detected" behind to
 * read as a presence.
 */
const QUAL_SCAN_RE = new RegExp(`\\b(?:${ABSENT_PHRASE_SRC})\\b|\\b(?:${PRESENT_PHRASE_SRC})\\b`, 'gi');
const PRESENT_ONLY_RE = new RegExp(`^(?:${PRESENT_PHRASE_SRC})$`, 'i');

/** Which qualitative families does this string claim? Both = it contradicts itself. */
function qualitativeFamilies(s: string): { absent: boolean; present: boolean } {
  let absent = false;
  let present = false;
  for (const m of s.match(QUAL_SCAN_RE) || []) {
    if (PRESENT_ONLY_RE.test(m.replace(/[\s-]+/g, ''))) present = true;
    else absent = true;
  }
  return { absent, present };
}

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
 *
 * THE ONE SOURCE OF TRUTH for the placeholder vocabulary. `normalizeUnit` and
 * `resultRestatesSpec` both read it, so "N/A", "n.a.", "--", "—" and friends
 * mean "this cell says nothing" identically wherever they land.
 */
function isEmptyCell(raw: unknown): boolean {
  const s = String(raw ?? '').trim();
  if (!s) return true;
  // A bare "%" normalises to the empty string, so without this it read as an
  // EMPTY token and `applyRowUnit` dropped it — leaving a fat percentage to be
  // judged as unitless against a CFU/g limit, which is the exact false alert
  // the percent family exists to refuse. "%" is a unit, not an absent value.
  if (s.includes('%')) return false;
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
const SUPERSCRIPTS: Record<string, string> = {
  '²': '2', '³': '3', '⁴': '4', '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9',
};

/**
 * Match scientific shorthand at the START of a string and report what is left
 * over, which is the unit.
 *
 * This deliberately does NOT anchor at the end. It used to, and the result was
 * the worst class of bug this module can have: `applyRowUnit` appends the unit
 * column to the value, so `3.0x10^2` + `CFU/g` became `3.0x10^2 CFU/g`, the
 * anchored match failed, and `parseLeadingNumber` fell back to the leading
 * token — yielding **3 instead of 300**, which reads as `in_spec` against a
 * ≤100 limit. A value three times over its limit passed silently, and every
 * scientific form was affected (`1.2e3` → 1.2, `2×10³` → 2, `5.0 x 10^4` → 5).
 * Labs print micro counts this way routinely, so this was not a corner case.
 */
function scientificPrefix(s: string): { value: number; rest: string } | null {
  const t = s.replace(/[²³⁴⁵⁶⁷⁸⁹]/g, (c) => `^${SUPERSCRIPTS[c]}`);
  const m = /^([+-]?\d*\.?\d+)\s*(?:x|×)\s*10\s*\^?\s*([+-]?\d+)/i.exec(t);
  if (m) return { value: Number(m[1]) * Math.pow(10, Number(m[2])), rest: t.slice(m[0].length) };
  // The negative lookahead keeps `1.2e3` from being read out of `1.2e3.5`, and
  // the required digits keep `1.2est` from looking like an exponent.
  const e = /^([+-]?\d*\.?\d+)e([+-]?\d+)(?![\d.])/i.exec(t);
  if (e) return { value: Number(e[1]) * Math.pow(10, Number(e[2])), rest: t.slice(e[0].length) };
  return null;
}

/** Parse scientific shorthand the labs actually print: 3.0x10^2, 1.2e3, 2×10³. */
function parseScientific(s: string): number | null {
  return scientificPrefix(s)?.value ?? null;
}

/**
 * Split a numeric cell into its magnitude and its unit, honouring scientific
 * shorthand. Kept separate from `trailingUnit` because that helper reads a unit
 * off the tail of the raw string, and on `1.2e3 CFU/g` it would claim the
 * exponent as part of the unit ("e3 CFU/g").
 */
function splitNumericAndUnit(s: string): { value: number; unit: string | null } | null {
  const sci = scientificPrefix(s.replace(/,/g, ''));
  if (sci) {
    const rest = sci.rest.trim();
    return { value: sci.value, unit: rest ? trailingUnit(rest) : null };
  }
  const num = parseLeadingNumber(s);
  if (num === null) return null;
  return { value: num, unit: trailingUnit(s) };
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

  // "Absent/25g", "Negative in 25 g", "Non-detectable for Listeria mono/25g" —
  // qualitative with trailing text. Matched against the ORIGINAL string so the
  // word boundary survives ("Absent in 25 g" collapses to "Absentin25g" once
  // whitespace is stripped, and stops matching).
  //
  // ONLY A LEADING TOKEN COUNTS, and that is a deliberate line. A cell that
  // BEGINS with an absence claim is the lab stating the result, with the rest
  // naming the analyte or the sample basis ("...for Listeria mono/25g"). A
  // token buried anywhere in a longer phrase is not the same statement: this
  // engine sits downstream of ~90.6% extraction accuracy and cells routinely
  // arrive carrying text from a neighbouring column, so a substring rule would
  // let the word "Absent" lifted out of a specification paragraph assert that a
  // pathogen test passed. A false "absent" on a pathogen is the worst output
  // this module can produce; a phrase we cannot confidently read stays
  // unparseable, which surfaces as `not_checked`, never as a pass.
  //
  // Same reasoning for a cell claiming BOTH ("Negative for Listeria, Positive
  // for Salmonella"): a contradiction is refused outright rather than resolved
  // in favour of whichever token happened to come first.
  const qualBasis = ABSENT_PHRASE_RE.exec(s) || /^(?:present|positive|detected|detectable)\b/i.exec(s);
  if (qualBasis && !/\d+\s*(cfu|mpn)/i.test(s)) {
    const fam = qualitativeFamilies(s);
    if (fam.absent && fam.present) return base; // contradictory — not readable
    const qualifier: Qualifier = fam.present ? 'present' : 'absent';
    return { ...base, kind: 'qualitative', qualifier, unit: null };
  }

  if (ABSENT_TOKENS.has(n)) return { ...base, kind: 'qualitative', qualifier: 'absent' };
  if (PRESENT_TOKENS.has(n)) return { ...base, kind: 'qualitative', qualifier: 'present' };

  // Censored: <10, ≤ 10, <10 est, less than 10
  const cens = /^(<=|<|≤|>=|>|≥|lessthan|greaterthan)\s*(.+)$/i.exec(s.replace(/\s*(less\s+than)\s*/i, 'lessthan').replace(/\s*(greater\s+than)\s*/i, 'greaterthan'));
  if (cens) {
    const rest = cens[2].trim();
    const parsed = splitNumericAndUnit(rest);
    if (parsed !== null) {
      const op = cens[1].toLowerCase();
      const isLt = op === '<' || op === '<=' || op === '≤' || op === 'lessthan';
      return {
        kind: isLt ? 'censored_lt' : 'censored_gt',
        value: parsed.value,
        qualifier: null,
        unit: parsed.unit,
        raw: s,
      };
    }
  }

  const parsed = splitNumericAndUnit(s);
  if (parsed !== null) {
    return { kind: 'numeric', value: parsed.value, qualifier: null, unit: parsed.unit, raw: s };
  }

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

  if (ABSENT_TOKENS.has(n) || ABSENT_PHRASE_RE.test(s)) {
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
  /**
   * Set when this verdict was only reachable because the tenant equates
   * volume and mass bases (see `UnitPolicy`). `reason` already names it; this
   * is the machine-readable copy, for the register and the UI.
   */
  unit_equivalence_applied?: boolean;
  /** The conversion the comparison rested on, when there was one. */
  conversion?: UnitConversion;
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
 *  - CFU/mL against CFU/g → NOT CHECKED. Different basis, not convertible —
 *                           UNLESS this tenant has said the two are the same
 *                           number for its products, in which case they are
 *                           compared and every reason produced says so out
 *                           loud. See `UnitPolicy`.
 */
export function compareToLimit(
  value: MeasuredValue,
  limit: SpecLimit,
  policy: UnitPolicy = STRICT_UNIT_POLICY
): Comparison {
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
  const match = resolveUnits(vu, lu, policy);
  if (match === null) {
    return {
      verdict: 'not_checked',
      reason: `result is in ${vu.canonical || 'an unknown unit'} but the limit is in ${lu.canonical || 'another unit'} — not comparable${unitRefusalNote(vu, lu)}`,
      value_num: null,
    };
  }
  const v = (value.value as number) * match.factor;
  const conversion = describeUnitConversion(vu, lu, match);

  /**
   * Every verdict below passes through here. When the tenant's unit-equivalence
   * setting is the only reason a comparison happened at all, the reason text
   * has to carry that — a bare "120 is within the 20000 limit" would be the
   * silent pass this module is built to refuse.
   *
   * A sample-basis conversion (CFU/100 g → CFU/g) is named the same way: the
   * number in the reason is the CONVERTED one, and "5 is within the 10 limit"
   * beside a printed "500" is unreadable unless the conversion is on the line.
   */
  const say = (c: Comparison): Comparison => {
    if (!conversion) return c;
    return {
      ...c,
      reason: `${c.reason} (${unitConversionNote(conversion)})`,
      ...(match.equated ? { unit_equivalence_applied: true } : {}),
      conversion,
    };
  };

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
          return say({ verdict: 'in_spec', reason: `reported below ${value.value}, which clears the limit`, value_num: v });
        }
        return say({
          verdict: 'not_checked',
          reason: `reported as <${value.value}, which straddles the ${bound} limit — the true value could fall either side`,
          value_num: v,
        });
      }
      if (value.kind === 'censored_gt') {
        return say(
          exceedsCeiling(bound, inclusive)
            ? { verdict: 'out_of_spec', reason: `reported above ${value.value}, past the ${bound} limit`, value_num: v }
            : { verdict: 'not_checked', reason: `reported as >${value.value}, which straddles the ${bound} limit`, value_num: v }
        );
      }
      return say(
        exceedsCeiling(bound, inclusive)
          ? { verdict: 'out_of_spec', reason: `${v} exceeds the ${bound} limit`, value_num: v }
          : { verdict: 'in_spec', reason: `${v} is within the ${bound} limit`, value_num: v }
      );
    }
    case '>':
    case '>=': {
      const bound = limit.min as number;
      const inclusive = limit.operator === '>=';
      if (value.kind === 'censored_gt') {
        return say(
          v >= bound
            ? { verdict: 'in_spec', reason: `reported above ${value.value}, which clears the minimum`, value_num: v }
            : { verdict: 'not_checked', reason: `reported as >${value.value}, which straddles the ${bound} minimum`, value_num: v }
        );
      }
      if (value.kind === 'censored_lt') {
        return say(
          belowFloor(bound, inclusive)
            ? { verdict: 'out_of_spec', reason: `reported below ${value.value}, under the ${bound} minimum`, value_num: v }
            : { verdict: 'not_checked', reason: `reported as <${value.value}, which straddles the ${bound} minimum`, value_num: v }
        );
      }
      return say(
        belowFloor(bound, inclusive)
          ? { verdict: 'out_of_spec', reason: `${v} is below the ${bound} minimum`, value_num: v }
          : { verdict: 'in_spec', reason: `${v} meets the ${bound} minimum`, value_num: v }
      );
    }
    case 'between': {
      const lo = limit.min as number;
      const hi = limit.max as number;
      if (value.kind !== 'numeric') {
        return say({ verdict: 'not_checked', reason: `a censored result cannot be placed inside the ${lo}–${hi} range`, value_num: v });
      }
      return say(
        v < lo || v > hi
          ? { verdict: 'out_of_spec', reason: `${v} falls outside the ${lo}–${hi} range`, value_num: v }
          : { verdict: 'in_spec', reason: `${v} is inside the ${lo}–${hi} range`, value_num: v }
      );
    }
    case '==': {
      const target = limit.min as number;
      if (value.kind !== 'numeric') {
        return say({ verdict: 'not_checked', reason: 'a censored result cannot be matched to an exact target', value_num: v });
      }
      return say(
        v === target
          ? { verdict: 'in_spec', reason: `${v} matches the target`, value_num: v }
          : { verdict: 'out_of_spec', reason: `${v} does not match the ${target} target`, value_num: v }
      );
    }
    default:
      // No comparison was made, so nothing was equated — an unsupported
      // operator is refused on its own terms, not because of a unit.
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

/**
 * THE conformance vocabulary, read in ONE place.
 *
 * A cell either states a verdict the lab reached or it does not. Both readers
 * of that question go through here: `printedClaim`, which asks it of the COA's
 * own pass/fail column, and `checkConfiguredLimits`, which meets the same words
 * sitting where a measurement should be ("COLIFORMS | Pass"). A second parser
 * for the second reader would be a vocabulary that could drift, and then the
 * same word would be a verdict on one code path and unreadable noise on the
 * other — which is exactly what it was.
 *
 * EXACT on the normalized cell, never substring: "Pass" is a verdict, "Passed
 * visual inspection after re-plating" is a sentence, and a result cell that
 * merely CONTAINS the word must not be allowed to assert its own conformance.
 */
export function readVerdictWord(cell: unknown): 'pass' | 'fail' | null {
  const key = norm(cell);
  if (!key) return null;
  if (FAIL_VERDICT_TOKENS.has(key)) return 'fail';
  if (PASS_VERDICT_TOKENS.has(key)) return 'pass';
  return null;
}

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
 * What the document CLAIMS about this row, before anything is measured.
 *
 * Factored out of `judgePrinted` because two callers need exactly the same
 * reading of it: the judgement below, and the catch metric at the foot of this
 * file, which is a statement about the document's claim and must not be allowed
 * to drift from what the judgement understood that claim to be.
 */
function printedClaim(row: PrintedRow): { cell: string; pass: boolean; fail: boolean } {
  // Some COAs put the claim in a dedicated column and others put it in the
  // result column itself ("Coliform | <10 | Pass"). Both are the document
  // asserting conformance rather than reporting a measurement.
  const cell = row.verdictRaw || row.resultRaw;
  const word = readVerdictWord(cell);
  return { cell, pass: word === 'pass', fail: word === 'fail' };
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
function judgePrinted(
  scope: string,
  target: SpecTarget,
  row: PrintedRow,
  policy: UnitPolicy = STRICT_UNIT_POLICY
): SpecVerdict | null {
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

  // 1. The document's own verdict. A claim is never parsed as a value.
  const { cell: verdictCell, pass: printedPass, fail: printedFail } = printedClaim(row);
  const resultIsVerdict = !verdictRaw && !!resultRaw && (printedFail || printedPass);

  // 2. Result against the printed specification.
  const limit = parseLimitExpression(specRaw);
  const value = parseMeasuredValue(applyRowUnit(resultRaw, unitRaw));
  const restated = resultRestatesSpec(resultRaw, specRaw, unitRaw);
  const comparable = !!limit && !resultIsVerdict && !restated && !isBlankResult(resultRaw);
  const cmp = comparable ? compareToLimit(value, withUnit(limit as SpecLimit, unitRaw), policy) : null;

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

  // 3. The result cell is the specification restated, not a measurement. It is
  //    not judged — and per the module contract it is not silently dropped
  //    either, because "we saw a number here and chose not to grade it" is
  //    exactly what a reviewer needs told.
  if (restated) {
    return {
      ...base,
      verdict: 'not_checked',
      limit_text: limit ? formatLimit(limit) : specRaw || null,
      reason: RESTATED_SPEC_REASON,
      message: `${testName} was not judged — ${RESTATED_SPEC_REASON}.`,
      value_num: null,
    };
  }

  if (!cmp) return null;
  const limitText = formatLimit(limit as SpecLimit);
  // A `not_checked` message already ends with `cmp.reason`, which carries the
  // note; appending it again would say it twice.
  const equatedSuffix = cmp.conversion ? ` (${unitConversionNote(cmp.conversion)})` : '';
  const equated = {
    ...(cmp.unit_equivalence_applied ? { unit_equivalence_applied: true } : {}),
    ...(cmp.conversion ? { conversion: cmp.conversion } : {}),
  };

  if (cmp.verdict === 'out_of_spec') {
    return {
      ...base,
      ...equated,
      verdict: 'out_of_spec',
      limit_text: limitText,
      reason: cmp.reason,
      message: printedPass
        ? `${testName} is ${resultRaw} against the COA's own printed limit of ${limitText}${equatedSuffix}, but the row is marked "${verdictCell}" — the document contradicts itself.`
        : `${testName} is ${resultRaw}, outside the COA's own printed limit of ${limitText}${equatedSuffix}.`,
      value_num: cmp.value_num,
    };
  }

  if (cmp.verdict === 'not_checked') {
    return {
      ...base,
      ...equated,
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
 * Walk every printed row, in ONE place.
 *
 * Two readers need the identical set of rows and the identical `PrintedRow` for
 * each: the judgement (`checkPrintedSpecs`) and the claim reader that the catch
 * metric is built on. If those two walks could disagree about which rows exist,
 * the metric would be counting claims against judgements made somewhere else —
 * so they share this iterator rather than each keeping their own copy.
 *
 * Covers both shapes COAs arrive in: free-form `tables`, and the records
 * assembler's structured `groups`.
 */
function forEachPrintedRow(
  sources: SpecSource[],
  visit: (scope: string, target: SpecTarget, row: PrintedRow) => void
): void {
  for (const src of sources) {
    (src.tables ?? []).forEach((table, ti) => {
      const shape = detectTableShape(table.headers || []);
      // Nothing to judge without a result column or a verdict column.
      if (shape.result === -1 && shape.verdict === -1) return;
      (table.rows || []).forEach((row, ri) => {
        const cell = (i: number) => (i >= 0 ? String(row[i] ?? '').trim() : '');
        visit(
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
      });
    });

    for (const [groupName, cells] of Object.entries(src.groups ?? {})) {
      if (!cells || typeof cells !== 'object') continue;
      for (const [cellName, cell] of Object.entries(cells)) {
        if (!cell || typeof cell !== 'object') continue;
        visit(
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
      }
    }
  }
}

/**
 * Check every extracted test result against the limit the COA itself prints,
 * plus its own pass/fail column. Needs no configuration and runs on every
 * supplier from day one.
 *
 * Covers both shapes COAs arrive in: free-form `tables`, and the records
 * assembler's structured `groups`.
 *
 * `unitPolicy` is the tenant's own statement about which units are the same
 * quantity for its products. It applies here as well as to our configured
 * limits: it is a claim about the PRODUCT range, not about whose limit is being
 * read, so a COA printing its spec in CFU/g beside a CFU/mL result is judged on
 * exactly the same footing.
 */
export function checkPrintedSpecs(
  sources: SpecSource[],
  opts: { unitPolicy?: UnitPolicy } = {}
): SpecVerdict[] {
  const policy = opts.unitPolicy ?? STRICT_UNIT_POLICY;
  const out: SpecVerdict[] = [];
  forEachPrintedRow(sources, (scope, target, row) => {
    const v = judgePrinted(scope, target, row, policy);
    if (v) out.push(v);
  });
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

/**
 * Attach the row's unit column to a bare value so the comparator can see it.
 * A placeholder unit cell is not attached: gluing "N/A" onto the value only
 * makes it back out again in `normalizeUnit`, and it would leak into the
 * `value.raw` quoted in reviewer-facing reasons.
 */
function applyRowUnit(value: string, unit: string): string {
  if (!unit || !value) return value;
  if (isEmptyCell(unit)) return value;
  if (trailingUnit(value)) return value;
  return `${value} ${unit}`;
}

/** A printed limit inherits the row's unit column when it states none itself. */
function withUnit(limit: SpecLimit, unit: string): SpecLimit {
  if (limit.unit || !unit || isEmptyCell(unit)) return limit;
  return { ...limit, unit };
}

// ---------------------------------------------------------------------------
// A result that is only its own specification restated
// ---------------------------------------------------------------------------

/**
 * The reason text, in one place: it is written into both the printed-spec and
 * the configured-limit verdict so the register reads the same either way.
 */
const RESTATED_SPEC_REASON =
  'the reported result is identical to the specification printed beside it, so it is a limit restated rather than a measurement';

/** Trim, fold case, drop thousands separators, collapse runs of whitespace. */
function restatementKey(raw: unknown): string {
  return String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/,/g, '')
    .replace(/\s+/g, ' ');
}

/**
 * Is this "result" just the row's own printed specification, copied across?
 *
 * REAL AND ALREADY IN THE CORPUS: 59 rows carry a result byte-identical to
 * their specification. The clearest are Andersen COAs, whose certification
 * paragraph names the regulatory thresholds ("...somatic cell (400,000 per ml.)
 * and bacteria standard plate count (100,000 per ml.)...") and whose extractor
 * lifts those numbers into the results table:
 *
 *     ["BACTERIA STANDARD PLATE COUNT", "100,000", "per ml.", "100,000 per ml.", "Pass"]
 *
 * Nothing was measured there. A unit mismatch happens to suppress those rows
 * today, but that is luck, not a decision — once units line up they would fire
 * as out_of_spec against a tighter configured limit, on a supplier already under
 * a sanitation alert. A false alert is the fastest way to teach a QA buyer to
 * ignore this feature.
 *
 * Note the Andersen row's result cell is "100,000" while the spec cell is
 * "100,000 per ml." — the restatement only shows up once the row's unit column
 * is put back on the value, so both forms are compared.
 *
 * THE GUARD, and why it is drawn where it is. A genuine measurement CAN equal
 * its own spec: a result of 0 against a limit of 0, a pH of 6.5 against a target
 * of 6.5, an "Absent" against a spec of "Absent". Suppressing one of those would
 * cost a real judgement, so this fires only when BOTH hold:
 *
 *   1. the value reads as a plain number — a qualitative result ("Absent",
 *      "Negative") equal to its spec is the normal way a COA reports a pass, and
 *      "<10" against "<10" is a detection limit, not boilerplate; and
 *   2. it carries at least 4 digits. Regulatory thresholds lifted off a page are
 *      big round numbers (100,000 / 400,000); the collisions that are genuine
 *      measurements are short (0, 6.5, 35, 100). Four digits is deliberately
 *      generous to the measurement: the bias is to keep judging, because a
 *      missed guard costs a duplicate alert a reviewer can dismiss, while an
 *      over-eager one hides a real failure behind "not checked".
 */
export function resultRestatesSpec(
  resultRaw: unknown,
  specRaw: unknown,
  unitRaw: unknown = ''
): boolean {
  const result = String(resultRaw ?? '').trim();
  const spec = String(specRaw ?? '').trim();
  const unit = String(unitRaw ?? '').trim();

  // Both a result and a spec must actually be present and say something.
  if (!result || !spec) return false;
  if (isEmptyCell(result) || isEmptyCell(spec)) return false;

  const specKey = restatementKey(spec);
  const withRowUnit = applyRowUnit(result, unit);
  if (restatementKey(result) !== specKey && restatementKey(withRowUnit) !== specKey) return false;

  // Guard 1 — only a plain number can be boilerplate here.
  const value = parseMeasuredValue(withRowUnit);
  if (value.kind !== 'numeric') return false;

  // Guard 2 — short values are where the genuine collisions live.
  return (result.match(/\d/g) || []).length >= 4;
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
  /**
   * Presentation rank (migration 0095), never a verdict input. OPTIONAL because
   * a row read from a database that predates 0095 — or from the fallback query
   * in `loadSpecConfig` — genuinely has no value; every read goes through
   * `parseSpecCriticality`, which lands on the middle tier.
   */
  criticality?: SpecCriticality | null;
  active: boolean;
  supplier_id: string | null;
  document_type_id: string | null;
  product_id: string | null;
  /** Tie-breaker when two limits are equally specific. */
  updated_at?: string | null;
  /**
   * When a supplier-scoped limit's WATCH PERIOD is due for review (migration
   * 0109), as YYYY-MM-DD. Passing it never loosens anything — the limit keeps
   * applying and the verdict is flagged instead. See `watchStatus`.
   */
  review_by?: string | null;
}

/**
 * A watch period's state at the moment of judgement.
 *
 * SME ruling (2026-09-14): a supplier under watch gets tighter limits and extra
 * required analytes for a period, then returns to company defaults — and
 * "nobody remembers to loosen by hand". The date is the reminder. It is NOT an
 * expiry: after it passes the tighter rule STILL APPLIES, because the unsafe
 * failure is a watch that quietly lapsed and let a supplier back onto looser
 * limits nobody chose. What changes is that every surface says the period
 * ended and asks a person to extend it or remove it.
 */
export interface WatchStatus {
  review_by: string;
  /** True once `as_of` is AFTER `review_by` (the review-by day itself is still inside the period). */
  review_overdue: boolean;
}

/** Normalize a stored date to YYYY-MM-DD, or null when it is not one. */
export function isoDay(raw: unknown): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(raw ?? '').trim());
  return m ? m[1] : null;
}

/**
 * The watch state for a review-by date as of a day. Null when there is no date.
 * Without an `asOf` nothing can be overdue: this module holds no clock, and
 * guessing "today" here would make a pure function time-dependent.
 */
export function watchStatus(reviewBy: unknown, asOf?: string | null): WatchStatus | null {
  const day = isoDay(reviewBy);
  if (!day) return null;
  const today = isoDay(asOf);
  return { review_by: day, review_overdue: !!today && today > day };
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
  /**
   * Labels of crosstab rows recognised as laboratory controls and therefore not
   * judged as product ("Buffer", "Negative Control"). Same quiet-count contract
   * as `unmatched`: skipped rows are never silently deleted, because "there were
   * rows here we chose not to grade" is exactly what this module refuses to keep
   * to itself.
   */
  control_rows: string[];
  /**
   * Labels of crosstab rows that were not results at all — an incubation log's
   * timing steps, a row declaring the columns' units. Distinct from
   * `control_rows`, which IS a measurement, just not of the product.
   *
   * Same quiet-count contract, and here it carries more weight than usual:
   * these rows produce NO verdict, not even `not_checked`, so this list is the
   * only trace that the engine looked at them and decided they held nothing to
   * judge. An unlabelled row appears as `row N` rather than being omitted.
   */
  non_measurement_rows: string[];
  /**
   * Printed results NOBODY judged: no configured limit applies to the analyte,
   * and the certificate prints no specification for it either (SME ruling,
   * 2026-09-14). A superset of `unmatched`'s names with the evidence attached,
   * because the portal must render "No limit configured" on the value itself
   * rather than imply an assurance it did not give. Distinct from `not_checked`,
   * which means we HELD a limit and could not apply it.
   */
  unjudged: UnjudgedResult[];
}

/**
 * One printed result that was not judged because nothing to judge it against
 * exists. `why` is the rule that left it unjudged:
 *   'no_analyte'         the printed name matches no configured analyte
 *   'no_limit_in_scope'  it matches one, but no limit applies to this supplier /
 *                        document type
 */
export interface UnjudgedResult {
  scope: string;
  target: SpecTarget;
  test_name_raw: string;
  value_raw: string;
  unit_raw: string | null;
  state: 'unjudged';
  why: 'no_analyte' | 'no_limit_in_scope';
  spec_test_id: string | null;
  /** The lab's own "Pass"/"Fail" where a number belongs, when it printed one. Not a verdict. */
  lab_verdict?: 'pass' | 'fail';
  reason: string;
  message: string;
}

/** The one label every surface uses for an unjudged result. */
export const NO_LIMIT_CONFIGURED_LABEL = 'No limit configured';

/**
 * CROSSTAB TABLES — a shape `detectTableShape` cannot describe.
 *
 * Two are in production and both were being dropped entirely by the row loop
 * below: no verdict, no `not_checked`, no `unmatched`. Silence is precisely the
 * failure this module exists to prevent, so they are detected here instead.
 *
 *   (a) a leading LABEL column, then one column per analyte
 *       ["Sample","Coliform","Aerobic"] / ["Product","<1","20"]
 *   (b) EVERY column an analyte
 *       ["FAT","MOISTURE","pH","SALT","COLIFORMS","YEAST/MOLD"]
 *
 * Detection deliberately lives HERE and not in `detectTableShape`, which is
 * analyte-blind by design: the only thing that tells these apart from an
 * ordinary table is the configured `spec_tests` list, which is in scope only in
 * `checkConfiguredLimits`.
 */
interface Crosstab {
  /** Column index of the row/sample label, or -1 when every column is an analyte. */
  labelIndex: number;
  /** Column indices to judge, in order. */
  resultIndexes: number[];
}

/**
 * A crosstab is claimed only when two or more headers name DISTINCT configured
 * analytes. One match is not enough — a two-column table whose second header
 * happens to be an analyte name is far more likely to be an ordinary table we
 * failed to read than a crosstab.
 */
function detectCrosstab(headers: string[], tests: SpecTestDef[]): Crosstab | null {
  if (headers.length < 2) return null;
  const matched = headers.map((h) => matchSpecTest(h, tests));
  const distinct = new Set(matched.filter(Boolean).map((t) => (t as SpecTestDef).id));
  if (distinct.size < 2) return null;
  // Only a LEADING non-analyte column is treated as the row label. A
  // non-analyte column anywhere else is judged like any other, which routes it
  // into the quiet `unmatched` count rather than dropping it unseen.
  const labelIndex = matched[0] === null ? 0 : -1;
  const resultIndexes = headers.map((_, i) => i).filter((i) => i !== labelIndex);
  return { labelIndex, resultIndexes };
}

/**
 * Row labels that name a laboratory CONTROL rather than the product.
 *
 * "Buffer" on a micro crosstab is the negative control — the sterile blank the
 * lab runs beside the sample. Judging it as product data is wrong in both
 * directions: a contaminated control raises an alarm about a product that was
 * never tested that way, and — worse — a reviewer who learns to wave off "that's
 * just the buffer" has been trained to wave off the real failure sitting next to
 * it.
 *
 * EXACT match on the normalized label, never substring. The failure modes are
 * not symmetric: mistaking a control for product costs one dismissible alert,
 * while mistaking product for a control silently drops a real result, which is
 * the false negative this whole module is built to avoid. So a label this list
 * does not recognise verbatim gets judged.
 */
const CONTROL_ROW_LABELS = new Set([
  'buffer',
  'buffers',
  'buffercontrol',
  'buffercontrols',
  'blank',
  'blanks',
  'blankcontrol',
  'control',
  'controls',
  'negativecontrol',
  'negativecontrols',
  'negcontrol',
  'positivecontrol',
  'poscontrol',
  'media',
  'mediacontrol',
  'mediablank',
  'sterility',
  'sterilitycontrol',
  'water',
  'watercontrol',
  'waterblank',
]);

/** Is this crosstab row a laboratory control rather than the product? */
export function isControlRowLabel(label: unknown): boolean {
  const key = norm(label);
  return !!key && CONTROL_ROW_LABELS.has(key);
}

/**
 * Does this cell record a POINT IN TIME rather than a quantity?
 *
 * Clock times ("12:08 PM", "11:00", "9:05:30") and calendar dates ("8/14/'26",
 * "08/14/2026", "2026-08-14"), with a date optionally followed by a time.
 * Deliberately anchored at both ends: a cell that is a date AND something else
 * is not a date, it is a cell we failed to read, and those are already handled.
 */
const CLOCK_SRC = String.raw`\d{1,2}:\d{2}(?::\d{2})?\s*(?:[ap]\.?m\.?)?`;
const CALENDAR_SRC = String.raw`\d{1,4}[/.\-]\d{1,2}[/.\-]'?\d{2,4}`;
const DATE_OR_TIME_RE = new RegExp(
  `^(?:${CLOCK_SRC}|${CALENDAR_SRC}(?:\\s+${CLOCK_SRC})?)$`,
  'i'
);

function isDateOrTimeCell(raw: unknown): boolean {
  const s = String(raw ?? '').trim();
  return !!s && DATE_OR_TIME_RE.test(s);
}

/**
 * A crosstab row that is not a MEASUREMENT — no verdict of any kind is produced
 * for it, `not_checked` included, because nothing here was ever a result.
 *
 * WHY THIS EXISTS. Andersen Dairy COAs carry an incubation log whose column
 * headers are the analyte names, so `detectCrosstab` reads it as a results
 * crosstab and grades the process steps beneath them:
 *
 *     Step      Coliform    Aerobic
 *     Date In   8/14/'26    8/14/'26
 *     Time In   12:08 PM    12:08 PM
 *     Date Out  8/15/'26    8/16/'26
 *     Time Out  12:56 PM    11:00 AM
 *
 * On production that produced 48 spurious "could not be checked" across 12
 * documents from the clock rows — and, worse and unreported, a silent PASS from
 * each date row, because `parseMeasuredValue("8/14/'26")` reads a leading 8 and
 * 8 is comfortably inside a ≤10 coliform limit. A false in-spec on the supplier
 * under sanitation scrutiny is the exact failure the three-state design exists
 * to prevent, and it was arriving from a table that reports no results at all.
 *
 * THE RULE IS ON THE CELLS, NOT ON THE LABEL, and that is the decision worth
 * defending. "Date In" / "Time Out" could have been four more strings beside
 * CONTROL_ROW_LABELS, and that would fix Andersen and leave the next lab's
 * "Plated At", "Read At" or "Incubación desde" to be discovered in production
 * the same way this was. A row whose cells are all clock times or calendar dates
 * is a timing log in any lab's table, in any wording, in any language — no
 * vocabulary to maintain and nothing to keep in step with reality.
 *
 * EVERY non-empty cell must agree, which is what makes this safe in the
 * direction that matters. The asymmetry is the same one CONTROL_ROW_LABELS
 * argues: mistaking a timing row for product costs a dismissible alert, while
 * mistaking product for a timing row silently drops a real result. So a row
 * carrying even one genuine measurement fails this test and is judged in full.
 *
 * AND IT IS NOT TAUGHT TO `parseMeasuredValue`. Refusing a date there would turn
 * these 96 cells into 96 `not_checked` rows — honest, and still noise about a
 * table that never held a result. Silence is the correct output here, and it is
 * only correct because we can say WHICH rows we were silent about: the labels
 * come back in `non_measurement_rows`.
 */
function isNonMeasurementRow(cells: string[]): boolean {
  const stated = cells.filter((c) => c && !isEmptyCell(c));
  if (stated.length === 0) return false;
  return stated.every(isDateOrTimeCell);
}

/**
 * Is this crosstab row DECLARING the columns' units rather than reporting
 * results? ("Units | CFU/g | CFU/g", or an unlabelled row of bare units.)
 *
 * Same cells-not-labels rule as `isNonMeasurementRow`, for the same reason, and
 * every cell must be a unit we actually RECOGNISE — a row of `other:<text>` is
 * a row we failed to read, not a units row. Two things follow from spotting it:
 * the row itself stops being graded (a cell reading "CFU/g" was previously an
 * unreadable "result"), and it becomes the unit for its column — see
 * `UnitOrigin`.
 */
function isUnitsRow(cells: string[]): boolean {
  const stated = cells.filter((c) => c && !isEmptyCell(c));
  if (stated.length === 0) return false;
  return stated.every((c) => isKnownUnit(c) && parseMeasuredValue(c).kind === 'unparseable');
}

/**
 * Check every extracted test result against OUR configured limits.
 *
 * `includePasses` controls whether `in_spec` verdicts come back. The review
 * queue does not want them (silence is the signal that a row is fine); the
 * approve-time register does, because "we checked this and it passed" is
 * precisely the record a QA buyer is paying for.
 *
 * `unitPolicy` is the tenant's unit-equivalence setting, passed in explicitly
 * rather than read from anywhere: this module holds no state, and a policy that
 * could be set once and then apply invisibly is the shape of exactly the bug
 * this feature must not become. Default is today's strict behaviour.
 */
export function checkConfiguredLimits(
  sources: SpecSource[],
  tests: SpecTestDef[],
  limits: ConfiguredLimit[],
  ctx: LimitContext,
  opts: { includePasses?: boolean; unitPolicy?: UnitPolicy; asOf?: string | null } = {}
): ConfiguredCheckResult {
  const policy = opts.unitPolicy ?? STRICT_UNIT_POLICY;
  const resolved = resolveSpecLimits(limits, ctx);
  const verdicts: SpecVerdict[] = [];
  const unmatched = new Set<string>();
  const controlRows = new Set<string>();
  const nonMeasurementRows = new Set<string>();
  const unjudged: UnjudgedResult[] = [];
  // No early return for a tenant with no analytes: every printed result is
  // then UNJUDGED, and saying so is the point (SME ruling, 2026-09-14). The
  // crosstab detector needs analytes to recognise a crosstab, so it simply
  // finds none; ordinary tables are still walked.

  /**
   * A printed result with nothing to judge it against. Recorded with the rule
   * that left it unjudged — but only when the certificate prints no
   * specification of its own for the row and does not call it a failure: a row
   * the printed-spec pass judged is not unjudged, whatever we hold.
   */
  const noteUnjudged = (
    scope: string,
    target: SpecTarget,
    testName: string,
    valueRaw: string,
    unitRaw: string,
    specRaw: string,
    verdictRaw: string,
    matched: SpecTestDef | null
  ) => {
    if (isBlankResult(valueRaw)) return;
    if (parseLimitExpression(specRaw)) return;
    const labWord = readVerdictWord(verdictRaw || valueRaw);
    if (labWord === 'fail') return;
    const printed = `${valueRaw}${unitRaw && !isEmptyCell(unitRaw) && !trailingUnit(valueRaw) ? ` ${unitRaw}` : ''}`;
    const reason = matched
      ? `${matched.name} is a configured analyte, but no limit applies to this supplier and document type, and the certificate prints no specification for it`
      : 'no configured analyte matches this name, and the certificate prints no specification for it';
    unjudged.push({
      scope,
      target,
      test_name_raw: testName,
      value_raw: valueRaw,
      unit_raw: unitRaw || null,
      state: 'unjudged',
      why: matched ? 'no_limit_in_scope' : 'no_analyte',
      spec_test_id: matched ? matched.id : null,
      ...(labWord ? { lab_verdict: labWord } : {}),
      reason,
      message: `${testName}: ${NO_LIMIT_CONFIGURED_LABEL.toLowerCase()} — ${printed} was printed and not judged.`,
    });
  };

  const judge = (
    scope: string,
    target: SpecTarget,
    testName: string,
    valueRaw: string,
    unitRaw: string,
    /** The row's own printed spec cell, when it has one. Only used to spot a
     *  result that is that spec restated — our limits are never read from it. */
    specRaw = '',
    /**
     * A unit found ELSEWHERE ON THE PAGE, used only when this result carries
     * none of its own and the row's unit column is blank. Never the limit's own
     * unit: falling back to that would make every unitless number silently
     * comparable to the very thing it is being judged against, which is the
     * failure the refusal exists to prevent.
     */
    unitHint: { unit: string; from: UnitOrigin } | null = null,
    /** The row's pass/fail column, when the table has one. Only read to keep a
     *  printed failure out of the unjudged list — it was judged, by the COA. */
    verdictRaw = ''
  ) => {
    if (!testName) return;
    const test = matchSpecTest(testName, tests);
    if (!test) {
      unmatched.add(testName);
      noteUnjudged(scope, target, testName, valueRaw, unitRaw, specRaw, verdictRaw, null);
      return;
    }
    const configured = resolved.get(test.id);
    if (!configured) {
      unmatched.add(testName);
      noteUnjudged(scope, target, testName, valueRaw, unitRaw, specRaw, verdictRaw, test);
      return;
    }
    if (isBlankResult(valueRaw)) return;

    const limit = toSpecLimit(configured, test);
    // A supplier watch rides along on EVERY verdict its limit produces —
    // passes, failures and refusals alike — so a lapsed watch is visible
    // wherever the result is, not only when something failed.
    const watch = watchStatus(configured.review_by, opts.asOf);
    const watched = watch ? { watch } : {};

    // Our limit is usually TIGHTER than what the supplier certifies against, so
    // this path is precisely where a spec restated in the result column would
    // fire as a false out_of_spec. Refuse to grade it, and say so.
    if (resultRestatesSpec(valueRaw, specRaw, unitRaw)) {
      const limitTextOnly = formatLimit(limit);
      verdicts.push({
        scope,
        target,
        test_name_raw: testName,
        value_raw: valueRaw,
        unit_raw: unitRaw || null,
        source: 'limit',
        limit_text: limitTextOnly,
        spec_test_id: test.id,
        limit_id: configured.id,
        criticality: parseSpecCriticality(configured.criticality),
        value_num: null,
        ...watched,
        reason: RESTATED_SPEC_REASON,
        verdict: 'not_checked',
        message: `${test.name} could not be judged against our limit of ${limitTextOnly} — ${RESTATED_SPEC_REASON}.`,
      });
      return;
    }

    /**
     * THE LAB GAVE A VERDICT WHERE A NUMBER BELONGS ("COLIFORMS | Pass").
     *
     * Recorded, not discarded. Until this branch existed the row came back
     * `result "Pass" could not be read as a value`, which throws away the one
     * fact the certificate did state — the lab's own conclusion — and reads to a
     * reviewer like an extraction failure rather than a lab that reports
     * qualitatively.
     *
     * IT STAYS `not_checked`, AND THAT IS THE POINT. We know what the lab
     * concluded; we have no measurement, so there is nothing to compare against
     * OUR limit (which is usually tighter than whatever the lab passed it
     * against) and nothing to trend. Turning the word into `in_spec` would
     * launder the lab's judgement into ours, and "Pass" is not evidence that a
     * count of 40 would have cleared a ≤10 ceiling. The word rides along in
     * `lab_verdict` for anyone who wants to act on it.
     *
     * The printed-spec path is untouched by this: a "Fail" there is already
     * reported as `out_of_spec` under `source: 'printed'`, which is correct —
     * that IS the document's own claim about its own limit.
     */
    const labVerdict = readVerdictWord(valueRaw);
    if (labVerdict) {
      const limitTextOnly = formatLimit(limit);
      const reason =
        `the lab reported "${valueRaw}" — a verdict with no number behind it, ` +
        `so there is nothing to compare with our limit`;
      verdicts.push({
        scope,
        target,
        test_name_raw: testName,
        value_raw: valueRaw,
        unit_raw: unitRaw || null,
        source: 'limit',
        limit_text: limitTextOnly,
        spec_test_id: test.id,
        limit_id: configured.id,
        criticality: parseSpecCriticality(configured.criticality),
        value_num: null,
        ...watched,
        lab_verdict: labVerdict,
        verdict: 'not_checked',
        reason,
        message:
          `${test.name}: the lab reported "${valueRaw}" and printed no number, ` +
          `so it could not be judged against our limit of ${limitTextOnly}.`,
      });
      return;
    }

    /**
     * The unit, in order of how well the page evidences it: printed on the
     * result itself (handled inside `applyRowUnit`), then the row's own unit
     * column, then whatever the caller found elsewhere on the page. If none of
     * those produced one, nothing is attached — an invented unit is worse than
     * no unit, because it makes a result silently comparable when it is not.
     */
    const rowUnitStated = !!unitRaw && !isEmptyCell(unitRaw);
    const hint = rowUnitStated ? null : unitHint;
    const effectiveUnitRaw = hint ? hint.unit : unitRaw;
    const valueWithUnit = applyRowUnit(valueRaw, effectiveUnitRaw);
    // Only claim inference when it actually changed what was judged: a value
    // carrying its own trailing unit is returned untouched by `applyRowUnit`.
    const inferred = hint && valueWithUnit !== valueRaw ? hint : null;
    const inferenceNote = inferred ? unitInferenceNote(inferred.unit, inferred.from) : '';
    const inferredSuffix = inferred ? ` (${inferenceNote})` : '';

    const effectiveLimit = withUnit(limit, effectiveUnitRaw);
    const value = parseMeasuredValue(valueWithUnit);
    const cmp = compareToLimit(value, effectiveLimit, policy);
    if (cmp.verdict === 'in_spec' && !opts.includePasses) return;

    const limitText = formatLimit(limit);
    // An equated comparison names itself in the reviewer-facing sentence too,
    // not only in `reason`. A pass that reads "120, within our limit of ≤20000
    // CFU/g" while the COA printed CFU/mL would be the quiet answer this
    // module refuses to give. `not_checked` already ends with `cmp.reason`,
    // which carries the note, so it is not repeated there.
    const equatedSuffix = cmp.conversion ? ` (${unitConversionNote(cmp.conversion)})` : '';
    // An inferred unit names itself in `reason` as well as in the sentence, so
    // the register — which stores `reason` verbatim — records a comparison that
    // rested on a heading rather than on the result's own line.
    const reason = inferred ? `${cmp.reason} (${inferenceNote})` : cmp.reason;
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
      // Ranking only — it rides along with every verdict this limit produces,
      // pass and fail alike, so the reviewer UI can sort without a second read.
      criticality: parseSpecCriticality(configured.criticality),
      value_num: cmp.value_num,
      reason,
      ...(cmp.unit_equivalence_applied ? { unit_equivalence_applied: true } : {}),
      ...(cmp.conversion ? { conversion: cmp.conversion } : {}),
      ...(inferred ? { unit_inferred_from: inferred.from } : {}),
      ...watched,
    };

    if (cmp.verdict === 'out_of_spec') {
      verdicts.push({
        ...base,
        verdict: 'out_of_spec',
        message: `${test.name} is ${valueRaw}, outside our limit of ${limitText}${equatedSuffix}${inferredSuffix}.`,
      });
    } else if (cmp.verdict === 'not_checked') {
      verdicts.push({
        ...base,
        verdict: 'not_checked',
        message: `${test.name} could not be judged against our limit of ${limitText} — ${reason}.`,
      });
    } else {
      verdicts.push({
        ...base,
        verdict: 'in_spec',
        message: `${test.name} is ${valueRaw}, within our limit of ${limitText}${equatedSuffix}${inferredSuffix}.`,
      });
    }
  };

  for (const src of sources) {
    (src.tables ?? []).forEach((table, ti) => {
      const headers = table.headers || [];
      const shape = detectTableShape(headers);

      // Crosstab first, and only when the ordinary shape found neither a result
      // nor a spec column — a table that HAS a result column is walked by the
      // row loop below, and a table is never walked twice.
      if (shape.result === -1 && shape.spec === -1) {
        const cross = detectCrosstab(headers, tests);
        if (cross) {
          const rows = table.rows || [];
          const cellsOf = (row: unknown[], idx: number[]) =>
            idx.map((i) => String(row[i] ?? '').trim());

          /**
           * The units row, found before anything is graded: it declares the
           * columns' units, so it is both a row that must not be judged and the
           * unit for every result beneath it. One per table — a second such row
           * is a table we are not reading correctly, so neither is trusted.
           */
          const unitRows = rows.filter((r) => isUnitsRow(cellsOf(r, cross.resultIndexes)));
          const unitsRow = unitRows.length === 1 ? unitRows[0] : null;

          rows.forEach((row, ri) => {
            const cell = (i: number) => (i >= 0 ? String(row[i] ?? '').trim() : '');
            const label = cell(cross.labelIndex);
            if (isControlRowLabel(label)) {
              // Counted, not judged, and not deleted either — see
              // CONTROL_ROW_LABELS.
              controlRows.add(label);
              return;
            }
            const resultCells = cellsOf(row, cross.resultIndexes);
            // Not a measurement at all — an incubation log's timing steps, or
            // the units row itself. No verdict of any kind; see
            // `isNonMeasurementRow` for why the rule is on the cells.
            if (isNonMeasurementRow(resultCells) || row === unitsRow) {
              nonMeasurementRows.add(label || `row ${ri + 1}`);
              return;
            }
            for (const ci of cross.resultIndexes) {
              // BACKSTOP for the row rule above, which needs EVERY cell to
              // agree before it will skip a row. A single timing cell in an
              // otherwise ordinary row would still be graded, and a date is not
              // refused when it is graded — it is READ, as the integer it
              // starts with ("8/15/'26" → 8), which lands comfortably inside a
              // ≤10 coliform limit and reports a silent pass. A clock time or a
              // calendar date is never a measurement, so it never gets a
              // verdict; the row it came from is reported instead.
              if (isDateOrTimeCell(cell(ci))) {
                nonMeasurementRows.add(label || `row ${ri + 1}`);
                continue;
              }
              judge(
                src.scope,
                {
                  kind: 'table',
                  table_index: ti,
                  row_index: ri,
                  table_name: table.name || '',
                  col_index: ci,
                  ...(label ? { row_label: label } : {}),
                },
                headers[ci] ?? '',
                cell(ci),
                // A crosstab carries its unit inside the cell ("<10 CFU/g",
                // "33.09%") and prints no spec of its own.
                '',
                '',
                // …and when it does not, the page may still say so somewhere:
                // this column's own heading, or a units row. Never our limit's
                // unit.
                unitHintFor(headers[ci], unitsRow ? String(unitsRow[ci] ?? '') : '')
              );
            }
          });
          return;
        }
      }

      if (shape.result === -1) return;
      // The result column's own heading, for rows that print no unit of their
      // own — "Result (CFU/g)". Computed once: it is a property of the table.
      const headerHint = unitHintFor(headers[shape.result], '');
      (table.rows || []).forEach((row, ri) => {
        const cell = (i: number) => (i >= 0 ? String(row[i] ?? '').trim() : '');
        judge(
          src.scope,
          { kind: 'table', table_index: ti, row_index: ri, table_name: table.name || '' },
          cell(shape.test),
          cell(shape.result),
          cell(shape.unit),
          cell(shape.spec),
          headerHint,
          cell(shape.verdict)
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
          String(cell.unit ?? '').trim(),
          String(cell.spec ?? '').trim()
        );
      }
    }
  }

  return {
    verdicts,
    unmatched: [...unmatched],
    control_rows: [...controlRows],
    non_measurement_rows: [...nonMeasurementRows],
    unjudged,
  };
}

/**
 * Where on the page a unit was found for a column, in order of how directly it
 * speaks about it: the column's own heading first, then the table's units row.
 * `null` when neither said anything we recognise — which stays `null`, because
 * the next candidate would have to be the limit's own unit and that is not
 * evidence about the result, it is the answer copied onto the question.
 */
function unitHintFor(header: unknown, unitsRowCell: string): { unit: string; from: UnitOrigin } | null {
  const fromHeader = unitFromHeader(header);
  if (fromHeader) return { unit: fromHeader, from: 'column_header' };
  const cell = unitsRowCell.trim();
  if (cell && isKnownUnit(cell)) return { unit: cell, from: 'units_row' };
  return null;
}

// ---------------------------------------------------------------------------
// Completeness — required analytes per supplier (migration 0109)
// ---------------------------------------------------------------------------

/**
 * A `supplier_required_analytes` row: an analyte this supplier's certificates of
 * this document type MUST report.
 *
 * SME ruling (2026-09-14): whatever the supplier's COA reports counts as
 * complete BY DEFAULT. Only this configuration can make a COA incomplete — so a
 * tenant that has written no rows gets no completeness findings at all, and a
 * supplier "on watch" gets extra analytes it must report for the watch period.
 */
export interface RequiredAnalyte {
  id: string;
  spec_test_id: string;
  supplier_id: string;
  document_type_id: string;
  /** YYYY-MM-DD; before this day the requirement does not apply yet. */
  effective_from?: string | null;
  /** YYYY-MM-DD; after this day the requirement STILL applies and is flagged. */
  review_by?: string | null;
  reason?: string | null;
}

/**
 * A required analyte the certificate did not report. Its own state — never a
 * pass, never folded into `not_checked` (which means a result WAS printed and
 * could not be compared).
 *
 * `why` is the rule that fired:
 *   'not_on_certificate'  no printed name matched the analyte or any alias
 *   'no_result'           it is printed, but the result cell is blank or a
 *                         placeholder ("Pending", "Not tested")
 */
export interface MissingRequiredAnalyte {
  /** Which bundle it is missing from: 'ai_fields' or 'record[N]'. */
  scope: string;
  state: 'missing_required';
  requirement_id: string;
  spec_test_id: string;
  analyte_name: string;
  why: 'not_on_certificate' | 'no_result';
  /** The printed name, when `why` is 'no_result'. */
  printed_as: string | null;
  watch: WatchStatus | null;
  requirement_reason: string | null;
  reason: string;
  message: string;
}

/** Does this requirement apply to this document on this day? */
export function requiredAnalyteApplies(
  r: RequiredAnalyte,
  ctx: LimitContext,
  asOf?: string | null
): boolean {
  if (!ctx.supplier_id || r.supplier_id !== ctx.supplier_id) return false;
  if (!ctx.document_type_id || r.document_type_id !== ctx.document_type_id) return false;
  const from = isoDay(r.effective_from);
  const today = isoDay(asOf);
  // Not yet effective only when both days are known; an unknown "today" never
  // silently disables a requirement somebody wrote.
  if (from && today && today < from) return false;
  return true;
}

/**
 * Which configured analytes a set of sources REPORTS, matched by name and
 * alias exactly as limits are (`matchSpecTest`). `withResult` is false when the
 * analyte is printed only beside a blank or placeholder result.
 */
function reportedAnalytes(
  sources: SpecSource[],
  tests: SpecTestDef[]
): Map<string, { withResult: boolean; printedAs: string }> {
  const out = new Map<string, { withResult: boolean; printedAs: string }>();
  const note = (name: string, value: string) => {
    const t = matchSpecTest(name, tests);
    if (!t) return;
    const has = !isBlankResult(value) && !isDateOrTimeCell(value);
    const prev = out.get(t.id);
    if (!prev || (!prev.withResult && has)) out.set(t.id, { withResult: has, printedAs: name });
  };
  for (const src of sources) {
    for (const table of src.tables ?? []) {
      const headers = table.headers || [];
      const rows = table.rows || [];
      const shape = detectTableShape(headers);
      if (shape.result === -1 && shape.spec === -1) {
        const cross = detectCrosstab(headers, tests);
        if (cross) {
          for (const ci of cross.resultIndexes) {
            const header = headers[ci] ?? '';
            const product = rows.filter(
              (r) => !isControlRowLabel(cross.labelIndex >= 0 ? r[cross.labelIndex] : '')
            );
            if (product.length === 0) note(header, '');
            for (const r of product) note(header, String(r[ci] ?? '').trim());
          }
          continue;
        }
      }
      // A result column, or failing that the lab's own pass/fail column: "Pass"
      // with no number is still the lab reporting the analyte. Whether it can
      // be judged is the limit check's question, answered there.
      const valueCol = shape.result !== -1 ? shape.result : shape.verdict;
      if (valueCol === -1 || shape.test === -1) continue;
      for (const r of rows) {
        note(String(r[shape.test] ?? '').trim(), String(r[valueCol] ?? '').trim());
      }
    }
    for (const cells of Object.values(src.groups ?? {})) {
      if (!cells || typeof cells !== 'object') continue;
      for (const [cellName, cell] of Object.entries(cells)) {
        if (!cell || typeof cell !== 'object') continue;
        note(cellName.replace(/_/g, ' '), String(cell.value ?? '').trim());
      }
    }
  }
  return out;
}

/**
 * Report every required analyte this document's certificate did not report.
 *
 * PER RECORD. A records-mode COA becomes one document per record, and a lot
 * whose own table omits coliform is incomplete even when the lot beside it
 * printed one — so each `record[N]` is judged on its own sources plus any
 * page-level ones (a header table applies to every record). A flat extraction
 * is judged once, under 'ai_fields'. No sources at all is still judged: a
 * certificate that yielded no results table reported nothing, and the message
 * says so rather than calling it complete.
 */
export function checkRequiredAnalytes(
  sources: SpecSource[],
  tests: SpecTestDef[],
  required: RequiredAnalyte[],
  ctx: LimitContext,
  opts: { asOf?: string | null } = {}
): MissingRequiredAnalyte[] {
  const applicable = required.filter((r) => requiredAnalyteApplies(r, ctx, opts.asOf));
  if (applicable.length === 0) return [];

  const isRecord = (s: SpecSource) => /^record\[\d+\]$/.test(s.scope);
  const shared = sources.filter((s) => !isRecord(s));
  const recordScopes = [...new Set(sources.filter(isRecord).map((s) => s.scope))];
  const units =
    recordScopes.length > 0
      ? recordScopes.map((scope) => ({ scope, sources: [...sources.filter((s) => s.scope === scope), ...shared] }))
      : [{ scope: shared[0]?.scope ?? 'ai_fields', sources: shared }];
  const noResults = sources.every((s) => (s.tables ?? []).length === 0 && Object.keys(s.groups ?? {}).length === 0);

  const byId = new Map(tests.map((t) => [t.id, t]));
  const out: MissingRequiredAnalyte[] = [];
  for (const unit of units) {
    const reported = reportedAnalytes(unit.sources, tests);
    for (const r of applicable) {
      const seen = reported.get(r.spec_test_id);
      if (seen?.withResult) continue;
      const name = byId.get(r.spec_test_id)?.name ?? 'A required analyte';
      const watch = watchStatus(r.review_by, opts.asOf);
      const why = seen ? 'no_result' : 'not_on_certificate';
      const reason =
        why === 'no_result'
          ? `required for this supplier, printed as "${seen!.printedAs}" with no result`
          : noResults
            ? 'required for this supplier, and no test results were read from this certificate at all'
            : 'required for this supplier, and not reported on this certificate under its name or any alias';
      out.push({
        scope: unit.scope,
        state: 'missing_required',
        requirement_id: r.id,
        spec_test_id: r.spec_test_id,
        analyte_name: name,
        why,
        printed_as: seen ? seen.printedAs : null,
        watch,
        requirement_reason: r.reason ?? null,
        reason,
        message:
          why === 'no_result'
            ? `${name} is required for this supplier and was printed with no result — the certificate is incomplete.`
            : `${name} is required for this supplier and is not on this certificate — the certificate is incomplete.`,
      });
    }
  }
  return out;
}

/**
 * Every watch in force for this document whose review-by day has passed: the
 * resolved supplier-scoped limits and the applicable required analytes. Read by
 * the review queue to say "watch period ended — review" whether or not any
 * result on this certificate happened to fail.
 */
export function overdueWatches(
  tests: SpecTestDef[],
  limits: ConfiguredLimit[],
  required: RequiredAnalyte[],
  ctx: LimitContext,
  asOf: string | null | undefined
): Array<{ kind: 'limit' | 'required_analyte'; id: string; spec_test_id: string; analyte_name: string; review_by: string }> {
  const name = (id: string) => tests.find((t) => t.id === id)?.name ?? 'an analyte';
  const out: Array<{ kind: 'limit' | 'required_analyte'; id: string; spec_test_id: string; analyte_name: string; review_by: string }> = [];
  for (const l of resolveSpecLimits(limits, ctx).values()) {
    const w = watchStatus(l.review_by, asOf);
    if (w?.review_overdue) {
      out.push({ kind: 'limit', id: l.id, spec_test_id: l.spec_test_id, analyte_name: name(l.spec_test_id), review_by: w.review_by });
    }
  }
  for (const r of required) {
    if (!requiredAnalyteApplies(r, ctx, asOf)) continue;
    const w = watchStatus(r.review_by, asOf);
    if (w?.review_overdue) {
      out.push({ kind: 'required_analyte', id: r.id, spec_test_id: r.spec_test_id, analyte_name: name(r.spec_test_id), review_by: w.review_by });
    }
  }
  return out;
}

/** "Watch period ended 2026-10-01 — review", the one phrasing every surface uses. */
export function watchEndedLabel(reviewBy: string): string {
  return `Watch period ended ${reviewBy} — review`;
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

// ---------------------------------------------------------------------------
// Catches — the certificate claimed a pass, the number says otherwise
// ---------------------------------------------------------------------------

/**
 * THE METRIC THIS PRODUCT IS ACTUALLY SOLD ON.
 *
 * Across the production corpus, seven certificates asserted a PASS on a row
 * whose extracted value breaches a limit. That is a category of error a human
 * reviewer misses PRECISELY BECAUSE the document says it is fine — nobody
 * re-reads a certificate that claims compliance. Folded into an overall accuracy
 * percentage it disappears; accuracy is a table-stakes claim every vendor makes,
 * and catches is the one nobody else can show. So it is counted on its own.
 *
 * THIS SECTION READS. It derives nothing new about whether a result passes: it
 * takes verdicts the engine above already produced and asks which of them
 * contradict the document's own claim. No verdict is computed, changed or
 * re-graded here, and nothing here can make a `not_checked` into a finding.
 *
 * THE THREE-STATE RULE CARRIES THROUGH. `not_checked` is an honest refusal, not
 * a finding, and it can NEVER be a catch — see `classifySpecDisagreement`, which
 * refuses it before anything else. A metric that quietly counted refusals would
 * be the same lie as a two-state verdict, told at the level of the number a
 * customer is shown.
 *
 * WHAT IT CANNOT SEE, stated rather than left to be discovered: a crosstab table
 * (one column per analyte) prints neither a specification nor a pass/fail
 * column, so it carries no claim, and its results can never be catches however
 * badly they fail. That is the correct answer — there is nothing for the
 * document to have been wrong about — but it means the count is a floor, not a
 * ceiling.
 */

/** What the document itself claims about a result. */
export type PrintedAssertionKind = 'pass' | 'fail' | 'none';

/**
 * Which cell carried the claim:
 *   'verdict_cell'  an explicit Pass/Fail the document printed
 *   'printed_limit' no explicit verdict, but the value sits inside the
 *                   specification the document printed for that row — the
 *                   document is still asserting conformance, just arithmetically
 */
export type PrintedAssertionBasis = 'verdict_cell' | 'printed_limit';

/** Where in the payload the claim was read, shared by both variants below. */
interface PrintedAssertionBase {
  scope: string;
  target: SpecTarget;
  test_name_raw: string;
  value_raw: string;
}

/**
 * A UNION rather than three nullable fields: "there is a basis exactly when
 * there is a claim" is then enforced by the compiler instead of asserted in a
 * comment, and the consumer below needs no non-null cast to read it.
 */
export type PrintedAssertion =
  | (PrintedAssertionBase & { assertion: 'none'; basis: null; basis_text: null })
  | (PrintedAssertionBase & {
      assertion: 'pass' | 'fail';
      basis: PrintedAssertionBasis;
      /** The claim verbatim: "Pass", or the printed limit the value met ("≤10 CFU/g"). */
      basis_text: string;
    });

/** The claim half of a `PrintedAssertion`, before it is placed. */
type Claim =
  | { assertion: 'none'; basis: null; basis_text: null }
  | { assertion: 'pass' | 'fail'; basis: PrintedAssertionBasis; basis_text: string };

const NO_ASSERTION: Claim = { assertion: 'none', basis: null, basis_text: null };

/**
 * Read one row's claim. Deliberately narrower than `judgePrinted`: it answers
 * "what does the paper say about this row?", never "is the row acceptable?".
 *
 * An explicit verdict cell WINS over the arithmetic. A row marked "Pass" whose
 * value breaches the document's own printed limit has still asserted a pass —
 * that self-contradiction is the strongest catch there is, and reading the
 * arithmetic first would erase it.
 *
 * A comparison that comes back `not_checked` yields NO claim. The document
 * printed a limit we could not apply, which is not the document saying the
 * result is fine.
 */
function claimForRow(row: PrintedRow, policy: UnitPolicy): Claim {
  const { cell, pass, fail } = printedClaim(row);
  if (fail) return { assertion: 'fail', basis: 'verdict_cell', basis_text: cell };
  if (pass) return { assertion: 'pass', basis: 'verdict_cell', basis_text: cell };

  const limit = parseLimitExpression(row.specRaw);
  if (!limit) return NO_ASSERTION;
  if (isBlankResult(row.resultRaw)) return NO_ASSERTION;
  // The result cell is the spec restated, so it is not a measurement and the
  // document has claimed nothing about an actual value.
  if (resultRestatesSpec(row.resultRaw, row.specRaw, row.unitRaw)) return NO_ASSERTION;

  const value = parseMeasuredValue(applyRowUnit(row.resultRaw, row.unitRaw));
  const cmp = compareToLimit(value, withUnit(limit, row.unitRaw), policy);
  const text = formatLimit(limit);
  if (cmp.verdict === 'in_spec') return { assertion: 'pass', basis: 'printed_limit', basis_text: text };
  if (cmp.verdict === 'out_of_spec') return { assertion: 'fail', basis: 'printed_limit', basis_text: text };
  return NO_ASSERTION;
}

/**
 * What every printed row CLAIMS, whether or not anything was judged.
 *
 * Rows with no claim come back as 'none' rather than being dropped: the caller
 * needs the full walk to know its own denominator, and a result the document
 * said nothing about is not in the denominator of a metric about broken claims.
 */
export function collectPrintedAssertions(
  sources: SpecSource[],
  opts: { unitPolicy?: UnitPolicy } = {}
): PrintedAssertion[] {
  const policy = opts.unitPolicy ?? STRICT_UNIT_POLICY;
  const out: PrintedAssertion[] = [];
  forEachPrintedRow(sources, (scope, target, row) => {
    if (!row.testName) return;
    const claim = claimForRow(row, policy);
    const where = {
      scope,
      target,
      test_name_raw: row.testName,
      value_raw: row.resultRaw,
    };
    // Spelled out per variant rather than spread: a spread widens back into
    // "kind | none" and loses exactly the guarantee the union is here for.
    out.push(
      claim.assertion === 'none'
        ? { ...where, assertion: 'none', basis: null, basis_text: null }
        : { ...where, assertion: claim.assertion, basis: claim.basis, basis_text: claim.basis_text }
    );
  });
  return out;
}

/**
 * The two directions in which a document and a measured value can disagree.
 * Kept as separate kinds, never summed: one is a missed failure and the other is
 * a document being conservative (or an extraction error), and a customer reading
 * a single blended number would learn nothing from it.
 */
export type SpecDisagreementKind =
  /** The document said it passed; our judgement of the extracted value says it did not. */
  | 'asserted_pass_extracted_fail'
  /** The document said it failed; our judgement of the extracted value says it passed. */
  | 'asserted_fail_extracted_pass';

export interface SpecDisagreement {
  kind: SpecDisagreementKind;
  scope: string;
  target: SpecTarget;
  test_name_raw: string;
  value_raw: string;
  unit_raw: string | null;
  /** The limit that produced the judgement, rendered. */
  limit_text: string | null;
  /** Whose limit judged it: the COA's own printed one, or one of ours. */
  judged_by: 'printed' | 'limit';
  /**
   * Every source that reached the same judgement on this result. One result is
   * ONE catch however many limits agree on it — a document that breaches both
   * its own printed spec and ours was not caught twice.
   */
  judged_by_all: Array<'printed' | 'limit'>;
  asserted_by: PrintedAssertionBasis;
  assertion_text: string;
  /** One-line plain-English sentence, same contract as `SpecVerdict.message`. */
  message: string;
  /** The judged verdict this was derived from. Carried verbatim, never edited. */
  verdict: SpecVerdict;
}

/**
 * Classify ONE judged result against what the document claimed for it.
 *
 * The whole definition lives here, in one place, so it can be tested as one
 * thing:
 *
 *   * `not_checked` is never a catch, in either direction. It is the engine
 *     saying it could not honestly judge, and a refusal counted as a finding
 *     would make the headline number dishonest in exactly the way the
 *     three-state verdict exists to prevent.
 *   * a result the document made no claim about is not in the denominator, so it
 *     cannot produce a disagreement either.
 *   * the assertion and the verdict must describe the SAME result. Checked, not
 *     assumed — a mismatched pairing would invent a catch out of two unrelated
 *     rows.
 */
export function classifySpecDisagreement(
  assertion: PrintedAssertion,
  verdict: SpecVerdict
): SpecDisagreementKind | null {
  if (assertion.assertion === 'none') return null;
  // The refusal guard, first and unconditional.
  if (verdict.verdict === 'not_checked') return null;
  if (specResultKey(assertion.scope, assertion.target) !== specResultKey(verdict.scope, verdict.target)) {
    return null;
  }
  if (assertion.assertion === 'pass' && verdict.verdict === 'out_of_spec') {
    return 'asserted_pass_extracted_fail';
  }
  if (assertion.assertion === 'fail' && verdict.verdict === 'in_spec') {
    return 'asserted_fail_extracted_pass';
  }
  return null;
}

export interface SpecDisagreementReport {
  /**
   * THE metric: the document asserted a pass, the extracted value breaches a
   * limit. One entry per RESULT, not per limit.
   */
  catches: SpecDisagreement[];
  /**
   * The other direction, counted separately and never folded into the line
   * above. Worth having — it is either a supplier being conservative or an
   * extraction error, and both are worth knowing — but it is not a catch.
   *
   * Only reachable when the caller asked for passes (`includePasses`); without
   * `in_spec` verdicts in hand there is nothing to compare a printed failure to,
   * and this list is legitimately empty rather than zero-because-checked.
   */
  reverse: SpecDisagreement[];
  /** Results where the document claimed conformance. */
  asserted_pass: number;
  /**
   * Of those, the ones some limit could actually be applied to. This is the
   * honest denominator for a catch RATE: a claim nothing judged was never given
   * the chance to be caught, and quoting a rate against all claims would
   * understate the check rather than the risk.
   *
   * COUNTED FROM THE VERDICTS THE CALLER HOLDS, and `checkPrintedSpecs` never
   * emits `in_spec` — that is its noise contract, not an omission. So a claim
   * that only the certificate's own limit judged, and passed, does not appear
   * here. With configured limits and `includePasses` on, it does.
   */
  asserted_pass_judged: number;
  /** Results where the document itself declared a failure. */
  asserted_fail: number;
  asserted_fail_judged: number;
}

/** Which of two equally valid judgements to show for one catch. */
function preferredVerdict(a: SpecVerdict, b: SpecVerdict): SpecVerdict {
  // The COA's own printed limit wins: "the document contradicts itself" needs no
  // configuration to be true, and is the sharper thing to put in front of a
  // customer. Ours is still listed in `judged_by_all`.
  if (a.source === b.source) return a;
  return a.source === 'printed' ? a : b;
}

/**
 * Line every judged verdict up against the document's own claim for the same
 * cell, and report the disagreements.
 *
 * `verdicts` is whatever the caller already computed — printed, configured, or
 * both. Pass them ALL: a catch is defined by the pairing of a claim with a
 * judgement, and handing over only half the judgements silently shrinks the
 * number without shrinking the risk.
 *
 * `unitPolicy` must be the same one the verdicts were computed under. It decides
 * which comparisons are possible at all, so reading the claims under different
 * rules would compare two different worlds.
 */
export function findSpecDisagreements(
  sources: SpecSource[],
  verdicts: SpecVerdict[],
  opts: { unitPolicy?: UnitPolicy } = {}
): SpecDisagreementReport {
  const policy = opts.unitPolicy ?? STRICT_UNIT_POLICY;
  const assertions = collectPrintedAssertions(sources, { unitPolicy: policy });

  const byResult = new Map<string, SpecVerdict[]>();
  for (const v of verdicts) {
    const key = specResultKey(v.scope, v.target);
    const bucket = byResult.get(key);
    if (bucket) bucket.push(v);
    else byResult.set(key, [v]);
  }

  const report: SpecDisagreementReport = {
    catches: [],
    reverse: [],
    asserted_pass: 0,
    asserted_pass_judged: 0,
    asserted_fail: 0,
    asserted_fail_judged: 0,
  };

  for (const a of assertions) {
    if (a.assertion === 'none') continue;
    const judged = byResult.get(specResultKey(a.scope, a.target)) ?? [];
    // A row judged only as `not_checked` was not judged, for this purpose.
    const decided = judged.filter((v) => v.verdict !== 'not_checked');
    if (a.assertion === 'pass') {
      report.asserted_pass++;
      if (decided.length > 0) report.asserted_pass_judged++;
    } else {
      report.asserted_fail++;
      if (decided.length > 0) report.asserted_fail_judged++;
    }

    let kind: SpecDisagreementKind | null = null;
    let chosen: SpecVerdict | null = null;
    const agreeing: Array<'printed' | 'limit'> = [];
    for (const v of decided) {
      const k = classifySpecDisagreement(a, v);
      if (!k) continue;
      kind = k;
      agreeing.push(v.source);
      chosen = chosen ? preferredVerdict(chosen, v) : v;
    }
    if (!kind || !chosen) continue;

    const whose = chosen.source === 'printed' ? "the certificate's own" : 'our';
    const message =
      kind === 'asserted_pass_extracted_fail'
        ? a.basis === 'verdict_cell'
          ? `${a.test_name_raw}: the certificate says "${a.basis_text}", but ${a.value_raw} is outside ${whose} limit of ${chosen.limit_text}.`
          : `${a.test_name_raw}: ${a.value_raw} meets the certificate's own printed ${a.basis_text}, but is outside our limit of ${chosen.limit_text}.`
        : `${a.test_name_raw}: the certificate says "${a.basis_text}", but ${a.value_raw} is within ${whose} limit of ${chosen.limit_text}.`;

    const entry: SpecDisagreement = {
      kind,
      scope: a.scope,
      target: a.target,
      test_name_raw: a.test_name_raw,
      value_raw: a.value_raw,
      unit_raw: chosen.unit_raw,
      limit_text: chosen.limit_text,
      judged_by: chosen.source,
      judged_by_all: [...new Set(agreeing)],
      asserted_by: a.basis,
      assertion_text: a.basis_text,
      message,
      verdict: chosen,
    };
    if (kind === 'asserted_pass_extracted_fail') report.catches.push(entry);
    else report.reverse.push(entry);
  }

  return report;
}
