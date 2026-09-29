/**
 * Questions a person would ask about a document they KNOW is on file, and how
 * to score what search answered (search regression harness).
 *
 * Pure, shared by three callers so they cannot drift:
 *   - GET /api/search/examples   the "Try" chips, built from this tenant's own
 *                                documents and kept only when they verify
 *   - bin/eval-search            the scorecard against a running server
 *   - tests/api/search-eval-golden.test.ts   the same probes over the golden corpus
 *
 * A probe names the document it came from and the band that document must land
 * in: `covering`, or `likely` when the only evidence is an older extraction's
 * code date or a lot-code decode (never covering — that is the rule, and a
 * probe that expects covering there would reward a regression). A NEGATIVE
 * probe (a day next to a real one with no lot, a lot nobody has, a real lot
 * under the wrong supplier) must come back `none` with nothing in the covering
 * or likely band — a nearby document presented as covering is exactly the
 * failure the coverage engine exists to prevent.
 */

import type { SearchKeyKind } from './types';
import type { Clause } from './searchQuery';

// ---------------------------------------------------------------------------
// The sample (GET /api/search/eval-sample returns this shape)
// ---------------------------------------------------------------------------

export type SampleDateSource = 'extracted' | 'extracted_code_date_legacy' | 'reviewer' | 'lot_decode' | null;

export interface SampleLot {
  lot_number: string;
  sub_lot_code: string;
  lot_key: string;
  production_date: string | null;
  production_date_source: SampleDateSource;
}

export interface SampleKey {
  kind: SearchKeyKind;
  value_raw: string;
}

export interface SampleProduct {
  id: string;
  name: string;
  /** Aliases and supplier product names (product_identifiers), plain words only. */
  names: string[];
}

export interface SampleDoc {
  id: string;
  title: string;
  supplier_id: string | null;
  supplier_name: string | null;
  document_type_name: string | null;
  document_type_slug: string | null;
  lots: SampleLot[];
  keys: SampleKey[];
  products: SampleProduct[];
  /** The product name printed on the document (metadata), when there is one. */
  printed_product: string | null;
}

export interface SampleNegatives {
  /** A day next to a real production day on which the tenant holds NO lot (verified). */
  days: Array<{ doc_id: string; day: string }>;
  /** A lot spelling nobody holds (verified against lots and search keys). */
  lots: Array<{ doc_id: string; lot: string }>;
  /** A real lot, and a supplier that holds no lot with that key (verified). */
  wrong_supplier: Array<{ doc_id: string; lot: string; supplier_id: string; supplier_name: string }>;
}

export interface EvalSample {
  tenant_id: string;
  seed: string;
  n: number;
  docs: SampleDoc[];
  negatives: SampleNegatives;
  /** Suppliers with a declared lot format whose code starts with a fixed digit segment. */
  lot_prefixes: Array<{ doc_id: string; prefix: string; supplier_name: string }>;
}

// ---------------------------------------------------------------------------
// Probes
// ---------------------------------------------------------------------------

export type ProbeKind =
  | 'lot_exact'
  | 'lot_composite'
  | 'lot_dash'
  | 'lot_space'
  | 'lot_prefix'
  | 'supplier_po'
  | 'invoice'
  | 'document_number'
  | 'product_day'
  | 'product_month'
  | 'supplier_type'
  | 'neg_adjacent_day'
  | 'neg_absent_lot'
  | 'neg_wrong_supplier';

export const PROBE_KIND_LABELS: Record<ProbeKind, string> = {
  lot_exact: 'lot, as printed',
  lot_composite: 'lot + sublot run together (1042620303)',
  lot_dash: 'lot-sublot (10426203-03)',
  lot_space: 'lot sublot ("10426203 03")',
  lot_prefix: 'lot prefix under a declared format',
  supplier_po: 'supplier PO',
  invoice: 'invoice number',
  document_number: 'document / certificate number',
  product_day: 'product + production day',
  product_month: 'product + production month',
  supplier_type: 'supplier + document type (browse)',
  neg_adjacent_day: 'NEGATIVE: day next to a real one',
  neg_absent_lot: 'NEGATIVE: a lot nobody has',
  neg_wrong_supplier: 'NEGATIVE: real lot, wrong supplier',
};

export type ProbeExpect = 'covering' | 'likely' | 'listed' | 'none';

export interface Probe {
  kind: ProbeKind;
  text: string;
  clauses?: Clause[];
  /** The document the question is about (negatives: the document next to it). */
  doc_id: string;
  expect: ProbeExpect;
  /** Why the band is what it is ("legacy code date" / "lot-code decode"). */
  basis?: string;
  /** A capability the reader may not have yet; unsupported probes are reported, not failed. */
  needs?: 'month_phrases';
}

