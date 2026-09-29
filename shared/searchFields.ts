/**
 * The search field registry (search redesign, Phase 1). One entry per thing a
 * person can search BY, with the one epistemic rule enforced by `class`:
 *
 *   scope        a hard SQL filter (supplier, type, product, status, upload
 *                date). It NARROWS the set; it is facetable and excludable; it
 *                never claims a document "covers" anything.
 *   identifying  something a document must BE (a lot, a production / code /
 *                best-by date, an order, a PO, an invoice, an identifier). It
 *                becomes a `SearchConstraint` and is judged row by row by the
 *                unchanged `evaluateSubject`: covering / likely / nearby / none.
 *                "Not lot X" is not a coverage question, so exclude is refused.
 *   text         the free words, matched by FTS.
 *
 * `clauseToConstraint` is pure: the server hands it the WMS orders it looked
 * up, and it never reaches for anything else.
 */

import type { SearchConstraint, SearchDateRole, SearchDroppedConstraint, SearchOrderEvidence } from './types';
import type { Clause } from './searchQuery';
import {
  makeDateConstraint,
  makeDateRangeConstraint,
  makeIdentifierConstraint,
  makeInvoiceConstraint,
  makeLotConstraint,
  makeLotPrefixConstraint,
  makePoConstraint,
  makeStructuredLotConstraint,
} from './searchCoverage';
import { makeOrderConstraint } from './orderCoverage';
import { normalizeLotNumber } from './lotNormalize';
import { foldCustomerPo, normalizeKeyValue, stripKeyword } from './searchKeys';

export type FieldKey =
  | 'supplier'
  | 'document_type'
  | 'product'
  | 'status'
  | 'uploaded'
  | 'text'
  | 'lot'
  | 'production_date'
  | 'code_date'
  | 'best_by_date'
  | 'date'
  | 'order'
  | 'po'
  | 'invoice'
  | 'identifier';

export type ClauseOp =
  | 'in'
  | 'is'
  /** Lot only: every lot that starts with the value ("lot 104"). */
  | 'starts'
  | 'on'
  | 'between'
  | 'before'
  | 'after'
  | 'within'
  | 'older_than'
  | 'contains';

export type FieldClass = 'scope' | 'identifying' | 'text';
export type SearchEntity = 'documents' | 'lots' | 'products' | 'suppliers';

export interface FieldDef {
  key: FieldKey;
  label: string;
  class: FieldClass;
  valueKind: 'entity' | 'enum' | 'date' | 'identifier' | 'lot' | 'text';
  ops: ClauseOp[];
  defaultOp: ClauseOp;
  facetable: boolean;
  excludable: boolean;
  /** May one clause hold several values (any-of)? */
  multi: boolean;
  entities: SearchEntity[];
  /** Identifying date fields: the role they are judged under. */
  role?: SearchDateRole;
}

const ENTITY_OPS: ClauseOp[] = ['in'];
const DATE_OPS: ClauseOp[] = ['on', 'between', 'before', 'after'];

