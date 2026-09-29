/**
 * ONE query model for search (search redesign, Phase 1).
 *
 * `/search` had the coverage engine and no filters; `/documents` had filters
 * and only the FIRST of them ever reached the server (AJ's I1: supplier A →
 * butter → COA → September narrowed on supplier alone, and the date filter the
 * client sent was silently ignored). Both surfaces now edit the same
 * `SearchQuery`: free text plus AND-composed `Clause`s, each one field /
 * operator / values. The server (`POST /api/search/query`) runs every clause —
 * scope clauses as hard filters, identifying clauses through the unchanged
 * coverage judge — so the result cannot depend on the order the filters were
 * ticked in, and clearing one clause keeps the rest.
 *
 * The URL codec is compact and human-readable:
 *
 *   /documents?q=butter&f=supplier.in:S1,S2&f=production_date.on:2026-09-02&mode=advanced
 *
 * and it still reads every URL and saved search written before it
 * (`supplier=…&doc_type=…&date=last_30d`), through `legacyStateToQuery`.
 *
 * Pure; shared by the Workers functions and the frontend.
 */

import type { SearchDateRole, SearchSort, SearchState } from './types';
import {
  fieldDef,
  isFieldKey,
  SEARCH_FIELDS,
  STATUS_LABELS,
  UPLOADED_BUCKETS,
  type ClauseOp,
  type FieldKey,
  type SearchEntity,
} from './searchFields';
import { describeSpanValues, formatIsoHuman, formatMonthDay, sinceWords } from './searchDates';

export type ClauseSource = 'typed' | 'detected' | 'ai' | 'facet' | 'builder' | 'saved';

export interface Clause {
  id: string;
  field: FieldKey;
  op: ClauseOp;
  values: string[];
  /** Scope fields only: every value EXCEPT these. */
  exclude?: boolean;
  /** The `date` field: which role the date is judged under. */
  role?: SearchDateRole;
  /** The `lot` field: a sublot typed as its own input (matched part against part). */
  sublot?: string;
  source: ClauseSource;
  /** What the person typed, when a clause was read out of text. */
  raw?: string;
  /** Anything the reader should know about how it was read. */
  note?: string | null;
  /**
   * A product clause read from a phrase that fits several products ("5 gal
   * bag"): every candidate is listed and NOTHING IS PICKED. The answer is
   * shown per product until the person chooses one (search redesign Phase 2).
   */
  ambiguous?: boolean;
}

export interface SearchView {
  entity: SearchEntity;
  sort?: SearchSort;
  columns?: string[];
  page?: number;
  mode?: 'easy' | 'advanced';
}

export interface SearchQuery {
  v: 1;
  /** Residual free text: FTS, and a `text` constraint next to an identifying clause. */
  text: string;
  /** AND-composed. */
  clauses: Clause[];
  view: SearchView;
}

export const EMPTY_QUERY: SearchQuery = { v: 1, text: '', clauses: [], view: { entity: 'documents' } };

const SORTS: SearchSort[] = ['relevance', 'newest', 'oldest', 'name'];
const ENTITIES: SearchEntity[] = ['documents', 'lots', 'products', 'suppliers'];
const SOURCES: ClauseSource[] = ['typed', 'detected', 'ai', 'facet', 'builder', 'saved'];
const ROLES: SearchDateRole[] = ['production', 'code', 'expiration', 'ship', 'uploaded', 'any'];

// ---------------------------------------------------------------------------
// Clause <-> string
// ---------------------------------------------------------------------------

function escValue(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/,/g, '\\,');
}

function splitValues(s: string): string[] {
  const out: string[] = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\' && i + 1 < s.length) {
      cur += s[i + 1];
      i++;
    } else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map((v) => v.trim()).filter(Boolean);
}

/** `!supplier.in;src=facet:S1,S2` */
export function encodeClause(c: Clause): string {
  const opts: string[] = [];
  if (c.role) opts.push(`role=${c.role}`);
  if (c.sublot) opts.push(`sub=${encodeURIComponent(c.sublot)}`);
  if (c.source && c.source !== 'builder') opts.push(`src=${c.source}`);
  // What the person typed travels with the clause, so "treat it as text" can
  // hand their own words back after a reload or a shared link.
  if (c.raw && c.raw.trim()) opts.push(`raw=${encodeURIComponent(c.raw.trim())}`);
  if (c.ambiguous) opts.push('amb=1');
  return `${c.exclude ? '!' : ''}${c.field}.${c.op}${opts.map((o) => `;${o}`).join('')}:${c.values.map(escValue).join(',')}`;
}

