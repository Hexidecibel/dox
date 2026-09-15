/**
 * A supplier's lot format, DECLARED as data (migration 0109; AJ Conner,
 * Any-Field COA Retrieval §6, R2 / R3 / R8).
 *
 * Darigold's lot code is a deterministic encoding of the production date:
 * plant(3) | YY | Julian day(3), with a 2-digit sublot appended to form the WMS
 * composite. Country Morning's is the best-by date MMDDYY plus a product suffix.
 * Andersen prints no product lot at all. AJ's constraints on using that, and
 * this module is built around them:
 *
 *   1. A PER-SUPPLIER parser with a declared pattern registered against the
 *      supplier record — never a global regex. A pattern that silently
 *      mis-parses another supplier's lot is worse than no parser. So nothing
 *      here guesses a format: `decodeLot` runs exactly the spec it is handed.
 *   2. A decoded date is NEVER authoritative when the document states one. It is
 *      a fallback and a cross-check. This module only DECODES; it has no idea
 *      what the document said and never overrides anything.
 *   3. Decode and extraction disagreeing is FLAGGED, not resolved in code
 *      (shared/extractionInvariants.ts, functions/lib/entities/lots.ts).
 *   4. A lot that does not fit is reported with the reason, never forced.
 *
 * The four legacy `suppliers.lot_scheme` enum values (0075) are expressed as
 * specs too (`legacyLotSchemeSpec`), so there is one key-generation engine and
 * the old values keep producing byte-identical keys.
 *
 * Pure, import-free except ./lotNormalize: bundled for bin/ (npm run
 * build:worker-shared) and imported by the frontend's live tester.
 */

import { normalizeLotNumber, normalizeSubLotCode } from './lotNormalize';
import type { ProductionDateResolution } from './lotProductionDate';

// ---------------------------------------------------------------------------
// The declaration
// ---------------------------------------------------------------------------

export const LOT_SCHEME_FORMAT = 1 as const;

export type LotSegmentKind =
  | 'digits'
  | 'letters'
  | 'alnum'
  | 'yy'
  | 'julian_day'
  | 'mmddyy'
  | 'yymmdd';

export const LOT_SEGMENT_KINDS: readonly LotSegmentKind[] = [
  'digits', 'letters', 'alnum', 'yy', 'julian_day', 'mmddyy', 'yymmdd',
];

/** Which date a lot code encodes. Nothing else is decodable. */
export type LotDateRole = 'production' | 'best_by';

export const LOT_DATE_ROLE_WORDS: Record<LotDateRole, string> = {
  production: 'production date',
  best_by: 'best-by date',
};

export interface LotSegment {
  /** Machine name, e.g. 'plant', 'year', 'day'. Unique within the spec. */
  name: string;
  kind: LotSegmentKind;
  /** Fixed width. Implied for the date kinds (yy 2, julian_day 3, mmddyy/yymmdd 6). */
  width?: number;
  /** Variable width — allowed on the LAST segment only. */
  min_width?: number;
  max_width?: number;
  /** Allowed values (e.g. known plant codes). Omitted = any value of the kind. */
  values?: string[];
}

export interface LotSublotSpec {
  width: number;
  kind: 'digits' | 'alnum';
}

export type LegacyLotScheme = 'auto' | 'date_code' | 'lims_combined' | 'plain';

export interface LotSchemeSpec {
  format: typeof LOT_SCHEME_FORMAT;
  /**
   * 'structured' — the lot has declared segments and can be checked and decoded.
   * 'none'       — DECLARED to carry no decodable structure (Andersen). Lots are
   *                keyed as written (base + sublot), nothing is checked or decoded.
   *                Distinct from no declaration at all, which means nobody looked.
   */
  kind: 'structured' | 'none';
  /** How a person would say the format, e.g. "plant · YY · Julian day". */
  label?: string;
  /** The base lot, in order. structured only. */
  segments?: LotSegment[];
  /**
   * A sublot appended to the base. null/omitted = this supplier has no sublot,
   * so an extracted sublot is not part of the lot's identity.
   */
  sublot?: LotSublotSpec | null;
  /**
   * How lot identity (`lots.lot_key`) is formed from a fitting lot:
   *   'base_plus_sublot' — every base segment, then the sublot (Darigold's WMS composite)
   *   'segments'         — only `key_segments` (+ the sublot, if one is declared);
   *                        CMF's product suffix is the item, not the lot
   */
  key?: 'base_plus_sublot' | 'segments';
  key_segments?: string[];
  /** Which date the date segment(s) encode. Required when any date segment is declared. */
  date_role?: LotDateRole | null;
}