export const SEARCH_FIELDS: Record<FieldKey, FieldDef> = {
  supplier: { key: 'supplier', label: 'Supplier', class: 'scope', valueKind: 'entity', ops: ENTITY_OPS, defaultOp: 'in', facetable: true, excludable: true, multi: true, entities: ['documents', 'lots', 'products'] },
  document_type: { key: 'document_type', label: 'Document type', class: 'scope', valueKind: 'entity', ops: ENTITY_OPS, defaultOp: 'in', facetable: true, excludable: true, multi: true, entities: ['documents'] },
  product: { key: 'product', label: 'Product', class: 'scope', valueKind: 'entity', ops: ENTITY_OPS, defaultOp: 'in', facetable: true, excludable: true, multi: true, entities: ['documents', 'lots', 'suppliers'] },
  status: { key: 'status', label: 'Status', class: 'scope', valueKind: 'enum', ops: ENTITY_OPS, defaultOp: 'in', facetable: true, excludable: true, multi: true, entities: ['documents'] },
  uploaded: { key: 'uploaded', label: 'Uploaded', class: 'scope', valueKind: 'date', ops: ['within', 'older_than', ...DATE_OPS], defaultOp: 'within', facetable: true, excludable: false, multi: false, entities: ['documents'] },
  text: { key: 'text', label: 'Mentions', class: 'text', valueKind: 'text', ops: ['contains'], defaultOp: 'contains', facetable: false, excludable: false, multi: false, entities: ['documents'] },
  lot: { key: 'lot', label: 'Lot', class: 'identifying', valueKind: 'lot', ops: ['is', 'starts'], defaultOp: 'is', facetable: false, excludable: false, multi: false, entities: ['documents', 'lots'] },
  production_date: { key: 'production_date', label: 'Production date', class: 'identifying', valueKind: 'date', ops: DATE_OPS, defaultOp: 'on', facetable: false, excludable: false, multi: false, entities: ['documents', 'lots'], role: 'production' },
  code_date: { key: 'code_date', label: 'Code date', class: 'identifying', valueKind: 'date', ops: DATE_OPS, defaultOp: 'on', facetable: false, excludable: false, multi: false, entities: ['documents', 'lots'], role: 'code' },
  best_by_date: { key: 'best_by_date', label: 'Best-by / expiration date', class: 'identifying', valueKind: 'date', ops: DATE_OPS, defaultOp: 'on', facetable: false, excludable: false, multi: false, entities: ['documents', 'lots'], role: 'expiration' },
  date: { key: 'date', label: 'Date', class: 'identifying', valueKind: 'date', ops: DATE_OPS, defaultOp: 'on', facetable: false, excludable: false, multi: false, entities: ['documents', 'lots'], role: 'any' },
  order: { key: 'order', label: 'Order', class: 'identifying', valueKind: 'identifier', ops: ['is'], defaultOp: 'is', facetable: false, excludable: false, multi: false, entities: ['documents', 'lots'] },
  po: { key: 'po', label: 'PO', class: 'identifying', valueKind: 'identifier', ops: ['is'], defaultOp: 'is', facetable: false, excludable: false, multi: false, entities: ['documents'] },
  invoice: { key: 'invoice', label: 'Invoice', class: 'identifying', valueKind: 'identifier', ops: ['is'], defaultOp: 'is', facetable: false, excludable: false, multi: false, entities: ['documents'] },
  identifier: { key: 'identifier', label: 'Identifier', class: 'identifying', valueKind: 'identifier', ops: ['is'], defaultOp: 'is', facetable: false, excludable: false, multi: false, entities: ['documents'] },
};

export const FIELD_KEYS = Object.keys(SEARCH_FIELDS) as FieldKey[];
export const SCOPE_FIELDS = FIELD_KEYS.filter((k) => SEARCH_FIELDS[k].class === 'scope');
/** The facets a documents search returns, in sidebar order. */
export const FACET_FIELDS = ['supplier', 'document_type', 'product', 'status', 'uploaded'] as const;
export type FacetField = (typeof FACET_FIELDS)[number];

export function isFieldKey(k: unknown): k is FieldKey {
  return typeof k === 'string' && Object.prototype.hasOwnProperty.call(SEARCH_FIELDS, k);
}

export function fieldDef(k: string): FieldDef | null {
  return isFieldKey(k) ? SEARCH_FIELDS[k] : null;
}

export function isIdentifyingField(k: FieldKey): boolean {
  return SEARCH_FIELDS[k].class === 'identifying';
}

export function isScopeField(k: FieldKey): boolean {
  return SEARCH_FIELDS[k].class === 'scope';
}

/** Document status values search can filter on ('deleted' is never searchable). */
export const STATUS_VALUES = ['active', 'archived'] as const;
export const STATUS_LABELS: Record<string, string> = { active: 'Active', archived: 'Archived' };

/**
 * Uploaded-date facet options. ONE vocabulary: each value is literally the
 * clause it selects (`within:30` = op within, value 30), so the facet, the URL
 * and the server can no longer disagree about what "30d" means. Counts are
 * cumulative ("in the last 30 days" includes the last 7).
 */
export const UPLOADED_BUCKETS: Array<{ value: string; label: string; op: 'within' | 'older_than'; days: number }> = [
  { value: 'within:1', label: 'Last 24 hours', op: 'within', days: 1 },
  { value: 'within:7', label: 'Last 7 days', op: 'within', days: 7 },
  { value: 'within:30', label: 'Last 30 days', op: 'within', days: 30 },
  { value: 'within:90', label: 'Last 90 days', op: 'within', days: 90 },
  { value: 'within:365', label: 'Last year', op: 'within', days: 365 },
  { value: 'older_than:365', label: 'Over a year ago', op: 'older_than', days: 365 },
];