/** Null for anything malformed or unknown — a URL is never trusted to be well formed. */
export function decodeClause(s: string, id: string): Clause | null {
  const colon = s.indexOf(':');
  if (colon < 0) return null;
  let head = s.slice(0, colon);
  const exclude = head.startsWith('!');
  if (exclude) head = head.slice(1);
  const [fieldOp, ...optParts] = head.split(';');
  const dot = fieldOp.indexOf('.');
  if (dot < 0) return null;
  const field = fieldOp.slice(0, dot);
  const op = fieldOp.slice(dot + 1) as ClauseOp;
  if (!isFieldKey(field)) return null;
  if (!SEARCH_FIELDS[field].ops.includes(op)) return null;
  const values = splitValues(s.slice(colon + 1));
  if (values.length === 0) return null;
  const c: Clause = { id, field, op, values, source: 'builder' };
  if (exclude) c.exclude = true;
  for (const o of optParts) {
    const eq = o.indexOf('=');
    const k = o.slice(0, eq);
    const v = o.slice(eq + 1);
    if (k === 'role' && (ROLES as string[]).includes(v)) c.role = v as SearchDateRole;
    else if (k === 'sub' && v) c.sublot = decodeURIComponent(v);
    else if (k === 'src' && (SOURCES as string[]).includes(v)) c.source = v as ClauseSource;
    else if (k === 'raw' && v) {
      try {
        c.raw = decodeURIComponent(v);
      } catch {
        // a malformed escape is dropped, never guessed at
      }
    } else if (k === 'amb' && v === '1') c.ambiguous = true;
  }
  return c;
}

// ---------------------------------------------------------------------------
// Query <-> URL
// ---------------------------------------------------------------------------

/** Encode a query as URL params. Defaults are dropped so the URL stays short. */
export function encodeQuery(q: SearchQuery): URLSearchParams {
  const p = new URLSearchParams();
  const text = q.text.trim();
  if (text) p.set('q', text);
  for (const c of q.clauses) p.append('f', encodeClause(c));
  const v = q.view;
  if (v.mode === 'advanced') p.set('mode', 'advanced');
  if (v.entity && v.entity !== 'documents') p.set('entity', v.entity);
  if (v.sort && v.sort !== 'relevance') p.set('sort', v.sort);
  if (v.columns && v.columns.length) p.set('cols', v.columns.join(','));
  if (v.page && v.page > 1) p.set('page', String(v.page));
  return p;
}

/** The canonical string a query is keyed on (in-flight de-dupe, equality). */
export function queryKey(q: SearchQuery): string {
  return encodeQuery(q).toString();
}

export function queriesEqual(a: SearchQuery, b: SearchQuery): boolean {
  return queryKey(a) === queryKey(b);
}

const LEGACY_KEYS = ['supplier', 'doc_type', 'product', 'status', 'date'] as const;

const LEGACY_DATE: Record<string, { op: 'within' | 'older_than'; days: number }> = {
  last_24h: { op: 'within', days: 1 },
  last_7d: { op: 'within', days: 7 },
  last_30d: { op: 'within', days: 30 },
  last_90d: { op: 'within', days: 90 },
  last_365d: { op: 'within', days: 365 },
  // The old server's disjoint bucket: created more than 90 days ago.
  older: { op: 'older_than', days: 90 },
};

function splitComma(v: string | null | undefined): string[] {
  return (v ?? '').split(',').map((x) => x.trim()).filter(Boolean);
}

/**
 * The pre-redesign `SearchState` (old URLs, old saved searches) as clauses.
 * Every filter it could express survives — including the product and status
 * filters and the date bucket the old server silently ignored.
 */
export function legacyStateToQuery(input: Partial<SearchState> | object): SearchQuery {
  const state = input as Record<string, unknown>;
  const clauses: Clause[] = [];
  const add = (field: FieldKey, op: ClauseOp, values: string[]) => {
    if (values.length) clauses.push({ id: `c${clauses.length + 1}`, field, op, values, source: 'saved' });
  };
  const arr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x.trim()) : typeof v === 'string' ? splitComma(v) : []);
  add('supplier', 'in', arr(state.supplier));
  add('document_type', 'in', arr(state.doc_type));
  add('product', 'in', arr(state.product));
  add('status', 'in', arr(state.status).filter((s) => s in STATUS_LABELS));
  const date = typeof state.date === 'string' ? LEGACY_DATE[state.date] : undefined;
  if (date) add('uploaded', date.op, [String(date.days)]);
  const sort = typeof state.sort === 'string' && (SORTS as string[]).includes(state.sort) ? (state.sort as SearchSort) : undefined;
  const page = typeof state.page === 'number' && state.page > 1 ? state.page : undefined;
  return {
    v: 1,
    text: typeof state.q === 'string' ? state.q.trim() : '',
    clauses,
    view: { entity: 'documents', ...(sort && sort !== 'relevance' ? { sort } : {}), ...(page ? { page } : {}) },
  };
}

