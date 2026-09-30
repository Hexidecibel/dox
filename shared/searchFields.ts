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
  makeCustomerConstraint,
  makeInvoiceConstraint,
  makeKeyKindConstraint,
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
  | 'identifier'
  // --- Phase 3 (Advanced mode and every field) ---
  | 'requirement'
  | 'claim'
  | 'spec_verdict'
  | 'renewal_state'
  | 'classification'
  | 'owner'
  | 'intake_source'
  | 'approved'
  | 'document_number'
  | 'certificate_number'
  | 'customer';

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
  | 'contains'
  /** A date field with nothing recorded (approved: "not recorded"). */
  | 'missing';

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

/**
 * Which result modes (Documents / Lots / Products / Suppliers) each field means
 * something in. Every mode is a view over the matching DOCUMENTS; a clause
 * whose field does not describe that mode's row is shown greyed ("doesn't
 * apply to lots") and is not run — it is never dropped from the query, and it
 * applies again when the mode is switched back.
 */
const ALL: SearchEntity[] = ['documents', 'lots', 'products', 'suppliers'];
/** Document housekeeping: when, how and by whom a DOCUMENT was filed. */
const DOC_ONLY: SearchEntity[] = ['documents'];
/** A lot, a date or a printed number is a row fact: a supplier row has none. */
const ROWS: SearchEntity[] = ['documents', 'lots', 'products'];

function scopeField(key: FieldKey, label: string, valueKind: FieldDef['valueKind'], entities: SearchEntity[]): FieldDef {
  return { key, label, class: 'scope', valueKind, ops: ENTITY_OPS, defaultOp: 'in', facetable: true, excludable: true, multi: true, entities };
}
function scopeDate(key: FieldKey, label: string, entities: SearchEntity[], extra: ClauseOp[] = []): FieldDef {
  return { key, label, class: 'scope', valueKind: 'date', ops: ['within', 'older_than', ...DATE_OPS, ...extra], defaultOp: 'within', facetable: true, excludable: false, multi: false, entities };
}
function identField(key: FieldKey, label: string, entities: SearchEntity[]): FieldDef {
  return { key, label, class: 'identifying', valueKind: 'identifier', ops: ['is'], defaultOp: 'is', facetable: false, excludable: false, multi: false, entities };
}
function identDate(key: FieldKey, label: string, role: SearchDateRole): FieldDef {
  return { key, label, class: 'identifying', valueKind: 'date', ops: DATE_OPS, defaultOp: 'on', facetable: false, excludable: false, multi: false, entities: ROWS, role };
}

export const SEARCH_FIELDS: Record<FieldKey, FieldDef> = {
  supplier: scopeField('supplier', 'Supplier', 'entity', ALL),
  document_type: scopeField('document_type', 'Document type', 'entity', ALL),
  product: scopeField('product', 'Product', 'entity', ALL),
  status: scopeField('status', 'Status', 'enum', ['documents', 'lots', 'suppliers']),
  uploaded: scopeDate('uploaded', 'Uploaded', DOC_ONLY),
  text: { key: 'text', label: 'Mentions', class: 'text', valueKind: 'text', ops: ['contains'], defaultOp: 'contains', facetable: false, excludable: false, multi: false, entities: ALL },
  lot: { key: 'lot', label: 'Lot', class: 'identifying', valueKind: 'lot', ops: ['is', 'starts'], defaultOp: 'is', facetable: false, excludable: false, multi: false, entities: ROWS },
  production_date: identDate('production_date', 'Production date', 'production'),
  code_date: identDate('code_date', 'Code date', 'code'),
  best_by_date: identDate('best_by_date', 'Best-by / expiration date', 'expiration'),
  date: identDate('date', 'Date', 'any'),
  order: identField('order', 'Order', ALL),
  po: identField('po', 'PO', ALL),
  invoice: identField('invoice', 'Invoice', ALL),
  identifier: identField('identifier', 'Identifier', ALL),
  // --- Phase 3: every field ---
  requirement: scopeField('requirement', 'Requirement', 'entity', ALL),
  claim: scopeField('claim', 'Claim', 'entity', ALL),
  spec_verdict: scopeField('spec_verdict', 'Spec result', 'enum', ALL),
  renewal_state: scopeField('renewal_state', 'Renewal', 'enum', ['documents', 'suppliers']),
  classification: scopeField('classification', 'Classification', 'enum', DOC_ONLY),
  owner: scopeField('owner', 'Owner', 'enum', DOC_ONLY),
  intake_source: scopeField('intake_source', 'Came in by', 'enum', DOC_ONLY),
  approved: scopeDate('approved', 'Approved', DOC_ONLY, ['missing']),
  document_number: identField('document_number', 'Document #', ROWS),
  certificate_number: identField('certificate_number', 'Certificate #', ROWS),
  customer: { key: 'customer', label: 'Customer', class: 'identifying', valueKind: 'entity', ops: ['is'], defaultOp: 'is', facetable: false, excludable: false, multi: false, entities: ALL },
};

