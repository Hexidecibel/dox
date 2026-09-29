/**
 * HOW FAR OUT — a band for an out-of-spec or could-not-check result, whose
 * MEANING depends on what kind of analyte it is (rules table D3, 2026-09-27).
 *
 * "Risk doesn't climb the same way for every analyte type, so one ratio scale
 * is wrong for most of them." Four categories (`spec_tests.category`,
 * migration 0120), four shapes:
 *
 *   indicator           TWO LINES, no gradient. Any exceedance of the limit is
 *                       `review`: the organism itself signals a process or
 *                       sanitation failure. More than 10x the limit is
 *                       `violation`: an order-of-magnitude exceedance is a
 *                       different thing (a PMO violation), not a louder review.
 *   compositional       GRADUATED on how far past the limit, relative to it:
 *                       `light` (up to 10% past), `look` (up to 50%), `urgent`
 *                       (beyond). Fat and solids genuinely climb.
 *   zero_tolerance      NO BAND. Detected, presumptive or ambiguous: every
 *                       non-pass is `top_priority`.
 *   regulatory_ceiling  GRADUATED BUT TIGHTER, around the legal ceiling rather
 *                       than our limit: under the ceiling (we write tighter) is
 *                       a `note`; a measured result over it is a `violation`;
 *                       a could-not-check whose reported bound is over it is
 *                       `call` — up to `regulatory_band_factor` times the
 *                       ceiling (default 3x) — and `violation` beyond. So
 *                       aflatoxin M1 reported "<1.0 ppb" against the FDA action
 *                       level of 0.5 ppb is 2x the ceiling and gets CALLED
 *                       rather than waved through, which is D3's own example.
 *
 * WHAT A BAND IS FOR, AND WHAT IT IS NOT. It orders what a person reads (after
 * the verdict and the limit's criticality) and it words the alert. It never
 * changes a verdict — `shared/specCheck.ts` decides in_spec / out_of_spec /
 * not_checked and never reads this — never routes to a separate queue and
 * never holds anything. A result with no category, no usable number, or a
 * ceiling in a unit that cannot be converted gets NO band, which is exactly
 * what every result had before.
 *
 * THE DEFAULTS ARE DEFAULTS. The 10x indicator line, the 10% / 50% compositional
 * steps and the 3x regulatory band are this file's constants, named so a later
 * per-analyte override (D3 layers A2/B2 on top) has one place to replace. The
 * one well-known ceiling shipped, aflatoxin M1 at 0.5 ppb, is in
 * `KNOWN_REGULATORY_CEILINGS`: offered by the analyte editor, and used here only
 * when the analyte is categorized as a regulatory ceiling and nobody configured
 * one — never written into the database on anyone's behalf.
 *
 * PURE. Imports only unit arithmetic from specCheck.
 */

import { normalizeUnit, unitFactor } from './specCheck';
import type { SpecVerdictKind } from './specCheck';

export const SPEC_TEST_CATEGORIES = [
  'indicator',
  'compositional',
  'zero_tolerance',
  'regulatory_ceiling',
] as const;

export type SpecTestCategory = (typeof SPEC_TEST_CATEGORIES)[number];

export function isSpecTestCategory(v: unknown): v is SpecTestCategory {
  return typeof v === 'string' && (SPEC_TEST_CATEGORIES as readonly string[]).includes(v);
}

export const SPEC_TEST_CATEGORY_LABELS: Record<SpecTestCategory, string> = {
  indicator: 'Indicator organism',
  compositional: 'Compositional / quality',
  zero_tolerance: 'Zero tolerance (presence/absence)',
  regulatory_ceiling: 'Regulatory ceiling',
};

export const SPEC_TEST_CATEGORY_HELP: Record<SpecTestCategory, string> = {
  indicator:
    'Coliform and similar. Any miss is worth a review; more than 10x the limit is treated as a violation.',
  compositional:
    'Fat, solids and similar. The further past the limit, the louder: a light note, a look, then urgent.',
  zero_tolerance:
    'Pathogens, drug residues, undeclared allergens. No middle ground: anything other than a clean pass is top priority.',
  regulatory_ceiling:
    'A legal limit such as aflatoxin M1. Judged around the ceiling itself, with a narrower band than an indicator.',
};

/** The bands, MOST URGENT FIRST — the index is the sort key. */
export const SPEC_BANDS = [
  'top_priority',
  'violation',
  'urgent',
  'call',
  'review',
  'look',
  'note',
  'light',
] as const;

export type SpecBand = (typeof SPEC_BANDS)[number];