const IMPLIED_WIDTH: Partial<Record<LotSegmentKind, number>> = {
  yy: 2,
  julian_day: 3,
  mmddyy: 6,
  yymmdd: 6,
};

const DATE_KINDS = new Set<LotSegmentKind>(['yy', 'julian_day', 'mmddyy', 'yymmdd']);

// ---------------------------------------------------------------------------
// Templates (the admin UI's starting points) and the legacy enum
// ---------------------------------------------------------------------------

export const LOT_SCHEME_TEMPLATES: Record<'plant_yy_julian' | 'best_by_mmddyy_suffix' | 'none', { title: string; spec: LotSchemeSpec }> = {
  plant_yy_julian: {
    title: 'Plant · YY · Julian day, 2-digit sublot (Darigold-style)',
    spec: {
      format: 1,
      kind: 'structured',
      label: 'plant · YY · Julian day',
      segments: [
        { name: 'plant', kind: 'digits', width: 3 },
        { name: 'year', kind: 'yy' },
        { name: 'day', kind: 'julian_day' },
      ],
      sublot: { width: 2, kind: 'digits' },
      key: 'base_plus_sublot',
      date_role: 'production',
    },
  },
  best_by_mmddyy_suffix: {
    title: 'Best-by MMDDYY + product suffix (Country Morning-style)',
    spec: {
      format: 1,
      kind: 'structured',
      label: 'best-by MMDDYY · product suffix',
      segments: [
        { name: 'best_by', kind: 'mmddyy' },
        { name: 'product', kind: 'alnum', min_width: 0, max_width: 4 },
      ],
      sublot: null,
      key: 'segments',
      key_segments: ['best_by'],
      date_role: 'best_by',
    },
  },
  none: {
    title: 'No lot format — this supplier prints no decodable lot',
    spec: { format: 1, kind: 'none', label: 'no declared lot format' },
  },
};

/**
 * The four 0075 enum values as specs. `auto`, `plain` and `lims_combined` all
 * stored base + sublot — they were one behaviour under three names. `date_code`
 * kept the leading six digits (NOT validated as a date: '999999X' keyed as
 * '999999'), dropped the sublot, and kept a non-conforming key whole.
 */
export function legacyLotSchemeSpec(value: string | null | undefined): LotSchemeSpec {
  if (value === 'date_code') {
    return {
      format: 1,
      kind: 'structured',
      label: 'legacy date code (leading six digits)',
      segments: [
        { name: 'date', kind: 'digits', width: 6 },
        // Any length: the legacy regex looked only at the first six characters.
        { name: 'rest', kind: 'alnum', min_width: 0, max_width: Number.MAX_SAFE_INTEGER },
      ],
      sublot: null,
      key: 'segments',
      key_segments: ['date'],
      date_role: null,
    };
  }
  return { format: 1, kind: 'none', label: 'legacy: lot as written' };
}

export function asLegacyLotScheme(value: unknown): LegacyLotScheme {
  return value === 'date_code' || value === 'lims_combined' || value === 'plain' ? value : 'auto';
}

/**
 * The scheme in force for one supplier, as the server resolves it: the latest
 * declared version (supplier_lot_schemes) when there is one, else the legacy
 * enum mapped onto a spec. `source` matters — only a DECLARED structured scheme
 * is used to validate, decode, or normalise the order side.
 */
export interface ResolvedLotScheme {
  source: 'declared' | 'legacy';
  spec: LotSchemeSpec;
  scheme_id: string | null;
  version: number | null;
  supplier_name: string | null;
  legacy: LegacyLotScheme;
}

