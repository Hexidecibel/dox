/**
 * Reading identifying clauses out of typed text (search redesign Phase 1).
 *
 * Two halves, so the database is asked ONE batched question per search:
 *
 *   scanText(text)        pure: role-dated phrases, lot-shaped tokens and
 *                         number tokens (4+ digits), plus a keyword in front
 *                         of a number ("PO K134273", "invoice 261149").
 *   resolveDetections()   pure: given what the tenant HOLDS for those tokens
 *                         (search keys, lots, WMS orders), turn each into a
 *                         clause — or leave it as text.
 *
 * The rule for a number is the product-ambiguity rule applied to identifiers:
 * a number on file as exactly one kind becomes that kind's clause; a number on
 * file as several kinds becomes an `identifier` clause that ANY kind answers,
 * and says which kinds hit; nothing is picked. A number on file as nothing
 * stays text — except a long all-digit run (a WMS composite lot is ten), which
 * is asked for as a lot so the answer is "no document covers lot X" rather
 * than an unlabelled empty list (the instant-search rule, unchanged).
 *
 * A detected clause is returned to the caller and never written into the
 * query: the text stays text, so a detection a person disagrees with costs
 * nothing to undo.
 */

import type { SearchDateRole } from './types';
import type { Clause } from './searchQuery';
import type { FieldKey } from './searchFields';
import { parseQueryText, residualText, type LotToken } from './searchCoverage';
import { foldCustomerPo, normalizeKeyValue, KEY_KIND_LABELS } from './searchKeys';
import { normalizeLotNumber } from './lotNormalize';
import { monthDayValue, type QueryDate } from './searchDates';
import { resolveProductPhrase, type PreparedCatalog } from './productIdentity';
import { lotSchemeLabel, type LotSchemeSpec } from './lotScheme';
import type { SearchKeyKind } from './types';

export interface IdToken {
  raw: string;
  norm: string;
  start: number;
  end: number;
  /** A keyword typed in front of it. */
  declared: 'po' | 'invoice' | 'order' | null;
  keywordSpan: [number, number] | null;
}

export interface TextScan {
  text: string;
  dates: ReturnType<typeof parseQueryText>['dates'];
  lotTokens: LotToken[];
  idTokens: IdToken[];
}

const KEYWORDS: Record<string, IdToken['declared']> = {
  po: 'po', 'p.o': 'po', 'p.o.': 'po', 'po#': 'po', purchase: 'po',
  invoice: 'invoice', inv: 'invoice', 'invoice#': 'invoice', 'inv#': 'invoice',
  order: 'order', 'order#': 'order', so: 'order',
};

const MAX_TOKENS = 10;

function overlaps(a: [number, number], spans: Array<[number, number]>): boolean {
  return spans.some(([s, e]) => a[0] < e && a[1] > s);
}