export const SPEC_BAND_LABELS: Record<SpecBand, string> = {
  top_priority: 'Top priority',
  violation: 'Violation band',
  urgent: 'Urgent',
  call: 'Call the lab',
  review: 'Review',
  look: 'Needs a look',
  note: 'Note',
  light: 'Light note',
};

export interface SpecBandResult {
  band: SpecBand;
  category: SpecTestCategory;
  /** One plain sentence: why this band. */
  reason: string;
}

/** Sort key, 0 = most urgent; a result with no band sorts after every band. */
export function specBandRank(b: SpecBandResult | SpecBand | null | undefined): number {
  const band = typeof b === 'string' ? b : b?.band;
  const i = band ? SPEC_BANDS.indexOf(band) : -1;
  return i === -1 ? SPEC_BANDS.length : i;
}

// ── Defaults (D3: "each category ships a default band shape") ─────────────

/** Indicator: more than this multiple of the limit is the violation line. */
export const INDICATOR_VIOLATION_FACTOR = 10;
/** Compositional: relative overshoot up to which a miss is `light`, then `look`. */
export const COMPOSITIONAL_LIGHT_UP_TO = 0.1;
export const COMPOSITIONAL_LOOK_UP_TO = 0.5;
/** Regulatory ceiling: a reported bound up to this multiple of the ceiling is `call`. */
export const DEFAULT_REGULATORY_BAND_FACTOR = 3;

export interface KnownCeiling {
  /** Matched against the analyte's name. */
  match: RegExp;
  value: number;
  unit: string;
  source: string;
}

/**
 * Well-known, agreed regulatory ceilings the portal ships as a DEFAULT (D3:
 * "where a well-known, agreed-upon regulatory or legal standard exists, the
 * portal ships that as the default"). A client overrides it on the analyte.
 */
export const KNOWN_REGULATORY_CEILINGS: readonly KnownCeiling[] = [
  {
    match: /\baflatoxin\s*-?\s*m\s*-?\s*1\b|\bafm\s*1\b/i,
    value: 0.5,
    unit: 'ppb',
    source: 'FDA action level for aflatoxin M1 in milk (CPG Sec. 527.400)',
  },
];

export function knownRegulatoryCeiling(analyteName: string): KnownCeiling | null {
  return KNOWN_REGULATORY_CEILINGS.find((k) => k.match.test(analyteName)) ?? null;
}

// ── The engine ─────────────────────────────────────────────────────────────

export interface BandAnalyte {
  name: string;
  category?: string | null;
  regulatory_ceiling_value?: number | null;
  regulatory_ceiling_unit?: string | null;
  regulatory_band_factor?: number | null;
}

export interface BandLimit {
  operator: string;
  value_min: number | null;
  value_max: number | null;
  unit: string | null;
}

export interface BandInput {
  verdict: SpecVerdictKind;
  /**
   * The result on the LIMIT's footing (the engine's `value_num`): a measured
   * value, or the bound a censored result reported. Null = no band.
   */
  value_num: number | null | undefined;
  analyte: BandAnalyte;
  limit: BandLimit;
}

/**
 * How far past the limit, relative to it: 0.2 = 20% past. Null when the value
 * is not past it, or the limit gives nothing to measure against.
 */
function overshoot(v: number, l: BandLimit): number | null {
  const over = (bound: number) => (bound > 0 ? (v - bound) / bound : null);
  const under = (bound: number) => (bound > 0 ? (bound - v) / bound : null);
  switch (l.operator) {
    case '<':
    case '<=':
      return l.value_max != null && v > l.value_max ? over(l.value_max) : null;
    case '>':
    case '>=':
      return l.value_min != null && v < l.value_min ? under(l.value_min) : null;
    case 'between':
      if (l.value_max != null && v > l.value_max) return over(l.value_max);
      if (l.value_min != null && v < l.value_min) return under(l.value_min);
      return null;
    case '==':
      return l.value_min != null && l.value_min > 0 ? Math.abs(v - l.value_min) / l.value_min : null;
    default:
      return null;
  }
}

const fmt = (n: number) => String(Math.round(n * 1000) / 1000);

/**
 * The band for one result, or null. Only `out_of_spec` and `not_checked` are
 * banded — a pass has nothing to rank.
 */