/**
 * Decode URL params. Reads the new `f=` clauses AND the legacy keys, so a URL
 * or bookmark from before the redesign opens the same search it always meant.
 * Clause ids are assigned in order (c1, c2, …); they are not part of the URL.
 */
export function decodeQuery(input: URLSearchParams | string): SearchQuery {
  const p = typeof input === 'string' ? new URLSearchParams(input) : input;
  const legacyPresent = LEGACY_KEYS.some((k) => p.has(k));
  const base = legacyPresent
    ? legacyStateToQuery({
      q: p.get('q') ?? '',
      supplier: splitComma(p.get('supplier')),
      doc_type: splitComma(p.get('doc_type')),
      product: splitComma(p.get('product')),
      status: splitComma(p.get('status')),
      date: p.get('date') ?? undefined,
    })
    : { ...EMPTY_QUERY, text: (p.get('q') ?? '').trim(), clauses: [] as Clause[] };
  const clauses: Clause[] = [...base.clauses];
  for (const s of p.getAll('f')) {
    const c = decodeClause(s, `c${clauses.length + 1}`);
    if (c) clauses.push(c);
  }
  const view: SearchView = { entity: 'documents' };
  const entity = p.get('entity');
  if (entity && (ENTITIES as string[]).includes(entity)) view.entity = entity as SearchEntity;
  const sort = p.get('sort');
  if (sort && sort !== 'relevance' && (SORTS as string[]).includes(sort)) view.sort = sort as SearchSort;
  if (p.get('mode') === 'advanced') view.mode = 'advanced';
  const cols = splitComma(p.get('cols'));
  if (cols.length) view.columns = cols;
  const page = Number.parseInt(p.get('page') ?? '', 10);
  if (Number.isFinite(page) && page > 1) view.page = page;
  return { v: 1, text: base.text, clauses: clauses.map((c, i) => ({ ...c, id: `c${i + 1}` })), view };
}

/**
 * A saved search's stored payload as a query: a v1 AST as is, anything else
 * as the legacy `SearchState` it was written as.
 */
export function savedPayloadToQuery(payload: Record<string, unknown>): SearchQuery {
  if (payload && payload.v === 1 && Array.isArray(payload.clauses)) {
    const q = payload as unknown as SearchQuery;
    const clauses = q.clauses
      .map((c, i) => decodeClause(encodeClause(c), `c${i + 1}`))
      .filter((c): c is Clause => !!c)
      .map((c) => ({ ...c, source: 'saved' as const }));
    return { v: 1, text: typeof q.text === 'string' ? q.text : '', clauses, view: { entity: 'documents', ...(q.view?.sort ? { sort: q.view.sort } : {}) } };
  }
  return legacyStateToQuery(payload);
}

// ---------------------------------------------------------------------------
// Editing helpers (facets, chips)
// ---------------------------------------------------------------------------

function renumber(clauses: Clause[]): Clause[] {
  return clauses.map((c, i) => ({ ...c, id: `c${i + 1}` }));
}

/** The values ticked for a scope field (its include clause). */
export function selectedValues(q: SearchQuery, field: FieldKey): string[] {
  return q.clauses.filter((c) => c.field === field && !c.exclude).flatMap((c) => c.values);
}

/**
 * Set the ticked values for a facet: the field's include clause is replaced
 * (or removed when empty). Every OTHER clause is untouched — the I1 rule.
 * The page resets, because the result set changed.
 */
export function withFieldValues(q: SearchQuery, field: FieldKey, values: string[], op?: ClauseOp): SearchQuery {
  const def = SEARCH_FIELDS[field];
  const idx = q.clauses.findIndex((c) => c.field === field && !c.exclude);
  const clean = [...new Set(values.map((v) => v.trim()).filter(Boolean))];
  const clauses = [...q.clauses];
  if (clean.length === 0) {
    if (idx >= 0) clauses.splice(idx, 1);
  } else {
    const next: Clause = { id: '', field, op: op ?? def.defaultOp, values: clean, source: idx >= 0 ? q.clauses[idx].source : 'facet' };
    if (idx >= 0) clauses[idx] = next;
    else clauses.push(next);
  }
  return { ...q, clauses: renumber(clauses), view: { ...q.view, page: undefined } };
}