export function scanText(text: string, opts: { now?: Date } = {}): TextScan {
  const parsed = parseQueryText(text, opts);
  const dateSpans: Array<[number, number]> = parsed.dates.flatMap((d) => [[d.start, d.end] as [number, number], ...(d.roleSpan ? [d.roleSpan] : [])]);
  const re = /[A-Za-z0-9][A-Za-z0-9\-.#]*/g;
  const words: Array<{ raw: string; start: number; end: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const raw = m[0].replace(/[.\-]+$/, '');
    words.push({ raw, start: m.index, end: m.index + raw.length });
  }
  const idTokens: IdToken[] = [];
  for (let i = 0; i < words.length && idTokens.length < MAX_TOKENS; i++) {
    const w = words[i];
    let raw = w.raw;
    let start = w.start;
    const end = w.end;
    // "K 135680": a short letter prefix typed apart from its digits.
    const prev = i > 0 ? words[i - 1] : null;
    if (prev && /^[A-Za-z]{1,2}$/.test(prev.raw) && !KEYWORDS[prev.raw.toLowerCase()] && /^\s+$/.test(text.slice(prev.end, w.start)) && /^\d{4,}$/.test(w.raw)) {
      raw = `${prev.raw} ${w.raw}`;
      start = prev.start;
    }
    if ((raw.match(/\d/g) || []).length < 4) continue;
    if (overlaps([start, end], dateSpans)) continue;
    const kwWord = words[i - 1]?.start === start ? words[i - 2] : words[i - 1];
    const kw = kwWord ? KEYWORDS[kwWord.raw.toLowerCase().replace(/[:]+$/, '')] ?? null : null;
    idTokens.push({
      raw, norm: normalizeKeyValue(raw), start, end,
      declared: kw, keywordSpan: kw && kwWord ? [kwWord.start, kwWord.end] : null,
    });
  }
  const lotTokens = parsed.lotTokens.filter((t) => !overlaps([t.start, t.end], dateSpans));
  // "lot 104": a lot typed after the word lot is a lot however short it is —
  // too short to be a whole lot, it is asked for as a PREFIX (resolveDetections),
  // never left as free text that matches a plant's street address.
  const lotWord = /\b(?:lot|batch)\s*#?\s*([A-Za-z0-9][A-Za-z0-9-]*)/gi;
  while ((m = lotWord.exec(text)) !== null) {
    const raw = m[1].replace(/-+$/, '');
    const start = m.index + m[0].length - m[1].length;
    const end = start + raw.length;
    if (!/\d/.test(raw) || overlaps([start, end], dateSpans)) continue;
    if (lotTokens.some((t) => start < t.end && end > t.start)) continue;
    const norm = normalizeLotNumber(raw);
    if (norm) lotTokens.push({ raw, norm, explicit: true, start, end });
  }
  lotTokens.sort((a, b) => a.start - b.start);
  return { text, dates: parsed.dates, lotTokens: lotTokens.slice(0, MAX_TOKENS), idTokens };
}

export function scanHasCandidates(s: TextScan): boolean {
  return s.dates.length > 0 || s.lotTokens.length > 0 || s.idTokens.length > 0;
}

/** Every normalized value the database is asked about (keys, lots). */
export function scanNorms(s: TextScan): string[] {
  return [...new Set([...s.idTokens.map((t) => t.norm), ...s.lotTokens.map((t) => t.norm)].filter((n) => n.length >= 2))];
}

/** The typed spellings WMS order / PO numbers are looked up by (stored as typed). */
export function scanOrderValues(s: TextScan): string[] {
  const out = new Set<string>();
  for (const t of s.idTokens) {
    out.add(t.raw);
    out.add(t.raw.toUpperCase());
  }
  return [...out];
}

export interface DetectionHits {
  /** normalized value -> document key kinds it is on file as */
  keys: Map<string, Set<SearchKeyKind>>;
  /** lot_key values on file that bear on the scanned lot tokens */
  lotKeys: string[];
  /** Their lot numbers (normalized): a base lot typed whole is a whole lot. */
  lotNumbers?: string[];
  /** Declared lot formats (0110), to say what a lot prefix IS. */
  lotSchemes?: Array<{ supplier_name: string; spec: LotSchemeSpec }>;
  /** WMS orders whose number or customer PO was typed */
  orders: Array<{ order_number: string; po_number: string | null }>;
}

function lotOnFile(norm: string, lotKeys: string[]): boolean {
  return lotKeys.some((k) => k === norm
    || (norm.length >= 6 && k.startsWith(norm))
    || (k.length >= 6 && norm.startsWith(k) && norm.length - k.length <= 3));
}

const IMPLIED_WIDTH: Record<string, number> = { yy: 2, julian_day: 3, mmddyy: 6, yymmdd: 6 };

/**
 * What a lot PREFIX is under a supplier's declared lot format, when the format
 * explains it: "104 = Darigold, Inc. plant (declared lot format: plant · YY ·
 * Julian day) · every lot from plant 104". Null when no declaration's leading
 * segment is exactly that wide and that kind.
 */
export function lotPrefixNote(prefix: string, schemes: Array<{ supplier_name: string; spec: LotSchemeSpec }>): string | null {
  const notes: string[] = [];
  for (const { supplier_name, spec } of schemes) {
    if (spec.kind !== 'structured') continue;
    const g = spec.segments?.[0];
    if (!g) continue;
    const width = g.width ?? IMPLIED_WIDTH[g.kind];
    if (width !== prefix.length) continue;
    if ((g.kind === 'digits' || g.kind in IMPLIED_WIDTH) && !/^\d+$/.test(prefix)) continue;
    if (g.kind === 'letters' && !/^[A-Z]+$/.test(prefix)) continue;
    if (g.values && g.values.length && !g.values.includes(prefix)) continue;
    notes.push(`${prefix} = ${supplier_name} ${g.name} (declared lot format: ${lotSchemeLabel(spec)}) · every lot from ${g.name} ${prefix}`);
  }
  return notes.length ? notes.join('; ') : null;
}

const DATE_FIELD: Record<SearchDateRole, FieldKey> = {
  production: 'production_date',
  code: 'code_date',
  expiration: 'best_by_date',
  ship: 'date',
  any: 'date',
  uploaded: 'date',
};

function addDays(iso: string, n: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

/**
 * A read date as the clause that asks for it: a day is `on`; a span is
 * `between` its two ends (year-less ends as `--MM-DD`, any year); an open span
 * is `after` / `before` the day outside it (both strict, as the builder's are).
 */
export function dateClauseShape(date: QueryDate): { op: 'on' | 'between' | 'before' | 'after'; values: string[] } {
  switch (date.kind) {
    case 'day': return { op: 'on', values: [date.iso] };
    case 'month_day': return { op: 'on', values: [monthDayValue(date)] };
    case 'month_range': return { op: 'between', values: [monthDayValue(date.from), monthDayValue(date.to)] };
    case 'range':
      if (date.from && date.to) return date.from === date.to ? { op: 'on', values: [date.from] } : { op: 'between', values: [date.from, date.to] };
      if (date.from) return { op: 'after', values: [addDays(date.from, -1)] };
      return { op: 'before', values: [addDays(date.to as string, 1)] };
  }
}

export interface Detection {
  clauses: Clause[];
  /** Text left once every detected phrase is cut out ('' = none). */
  residual: string;
}

/** Map a document-key kind (or a WMS hit) to the field that asks for it. */
function fieldForKind(kind: SearchKeyKind | 'wms_order' | 'wms_po'): FieldKey {
  switch (kind) {
    case 'supplier_po':
    case 'customer_po':
    case 'wms_po':
      return 'po';
    case 'invoice_number':
      return 'invoice';
    case 'wms_order':
      return 'order';
    case 'lot':
      return 'lot';
    default:
      return 'identifier';
  }
}

function kindWords(kind: SearchKeyKind | 'wms_order' | 'wms_po'): string {
  if (kind === 'wms_order') return 'a WMS order number';
  if (kind === 'wms_po') return "a customer's PO on a WMS order";
  if (kind === 'supplier_po') return 'a PO printed on a document';
  return `${/^[aeiou]/.test(KEY_KIND_LABELS[kind]) ? 'an' : 'a'} ${KEY_KIND_LABELS[kind]}`;
}

export function resolveDetections(scan: TextScan, hits: DetectionHits): Detection {
  const clauses: Clause[] = [];
  const spans: Array<[number, number]> = [];
  const push = (c: Omit<Clause, 'id'>) => clauses.push({ ...c, id: `d${clauses.length + 1}` });

  for (const d of scan.dates) {
    const field = DATE_FIELD[d.role];
    const { op, values } = dateClauseShape(d.date);
    const raw = scan.text.slice(d.roleSpan ? Math.min(d.roleSpan[0], d.start) : d.start, Math.max(d.end, d.roleSpan?.[1] ?? d.end)).trim();
    push({
      field, op, values, source: 'detected', raw,
      ...(field === 'date' ? { role: d.role === 'uploaded' ? 'any' : d.role } : {}),
      note: d.date.note,
    });
    spans.push([d.start, d.end]);
    if (d.roleSpan) spans.push(d.roleSpan);
  }

  const wmsKinds = (norm: string, raw: string): Array<'wms_order' | 'wms_po'> => {
    const out: Array<'wms_order' | 'wms_po'> = [];
    if (hits.orders.some((o) => normalizeKeyValue(o.order_number) === norm)) out.push('wms_order');
    // A customer's PO compares folded ("90001" = "PO-90001"); ours never does.
    if (hits.orders.some((o) => o.po_number && foldCustomerPo(o.po_number) === foldCustomerPo(raw))) out.push('wms_po');
    return out;
  };
  const kindsOf = (norm: string, raw: string) => [
    ...[...(hits.keys.get(norm) ?? [])],
    ...wmsKinds(norm, raw),
    ...(lotOnFile(norm, hits.lotKeys) && !hits.keys.get(norm)?.has('lot') ? ['lot' as const] : []),
  ];

  // Lots first: a lot-shaped token that is on file as nothing else, or that
  // was declared a lot ("lot 10426203"), is a lot.
  // A number typed after "PO" / "invoice" / "order" is that, however lot-like it looks.
  const declared = scan.idTokens.filter((t) => t.declared);
  for (const t of scan.lotTokens) {
    if (!t.explicit && declared.some((d) => d.start < t.end && d.end > t.start)) continue;
    const norm = normalizeLotNumber(t.norm);
    const kinds = kindsOf(normalizeKeyValue(t.norm), t.raw);
    const other = kinds.filter((k) => k !== 'lot');
    const isLot = t.explicit
      || (other.length === 0 && (kinds.includes('lot') || /^\d{8,}$/.test(norm)));
    if (!isLot) continue;
    // A lot declared with the word "lot" that is not a whole lot on file but
    // starts some — or is too short to be one — is a prefix.
    const whole = hits.lotKeys.includes(norm) || (hits.lotNumbers ?? []).includes(norm) || !!hits.keys.get(norm)?.has('lot');
    const starts = hits.lotKeys.some((k) => k !== norm && k.startsWith(norm));
    const prefix = t.explicit && !t.parts && !whole && (starts || norm.length < 5);
    const value = t.parts ? t.parts.base : t.raw.replace(/^lot\s*#?\s*/i, '');
    // The words the person typed, keyword included ("lot 104"), so rejecting
    // the chip hands back exactly what was typed rather than a bare number.
    const kw = /(?:\blot|\bbatch)\s*#?\s*$/i.exec(scan.text.slice(Math.max(0, t.start - 12), t.start));
    const typed = kw && !/^lot\b/i.test(t.raw) ? scan.text.slice(t.start - kw[0].length, t.end) : t.raw;
    push({
      field: 'lot', op: prefix ? 'starts' : 'is', values: [value], source: 'detected', raw: typed,
      ...(t.parts ? { sublot: t.parts.sub } : {}),
      ...(prefix ? { note: lotPrefixNote(norm, hits.lotSchemes ?? []) } : {}),
    });
    spans.push([t.start, t.end]);
  }

  for (const t of scan.idTokens) {
    if (overlaps([t.start, t.end], spans)) continue;
    let field: FieldKey | null = null;
    let note: string | null = null;
    if (t.declared === 'po') field = 'po';
    else if (t.declared === 'invoice') field = 'invoice';
    else if (t.declared === 'order') field = 'order';
    else {
      const kinds = kindsOf(t.norm, t.raw);
      const fields = [...new Set(kinds.map(fieldForKind))];
      if (fields.length === 1) {
        field = fields[0];
        note = `On file as ${[...new Set(kinds)].map(kindWords).join(' and as ')}.`;
      } else if (fields.length > 1) {
        field = 'identifier';
        note = `On file as ${[...new Set(kinds)].map(kindWords).join(', ')} — any of them answers; nothing is picked.`;
      }
    }
    if (!field) continue;
    push({
      field, op: 'is', values: [t.raw], source: 'detected',
      raw: t.keywordSpan ? scan.text.slice(t.keywordSpan[0], t.end) : t.raw, note,
    });
    spans.push([t.start, t.end]);
    if (t.keywordSpan) spans.push(t.keywordSpan);
  }

  return { clauses, residual: residualText(scan.text, spans) };
}

/**
 * The words a scan leaves once every CANDIDATE phrase (date, lot, number) is
 * cut out — an upper bound on what `resolveDetections` will leave. The server
 * reads the product catalog only when this is non-empty, in the same batch.
 */
export function scanResidualWords(s: TextScan): string {
  const spans: Array<[number, number]> = [
    ...s.dates.flatMap((d) => [[d.start, d.end] as [number, number], ...(d.roleSpan ? [d.roleSpan] : [])]),
    ...s.lotTokens.map((t) => [t.start, t.end] as [number, number]),
    ...s.idTokens.flatMap((t) => [[t.start, t.end] as [number, number], ...(t.keywordSpan ? [t.keywordSpan] : [])]),
  ];
  return residualText(s.text, spans);
}

/**
 * Product words next to another constraint ("butter produced in April"): the
 * words left over are resolved through the product identifier graph (0107).
 * The rule is Phase 3's, unchanged: words alone apply ONLY next to another
 * constraint ("butter" by itself stays a browse); every word must be accounted
 * for; a phrase that fits several products becomes one clause listing every
 * candidate with `ambiguous: true` — nothing is picked; a phrase that fits
 * nothing stays text. `labels` names each product for its chip.
 */
export function detectProduct(
  det: Detection,
  catalog: PreparedCatalog | null,
  opts: { otherConstraints: boolean },
): { detection: Detection; labels: Record<string, string> } {
  const phrase = det.residual.trim();
  if (!catalog || !phrase || !opts.otherConstraints) return { detection: det, labels: {} };
  const resolved = resolveProductPhrase(phrase, catalog);
  if (!resolved || resolved.resolution.candidates.length === 0) return { detection: det, labels: {} };
  const cands = resolved.resolution.candidates;
  const labels: Record<string, string> = {};
  for (const k of cands) labels[k.product_id] = k.product_name;
  const clause: Clause = cands.length === 1
    ? { id: '', field: 'product', op: 'in', values: [cands[0].product_id], source: 'detected', raw: phrase, note: cands[0].explanation }
    : {
      id: '', field: 'product', op: 'in', values: cands.map((k) => k.product_id), source: 'detected', raw: phrase, ambiguous: true,
      note: `"${phrase}" could mean ${cands.length} products. Nothing was picked — the answer is shown for each; choose one.`,
    };
  clause.id = `d${det.clauses.length + 1}`;
  return { detection: { clauses: [...det.clauses, clause], residual: '' }, labels };
}

/** Nothing on file: what the browser knows before the server has answered. */
export const NO_HITS: DetectionHits = { keys: new Map(), lotKeys: [], orders: [] };

/**
 * The optimistic reading the browser shows while the server is still asked
 * (search redesign Phase 2): role-dated phrases, lots typed after the word
 * "lot" or as a long digit run, and numbers typed after "PO" / "invoice" /
 * "order". A bare number is left alone here — only the tenant's own keys can
 * say what it is — so an optimistic chip is never a reading the server will
 * take back for want of data the browser does not have.
 */
export function detectOptimistic(text: string, opts: { now?: Date } = {}): Detection {
  const trimmed = text.trim();
  if (!trimmed) return { clauses: [], residual: '' };
  const scan = scanText(trimmed, opts);
  if (!scanHasCandidates(scan)) return { clauses: [], residual: trimmed };
  return resolveDetections(scan, NO_HITS);
}