/** The bucket value a single-value uploaded clause corresponds to, or null. */
export function uploadedBucketOf(c: Pick<Clause, 'op' | 'values'>): string | null {
  if ((c.op !== 'within' && c.op !== 'older_than') || c.values.length !== 1) return null;
  const v = `${c.op}:${c.values[0]}`;
  return UPLOADED_BUCKETS.some((b) => b.value === v) ? v : null;
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_DAY = /^--(\d{2})-(\d{2})$/;

/** "--04-17": a valid month/day in some year (Feb 29 included). */
export function isMonthDay(v: string): boolean {
  const md = MONTH_DAY.exec(v);
  if (!md) return false;
  return isIsoDay(`2024-${md[1]}-${md[2]}`);
}

export function isIsoDay(v: string): boolean {
  if (!ISO.test(v)) return false;
  const t = Date.parse(`${v}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === v;
}

/**
 * Why a clause cannot be run, in words — or null when it is well formed.
 * The server refuses a bad clause with this message (400); it never guesses.
 */
export function validateClause(c: Clause): string | null {
  const def = fieldDef(c.field);
  if (!def) return `"${c.field}" is not a search field.`;
  if (!def.ops.includes(c.op)) return `${def.label} cannot be searched with "${c.op}".`;
  if (c.exclude && !def.excludable) {
    return def.class === 'identifying'
      ? `${def.label} cannot be excluded: "not ${def.label.toLowerCase()} X" is not a question a document can cover.`
      : `${def.label} cannot be excluded.`;
  }
  const values = c.values.map((v) => String(v).trim()).filter(Boolean);
  if (values.length === 0) return `${def.label} needs a value.`;
  if (!def.multi && values.length > 1 && c.op !== 'between') return `${def.label} takes one value per clause; add another clause for another value.`;
  if (values.length > 90) return `${def.label} has more than 90 values; narrow it.`;
  if (def.key === 'status' && values.some((v) => !(STATUS_VALUES as readonly string[]).includes(v))) {
    return `Status is one of: ${STATUS_VALUES.join(', ')}.`;
  }
  if (def.valueKind === 'date') {
    if (c.op === 'within' || c.op === 'older_than') {
      const n = Number(values[0]);
      if (!Number.isInteger(n) || n < 1 || n > 36500) return `${def.label}: "${values[0]}" is not a number of days.`;
    } else if (c.op === 'between') {
      if (values.length !== 2) return `${def.label} between needs two dates.`;
      // Two year-less days ("--04-01", "--04-30") are a span in ANY year; the
      // first after the second wraps the year end (Dec 15 – Jan 15).
      const yearlessSpan = def.class === 'identifying' && values.every(isMonthDay);
      if (!yearlessSpan && !values.every(isIsoDay)) {
        return `${def.label}: dates are YYYY-MM-DD${def.class === 'identifying' ? ', or --MM-DD for both ends in any year' : ''}.`;
      }
      if (!yearlessSpan && values[0] > values[1]) return `${def.label}: the first date is after the second.`;
    } else {
      const v = values[0];
      const yearless = c.op === 'on' && def.class === 'identifying' && isMonthDay(v);
      if (!isIsoDay(v) && !yearless) return `${def.label}: "${v}" is not a date (YYYY-MM-DD${def.class === 'identifying' && c.op === 'on' ? ', or --MM-DD for any year' : ''}).`;
    }
  }
  if (c.field === 'lot' && !normalizeLotNumber(values[0])) return `"${values[0]}" is not a lot number.`;
  if ((c.field === 'po' || c.field === 'invoice' || c.field === 'identifier' || c.field === 'order') && normalizeKeyValue(values[0]).length < 2) {
    return `${def.label}: "${values[0]}" is not an identifier.`;
  }
  return null;
}

/** The date role an identifying date clause is judged under. */
export function clauseRole(c: Clause): SearchDateRole {
  const def = SEARCH_FIELDS[c.field];
  if (c.field === 'date') return c.role && c.role !== 'uploaded' ? c.role : 'any';
  return def.role ?? 'any';
}

function addDays(iso: string, n: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

export interface ConstraintContext {
  /** WMS orders by normalized order number (order / identifier clauses). */
  ordersByNumber?: Map<string, SearchOrderEvidence>;
  /** WMS orders by FOLDED customer PO (`foldCustomerPo`; po / identifier clauses). */
  ordersByPo?: Map<string, SearchOrderEvidence[]>;
  /** Kinds of document key a number hit (identifier chip wording). */
  hitKinds?: Map<string, string[]>;
}

/**
 * An identifying clause as the engine's constraint. Pure. An order number the
 * WMS does not hold is DROPPED with the reason, never silently widened.
 */
export function clauseToConstraint(
  c: Clause,
  id: string,
  ctx: ConstraintContext = {},
): { constraint: SearchConstraint } | { dropped: SearchDroppedConstraint } {
  const source: SearchConstraint['source'] = c.source === 'ai' ? 'ai_parse' : c.source === 'detected' ? 'query_text' : 'structured';
  const v = String(c.values[0] ?? '').trim();
  const withNote = (k: SearchConstraint) => (c.note ? { ...k, note: [k.note, c.note].filter(Boolean).join(' ') } : k);
  switch (c.field) {
    case 'lot': {
      if (c.op === 'starts') return { constraint: { ...makeLotPrefixConstraint(id, v, source, c.note ?? null), raw: c.raw ?? v } };
      const k = c.sublot
        ? makeStructuredLotConstraint(id, v, c.sublot)
        : makeLotConstraint(id, { raw: v, norm: normalizeLotNumber(v) }, source);
      if (!k) return { dropped: { kind: 'lot', label: `lot ${v}`, raw: v, reason: 'that is not a lot number.' } };
      return { constraint: withNote({ ...k, source }) };
    }
    case 'production_date':
    case 'code_date':
    case 'best_by_date':
    case 'date': {
      const role = clauseRole(c);
      const md = MONTH_DAY.exec(v);
      if (c.op === 'on' && md) {
        return {
          constraint: withNote(makeDateConstraint(id, role, {
            kind: 'month_day', month: Number(md[1]), day: Number(md[2]), raw: c.raw ?? v, note: 'No year given — matches that day in any year.',
          }, source)),
        };
      }
      if (c.op === 'on') return { constraint: withNote(makeDateConstraint(id, role, { kind: 'day', iso: v, raw: c.raw ?? v, note: null }, source)) };
      const md2 = MONTH_DAY.exec(String(c.values[1] ?? ''));
      if (c.op === 'between' && md && md2) {
        const from = { month: Number(md[1]), day: Number(md[2]) };
        const to = { month: Number(md2[1]), day: Number(md2[2]) };
        const wraps = v > String(c.values[1]);
        return {
          constraint: withNote(makeDateConstraint(id, role, {
            kind: 'month_range', from, to, raw: c.raw ?? `${v}..${c.values[1]}`,
            // A detected clause carries its own reading's note already.
            note: c.note ? null : wraps ? 'No year given — the span runs across the year end, in any year.' : 'No year given — matches those days in any year.',
          }, source)),
        };
      }
      if (c.op === 'between') return { constraint: withNote(makeDateRangeConstraint(id, role, v, String(c.values[1]), c.raw ?? `${v}..${c.values[1]}`, source)) };
      if (c.op === 'before') return { constraint: withNote(makeDateRangeConstraint(id, role, null, addDays(v, -1), c.raw ?? `before ${v}`, source)) };
      return { constraint: withNote(makeDateRangeConstraint(id, role, addDays(v, 1), null, c.raw ?? `after ${v}`, source)) };
    }
    case 'order': {
      const ev = ctx.ordersByNumber?.get(normalizeKeyValue(v));
      if (!ev) return { dropped: { kind: 'order', label: `order ${v}`, raw: v, reason: 'no WMS order with that number is on file.' } };
      return { constraint: withNote({ ...makeOrderConstraint(id, ev, c.raw ?? v), source }) };
    }
    case 'po':
      return { constraint: withNote(makePoConstraint(id, v, ctx.ordersByPo?.get(foldCustomerPo(v)) ?? [], source)) };
    case 'invoice': {
      const bare = stripKeyword(v, 'invoice');
      return { constraint: withNote(makeInvoiceConstraint(id, v, ctx.ordersByNumber?.get(normalizeKeyValue(bare))?.order_number ?? null, source)) };
    }
    case 'identifier': {
      const norm = normalizeKeyValue(v);
      const orders = [
        ...(ctx.ordersByNumber?.get(norm) ? [ctx.ordersByNumber.get(norm)!] : []),
        ...(ctx.ordersByPo?.get(foldCustomerPo(v)) ?? []),
      ].filter((o, i, all) => all.findIndex((x) => x.order_id === o.order_id) === i);
      return { constraint: withNote(makeIdentifierConstraint(id, v, { orders, hitKinds: ctx.hitKinds?.get(norm) }, source)) };
    }
    default:
      return { dropped: { kind: 'unknown', label: `${c.field} ${v}`, raw: v, reason: 'that field is not something a document can cover.' } };
  }
}