export const FIELD_KEYS = Object.keys(SEARCH_FIELDS) as FieldKey[];
export const SCOPE_FIELDS = FIELD_KEYS.filter((k) => SEARCH_FIELDS[k].class === 'scope');
/** The facets a documents search returns, in sidebar order. */
export const FACET_FIELDS = [
  'supplier', 'document_type', 'product', 'requirement', 'claim', 'renewal_state', 'spec_verdict',
  'classification', 'owner', 'intake_source', 'uploaded', 'approved', 'status',
] as const;
export type FacetField = (typeof FACET_FIELDS)[number];
/** Facets whose options are day windows (single-select buckets). */
export const DATE_FACETS: ReadonlySet<string> = new Set(['uploaded', 'approved']);

/** Does this field mean anything in this result mode? */
export function appliesTo(field: FieldKey, entity: SearchEntity): boolean {
  return SEARCH_FIELDS[field].entities.includes(entity);
}

/**
 * The value an enum facet uses for "nothing recorded" (no owner, no intake door
 * on file). No real value is spelled like this.
 */
export const NONE_VALUE = '__none__';

/**
 * A document's spec result — the WORST judgement on its register (0085) and
 * its gaps (0109): one out-of-spec result makes the document "out of spec"
 * whatever else passed; a result that could not be judged, or a result its
 * supplier's watch requires and the certificate did not print, makes it
 * "could not check". A register holding nothing for it is "no results judged",
 * which is NOT a pass.
 */
export const SPEC_VERDICT_VALUES = ['out_of_spec', 'not_checked', 'in_spec', 'none'] as const;
export const SPEC_VERDICT_LABELS: Record<string, string> = {
  out_of_spec: 'Out of spec',
  not_checked: 'Could not check',
  in_spec: 'In spec',
  none: 'No results judged',
};

/**
 * A document's renewal state, judged on the renewal date CONFIRMED on it (0097)
 * by the alert engine's own rules (`classifyDaysUntil` in
 * functions/lib/expirations.ts) against its own resolved warning time (0111:
 * type -> organization -> 60 days). `expired` and `overdue` read together as
 * "past due". "Does not renew" is a reviewer's cleared decision or a type whose
 * policy is none. "No renewal date confirmed" is a document nobody settled a
 * date on — the Renewals dashboard may still compute one from the defaults,
 * which is why it is not called current.
 */
export const RENEWAL_STATE_VALUES = ['past_due', 'expiring', 'current', 'does_not_renew', 'not_set'] as const;
export type RenewalStateValue = (typeof RENEWAL_STATE_VALUES)[number];
export const RENEWAL_STATE_LABELS: Record<string, string> = {
  past_due: 'Past due',
  expiring: 'Due within its warning time',
  current: 'Current',
  does_not_renew: 'Does not renew',
  not_set: 'No renewal date confirmed',
};

export const CLASSIFICATION_VALUES = ['unclassified', 'needs_review', 'classified', 'unclassifiable'] as const;
export const CLASSIFICATION_LABELS: Record<string, string> = {
  unclassified: 'Unclassified',
  needs_review: 'Needs review',
  classified: 'Classified',
  unclassifiable: 'Unclassifiable',
};

/** How each intake door is named (`documents.intake_source`, migration 0130). */
export const INTAKE_SOURCE_LABELS: Record<string, string> = {
  import: 'Uploaded for review',
  email: 'Email',
  manual: 'Connector (run by hand)',
  s3: 'Connector (watched bucket)',
  r2_poll: 'Connector (watched bucket)',
  api: 'Connector drop (API)',
  public_link: 'Public drop link',
  webhook: 'Webhook',
  api_poll: 'Connector (polled API)',
  request_link: 'Supplier request link',
  direct_upload: 'Uploaded directly (no review)',
  ingest_api: 'Ingest API',
  [NONE_VALUE]: 'Not recorded',
};