export function isNegative(kind: ProbeKind): boolean {
  return kind.startsWith('neg_');
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** "2026-04-17" -> "Apr 17" */
export function spokenDay(iso: string): string {
  const [, m, d] = iso.split('-').map(Number);
  return `${MONTHS[m - 1].slice(0, 3)} ${d}`;
}

/** "2026-04-17" -> "4/17/2026" */
export function numericDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return `${m}/${d}/${y}`;
}

/** "2026-04-17" -> "April" */
export function spokenMonth(iso: string): string {
  return MONTHS[Number(iso.split('-')[1]) - 1];
}

/** Shift an ISO day by whole days (UTC, no DST). */
export function shiftDay(iso: string, days: number): string {
  const t = Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))) + days * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

const PACK_WORDS = new Set([
  'gl', 'gal', 'gallon', 'gallons', 'lb', 'lbs', 'kg', 'oz', 'bag', 'bags', 'tote', 'totes', 'box', 'case', 'cs', 'pail',
  'drum', 'bulk', 'grade', 'gr', 'aa', 'the', 'and', 'with', 'for', 'per', 'pack', 'std', 'standard', 'lot', 'item',
]);

/**
 * The words a person would use for a product: an alias or supplier name before
 * our catalog code-name, stripped of pack sizes, codes and abbreviations, at
 * most three words, the shortest clear one. Null when nothing reads as words.
 */
export function plainProductName(candidates: Array<string | null | undefined>): string | null {
  let best: string | null = null;
  for (const raw of candidates) {
    if (!raw) continue;
    const words = raw
      .toLowerCase()
      .replace(/[^a-z0-9%&\s-]/g, ' ')
      .split(/[\s-]+/)
      .filter((w) => w && !/\d/.test(w) && !PACK_WORDS.has(w))
      // An abbreviation ("btr", "liq", "whl") is not how a person talks.
      .filter((w) => /^[a-z]+$/.test(w) && w.length >= 3 && /[aeiouy]/.test(w));
    if (words.length === 0) continue;
    const phrase = words.slice(-3).join(' ');
    if (phrase.length < 4) continue;
    if (best === null || phrase.length < best.length) best = phrase;
  }
  return best;
}

function productWords(doc: SampleDoc): string | null {
  const aliasFirst = [...doc.products.flatMap((p) => p.names), doc.printed_product];
  return plainProductName(aliasFirst) ?? plainProductName(doc.products.map((p) => p.name));
}

const DECLARED_BAND: Record<string, { expect: ProbeExpect; basis?: string }> = {
  extracted: { expect: 'covering' },
  reviewer: { expect: 'covering' },
  extracted_code_date_legacy: { expect: 'likely', basis: 'legacy code date read as production' },
  lot_decode: { expect: 'likely', basis: 'decoded from the lot code' },
};

/** Short supplier word a person types ("Darigold, Inc." -> "darigold"). */
export function supplierWord(name: string | null): string | null {
  if (!name) return null;
  const w = name.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).find((x) => x.length >= 3 && !['the', 'inc', 'llc', 'co'].includes(x));
  return w ?? null;
}

/** Every positive question one document should answer. */
export function probesForDocument(doc: SampleDoc): Probe[] {
  const out: Probe[] = [];
  const seenText = new Set<string>();
  const add = (p: Probe) => {
    const k = `${p.kind}|${p.text}|${JSON.stringify(p.clauses ?? [])}`;
    if (seenText.has(k)) return;
    seenText.add(k);
    out.push(p);
  };

  const lot = doc.lots[0];
  if (lot) {
    const base = lot.lot_number.trim();
    const sub = lot.sub_lot_code.trim();
    if (sub) {
      add({ kind: 'lot_composite', text: `lot ${base}${sub}`, doc_id: doc.id, expect: 'covering' });
      add({ kind: 'lot_dash', text: `${base}-${sub}`, doc_id: doc.id, expect: 'covering' });
      add({ kind: 'lot_space', text: `${base} ${sub}`, doc_id: doc.id, expect: 'covering' });
    } else {
      add({ kind: 'lot_exact', text: `lot ${base}`, doc_id: doc.id, expect: 'covering' });
    }
  }

  const key = (kind: SearchKeyKind) => doc.keys.find((k) => k.kind === kind)?.value_raw ?? null;
  const po = key('supplier_po');
  if (po) add({ kind: 'supplier_po', text: `PO ${po}`, doc_id: doc.id, expect: 'covering' });
  const inv = key('invoice_number');
  if (inv) add({ kind: 'invoice', text: `invoice ${inv}`, doc_id: doc.id, expect: 'covering' });
  const num = key('certificate_number') ?? key('document_number');
  // A number with no letters or dashes reads as several kinds; it is still answerable (identifier).
  if (num) add({ kind: 'document_number', text: num, doc_id: doc.id, expect: 'covering' });

  const word = productWords(doc);
  const dated = doc.lots.find((l) => l.production_date && l.production_date_source && DECLARED_BAND[l.production_date_source]);
  if (word && dated?.production_date) {
    const band = DECLARED_BAND[dated.production_date_source as string];
    add({ kind: 'product_day', text: `${word} produced ${spokenDay(dated.production_date)}`, doc_id: doc.id, expect: band.expect, basis: band.basis });
    add({
      kind: 'product_month', text: `${word} produced in ${spokenMonth(dated.production_date)}`,
      doc_id: doc.id, expect: band.expect, basis: band.basis, needs: 'month_phrases',
    });
  }

  const sw = supplierWord(doc.supplier_name);
  const typeWord = doc.document_type_slug && doc.document_type_slug.length <= 4 ? doc.document_type_slug : doc.document_type_name?.toLowerCase() ?? null;
  if (sw && typeWord) add({ kind: 'supplier_type', text: `${sw} ${typeWord}`, doc_id: doc.id, expect: 'listed' });
  return out;
}