export function legacyResolvedScheme(value: string | null | undefined, supplierName: string | null = null): ResolvedLotScheme {
  const legacy = asLegacyLotScheme(value);
  return { source: 'legacy', spec: legacyLotSchemeSpec(legacy), scheme_id: null, version: null, supplier_name: supplierName, legacy };
}

/** A declared scheme that can validate and decode a lot (not 'none', not legacy). */
export function isDeclaredStructured(s: ResolvedLotScheme | null | undefined): s is ResolvedLotScheme {
  return !!s && s.source === 'declared' && s.spec.kind === 'structured';
}

// ---------------------------------------------------------------------------
// Validating a declaration
// ---------------------------------------------------------------------------

export type SpecValidation = { ok: true; spec: LotSchemeSpec } | { ok: false; errors: string[] };

const NAME_RE = /^[a-z][a-z0-9_]{0,31}$/;
const TOP_KEYS = new Set(['format', 'kind', 'label', 'segments', 'sublot', 'key', 'key_segments', 'date_role']);
const SEGMENT_KEYS = new Set(['name', 'kind', 'width', 'min_width', 'max_width', 'values']);
const MAX_SEGMENTS = 8;
const MAX_WIDTH = 32;

function isInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v);
}

function kindAccepts(kind: LotSegmentKind | 'digits' | 'alnum', s: string): boolean {
  switch (kind) {
    case 'letters': return /^[A-Z]*$/.test(s);
    case 'alnum': return /^[A-Z0-9]*$/.test(s);
    default: return /^[0-9]*$/.test(s);
  }
}

const KIND_WORDS: Record<LotSegmentKind, string> = {
  digits: 'digits',
  letters: 'letters',
  alnum: 'letters or digits',
  yy: 'a two-digit year',
  julian_day: 'a three-digit day of the year',
  mmddyy: 'a MMDDYY date',
  yymmdd: 'a YYMMDD date',
};

/**
 * Refuse a declaration that cannot mean one thing. Returns the spec normalised
 * (implied widths filled, unknown optional fields dropped) when it is sound.
 * A bad declaration refused at save is the whole point: a scheme that silently
 * mis-parses is worse than none.
 */