/** A value's words on an enum facet or chip. */
export function enumLabel(field: FieldKey, v: string): string {
  switch (field) {
    case 'status': return STATUS_LABELS[v] ?? v;
    case 'spec_verdict': return SPEC_VERDICT_LABELS[v] ?? v;
    case 'renewal_state': return RENEWAL_STATE_LABELS[v] ?? v;
    case 'classification': return CLASSIFICATION_LABELS[v] ?? v;
    case 'intake_source': return INTAKE_SOURCE_LABELS[v] ?? v;
    case 'owner': return v === NONE_VALUE ? 'No owner' : v;
    default: return v;
  }
}

/** The fixed options of a closed-vocabulary field (for the clause editor). */
export function enumOptions(field: FieldKey): Array<{ value: string; label: string }> | null {
  const list: Partial<Record<FieldKey, readonly string[]>> = {
    status: STATUS_VALUES,
    spec_verdict: SPEC_VERDICT_VALUES,
    renewal_state: RENEWAL_STATE_VALUES,
    classification: CLASSIFICATION_VALUES,
  };
  const vals = list[field];
  return vals ? vals.map((v) => ({ value: v, label: enumLabel(field, v) })) : null;
}

/**
 * The columns the Advanced documents table can show, in order. `title` is
 * always shown. A saved view stores its choice (`view.columns`).
 */
export const SEARCH_COLUMNS: Array<{ key: string; label: string; default?: boolean }> = [
  { key: 'title', label: 'Document', default: true },
  { key: 'type', label: 'Type', default: true },
  { key: 'supplier', label: 'Supplier', default: true },
  { key: 'products', label: 'Products', default: true },
  { key: 'lots', label: 'Lot(s)', default: true },
  { key: 'production', label: 'Production date' },
  { key: 'code_best_by', label: 'Code / best-by' },
  { key: 'renewal_due', label: 'Renewal due' },
  { key: 'renewal_state', label: 'Renewal' },
  { key: 'spec_verdict', label: 'Spec result' },
  { key: 'classification', label: 'Classification' },
  { key: 'owner', label: 'Owner' },
  { key: 'intake_source', label: 'Came in by' },
  { key: 'uploaded', label: 'Uploaded', default: true },
  { key: 'approved', label: 'Approved' },
  { key: 'document_number', label: 'Document #' },
  { key: 'certificate_number', label: 'Certificate #' },
  { key: 'po', label: 'PO' },
  { key: 'shelf_life', label: 'Shelf life' },
];
export const DEFAULT_COLUMNS: string[] = SEARCH_COLUMNS.filter((c) => c.default).map((c) => c.key);

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
  const closed: Partial<Record<FieldKey, readonly string[]>> = {
    spec_verdict: SPEC_VERDICT_VALUES,
    renewal_state: RENEWAL_STATE_VALUES,
    classification: CLASSIFICATION_VALUES,
  };
  const vocab = closed[def.key];
  if (vocab && values.some((v) => !vocab.includes(v))) return `${def.label} is one of: ${vocab.join(', ')}.`;
  if (values.some((v) => v.length > 200)) return `${def.label}: a value is too long.`;
  if (def.valueKind === 'date') {
    if (c.op === 'missing') {
      // "Not recorded": the value is a placeholder, there is nothing to parse.
    } else if (c.op === 'within' || c.op === 'older_than') {
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
  if ((c.field === 'po' || c.field === 'invoice' || c.field === 'identifier' || c.field === 'order' || c.field === 'document_number' || c.field === 'certificate_number') && normalizeKeyValue(values[0]).length < 2) {
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
  /** WMS orders by customer id (customer clauses), most recent first, capped. */
  ordersByCustomer?: Map<string, { name: string; orders: SearchOrderEvidence[]; capped: boolean }>;
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
    case 'document_number':
    case 'certificate_number':
      return { constraint: withNote(makeKeyKindConstraint(id, v, c.field, source)) };
    case 'customer': {
      const found = ctx.ordersByCustomer?.get(v);
      if (!found) return { dropped: { kind: 'customer', label: `customer ${v}`, raw: v, reason: 'no customer with that id is on file.' } };
      return { constraint: withNote(makeCustomerConstraint(id, v, found.name, found.orders, found.capped, source)) };
    }
    default:
      return { dropped: { kind: 'unknown', label: `${c.field} ${v}`, raw: v, reason: 'that field is not something a document can cover.' } };
  }
}