export function computeSpecBand(input: BandInput): SpecBandResult | null {
  const { verdict, analyte, limit } = input;
  if (verdict === 'in_spec') return null;
  const category = isSpecTestCategory(analyte.category) ? analyte.category : null;
  if (!category) return null;

  if (category === 'zero_tolerance') {
    return {
      band: 'top_priority',
      category,
      reason:
        verdict === 'out_of_spec'
          ? 'a zero-tolerance analyte was not clean'
          : 'a zero-tolerance analyte could not be confirmed clean',
    };
  }

  const v = input.value_num;
  if (v == null || !Number.isFinite(v)) return null;
  const measured = verdict === 'out_of_spec';
  const what = measured ? 'the result' : 'the reported bound';

  if (category === 'indicator') {
    const past = overshoot(v, limit);
    if (past == null) return null;
    const multiple = past + 1;
    return multiple > INDICATOR_VIOLATION_FACTOR
      ? {
          band: 'violation',
          category,
          reason: `${what} is ${fmt(multiple)}x the limit — over ${INDICATOR_VIOLATION_FACTOR}x is an order-of-magnitude exceedance`,
        }
      : { band: 'review', category, reason: `${what} is past the limit of an indicator organism` };
  }

  if (category === 'compositional') {
    const past = overshoot(v, limit);
    if (past == null) return null;
    const pct = `${fmt(past * 100)}%`;
    if (past <= COMPOSITIONAL_LIGHT_UP_TO) return { band: 'light', category, reason: `${what} is ${pct} past the limit` };
    if (past <= COMPOSITIONAL_LOOK_UP_TO) return { band: 'look', category, reason: `${what} is ${pct} past the limit` };
    return { band: 'urgent', category, reason: `${what} is ${pct} past the limit` };
  }

  // regulatory_ceiling — around the legal line, not our limit.
  const configured = analyte.regulatory_ceiling_value;
  const known = configured == null ? knownRegulatoryCeiling(analyte.name) : null;
  const ceilingRaw = configured ?? known?.value ?? limit.value_max;
  const ceilingUnit = configured != null ? analyte.regulatory_ceiling_unit ?? limit.unit : known ? known.unit : limit.unit;
  if (ceilingRaw == null || ceilingRaw <= 0) return null;
  // The ceiling onto the limit's unit, by the engine's exact arithmetic only.
  let ceiling = ceilingRaw;
  if ((ceilingUnit ?? '') !== (limit.unit ?? '')) {
    const factor = unitFactor(normalizeUnit(ceilingUnit), normalizeUnit(limit.unit));
    if (factor == null) return null;
    ceiling = ceilingRaw * factor;
  }
  const bandFactor =
    analyte.regulatory_band_factor != null && analyte.regulatory_band_factor > 1
      ? analyte.regulatory_band_factor
      : DEFAULT_REGULATORY_BAND_FACTOR;
  const source = configured != null ? 'the configured ceiling' : known ? `the default ceiling (${known.source})` : 'the limit as ceiling';
  const multiple = v / ceiling;

  if (multiple <= 1) {
    return { band: 'note', category, reason: `${what} is under ${source}, past our tighter limit` };
  }
  if (measured) {
    return { band: 'violation', category, reason: `the result is ${fmt(multiple)}x ${source}` };
  }
  return multiple <= bandFactor
    ? { band: 'call', category, reason: `${what} is ${fmt(multiple)}x ${source} — it may be over the legal line; call the lab` }
    : { band: 'violation', category, reason: `${what} is ${fmt(multiple)}x ${source}, beyond the ${fmt(bandFactor)}x band` };
}

/**
 * Attach a band to every banded verdict, by the analyte and limit that judged
 * it. Returns new objects; verdicts with no band come back unchanged. Only
 * configured-limit verdicts are banded — a printed verdict has no analyte
 * category behind it.
 */
export function attachSpecBands<
  V extends { verdict: SpecVerdictKind; source: string; spec_test_id?: string | null; limit_id?: string | null; value_num?: number | null },
>(
  verdicts: V[],
  analytes: Array<BandAnalyte & { id: string }>,
  limits: Array<BandLimit & { id: string }>
): Array<V & { band?: SpecBandResult }> {
  const byTest = new Map(analytes.map((a) => [a.id, a]));
  const byLimit = new Map(limits.map((l) => [l.id, l]));
  return verdicts.map((v) => {
    if (v.source !== 'limit' || !v.spec_test_id || !v.limit_id) return v;
    const analyte = byTest.get(v.spec_test_id);
    const limit = byLimit.get(v.limit_id);
    if (!analyte || !limit) return v;
    const band = computeSpecBand({ verdict: v.verdict, value_num: v.value_num, analyte, limit });
    return band ? { ...v, band } : v;
  });
}