export function validateLotSchemeSpec(input: unknown): SpecValidation {
  const errors: string[] = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, errors: ['The lot format must be an object.'] };
  }
  const raw = input as Record<string, unknown>;
  for (const k of Object.keys(raw)) {
    if (!TOP_KEYS.has(k)) errors.push(`Unknown setting "${k}".`);
  }
  if (raw.format !== LOT_SCHEME_FORMAT) errors.push(`format must be ${LOT_SCHEME_FORMAT}.`);
  if (raw.kind !== 'structured' && raw.kind !== 'none') errors.push('kind must be "structured" or "none".');
  const label = raw.label == null ? undefined : String(raw.label).trim().slice(0, 120) || undefined;

  if (raw.kind === 'none') {
    for (const k of ['segments', 'sublot', 'key', 'key_segments', 'date_role']) {
      const v = raw[k];
      if (v != null && !(Array.isArray(v) && v.length === 0)) errors.push(`A "none" lot format declares no ${k}.`);
    }
    return errors.length ? { ok: false, errors } : { ok: true, spec: { format: 1, kind: 'none', ...(label ? { label } : {}) } };
  }

  const segIn = raw.segments;
  const segments: LotSegment[] = [];
  if (!Array.isArray(segIn) || segIn.length === 0) {
    errors.push('A structured lot format needs at least one segment.');
  } else if (segIn.length > MAX_SEGMENTS) {
    errors.push(`At most ${MAX_SEGMENTS} segments.`);
  } else {
    const names = new Set<string>();
    segIn.forEach((s, i) => {
      const at = `Segment ${i + 1}`;
      if (!s || typeof s !== 'object' || Array.isArray(s)) {
        errors.push(`${at} must be an object.`);
        return;
      }
      const seg = s as Record<string, unknown>;
      for (const k of Object.keys(seg)) if (!SEGMENT_KEYS.has(k)) errors.push(`${at}: unknown setting "${k}".`);
      const name = typeof seg.name === 'string' ? seg.name.trim() : '';
      if (!NAME_RE.test(name)) errors.push(`${at}: name must be lower-case letters, digits or underscores, starting with a letter.`);
      else if (names.has(name)) errors.push(`${at}: the name "${name}" is used twice.`);
      names.add(name);
      const kind = seg.kind as LotSegmentKind;
      if (!LOT_SEGMENT_KINDS.includes(kind)) {
        errors.push(`${at}: kind must be one of ${LOT_SEGMENT_KINDS.join(', ')}.`);
        return;
      }
      const out: LotSegment = { name, kind };
      const implied = IMPLIED_WIDTH[kind];
      const last = i === segIn.length - 1;
      if (implied) {
        if (seg.width != null && seg.width !== implied) errors.push(`${at}: ${KIND_WORDS[kind]} is always ${implied} characters wide.`);
        if (seg.min_width != null || seg.max_width != null) errors.push(`${at}: ${KIND_WORDS[kind]} cannot have a variable width.`);
        out.width = implied;
      } else if (seg.width != null) {
        if (!isInt(seg.width) || seg.width < 1 || seg.width > MAX_WIDTH) errors.push(`${at}: width must be a whole number from 1 to ${MAX_WIDTH}.`);
        if (seg.min_width != null || seg.max_width != null) errors.push(`${at}: give either a fixed width or a min/max width, not both.`);
        out.width = seg.width as number;
      } else {
        if (!last) errors.push(`${at}: only the last segment may have a variable width; give this one a fixed width.`);
        const min = seg.min_width == null ? 1 : seg.min_width;
        const max = seg.max_width == null ? MAX_WIDTH : seg.max_width;
        if (!isInt(min) || min < 0 || min > MAX_WIDTH) errors.push(`${at}: min_width must be a whole number from 0 to ${MAX_WIDTH}.`);
        if (!isInt(max) || max < 1 || max > MAX_WIDTH) errors.push(`${at}: max_width must be a whole number from 1 to ${MAX_WIDTH}.`);
        if (isInt(min) && isInt(max) && min > max) errors.push(`${at}: min_width is larger than max_width.`);
        out.min_width = min as number;
        out.max_width = max as number;
      }
      if (seg.values != null) {
        if (DATE_KINDS.has(kind)) errors.push(`${at}: a date segment cannot list allowed values.`);
        else if (!Array.isArray(seg.values) || seg.values.length === 0 || seg.values.length > 50) errors.push(`${at}: values must be a list of 1 to 50 values.`);
        else {
          const vals = seg.values.map((v) => String(v ?? '').trim().toUpperCase());
          for (const v of vals) {
            const widthOk = out.width != null ? v.length === out.width : v.length >= (out.min_width ?? 0) && v.length <= (out.max_width ?? MAX_WIDTH);
            if (!v || !kindAccepts(kind, v) || !widthOk) errors.push(`${at}: "${v}" is not ${out.width ?? ''} ${KIND_WORDS[kind]}.`.replace('  ', ' '));
          }
          out.values = [...new Set(vals)];
        }
      }
      segments.push(out);
    });
  }

  // Sublot
  let sublot: LotSublotSpec | null = null;
  if (raw.sublot != null) {
    const sub = raw.sublot as Record<string, unknown>;
    if (typeof sub !== 'object' || Array.isArray(sub)) errors.push('sublot must be an object or null.');
    else {
      for (const k of Object.keys(sub)) if (k !== 'width' && k !== 'kind') errors.push(`sublot: unknown setting "${k}".`);
      if (!isInt(sub.width) || sub.width < 1 || sub.width > 6) errors.push('sublot width must be a whole number from 1 to 6.');
      if (sub.kind !== 'digits' && sub.kind !== 'alnum') errors.push('sublot kind must be "digits" or "alnum".');
      sublot = { width: Number(sub.width), kind: sub.kind === 'alnum' ? 'alnum' : 'digits' };
      if (segments.some((s) => s.width == null)) {
        errors.push('A sublot needs a fixed-width base: with a variable-width last segment the sublot cannot be told apart from it.');
      }
    }
  }

  // Key rule
  const key = raw.key == null ? 'base_plus_sublot' : raw.key;
  let keySegments: string[] | undefined;
  if (key !== 'base_plus_sublot' && key !== 'segments') errors.push('key must be "base_plus_sublot" or "segments".');
  if (key === 'segments') {
    if (!Array.isArray(raw.key_segments) || raw.key_segments.length === 0) errors.push('key "segments" needs key_segments naming at least one segment.');
    else {
      keySegments = raw.key_segments.map((n) => String(n));
      for (const n of keySegments) if (!segments.some((s) => s.name === n)) errors.push(`key_segments names "${n}", which is not a segment.`);
    }
  } else if (raw.key_segments != null && !(Array.isArray(raw.key_segments) && raw.key_segments.length === 0)) {
    errors.push('key_segments is only used with key "segments".');
  }

  // Date encoding
  const role = raw.date_role == null ? null : raw.date_role;
  if (role !== null && role !== 'production' && role !== 'best_by') errors.push('date_role must be "production", "best_by" or null.');
  const count = (k: LotSegmentKind) => segments.filter((s) => s.kind === k).length;
  const yy = count('yy');
  const jd = count('julian_day');
  const full = count('mmddyy') + count('yymmdd');
  const anyDate = yy + jd + full > 0;
  if (anyDate) {
    if (full > 1 || yy > 1 || jd > 1) errors.push('Declare one date encoding: a single YY + Julian day pair, or a single MMDDYY / YYMMDD segment.');
    else if (full === 1 && yy + jd > 0) errors.push('Declare one date encoding, not a full date and a YY / Julian day as well.');
    else if (jd === 1 && yy === 0) errors.push('A Julian day needs a YY segment for its year.');
    else if (yy === 1 && jd === 0) errors.push('A YY segment on its own is not a date; add the Julian day, or declare the year as plain digits.');
    if (!role) errors.push('Say which date the lot code encodes (date_role: production or best_by).');
  } else if (role) {
    errors.push('date_role is set but no segment encodes a date.');
  }

  if (errors.length) return { ok: false, errors };
  const spec: LotSchemeSpec = {
    format: 1,
    kind: 'structured',
    ...(label ? { label } : {}),
    segments,
    sublot,
    key: key as 'base_plus_sublot' | 'segments',
    ...(keySegments ? { key_segments: keySegments } : {}),
    date_role: (role as LotDateRole | null) ?? null,
  };
  return { ok: true, spec };
}