/** Remove one clause; the others keep their order and values. */
export function withoutClause(q: SearchQuery, id: string): SearchQuery {
  return { ...q, clauses: renumber(q.clauses.filter((c) => c.id !== id)), view: { ...q.view, page: undefined } };
}

/** Remove one value from a clause (the clause goes when its last value does). */
export function withoutValue(q: SearchQuery, id: string, value: string): SearchQuery {
  const clauses = q.clauses
    .map((c) => (c.id === id ? { ...c, values: c.values.filter((v) => v !== value) } : c))
    .filter((c) => c.values.length > 0);
  return { ...q, clauses: renumber(clauses), view: { ...q.view, page: undefined } };
}

/** The same query with only scope and text clauses (what a Clear filters leaves). */
export function withoutScope(q: SearchQuery): SearchQuery {
  return { ...q, clauses: renumber(q.clauses.filter((c) => SEARCH_FIELDS[c.field].class !== 'scope')), view: { ...q.view, page: undefined } };
}

// ---------------------------------------------------------------------------
// The omnibox (search redesign Phase 2): typed text -> chips, and back
// ---------------------------------------------------------------------------

/** The ids a committed batch of clauses received (in order). */
export interface CommitResult {
  query: SearchQuery;
  ids: string[];
}

/**
 * Keep what the omnibox read (Enter): every detected clause joins the query as
 * its own chip, whatever was left over becomes a `mentions` chip, and the box
 * empties. The detected clauses are written EXACTLY as they were shown — the
 * person saw them as live chips before pressing Enter — and nothing else is
 * re-read: the leftover text is a text clause, which the server never scans
 * for lots, dates or numbers again.
 *
 * `rejectIndex` (optional): the detection at that position is kept as the
 * person's own words instead (the live chip's ×) — see `clauseAsText`.
 */
export function commitInterpretation(
  q: SearchQuery,
  detected: Clause[],
  residual: string,
  rejectIndex?: number,
): CommitResult {
  const base = q.clauses.length;
  const added: Clause[] = detected.map((c, i) => {
    const kept: Clause = { ...c, id: '', source: c.source === 'ai' ? 'ai' : 'detected' };
    return i === rejectIndex ? asTextClause(kept) : kept;
  });
  const rest = residual.replace(/\s+/g, ' ').trim();
  if (rest) added.push({ id: '', field: 'text', op: 'contains', values: [rest], source: 'typed' });
  const clauses = renumber([...q.clauses, ...added]);
  return {
    query: { ...q, text: '', clauses, view: { ...q.view, page: undefined } },
    ids: clauses.slice(base).map((c) => c.id),
  };
}

/** Words a clause was read from, for putting them back as text. */
export function clauseWords(c: Clause, labels: Record<string, string> = {}): string {
  if (c.raw && c.raw.trim()) return c.raw.trim();
  if (c.field === 'text') return c.values.join(' ');
  return describeClause(c, labels);
}

function asTextClause(c: Clause, labels: Record<string, string> = {}): Clause {
  const words = clauseWords(c, labels);
  const def = fieldDef(c.field);
  return {
    id: c.id,
    field: 'text',
    op: 'contains',
    values: [words],
    // 'typed': the person's own words, which the server matches as text and
    // never re-reads — so a rejected detection cannot come back by itself.
    source: 'typed',
    raw: words,
    note: def && c.field !== 'text' ? `Kept as your words — not read as ${def.label.toLowerCase()}.` : null,
  };
}

/**
 * Reject a reading: the clause becomes the words it was read from, matched as
 * text. It is never silently re-applied — a text clause is not interpreted.
 */
export function clauseAsText(q: SearchQuery, id: string, labels: Record<string, string> = {}): SearchQuery {
  const clauses = q.clauses.map((c) => (c.id === id ? asTextClause(c, labels) : c));
  return { ...q, clauses: renumber(clauses), view: { ...q.view, page: undefined } };
}

/** Replace one clause in place (an edit from the clause editor). */
export function replaceClause(q: SearchQuery, id: string, next: Clause): SearchQuery {
  const clauses = q.clauses.map((c) => (c.id === id ? { ...next, id } : c));
  return { ...q, clauses: renumber(clauses), view: { ...q.view, page: undefined } };
}