/** The probes a sample's verified negatives and lot prefixes give. */
export function sampleProbes(sample: EvalSample): Probe[] {
  const out: Probe[] = sample.docs.flatMap(probesForDocument);
  const byId = new Map(sample.docs.map((d) => [d.id, d]));
  for (const p of sample.lot_prefixes) out.push({ kind: 'lot_prefix', text: `lot ${p.prefix}`, doc_id: p.doc_id, expect: 'covering' });
  for (const n of sample.negatives.days) {
    const word = byId.get(n.doc_id) ? productWords(byId.get(n.doc_id)!) : null;
    out.push({ kind: 'neg_adjacent_day', text: `${word ? `${word} ` : ''}produced ${numericDate(n.day)}`, doc_id: n.doc_id, expect: 'none' });
  }
  for (const n of sample.negatives.lots) out.push({ kind: 'neg_absent_lot', text: `lot ${n.lot}`, doc_id: n.doc_id, expect: 'none' });
  for (const n of sample.negatives.wrong_supplier) {
    out.push({
      kind: 'neg_wrong_supplier', text: `lot ${n.lot}`, doc_id: n.doc_id, expect: 'none',
      clauses: [{ id: 'eval-supplier', field: 'supplier', op: 'in', values: [n.supplier_id], source: 'builder' }],
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/** The part of a search response the scorer reads. */
export interface ScoredResponse {
  coverage?: string | null;
  coverage_summary?: string | null;
  documents: Array<{ id: string; match_status?: string | null }>;
}

export type ProbeOutcome = 'pass' | 'fail' | 'unsupported';

export interface ProbeResult {
  probe: Probe;
  outcome: ProbeOutcome;
  /** Where the probed document landed: covering / likely / nearby / listed / absent. */
  landed: string;
  coverage: string | null;
  /** When a negative failed: the documents it presented as covering or likely. */
  wrongly_covering: string[];
  summary: string | null;
}

function landing(doc: string, r: ScoredResponse): string {
  const d = r.documents.find((x) => x.id === doc);
  if (!d) return 'absent';
  if (d.match_status === 'covering') return 'covering';
  if (d.match_status === 'likely_covering') return 'likely';
  if (d.match_status === 'candidate_not_matching') return 'nearby';
  return 'listed';
}

/**
 * Score one probe. `supported: false` (the reader does not read a month phrase
 * yet) reports the probe as unsupported rather than failing it.
 */
export function scoreProbe(probe: Probe, r: ScoredResponse, supported = true): ProbeResult {
  const landed = landing(probe.doc_id, r);
  const coverage = r.coverage ?? null;
  const wrongly = r.documents.filter((d) => d.match_status === 'covering' || d.match_status === 'likely_covering').map((d) => d.id);
  const base = { probe, landed, coverage, summary: r.coverage_summary ?? null };
  if (!supported) return { ...base, outcome: 'unsupported', wrongly_covering: [] };
  if (probe.expect === 'none') {
    const ok = (coverage === 'none' || coverage === null || coverage === 'unconstrained') && wrongly.length === 0;
    return { ...base, outcome: ok ? 'pass' : 'fail', wrongly_covering: ok ? [] : wrongly };
  }
  const ok = probe.expect === 'listed' ? landed !== 'absent' : landed === probe.expect;
  return { ...base, outcome: ok ? 'pass' : 'fail', wrongly_covering: [] };
}

export interface KindScore {
  kind: ProbeKind;
  total: number;
  pass: number;
  unsupported: number;
  /** pass / (total - unsupported); null when nothing was scorable. */
  rate: number | null;
}

export interface Scorecard {
  kinds: KindScore[];
  positives: { total: number; pass: number; rate: number | null };
  negatives: { total: number; pass: number; rate: number | null };
  /** Positives whose document was expected likely and landed there. */
  likely_by_basis: Record<string, { total: number; pass: number }>;
  unsupported: number;
  failures: ProbeResult[];
}

const rate = (pass: number, of: number): number | null => (of > 0 ? pass / of : null);

export function scorecard(results: ProbeResult[]): Scorecard {
  const kinds = new Map<ProbeKind, KindScore>();
  const likely: Scorecard['likely_by_basis'] = {};
  let posT = 0, posP = 0, negT = 0, negP = 0, unsupported = 0;
  for (const r of results) {
    const k = kinds.get(r.probe.kind) ?? { kind: r.probe.kind, total: 0, pass: 0, unsupported: 0, rate: null };
    k.total += 1;
    if (r.outcome === 'unsupported') {
      k.unsupported += 1;
      unsupported += 1;
    } else if (isNegative(r.probe.kind)) {
      negT += 1;
      if (r.outcome === 'pass') negP += 1;
    } else {
      posT += 1;
      if (r.outcome === 'pass') posP += 1;
    }
    if (r.outcome === 'pass') k.pass += 1;
    if (r.probe.basis && r.outcome !== 'unsupported') {
      const b = (likely[r.probe.basis] ??= { total: 0, pass: 0 });
      b.total += 1;
      if (r.outcome === 'pass') b.pass += 1;
    }
    kinds.set(r.probe.kind, k);
  }
  for (const k of kinds.values()) k.rate = rate(k.pass, k.total - k.unsupported);
  const order = Object.keys(PROBE_KIND_LABELS) as ProbeKind[];
  return {
    kinds: [...kinds.values()].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind)),
    positives: { total: posT, pass: posP, rate: rate(posP, posT) },
    negatives: { total: negT, pass: negP, rate: rate(negP, negT) },
    likely_by_basis: likely,
    unsupported,
    failures: results.filter((r) => r.outcome === 'fail'),
  };
}

/** Overall hit rate across positives and negatives (null when nothing scored). */
export function overallRate(card: Scorecard): number | null {
  return rate(card.positives.pass + card.negatives.pass, card.positives.total + card.negatives.total);
}

const pct = (r: number | null) => (r === null ? '  n/a' : `${(r * 100).toFixed(1).padStart(5)}%`);

export function formatScorecard(card: Scorecard, maxFailures = 40): string {
  const lines: string[] = [];
  lines.push('Search regression scorecard');
  lines.push('');
  lines.push(`${'question kind'.padEnd(44)} ${'pass'.padStart(9)}   rate`);
  for (const k of card.kinds) {
    const scored = k.total - k.unsupported;
    const extra = k.unsupported ? `  (${k.unsupported} unsupported by the reader)` : '';
    lines.push(`${PROBE_KIND_LABELS[k.kind].padEnd(44)} ${`${k.pass}/${scored}`.padStart(9)}  ${pct(k.rate)}${extra}`);
  }
  lines.push('');
  lines.push(`positives: ${card.positives.pass}/${card.positives.total} ${pct(card.positives.rate)}`);
  lines.push(`negatives correct: ${card.negatives.pass}/${card.negatives.total} ${pct(card.negatives.rate)}`);
  for (const [basis, s] of Object.entries(card.likely_by_basis)) lines.push(`expected LIKELY (${basis}): ${s.pass}/${s.total}`);
  if (card.unsupported) lines.push(`unsupported (reader capability not present, not counted): ${card.unsupported}`);
  lines.push(`overall: ${pct(overallRate(card))}`);
  if (card.failures.length) {
    lines.push('');
    lines.push(`Failing questions (${card.failures.length}${card.failures.length > maxFailures ? `, first ${maxFailures}` : ''}):`);
    for (const f of card.failures.slice(0, maxFailures)) {
      const clauses = f.probe.clauses?.length ? ` + ${f.probe.clauses.map((c) => `${c.field}:${c.values.join('|')}`).join(' ')}` : '';
      const got = isNegative(f.probe.kind)
        ? `coverage=${f.coverage}; presented as covering/likely: ${f.wrongly_covering.join(', ') || '-'}`
        : `expected ${f.probe.expect}, document landed ${f.landed} (coverage=${f.coverage})`;
      lines.push(`  [${f.probe.kind}] "${f.probe.text}"${clauses} (doc ${f.probe.doc_id}): ${got}`);
      if (f.summary) lines.push(`      ${f.summary}`);
    }
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Deterministic sampling
// ---------------------------------------------------------------------------

/** A small seeded PRNG (FNV-1a seed -> mulberry32): same seed, same draw. */
export function seededRandom(seed: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Seeded Fisher-Yates; the input is not modified. */
export function seededShuffle<T>(xs: readonly T[], seed: string): T[] {
  const rnd = seededRandom(seed);
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