// ---------------------------------------------------------------------------
// Decoding a lot against a declaration
// ---------------------------------------------------------------------------

export interface LotDecode {
  /** The lot as given (trimmed). */
  input: string;
  /** Did the lot fit the declared format? Always false for a 'none' format. */
  fits: boolean;
  /** Plain words: why it does not fit. null when it fits. */
  reason: string | null;
  base: string;
  sublot: string;
  /** base + sublot — the WMS composite. */
  composite: string;
  /** What `lots.lot_key` / `lots.sub_lot_code` store for this lot under this format. */
  key: string;
  key_sublot: string;
  segments: Array<{ name: string; kind: LotSegmentKind; value: string }>;
  decoded_date: string | null;
  date_role: LotDateRole | null;
  /** How the format reads, for messages. */
  label: string;
}

export function lotSchemeLabel(spec: LotSchemeSpec): string {
  if (spec.label) return spec.label;
  if (spec.kind === 'none') return 'no declared lot format';
  const parts = (spec.segments ?? []).map((s) => s.name);
  if (spec.sublot) parts.push('sublot');
  return parts.join(' · ');
}

function isLeap(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function isoFromYmd(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1) return null;
  const dim = [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
  if (d > dim) return null;
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

function isoFromJulian(y: number, day: number): string | null {
  const days = isLeap(y) ? 366 : 365;
  if (day < 1 || day > days) return null;
  const t = Date.UTC(y, 0, 1) + (day - 1) * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

const SEPARATED_SUBLOT = /^(.*[A-Za-z0-9])[\s\-/._]+([A-Za-z0-9]{1,6})\s*$/;

/**
 * Parse one lot against a declared format. Accepts every shape AJ listed —
 * `1042620303`, `10426203-03`, `10426203 03`, or base and sublot given
 * separately — and returns the parts, the composite, the key this format stores,
 * and the decoded date when the format encodes one. NEVER throws: a lot that
 * does not fit comes back `fits: false` with the reason in plain words.
 */
export function decodeLot(
  spec: LotSchemeSpec | null | undefined,
  lotRaw: string | null | undefined,
  sublotRaw?: string | null,
): LotDecode {
  const input = String(lotRaw ?? '').trim();
  const n = normalizeLotNumber(input);
  const subGiven = normalizeSubLotCode(sublotRaw ?? null);
  const s = spec ?? legacyLotSchemeSpec('auto');
  const label = lotSchemeLabel(s);
  const plain = (reason: string | null, fits = false): LotDecode => {
    // A lot that does not fit keeps today's identity: as written, plus the
    // sublot when the format has one (the legacy 'none' behaviour is exactly this).
    const keepsSublot = s.kind === 'none' || !!s.sublot;
    const sub = keepsSublot ? subGiven : '';
    return {
      input, fits, reason, base: n, sublot: sub, composite: n + sub,
      key: n + sub, key_sublot: sub, segments: [], decoded_date: null, date_role: null, label,
    };
  };
  try {
    if (!n) return plain('There is no lot number.');
    if (s.kind === 'none') return plain('No lot format is declared for this supplier, so the lot is stored as written.');
    // Date kinds carry their width implicitly; a spec straight from a template
    // (not round-tripped through the validator) may leave it unstated.
    const segs = (s.segments ?? []).map((g) => (g.width == null && IMPLIED_WIDTH[g.kind] ? { ...g, width: IMPLIED_WIDTH[g.kind] } : g));
    if (segs.length === 0) return plain('The declared lot format has no segments.');
    const fixedBase = segs.every((g) => g.width != null) ? segs.reduce((a, g) => a + (g.width as number), 0) : null;

    // 1. Separate base from sublot.
    let base = n;
    let sub = '';
    if (s.sublot) {
      const w = s.sublot.width;
      const sepMatch = SEPARATED_SUBLOT.exec(input);
      const sepBase = sepMatch ? normalizeLotNumber(sepMatch[1]) : '';
      if (subGiven) {
        if (fixedBase != null && n.length === fixedBase + w) {
          if (n.slice(fixedBase) !== subGiven) {
            return plain(`The lot number ends in sublot ${n.slice(fixedBase)}, but the sublot given is ${subGiven}.`);
          }
          base = n.slice(0, fixedBase);
        }
        sub = subGiven;
      } else if (sepMatch && fixedBase != null && sepBase.length === fixedBase && normalizeLotNumber(sepMatch[2]).length <= w) {
        base = sepBase;
        sub = normalizeSubLotCode(sepMatch[2]);
      } else if (fixedBase != null && n.length === fixedBase + w) {
        base = n.slice(0, fixedBase);
        sub = n.slice(fixedBase);
      }
      if (sub && (sub.length !== w || !kindAccepts(s.sublot.kind, sub))) {
        return plain(`Sublot "${sub}" is not ${w} ${s.sublot.kind === 'digits' ? 'digits' : 'letters or digits'}.`);
      }
    }
    if (fixedBase != null && base.length !== fixedBase) {
      const withSub = s.sublot ? ` (${fixedBase + s.sublot.width} with the sublot)` : '';
      return plain(`"${input}" is ${n.length} characters; ${label} is ${fixedBase}${withSub}.`);
    }

    // 2. Walk the segments.
    const parts: LotDecode['segments'] = [];
    let at = 0;
    for (let i = 0; i < segs.length; i++) {
      const g = segs[i];
      let value: string;
      if (g.width != null) {
        value = base.slice(at, at + g.width);
        if (value.length !== g.width) return plain(`"${input}" is too short for ${label}: ${g.name} is missing.`);
      } else {
        value = base.slice(at);
        const min = g.min_width ?? 1;
        const max = g.max_width ?? MAX_WIDTH;
        if (value.length < min || value.length > max) {
          return plain(`${g.name} "${value}" should be ${min === max ? min : `${min} to ${max}`} characters.`);
        }
      }
      at += value.length;
      if (!kindAccepts(g.kind, value)) return plain(`${g.name} "${value}" is not ${KIND_WORDS[g.kind]}.`);
      if (g.values && value && !g.values.includes(value)) {
        return plain(`${g.name} "${value}" is not one of the declared values (${g.values.join(', ')}).`);
      }
      parts.push({ name: g.name, kind: g.kind, value });
    }
    if (at !== base.length) return plain(`"${input}" is longer than ${label}.`);

    // 3. Decode the date.
    let decoded: string | null = null;
    const val = (k: LotSegmentKind) => parts.find((p) => p.kind === k)?.value;
    const yy = val('yy');
    const jd = val('julian_day');
    const mdy = val('mmddyy');
    const ymd = val('yymmdd');
    if (jd != null && yy != null) {
      const year = 2000 + Number(yy);
      const day = Number(jd);
      decoded = isoFromJulian(year, day);
      if (!decoded) return plain(`Day "${jd}" is not a day of ${year} (1–${isLeap(year) ? 366 : 365}).`);
    } else if (mdy != null) {
      decoded = isoFromYmd(2000 + Number(mdy.slice(4, 6)), Number(mdy.slice(0, 2)), Number(mdy.slice(2, 4)));
      if (!decoded) return plain(`"${mdy}" is not a month-day-year date.`);
    } else if (ymd != null) {
      decoded = isoFromYmd(2000 + Number(ymd.slice(0, 2)), Number(ymd.slice(2, 4)), Number(ymd.slice(4, 6)));
      if (!decoded) return plain(`"${ymd}" is not a year-month-day date.`);
    }

    // 4. Identity.
    const keyBody = s.key === 'segments'
      ? (s.key_segments ?? []).map((name) => parts.find((p) => p.name === name)?.value ?? '').join('')
      : base;
    const keySub = s.sublot ? sub : '';
    return {
      input,
      fits: true,
      reason: null,
      base,
      sublot: sub,
      composite: base + sub,
      key: keyBody + keySub,
      key_sublot: keySub,
      segments: parts,
      decoded_date: decoded,
      date_role: decoded ? (s.date_role ?? null) : null,
      label,
    };
  } catch (err) {
    return plain(`The lot could not be read against ${label}: ${err instanceof Error ? err.message : String(err)}.`);
  }
}

/**
 * The stored identity for a lot under a scheme: `{ lotKey, subLotCode }`. The
 * legacy enum values run through the same engine as a declaration (their
 * spec is `legacyLotSchemeSpec`), so `auto` stays byte-identical.
 */
export function lotIdentity(
  spec: LotSchemeSpec | null | undefined,
  lotRaw: string | null | undefined,
  sublotRaw?: string | null,
): { lotKey: string; subLotCode: string } {
  const d = decodeLot(spec, lotRaw, sublotRaw);
  return { lotKey: d.key, subLotCode: d.key_sublot };
}

/** "Jul 31, 2026" — messages only. */
export function formatLotIso(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}`;
}

/** "decoded from the lot code using Darigold, Inc.'s declared format (plant · YY · Julian day)" */
export function lotDecodeProvenance(supplierName: string | null | undefined, spec: LotSchemeSpec): string {
  const who = supplierName ? `${supplierName}'s` : "the supplier's";
  return `decoded from the lot code using ${who} declared format (${lotSchemeLabel(spec)})`;
}

// ---------------------------------------------------------------------------
// The write path: a lot row's production date, with the decode as fallback
// ---------------------------------------------------------------------------

export interface LotProductionDecision {
  /** What to store — the stated value, the decode, or a conflict naming both. */
  resolution: ProductionDateResolution | null;
  /** The declaration that decoded it; null when the decode played no part. */
  scheme_id: string | null;
  decode: LotDecode | null;
}

/**
 * R3 in one function. Two sources, in priority order: (a) the production date
 * the certificate STATES, authoritative; (b) the date the supplier's declared lot
 * format DECODES, a fallback and a validator.
 *
 *   - no declared production-role format, or the lot does not fit -> (a) as given
 *   - nothing stated                          -> the decode, source 'lot_decode'
 *   - stated, same day                        -> the stated value (the decode agrees)
 *   - stated, a different day                 -> 'conflict', both kept in raw, no day
 *   - stated but ambiguous / unparseable      -> the stated value as given; a decode
 *                                                does not settle what a page printed
 */
export function productionDateFromLot(
  scheme: ResolvedLotScheme | null | undefined,
  lotRaw: string | null | undefined,
  sublotRaw: string | null | undefined,
  stated: ProductionDateResolution | null,
): LotProductionDecision {
  if (!isDeclaredStructured(scheme) || scheme.spec.date_role !== 'production') {
    return { resolution: stated, scheme_id: null, decode: null };
  }
  const decode = decodeLot(scheme.spec, lotRaw, sublotRaw);
  if (!decode.fits || !decode.decoded_date || decode.date_role !== 'production') {
    return { resolution: stated, scheme_id: null, decode };
  }
  const how = lotDecodeProvenance(scheme.supplier_name, scheme.spec);
  const version = scheme.version ? ` v${scheme.version}` : '';
  if (!stated) {
    return {
      resolution: {
        iso: decode.decoded_date,
        raw: `lot ${decode.base} decodes to ${decode.decoded_date}`,
        status: 'resolved',
        source: 'lot_decode',
        field: 'lot_number',
        note: `No production date is stated; ${how}${version}.`,
      },
      scheme_id: scheme.scheme_id,
      decode,
    };
  }
  if (stated.status === 'resolved' && stated.iso && stated.iso !== decode.decoded_date) {
    return {
      resolution: {
        ...stated,
        iso: null,
        status: 'conflict',
        raw: `${stated.raw} | lot ${decode.base} decodes to ${decode.decoded_date}`,
        note: `The certificate states ${stated.iso}; the lot code, ${how}${version}, says ${decode.decoded_date}. Flagged for a person — neither is picked.`,
      },
      scheme_id: scheme.scheme_id,
      decode,
    };
  }
  return { resolution: stated, scheme_id: null, decode };
}

// ---------------------------------------------------------------------------
// The admin preview: how the lots on file read against a format
// ---------------------------------------------------------------------------

export interface LotFitRow {
  lot_id: string;
  lot_number: string;
  sub_lot_code: string;
  lot_key: string;
  production_date: string | null;
  production_date_source: string | null;
}

export interface LotFitPreview {
  total: number;
  fits: number;
  not_fitting: Array<{ lot_id: string; lot_number: string; sub_lot_code: string; reason: string }>;
  /** A decoded date that disagrees with the production date on file. */
  date_disagreements: Array<{ lot_id: string; lot_number: string; sub_lot_code: string; on_file: string; decoded: string }>;
  /** Lots whose stored key differs from what this format would store. */
  key_differs: number;
}

/**
 * How the lots on file read against a format. Pure over its input, so the admin
 * page runs the same function on a draft before anything is saved.
 */
export function previewLotFit(spec: LotSchemeSpec, lots: LotFitRow[]): LotFitPreview {
  const out: LotFitPreview = { total: lots.length, fits: 0, not_fitting: [], date_disagreements: [], key_differs: 0 };
  for (const l of lots) {
    const d = decodeLot(spec, l.lot_number, l.sub_lot_code);
    if (d.key !== l.lot_key || d.key_sublot !== (l.sub_lot_code ?? '')) out.key_differs++;
    if (spec.kind !== 'structured') continue;
    if (!d.fits) {
      out.not_fitting.push({ lot_id: l.lot_id, lot_number: l.lot_number, sub_lot_code: l.sub_lot_code, reason: d.reason ?? '' });
      continue;
    }
    out.fits++;
    if (d.date_role === 'production' && d.decoded_date && l.production_date && l.production_date_source !== 'lot_decode'
      && l.production_date !== d.decoded_date) {
      out.date_disagreements.push({ lot_id: l.lot_id, lot_number: l.lot_number, sub_lot_code: l.sub_lot_code, on_file: l.production_date, decoded: d.decoded_date });
    }
  }
  return out;
}