/** Add one clause at the end (a facet pick, a jump-row filter). */
export function withClause(q: SearchQuery, c: Omit<Clause, 'id'>): SearchQuery {
  return { ...q, clauses: renumber([...q.clauses, { ...c, id: '' }]), view: { ...q.view, page: undefined } };
}

/**
 * An AI reading replaces what the text was read as before — detected chips,
 * the person's text chips and any earlier AI reading — and keeps what they
 * chose deliberately (facets, builder rows, a saved search). Every clause it
 * adds carries `source: 'ai'`, so its chip says so.
 */
export function withAiReading(q: SearchQuery, ai: Clause[]): SearchQuery {
  const kept = q.clauses.filter((c) => c.source === 'facet' || c.source === 'builder' || c.source === 'saved');
  const added = ai.map((c) => ({ ...c, id: '', source: 'ai' as const }));
  return { ...q, text: '', clauses: renumber([...kept, ...added]), view: { ...q.view, page: undefined } };
}

/** The words Ask AI is given: the box, plus every text chip. */
export function questionText(q: SearchQuery): string {
  return [q.text, ...q.clauses.filter((c) => c.field === 'text').flatMap((c) => c.values)]
    .join(' ').replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

function humanDate(v: string): string {
  const md = /^--(\d{2})-(\d{2})$/.exec(v);
  if (md) return `${formatMonthDay(Number(md[1]), Number(md[2]))} (any year)`;
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? formatIsoHuman(v) : v;
}

function orList(values: string[]): string {
  if (values.length <= 1) return values[0] ?? '';
  return `${values.slice(0, -1).join(', ')} or ${values[values.length - 1]}`;
}

const ROLE_WORDS: Record<SearchDateRole, string> = {
  production: 'Production date',
  code: 'Code date',
  expiration: 'Best-by / expiration date',
  ship: 'Ship date',
  uploaded: 'Uploaded',
  any: 'Date',
};

/**
 * A clause in words, for its chip: "Supplier: Darigold or West Point",
 * "Uploaded in the last 30 days", "Production date Sep 2 (any year)".
 * `labels` maps an id value to its display name (suppliers, types, products).
 */
export function describeClause(c: Clause, labels: Record<string, string> = {}): string {
  const def = fieldDef(c.field);
  if (!def) return c.values.join(', ');
  const named = c.values.map((v) => labels[v] ?? (c.field === 'status' ? STATUS_LABELS[v] ?? v : v));
  switch (c.field) {
    case 'supplier':
    case 'document_type':
    case 'product':
    case 'status':
      return `${def.label}: ${c.exclude ? 'not ' : ''}${orList(named)}`;
    case 'uploaded': {
      const bucket = UPLOADED_BUCKETS.find((b) => b.value === `${c.op}:${c.values[0]}`);
      if (bucket) return `Uploaded: ${bucket.label.toLowerCase()}`;
      if (c.op === 'within') return `Uploaded in the last ${c.values[0]} days`;
      if (c.op === 'older_than') return `Uploaded more than ${c.values[0]} days ago`;
      break;
    }
    case 'text':
      return `Mentions "${c.values.join(' ')}"`;
    case 'lot':
      if (c.op === 'starts') return `Lot starts with ${c.values[0]}${c.note ? ` · ${c.note}` : ''}`;
      return c.sublot ? `Lot ${c.values[0]} · sublot ${c.sublot}` : `Lot ${c.values[0]}`;
    case 'po':
      return `PO ${c.values[0]}`;
    case 'invoice':
      return `Invoice ${c.values[0]}`;
    case 'order':
      return `Order ${c.values[0]}`;
    case 'identifier':
      return `Identifier ${c.values[0]}`;
    default:
      break;
  }
  const label = c.field === 'date' ? ROLE_WORDS[c.role ?? 'any'] : c.field === 'uploaded' ? 'Uploaded' : def.label;
  const [a, b] = c.values;
  switch (c.op) {
    case 'on': return `${label} ${humanDate(a)}`;
    case 'between': {
      const span = b ? describeSpanValues(a, b) : null;
      if (span) return `${label} ${span.text}${span.anyYear ? ' (any year)' : ''}`;
      return `${label} between ${humanDate(a)} and ${humanDate(b ?? a)}`;
    }
    case 'before': return `${label} before ${humanDate(a)}`;
    case 'after': return `${label} ${sinceWords(a) ?? `after ${humanDate(a)}`}`;
    default: return `${label} ${c.values.join(', ')}`;
  }
}
