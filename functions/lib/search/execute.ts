/**
 * The one search executor (search redesign, Phase 1): `runSearch` behind
 * POST /api/search/query.
 *
 * TWO PATHS, ONE RULE.
 *
 *   Scope / text only — every scope clause is a hard SQL filter
 *   (compileScope.ts), free text is the documents_fts MATCH, and the page plus
 *   every facet (sticky exclusion: each facet's counts leave out that facet's
 *   own selection) go out in ONE `DB.batch`. One round trip.
 *
 *   Identifying — a lot, a production / code / best-by date, an order, a PO,
 *   an invoice or an identifier, typed as a clause or read out of the text,
 *   becomes a SearchConstraint and is judged by the UNCHANGED
 *   `evaluateSubject`. Candidates come from index SEEKS (lots by key and
 *   production date, document_search_keys by kind + value or date, orders by
 *   number / PO, documents by renewal date), never from the 5,000-document
 *   scan — which survives only as the declared fallback while a tenant's
 *   search keys are still being built (`keys_pending`). Candidates are loaded
 *   WITHOUT the scope, judged, and then the scope is applied in memory by the
 *   JS mirror of the SQL, so facet counts can be taken over the covering +
 *   likely answers with sticky exclusion. Nearby candidates never inflate a
 *   count. At most four round trips (two more when it first brings stale keys
 *   up to date):
 *
 *     R0  what the tenant holds for the typed tokens (keys, lots, WMS orders
 *         and their lines), names for the ids the query names, pending keys
 *     R1  the seeks, the FTS pools, the Review Queue
 *     R2  the candidates' narrow subject projection
 *     R3  the page's display rows
 *
 * The coverage answer keeps its epistemics word for word: covering / likely /
 * nearby / still in the Review Queue, and "No document on file covers …" when
 * nothing does — never a nearest document presented as the answer. A scope
 * narrows that statement, so the summary says what it was narrowed to.
 */

import type {
  FacetCount,
  SearchConstraint,
  SearchCoverage,
  SearchDroppedConstraint,
  SearchOrderEvidence,
  SearchKeyKind,
  SearchDocLot,
  SearchQueryResponse,
  SearchUnreviewedCandidate,
  UniversalSearchDocument,
} from '../../../shared/types';
import type { Clause, SearchQuery } from '../../../shared/searchQuery';
import { describeClause } from '../../../shared/searchQuery';
import {
  clauseToConstraint,
  FACET_FIELDS,
  SEARCH_FIELDS,
  STATUS_LABELS,
  UPLOADED_BUCKETS,
  validateClause,
  type ConstraintContext,
  type FacetField,
} from '../../../shared/searchFields';
import {
  answeringLotRows,
  coverageFor,
  coverageSummary,
  evaluateSubject,
  matchedLotOf,
  NEAR_DATE_DAYS,
  type CoverageSubject,
  type SubjectVerdict,
} from '../../../shared/searchCoverage';
import { customerPoSpellings, DATE_KEY_KINDS, foldCustomerPo, IDENTIFIER_KEY_KINDS, normalizeKeyValue, stripKeyword } from '../../../shared/searchKeys';
import { normalizeLotNumber } from '../../../shared/lotNormalize';
import { decodeLot, formatLotIso, lotSchemeLabel } from '../../../shared/lotScheme';
import { BadRequestError } from '../permissions';
import { buildMatchExprWithLot, DOCUMENTS_FTS_COLS, documentsBm25Expr } from '../search-fts';
import {
  addDocRow,
  CANDIDATE_CAP,
  DOC_SCAN_CAP,
  docSubjectSelect,
  fetchDocumentRows,
  ftsPoolStatement,
  impliedLotExample,
  orderEvidenceFromRows,
  poolFromRows,
  QUEUE_SCAN_CAP,
  QUEUE_SCAN_SQL,
  queueGroupFromRow,
  queueTextStatement,
  structuredScheme,
  UNREVIEWED_CAP,
  type DocScanRow,
  type OrderItemRow,
  type OrderSuggestionRow,
  type PoolHit,
  type QueueGroup,
  type QueueScanRow,
} from '../search-coverage';
import { catalogFromRows, loadProductCatalog, productCatalogStatement, type CatalogRow } from '../product-identifiers';
import { compileScope, scopeHolds, scopeWhere, uploadedBounds, type CompiledScope, type ScopeAttrs } from './compileScope';
import { drainDocumentKeyJobs } from './keys';
import { detectProduct, lotPrefixNote, resolveDetections, scanHasCandidates, scanMayNameProduct, scanNorms, scanOrderValues, scanText, type DetectionHits } from './interpret';
import type { LotSchemeSpec } from '../../../shared/lotScheme';

/** Pending key rebuilds a search drains before it reads keys. */
export const REPAIR_LIMIT = 50;
/** Rows one seek may return. */
export const SEEK_LIMIT = 2000;
/** Subjects one search judges. */
export const CANDIDATE_LIMIT = 4000;
const CHUNK = 80;
/** FTS hits a free-text part of an identifying search may add as candidates. */
const TEXT_CANDIDATES = 100;

// ===========================================================================
// Statement accounting
// ===========================================================================

export interface StatementStats {
  statements: number;
  round_trips: number;
}

/**
 * A D1 binding that counts what it is asked to do: one statement per
 * `prepare`, one round trip per `batch` or per `.all/.first/.run/.raw`. The
 * executor runs through one of these so every response can say what it cost,
 * and the statement-count guard test can hold it to its budget.
 */
export function countingDb(db: D1Database, stats: StatementStats): D1Database {
  const real = new WeakMap<object, D1PreparedStatement>();
  const wrap = (st: D1PreparedStatement): D1PreparedStatement => {
    const proxy = new Proxy(st, {
      get(target, prop) {
        if (prop === 'bind') return (...args: unknown[]) => wrap(target.bind(...args));
        if (prop === 'all' || prop === 'first' || prop === 'run' || prop === 'raw') {
          return (...args: unknown[]) => {
            stats.round_trips++;
            return (target as unknown as Record<string, (...a: unknown[]) => unknown>)[prop as string](...args);
          };
        }
        const v = Reflect.get(target, prop, target);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    real.set(proxy, st);
    return proxy;
  };
  return new Proxy(db, {
    get(target, prop) {
      if (prop === 'prepare') {
        return (sql: string) => {
          stats.statements++;
          return wrap(target.prepare(sql));
        };
      }
      if (prop === 'batch') {
        return (stmts: D1PreparedStatement[]) => {
          stats.round_trips++;
          return target.batch(stmts.map((s) => real.get(s) ?? s));
        };
      }
      const v = Reflect.get(target, prop, target);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

/** Statements added to one batch, read back by the index each `add` returned. */
class Batch {
  readonly stmts: D1PreparedStatement[] = [];
  private results: D1Result[] = [];
  add(stmt: D1PreparedStatement): number {
    this.stmts.push(stmt);
    return this.stmts.length - 1;
  }
  async run(db: D1Database): Promise<void> {
    this.results = this.stmts.length ? await db.batch(this.stmts) : [];
  }
  rows<T>(i: number | null | undefined): T[] {
    if (i === null || i === undefined) return [];
    return ((this.results[i]?.results ?? []) as T[]);
  }
}

function ph(n: number): string {
  return Array(n).fill('?').join(',');
}

function chunks<T>(xs: T[], n = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

// ===========================================================================
// Input
// ===========================================================================

export interface RunSearchInput {
  query: SearchQuery;
  limit: number;
  offset: number;
  facets: boolean;
  interpret: boolean;
  now?: Date;
  repairLimit?: number;
}

/** Refuse a clause that cannot mean one thing (400, with the reason in words). */
export function validateQuery(q: SearchQuery): void {
  if (!q || typeof q !== 'object' || !Array.isArray(q.clauses)) throw new BadRequestError('query.clauses must be an array');
  if (typeof q.text !== 'string') throw new BadRequestError('query.text must be a string');
  if (q.clauses.length > 30) throw new BadRequestError('A search holds at most 30 clauses.');
  for (const c of q.clauses) {
    if (!c || typeof c !== 'object' || !Array.isArray(c.values)) throw new BadRequestError('Each clause needs a field, an op and values.');
    const err = validateClause(c);
    if (err) throw new BadRequestError(err);
  }
}

// ===========================================================================
// Labels
// ===========================================================================

interface LabelRow { kind: string; id: string; name: string; extra: string | null }

function labelStatement(db: D1Database, tenantId: string, scope: CompiledScope): D1PreparedStatement | null {
  const ids = (field: string) => [...new Set(scope.clauses.filter((c) => c.field === field).flatMap((c) => c.values))];
  const parts: string[] = [];
  const params: unknown[] = [];
  const sup = ids('supplier');
  if (sup.length) {
    parts.push(`SELECT 'supplier' AS kind, s.id, s.name,
      (SELECT sls.spec FROM supplier_lot_schemes sls WHERE sls.supplier_id = s.id AND sls.tenant_id = s.tenant_id ORDER BY sls.version DESC LIMIT 1) AS extra
      FROM suppliers s WHERE s.tenant_id = ? AND s.id IN (${ph(sup.length)})`);
    params.push(tenantId, ...sup);
  }
  const dt = ids('document_type');
  if (dt.length) {
    parts.push(`SELECT 'document_type' AS kind, id, name, slug AS extra FROM document_types WHERE tenant_id = ? AND id IN (${ph(dt.length)})`);
    params.push(tenantId, ...dt);
  }
  const pr = ids('product');
  if (pr.length) {
    parts.push(`SELECT 'product' AS kind, id, name, NULL AS extra FROM products WHERE tenant_id = ? AND id IN (${ph(pr.length)})`);
    params.push(tenantId, ...pr);
  }
  if (!parts.length) return null;
  return db.prepare(parts.join(' UNION ALL ')).bind(...params);
}

function scopeSummary(scope: CompiledScope, labels: Record<string, string>): string | null {
  const words = scope.clauses.map((c) => describeClause(c, labels));
  return words.length ? words.join('; ') : null;
}

// ===========================================================================
// Facets
// ===========================================================================

function withSelected(field: FacetField, rows: FacetCount[], scope: CompiledScope, labels: Record<string, string>): FacetCount[] {
  // A ticked value stays visible (count 0) so it can be unticked where it was ticked.
  const selected = scope.clauses.filter((c) => c.field === field && !c.exclude).flatMap((c) => c.values);
  const out = [...rows];
  if (field === 'uploaded') return out;
  for (const v of selected) {
    if (!out.some((r) => r.value === v)) out.push({ value: v, label: labels[v] ?? STATUS_LABELS[v] ?? v, count: 0 });
  }
  return out;
}

function uploadedFacet(counts: number[]): FacetCount[] {
  return UPLOADED_BUCKETS.map((b, i) => ({ value: b.value, label: b.label, count: Number(counts[i] ?? 0) }))
    .filter((f) => f.count > 0);
}

function uploadedCaseColumns(today: string): { sql: string; params: string[] } {
  const params: string[] = [];
  const cols = UPLOADED_BUCKETS.map((b, i) => {
    const bounds = uploadedBounds({ id: '', field: 'uploaded', op: b.op, values: [String(b.days)], source: 'facet' }, today);
    if (bounds.from) {
      params.push(bounds.from);
      return `SUM(CASE WHEN b.created_at >= ? THEN 1 ELSE 0 END) AS b${i}`;
    }
    params.push(bounds.to!);
    return `SUM(CASE WHEN b.created_at < ? THEN 1 ELSE 0 END) AS b${i}`;
  });
  return { sql: cols.join(', '), params };
}

// ===========================================================================
// The scope / text path
// ===========================================================================

const PAGE_JOINS = `LEFT JOIN users u ON d.created_by = u.id
  LEFT JOIN tenants t ON d.tenant_id = t.id
  LEFT JOIN document_types dt ON d.document_type_id = dt.id
  LEFT JOIN suppliers s ON d.supplier_id = s.id`;

const PAGE_COLUMNS = `d.*, u.name AS creator_name, t.name AS tenant_name,
  dt.name AS document_type_name, dt.slug AS document_type_slug, dt.name AS primary_category_name,
  s.name AS supplier_name,
  COALESCE(d.renewal_due_date, json_extract(d.primary_metadata, '$.expiration_date')) AS expiration,
  COUNT(*) OVER () AS total_count`;

function orderByFor(sort: string | undefined, hasMatch: boolean): string {
  switch (sort) {
    case 'newest': return 'd.created_at DESC, d.id DESC';
    case 'oldest': return 'd.created_at ASC, d.id ASC';
    case 'name': return 'd.title ASC, d.id ASC';
    default: return hasMatch ? 'm.rank, d.created_at DESC' : 'd.updated_at DESC, d.id DESC';
  }
}

async function runScopePath(
  db: D1Database,
  tenantId: string,
  scope: CompiledScope,
  text: string,
  input: RunSearchInput,
  stats: StatementStats,
): Promise<SearchQueryResponse> {
  const expr = text ? buildMatchExprWithLot(text) : null;
  const batch = new Batch();
  const where = scopeWhere(scope, tenantId);
  const matchCte = expr
    ? `WITH matches AS (
         SELECT f.doc_id, ${documentsBm25Expr()} AS rank,
                snippet(documents_fts, -1, '<mark>', '</mark>', '…', 12) AS snippet,
                snippet(documents_fts, ${DOCUMENTS_FTS_COLS.extracted_text}, '<mark>', '</mark>', '…', 12) AS snippet_extracted,
                snippet(documents_fts, ${DOCUMENTS_FTS_COLS.supplier_text}, '<mark>', '</mark>', '…', 8) AS snippet_supplier
           FROM documents_fts f WHERE f.tenant_id = ? AND documents_fts MATCH ?)`
    : '';
  const pageIdx = batch.add(
    db.prepare(
      `${matchCte}
       SELECT ${expr ? 'm.rank AS rank, m.snippet AS snippet, m.snippet_extracted AS snippet_extracted, m.snippet_supplier AS snippet_supplier,' : ''}
              ${PAGE_COLUMNS}
         FROM ${expr ? 'matches m JOIN documents d ON d.id = m.doc_id' : 'documents d'}
         ${PAGE_JOINS}
        WHERE ${where.sql}
        ORDER BY ${orderByFor(input.query.view?.sort, !!expr)}
        LIMIT ? OFFSET ?`,
    ).bind(...(expr ? [tenantId, expr] : []), ...where.params, input.limit, input.offset),
  );

  const facetIdx: Partial<Record<FacetField, number>> = {};
  if (input.facets) {
    for (const field of FACET_FIELDS) {
      const w = scopeWhere(scope, tenantId, field);
      const base = `${expr ? 'WITH matches AS (SELECT f.doc_id FROM documents_fts f WHERE f.tenant_id = ? AND documents_fts MATCH ?),' : 'WITH'}
        base AS (SELECT d.id, d.supplier_id, d.document_type_id, d.status, d.created_at
                   FROM ${expr ? 'matches m JOIN documents d ON d.id = m.doc_id' : 'documents d'}
                  WHERE ${w.sql})`;
      const pre = [...(expr ? [tenantId, expr] : []), ...w.params];
      let sql: string;
      let extra: unknown[] = [];
      switch (field) {
        case 'supplier':
          sql = `${base} SELECT b.supplier_id AS value, s.name AS label, COUNT(*) AS count
                   FROM base b JOIN suppliers s ON s.id = b.supplier_id
                  GROUP BY b.supplier_id ORDER BY count DESC, label ASC LIMIT 50`;
          break;
        case 'document_type':
          sql = `${base} SELECT b.document_type_id AS value, dt.name AS label, COUNT(*) AS count
                   FROM base b JOIN document_types dt ON dt.id = b.document_type_id
                  GROUP BY b.document_type_id ORDER BY count DESC, label ASC LIMIT 50`;
          break;
        case 'product':
          sql = `${base} SELECT x.product_id AS value, p.name AS label, COUNT(DISTINCT x.document_id) AS count
                   FROM (SELECT dp.document_id, dp.product_id FROM document_products dp WHERE dp.document_id IN (SELECT id FROM base)
                         UNION
                         SELECT dl.document_id, l.product_id FROM document_lots dl JOIN lots l ON l.id = dl.lot_id
                          WHERE dl.document_id IN (SELECT id FROM base) AND l.product_id IS NOT NULL) x
                   JOIN products p ON p.id = x.product_id
                  GROUP BY x.product_id ORDER BY count DESC, label ASC LIMIT 50`;
          break;
        case 'status':
          sql = `${base} SELECT b.status AS value, b.status AS label, COUNT(*) AS count FROM base b GROUP BY b.status ORDER BY count DESC`;
          break;
        case 'uploaded': {
          const cols = uploadedCaseColumns(scope.today);
          sql = `${base} SELECT ${cols.sql} FROM base b`;
          extra = cols.params;
          break;
        }
      }
      // Positional parameters bind in textual order: the CTE's, then the SELECT list's.
      facetIdx[field] = batch.add(db.prepare(sql).bind(...pre, ...extra));
    }
  }
  const lblStmt = labelStatement(db, tenantId, scope);
  const labelIdx = lblStmt ? batch.add(lblStmt) : null;
  await batch.run(db);

  const labels: Record<string, string> = {};
  for (const r of batch.rows<LabelRow>(labelIdx)) labels[r.id] = r.name;
  const pageRows = batch.rows<Record<string, unknown> & { total_count?: number }>(pageIdx);
  const total = pageRows.length ? Number(pageRows[0].total_count ?? 0) : 0;
  const documents = pageRows.map(({ total_count: _t, ...rest }) => rest) as unknown as UniversalSearchDocument[];

  let facets: SearchQueryResponse['facets'];
  if (input.facets) {
    facets = {};
    for (const field of FACET_FIELDS) {
      const rows = batch.rows<Record<string, unknown>>(facetIdx[field]);
      let list: FacetCount[];
      if (field === 'uploaded') {
        const r = rows[0] ?? {};
        list = uploadedFacet(UPLOADED_BUCKETS.map((_, i) => Number(r[`b${i}`] ?? 0)));
      } else {
        list = rows.filter((r) => r.value != null).map((r) => ({
          value: String(r.value),
          label: field === 'status' ? STATUS_LABELS[String(r.value)] ?? String(r.value) : String(r.label ?? r.value),
          count: Number(r.count ?? 0),
        }));
      }
      facets[field] = withSelected(field, list, scope, labels);
    }
  }

  return {
    documents,
    total,
    limit: input.limit,
    offset: input.offset,
    ...(facets ? { facets } : {}),
    clauses: [],
    labels,
    scope_summary: scopeSummary(scope, labels),
    coverage: 'unconstrained',
    constraints: [],
    dropped_constraints: [],
    coverage_summary: null,
    stats: { ...stats, candidates: 0, scan_fallback: false },
  };
}

// ===========================================================================
// The identifying (coverage) path
// ===========================================================================

const SCOPE_EXTRA_COLUMNS = `d.document_type_id AS scope_document_type_id, d.status AS scope_status,
  (SELECT GROUP_CONCAT(dp.product_id || char(30) || COALESCE(p.name, ''), char(31))
     FROM document_products dp LEFT JOIN products p ON p.id = dp.product_id WHERE dp.document_id = d.id) AS scope_dp_products,
  (SELECT GROUP_CONCAT(l.product_id || char(30) || COALESCE(p2.name, ''), char(31))
     FROM document_lots dl JOIN lots l ON l.id = dl.lot_id LEFT JOIN products p2 ON p2.id = l.product_id
    WHERE dl.document_id = d.id AND l.product_id IS NOT NULL) AS scope_lot_products`;

type SubjectRow = DocScanRow & {
  scope_document_type_id: string | null;
  scope_status: string | null;
  scope_dp_products: string | null;
  scope_lot_products: string | null;
};

interface Loaded {
  subject: CoverageSubject;
  attrs: ScopeAttrs;
  productNames: Map<string, string>;
  updatedAt: string;
}

function loadedFromRow(r: SubjectRow): Loaded {
  const corpus = { docs: [] as CoverageSubject[], updatedAt: new Map<string, string>(), otherIdentifiers: new Set<string>() };
  addDocRow(corpus, r);
  const productNames = new Map<string, string>();
  for (const raw of [r.scope_dp_products, r.scope_lot_products]) {
    for (const part of (raw ?? '').split('\u001f')) {
      const [id, name] = part.split('\u001e');
      if (id) productNames.set(id, name || id);
    }
  }
  return {
    subject: corpus.docs[0],
    attrs: {
      supplier_id: r.supplier_id,
      document_type_id: r.scope_document_type_id,
      product_ids: [...productNames.keys()],
      status: r.scope_status,
      created_at: r.created_at,
    },
    productNames,
    updatedAt: r.updated_at ?? '',
  };
}

function addDaysIso(iso: string, n: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

/** The day window a date constraint's candidates are sought in (± the nearby window for a single day). */
type DateWindow = { from: string; to: string } | { monthDays: string[] } | { mdFrom: string; mdTo: string };

function dateWindow(c: SearchConstraint): DateWindow | null {
  // A year-less span ("produced in April"): its month/days in any year. No
  // nearby widening — a span is judged in or out, never "near".
  if (c.month_day_range) {
    const md = (x: { month: number; day: number }) => `${String(x.month).padStart(2, '0')}-${String(x.day).padStart(2, '0')}`;
    return { mdFrom: md(c.month_day_range.from), mdTo: md(c.month_day_range.to) };
  }
  if (c.month_day) {
    const out: string[] = [];
    const center = `2024-${String(c.month_day.month).padStart(2, '0')}-${String(c.month_day.day).padStart(2, '0')}`;
    for (let i = -NEAR_DATE_DAYS; i <= NEAR_DATE_DAYS; i++) out.push(addDaysIso(center, i).slice(5));
    return { monthDays: [...new Set(out)] };
  }
  if (!c.date_from && !c.date_to) return null;
  const single = !!c.date_from && c.date_from === c.date_to;
  return {
    from: c.date_from ? (single ? addDaysIso(c.date_from, -NEAR_DATE_DAYS) : c.date_from) : '0000-01-01',
    to: c.date_to ? (single ? addDaysIso(c.date_to, NEAR_DATE_DAYS) : c.date_to) : '9999-12-31',
  };
}

/** Does this constraint read search keys (and so need them fresh)? */
function readsKeys(c: SearchConstraint): boolean {
  return c.kind === 'po' || c.kind === 'invoice' || c.kind === 'identifier' || c.kind === 'date' || c.kind === 'lot';
}

interface OrderRow { id: string; order_number: string; po_number: string | null; customer_name: string | null }

interface SupplierScheme { id: string; name: string; spec: string | null }

async function runIdentifyingPath(args: {
  db: D1Database;
  tenantId: string;
  scope: CompiledScope;
  identClauses: Clause[];
  interpreted: { clauses: Clause[]; residual: string } | undefined;
  residual: string;
  labels: Record<string, string>;
  schemes: SupplierScheme[];
  orders: OrderRow[];
  items: OrderItemRow[];
  suggestions: OrderSuggestionRow[];
  keysPending: number;
  input: RunSearchInput;
  stats: StatementStats;
}): Promise<SearchQueryResponse> {
  const { db, tenantId, scope, input, stats, labels } = args;

  // --- constraints ---------------------------------------------------------
  const buildEvidence = (catalog: Parameters<typeof orderEvidenceFromRows>[3]): ConstraintContext => {
    const byNumber = new Map<string, SearchOrderEvidence>();
    const byPo = new Map<string, SearchOrderEvidence[]>();
    for (const o of args.orders) {
      const ev = orderEvidenceFromRows(o, args.items.filter((i) => i.order_id === o.id), args.suggestions.filter((s) => args.items.some((i) => i.id === s.order_item_id && i.order_id === o.id)), catalog);
      byNumber.set(normalizeKeyValue(o.order_number), ev);
      if (o.po_number) {
        const k = foldCustomerPo(o.po_number);
        byPo.set(k, [...(byPo.get(k) ?? []), ev]);
      }
    }
    return { ordersByNumber: byNumber, ordersByPo: byPo };
  };
  const build = (ctx: ConstraintContext) => {
    const constraints: SearchConstraint[] = [];
    const dropped: SearchDroppedConstraint[] = [];
    for (const c of args.identClauses) {
      const r = clauseToConstraint(c, c.id, ctx);
      if ('constraint' in r) constraints.push(r.constraint);
      else dropped.push(r.dropped);
    }
    if (args.residual) {
      constraints.push({
        id: 'text', kind: 'text', label: `mentions "${args.residual}"`, raw: args.residual, value: args.residual,
        fields: ['title', 'file_name', 'extracted_text', 'supplier', 'product'], source: 'query_text',
      });
    }
    return { constraints, dropped };
  };
  let { constraints, dropped } = build(buildEvidence(null));

  // --- R1: seeks -------------------------------------------------------------
  const batch = new Batch();
  const seekIdx: number[] = [];
  const addSeek = (sql: string, ...binds: unknown[]) => seekIdx.push(batch.add(db.prepare(sql).bind(tenantId, ...binds)));
  const mentionIdx: Array<{ idx: number; raw: string }> = [];
  const decodeIdx: Array<{ idx: number; constraintId: string; supplier: SupplierScheme }> = [];
  const lotPrefixSeek = (shipped: string, limit: number) => {
    const base = shipped.length > 8 ? shipped.slice(0, -2) : shipped;
    addSeek(
      `SELECT DISTINCT dl.document_id FROM lots l JOIN document_lots dl ON dl.lot_id = l.id
        WHERE l.tenant_id = ? AND ((l.lot_key >= ? AND l.lot_key < ?) OR l.lot_key = ?) LIMIT ${limit}`,
      base, `${base}~`, shipped,
    );
  };
  const orderLinked = new Set<string>();
  const ordersOf = (c: SearchConstraint): SearchOrderEvidence[] => [...(c.order ? [c.order] : []), ...(c.orders ?? [])];

  const queueDecodes = (c: SearchConstraint) => {
    for (const sup of args.schemes) {
      const spec = structuredScheme(sup.spec);
      if (!spec || spec.date_role !== 'production') continue;
      decodeIdx.push({
        idx: batch.add(db.prepare(
          `SELECT l.lot_number, l.sub_lot_code, dl.document_id FROM lots l JOIN document_lots dl ON dl.lot_id = l.id
            WHERE l.tenant_id = ? AND l.supplier_id = ? LIMIT 5000`,
        ).bind(tenantId, sup.id)),
        constraintId: c.id,
        supplier: sup,
      });
    }
  };

  for (const c of constraints) {
    if (c.kind === 'lot') {
      const prefix = c.match === 'prefix';
      const base = prefix ? c.value : c.lot_parts?.base ?? (c.value.length > 8 ? c.value.slice(0, -2) : c.value);
      addSeek(
        `SELECT DISTINCT dl.document_id FROM lots l JOIN document_lots dl ON dl.lot_id = l.id
          WHERE l.tenant_id = ? AND ((l.lot_key >= ? AND l.lot_key < ?) OR l.lot_key = ?) LIMIT ${SEEK_LIMIT}`,
        base, `${base}~`, c.value,
      );
      addSeek(
        `SELECT DISTINCT document_id FROM document_search_keys
          WHERE tenant_id = ? AND kind = 'lot' AND ((value_norm >= ? AND value_norm < ?) OR value_norm = ?) LIMIT ${SEEK_LIMIT}`,
        base, `${base}~`, c.value,
      );
      // A prefix is never looked for in the text: "104" is also a street number.
      const st = prefix ? null : ftsPoolStatement(db, tenantId, c.raw, 100);
      if (st) mentionIdx.push({ idx: batch.add(st), raw: c.raw });
    }
    if (c.kind === 'date') {
      const w = dateWindow(c);
      if (w && 'monthDays' in w) {
        addSeek(`SELECT DISTINCT document_id FROM document_search_keys
                  WHERE tenant_id = ? AND kind IN (${ph(DATE_KEY_KINDS.length)}) AND value_date IS NOT NULL
                    AND substr(value_date, 6) IN (${ph(w.monthDays.length)}) LIMIT ${SEEK_LIMIT}`, ...DATE_KEY_KINDS, ...w.monthDays);
        addSeek(`SELECT DISTINCT dl.document_id FROM lots l JOIN document_lots dl ON dl.lot_id = l.id
                  WHERE l.tenant_id = ? AND l.production_date IS NOT NULL AND substr(l.production_date, 6) IN (${ph(w.monthDays.length)}) LIMIT ${SEEK_LIMIT}`, ...w.monthDays);
      } else if (w && 'mdFrom' in w) {
        // Across the year end (Dec 15 – Jan 15) the span is two pieces.
        const wraps = w.mdFrom > w.mdTo;
        const cond = (col: string) => (wraps ? `(substr(${col}, 6, 5) >= ? OR substr(${col}, 6, 5) <= ?)` : `substr(${col}, 6, 5) BETWEEN ? AND ?`);
        addSeek(`SELECT DISTINCT document_id FROM document_search_keys
                  WHERE tenant_id = ? AND kind IN (${ph(DATE_KEY_KINDS.length)}) AND value_date IS NOT NULL
                    AND ${cond('value_date')} LIMIT ${SEEK_LIMIT}`, ...DATE_KEY_KINDS, w.mdFrom, w.mdTo);
        addSeek(`SELECT DISTINCT dl.document_id FROM lots l JOIN document_lots dl ON dl.lot_id = l.id
                  WHERE l.tenant_id = ? AND l.production_date IS NOT NULL AND ${cond('l.production_date')} LIMIT ${SEEK_LIMIT}`, w.mdFrom, w.mdTo);
        if (c.role === 'expiration') {
          addSeek(`SELECT id AS document_id FROM documents
                    WHERE tenant_id = ? AND status IN ('active', 'archived') AND renewal_due_date IS NOT NULL
                      AND ${cond('renewal_due_date')} LIMIT ${SEEK_LIMIT}`, w.mdFrom, w.mdTo);
        }
        if (c.role === 'production' || c.role === 'any') queueDecodes(c);
      } else if (w) {
        addSeek(`SELECT DISTINCT document_id FROM document_search_keys
                  WHERE tenant_id = ? AND kind IN (${ph(DATE_KEY_KINDS.length)}) AND value_date BETWEEN ? AND ? LIMIT ${SEEK_LIMIT}`, ...DATE_KEY_KINDS, w.from, w.to);
        addSeek(`SELECT DISTINCT dl.document_id FROM lots l JOIN document_lots dl ON dl.lot_id = l.id
                  WHERE l.tenant_id = ? AND l.production_date BETWEEN ? AND ? LIMIT ${SEEK_LIMIT}`, w.from, w.to);
        if (c.role === 'expiration') {
          addSeek(`SELECT id AS document_id FROM documents
                    WHERE tenant_id = ? AND status IN ('active', 'archived') AND renewal_due_date BETWEEN ? AND ? LIMIT ${SEEK_LIMIT}`, w.from, w.to);
        }
        // A declared production-date lot format (0110): the supplier's lots whose
        // CODE decodes into the window are judged too — likely at best.
        if ((c.role === 'production' || c.role === 'any')) queueDecodes(c);
      }
    }
    if (c.kind === 'po' || c.kind === 'invoice' || c.kind === 'identifier') {
      const kinds = (c.key_kinds ?? []).length ? c.key_kinds! : IDENTIFIER_KEY_KINDS;
      const allKinds = c.kind === 'identifier' ? [...kinds, 'lot'] : kinds;
      addSeek(`SELECT DISTINCT document_id FROM document_search_keys
                WHERE tenant_id = ? AND kind IN (${ph(allKinds.length)}) AND value_norm = ? LIMIT ${SEEK_LIMIT}`, ...allKinds, normalizeKeyValue(c.value));
      if (c.kind === 'identifier') {
        const lot = normalizeLotNumber(c.value);
        if (lot) addSeek(`SELECT DISTINCT dl.document_id FROM lots l JOIN document_lots dl ON dl.lot_id = l.id WHERE l.tenant_id = ? AND l.lot_key = ? LIMIT ${SEEK_LIMIT}`, lot);
      }
    }
    for (const o of ordersOf(c)) {
      for (const line of o.lines) {
        for (const id of [...line.accepted_document_ids, ...line.legacy_document_ids, ...line.rejected_document_ids, ...line.suggested.map((x) => x.document_id)]) {
          orderLinked.add(id);
        }
        const shipped = line.lot_number ? normalizeLotNumber(line.lot_number) : '';
        if (shipped.length >= 5) lotPrefixSeek(shipped, 500);
      }
    }
  }
  const textC = constraints.find((c) => c.kind === 'text');
  const poolStmt = textC ? ftsPoolStatement(db, tenantId, textC.value, 500) : null;
  const poolIdx = poolStmt ? batch.add(poolStmt) : null;
  const queueIdx = batch.add(db.prepare(QUEUE_SCAN_SQL).bind(tenantId, QUEUE_SCAN_CAP));
  const queueTextStmt = textC ? queueTextStatement(db, tenantId, textC.value) : null;
  const queueTextIdx = queueTextStmt ? batch.add(queueTextStmt) : null;

  // Keys still being built: the key-dependent seeks may miss documents, so the
  // scoped set is judged too (capped, and said).
  const scanFallback = args.keysPending > 0 && constraints.some(readsKeys);
  let fallbackIdx: number | null = null;
  if (scanFallback) {
    const w = scopeWhere(scope, tenantId);
    fallbackIdx = batch.add(db.prepare(
      `${docSubjectSelect(SCOPE_EXTRA_COLUMNS)} WHERE ${w.sql} ORDER BY d.updated_at DESC LIMIT ?`,
    ).bind(...w.params, DOC_SCAN_CAP + 1));
  }

  const needCatalog = args.orders.length > 0;
  const [, catalog] = await Promise.all([
    batch.run(db),
    needCatalog ? loadProductCatalog(db, tenantId) : Promise.resolve(null),
  ]);
  if (needCatalog) ({ constraints, dropped } = build(buildEvidence(catalog)));

  // --- candidates ------------------------------------------------------------
  const candidateIds = new Set<string>(orderLinked);
  for (const i of seekIdx) for (const r of batch.rows<{ document_id: string }>(i)) candidateIds.add(r.document_id);
  const mentions = new Map<string, string>();
  for (const m of mentionIdx) {
    for (const r of batch.rows<{ doc_id: string }>(m.idx)) {
      if (!mentions.has(r.doc_id)) mentions.set(r.doc_id, m.raw);
      candidateIds.add(r.doc_id);
    }
  }
  const pool: Map<string, PoolHit> = poolIdx !== null ? poolFromRows(batch.rows(poolIdx)) : new Map();
  [...pool.entries()].sort((a, b) => a[1].rank - b[1].rank).slice(0, TEXT_CANDIDATES).forEach(([id]) => candidateIds.add(id));
  for (const d of decodeIdx) {
    const c = constraints.find((x) => x.id === d.constraintId);
    const spec = structuredScheme(d.supplier.spec);
    if (!c || !spec) continue;
    const w = dateWindow(c);
    if (!w || 'monthDays' in w) continue;
    let exact = 0;
    for (const l of batch.rows<{ lot_number: string; sub_lot_code: string; document_id: string }>(d.idx)) {
      const dec = decodeLot(spec, l.lot_number, l.sub_lot_code);
      if (!dec.fits || !dec.decoded_date) continue;
      if ('mdFrom' in w) {
        const md = dec.decoded_date.slice(5, 10);
        if (w.mdFrom <= w.mdTo ? md >= w.mdFrom && md <= w.mdTo : md >= w.mdFrom || md <= w.mdTo) candidateIds.add(l.document_id);
        continue;
      }
      if (dec.decoded_date < w.from || dec.decoded_date > w.to) continue;
      candidateIds.add(l.document_id);
      if (c.date_from && c.date_to && dec.decoded_date >= c.date_from && dec.decoded_date <= c.date_to) exact++;
    }
    if (c.date_from && c.date_from === c.date_to) {
      c.note = [c.note,
        `${d.supplier.name}'s declared lot format (${lotSchemeLabel(spec)}) puts a ${formatLotIso(c.date_from)} production in lot codes like ${impliedLotExample(spec, c.date_from)}; `
        + `${exact} lot${exact === 1 ? '' : 's'} on file decode${exact === 1 ? 's' : ''} to that day. A decoded date is shown as likely — confirm; only a stated production date covers.`,
      ].filter(Boolean).join(' ');
    }
  }

  const loaded = new Map<string, Loaded>();
  let truncated = false;
  if (fallbackIdx !== null) {
    const rows = batch.rows<SubjectRow>(fallbackIdx);
    truncated = rows.length > DOC_SCAN_CAP;
    for (const r of rows.slice(0, DOC_SCAN_CAP)) loaded.set(r.id, loadedFromRow(r));
  }
  let ids = [...candidateIds].filter((id) => !loaded.has(id));
  if (ids.length > CANDIDATE_LIMIT) {
    ids = ids.slice(0, CANDIDATE_LIMIT);
    truncated = true;
  }

  // --- R2: subjects ----------------------------------------------------------
  if (ids.length) {
    const load = new Batch();
    const idxs = chunks(ids).map((chunk) => load.add(db.prepare(
      `${docSubjectSelect(SCOPE_EXTRA_COLUMNS)} WHERE d.tenant_id = ? AND d.status != 'deleted' AND d.id IN (${ph(chunk.length)})`,
    ).bind(tenantId, ...chunk)));
    await load.run(db);
    for (const i of idxs) for (const r of load.rows<SubjectRow>(i)) loaded.set(r.id, loadedFromRow(r));
  }

  // --- judge -----------------------------------------------------------------
  const hasText = !!textC;
  const judged: Array<{ id: string; verdict: SubjectVerdict; l: Loaded; inScope: boolean }> = [];
  for (const [id, l] of loaded) {
    const subject = hasText ? { ...l.subject, text_match: pool.has(id) } : l.subject;
    const verdict = evaluateSubject(subject, constraints, dropped, {
      inPool: mentions.has(id) || orderLinked.has(id),
    });
    if (verdict.status !== 'covering' && mentions.has(id)) {
      verdict.reason = `${verdict.reason ?? ''} Its text mentions "${mentions.get(id)}".`.trim();
    }
    if (!verdict.eligible) continue;
    judged.push({ id, verdict, l, inScope: scopeHolds(scope, l.attrs) });
  }

  const byRank = (a: { id: string; l: Loaded }, b: { id: string; l: Loaded }) => {
    const ra = pool.get(a.id)?.rank;
    const rb = pool.get(b.id)?.rank;
    if (ra !== undefined && rb !== undefined && ra !== rb) return ra - rb;
    if (ra !== undefined && rb === undefined) return -1;
    if (rb !== undefined && ra === undefined) return 1;
    return b.l.updatedAt.localeCompare(a.l.updatedAt);
  };
  const inScope = judged.filter((j) => j.inScope);
  const covering = inScope.filter((j) => j.verdict.status === 'covering').sort(byRank);
  const likely = inScope.filter((j) => j.verdict.status === 'likely_covering').sort((a, b) => b.verdict.score - a.verdict.score || byRank(a, b));
  const candidates = inScope
    .filter((j) => j.verdict.status === 'candidate_not_matching')
    .sort((a, b) => b.verdict.score - a.verdict.score || byRank(a, b))
    .slice(0, CANDIDATE_CAP);

  // --- facets over the ANSWER (covering + likely), sticky ---------------------
  let facets: SearchQueryResponse['facets'];
  if (input.facets) {
    const answers = judged.filter((j) => j.verdict.status === 'covering' || j.verdict.status === 'likely_covering');
    facets = {};
    for (const field of FACET_FIELDS) {
      const counted = answers.filter((j) => scopeHolds(scope, j.l.attrs, field));
      const tally = new Map<string, FacetCount>();
      const bump = (value: string | null, label: string | null) => {
        if (!value) return;
        const f = tally.get(value) ?? { value, label: label ?? value, count: 0 };
        f.count++;
        tally.set(value, f);
      };
      if (field === 'uploaded') {
        const counts = UPLOADED_BUCKETS.map((b) => {
          const bd = uploadedBounds({ id: '', field: 'uploaded', op: b.op, values: [String(b.days)], source: 'facet' }, scope.today);
          return counted.filter((j) => {
            const at = j.l.attrs.created_at;
            return !!at && (!bd.from || at >= bd.from) && (!bd.to || at < bd.to);
          }).length;
        });
        facets.uploaded = uploadedFacet(counts);
        continue;
      }
      for (const j of counted) {
        if (field === 'supplier') bump(j.l.attrs.supplier_id, j.l.subject.supplier_name);
        else if (field === 'document_type') bump(j.l.attrs.document_type_id, j.l.subject.document_type_name);
        else if (field === 'status') bump(j.l.attrs.status, STATUS_LABELS[j.l.attrs.status ?? ''] ?? j.l.attrs.status);
        else if (field === 'product') for (const [pid, name] of j.l.productNames) bump(pid, name);
      }
      const list = [...tally.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)).slice(0, 50);
      facets[field] = withSelected(field, list, scope, labels);
    }
  }

  // --- page ------------------------------------------------------------------
  const ordered = [...covering, ...likely, ...candidates];
  const page = ordered.slice(input.offset, input.offset + input.limit);
  const rowsById = await fetchDocumentRows(db, page.map((p) => p.id));
  const documents: UniversalSearchDocument[] = [];
  for (const p of page) {
    const row = rowsById.get(p.id);
    if (!row) continue;
    const hit = pool.get(p.id);
    const rowsAnswering = p.verdict.status === 'candidate_not_matching'
      ? []
      : answeringLotRows(p.l.subject, constraints, dropped, p.verdict.status);
    documents.push({
      ...row,
      ...(hit ? { rank: hit.rank, snippet: hit.snippet, snippet_extracted: hit.snippet_extracted, snippet_supplier: hit.snippet_supplier } : {}),
      match_status: p.verdict.status,
      matched_lot: matchedLotOf(p.verdict, p.l.subject),
      ...(rowsAnswering.length > 1 ? { matched_lots: rowsAnswering.map((lot) => matchedLotOf({ ...p.verdict, lot }, p.l.subject)) } : {}),
      match_checks: p.verdict.checks,
      match_reason: p.verdict.reason,
      // Every lot row on the certificate, so the result can mark the rows
      // that answer and dim the others (search redesign Phase 2).
      doc_lots: docLotsOf(p.l.subject),
    } as unknown as UniversalSearchDocument);
  }

  // --- Review Queue: judged record by record, never covering -----------------
  const queueText = queueTextIdx !== null ? new Set(batch.rows<{ id: string }>(queueTextIdx).map((r) => r.id)) : null;
  const supplierNames = scope.clauses.filter((c) => c.field === 'supplier' && !c.exclude).flatMap((c) => c.values.map((v) => labels[v]).filter(Boolean)).map((n) => n.toLowerCase());
  const typeIds = scope.clauses.filter((c) => c.field === 'document_type' && !c.exclude).flatMap((c) => c.values);
  const queue: QueueGroup[] = batch.rows<QueueScanRow>(queueIdx).map(queueGroupFromRow)
    .filter((g) => !supplierNames.length || (g.supplier && supplierNames.some((n) => g.supplier!.toLowerCase().includes(n) || n.includes(g.supplier!.toLowerCase()))))
    .filter((g) => !typeIds.length || (g.document_type_id && typeIds.includes(g.document_type_id)));
  const unreviewed: Array<SearchUnreviewedCandidate & { score: number }> = [];
  for (const g of queue) {
    let best: { label: string | null; verdict: SubjectVerdict } | null = null;
    for (const r of g.records) {
      const subject = hasText ? { ...r.subject, text_match: queueText?.has(g.queue_id) ?? false } : r.subject;
      const verdict = evaluateSubject(subject, constraints, dropped);
      if (!verdict.eligible) continue;
      if (!best || verdict.score > best.verdict.score) best = { label: r.label, verdict };
    }
    if (!best) continue;
    const all = best.verdict.status === 'covering' || best.verdict.status === 'likely_covering';
    unreviewed.push({
      queue_id: g.queue_id,
      file_name: g.file_name,
      supplier: g.supplier,
      created_at: g.created_at,
      review_url: `/review?item=${encodeURIComponent(g.queue_id)}`,
      match_status: 'unreviewed_candidate',
      matches_all_constraints: all,
      record_label: best.label,
      match_checks: best.verdict.checks,
      match_reason: all
        ? 'Matches what you asked for, but it is still in the Review Queue — it is not on file until someone approves it.'
        : `Still in the Review Queue. ${best.verdict.checks.filter((c) => c.outcome !== 'match').map((c) => c.message).join(' ')}`,
      score: best.verdict.score + (all ? 1000 : 0),
    });
  }
  unreviewed.sort((a, b) => b.score - a.score);

  const coverage: SearchCoverage = coverageFor(constraints, dropped, covering.length, likely.length);
  const scopeWords = scopeSummary(scope, labels);
  const summary = coverageSummary(constraints, dropped, covering.length, likely.length);

  return {
    documents,
    total: ordered.length,
    limit: input.limit,
    offset: input.offset,
    ...(facets ? { facets } : {}),
    clauses: [],
    labels,
    scope_summary: scopeWords,
    coverage,
    constraints,
    dropped_constraints: dropped,
    // A scope narrows the statement: "no document covers X" is only true of
    // the documents the scope let in, so the sentence says so.
    coverage_summary: summary && scopeWords ? `${summary} Searched within: ${scopeWords}.` : summary,
    covering_count: covering.length,
    likely_count: likely.length,
    candidate_count: candidates.length,
    unreviewed_candidates: unreviewed.slice(0, UNREVIEWED_CAP).map(({ score: _s, ...u }) => u),
    coverage_scan_truncated: truncated,
    ...(args.keysPending > 0 ? { keys_pending: args.keysPending } : {}),
    ...(args.interpreted ? { interpreted: args.interpreted } : {}),
    stats: { ...stats, candidates: loaded.size, scan_fallback: scanFallback },
  };
}

// ===========================================================================
// Entry point
// ===========================================================================

export async function runSearch(rawDb: D1Database, tenantId: string, input: RunSearchInput): Promise<SearchQueryResponse> {
  const stats: StatementStats = { statements: 0, round_trips: 0 };
  const db = countingDb(rawDb, stats);
  const query = input.query;
  validateQuery(query);
  const now = input.now ?? new Date();
  let scope = compileScope(query.clauses, now);
  // Only the BOX is read for lots, dates and numbers. A text clause is the
  // person's own words — kept as text on Enter, or a reading they rejected —
  // and re-reading it would silently re-apply a detection they took back
  // (search redesign Phase 2).
  const typedText = query.text.replace(/\s+/g, ' ').trim();
  const clauseText = query.clauses.filter((c) => c.field === 'text').flatMap((c) => c.values).join(' ').replace(/\s+/g, ' ').trim();
  const text = [typedText, clauseText].filter(Boolean).join(' ');
  const explicitIdent = query.clauses.filter((c) => SEARCH_FIELDS[c.field].class === 'identifying');

  const scan = input.interpret && typedText ? scanText(typedText, { now }) : null;
  const detecting = !!scan && scanHasCandidates(scan);
  const productChosen = query.clauses.some((c) => c.field === 'product');

  // Nothing identifying anywhere: the scope / text path, one round trip —
  // plus one for the product catalog when the typed words may NAME a product
  // on their own (a code, a pack, a recorded name: "4417", "unsalted butter").
  // Descriptive words alone ("butter") stay a browse (detectProduct).
  if (explicitIdent.length === 0 && !detecting) {
    if (scan && !productChosen && scanMayNameProduct(scan)) {
      const pb = new Batch();
      const ci = pb.add(productCatalogStatement(db, tenantId));
      await pb.run(db);
      const product = detectProduct({ clauses: [], residual: typedText }, catalogFromRows(pb.rows<CatalogRow>(ci)), { otherConstraints: false });
      if (product.detection.clauses.length) {
        const interpreted = { clauses: product.detection.clauses, residual: product.detection.residual };
        scope = compileScope([...query.clauses, ...interpreted.clauses], now);
        const res = await runScopePath(db, tenantId, scope, clauseText, input, stats);
        return withClauseSummaries({ ...res, labels: { ...product.labels, ...res.labels }, interpreted }, query.clauses, interpreted.clauses, stats);
      }
    }
    const res = await runScopePath(db, tenantId, scope, text, input, stats);
    return withClauseSummaries(res, query.clauses, [], stats);
  }

  // --- R0 ----------------------------------------------------------------------
  const r0 = new Batch();
  const repairLimit = input.repairLimit ?? REPAIR_LIMIT;
  const pendingIdx = r0.add(db.prepare(
    `SELECT id, entity_id FROM search_reindex_jobs
      WHERE tenant_id = ? AND entity_kind = 'document_keys' AND status = 'pending'
      ORDER BY created_at LIMIT ?`,
  ).bind(tenantId, repairLimit + 1));
  const norms = scan ? scanNorms(scan) : [];
  const allKeyKinds = [...IDENTIFIER_KEY_KINDS, 'lot'];
  const keyHitsStmt = () => db.prepare(
    `SELECT DISTINCT kind, value_norm FROM document_search_keys
      WHERE tenant_id = ? AND kind IN (${ph(allKeyKinds.length)}) AND value_norm IN (${ph(norms.length)})`,
  ).bind(tenantId, ...allKeyKinds, ...norms);
  let keyHitIdx = norms.length ? r0.add(keyHitsStmt()) : null;
  let lotIdx: number | null = null;
  if (scan && scan.lotTokens.length) {
    const conds: string[] = [];
    const binds: string[] = [];
    for (const t of scan.lotTokens) {
      const n = normalizeLotNumber(t.norm);
      conds.push('(lot_key >= ? AND lot_key < ?)');
      binds.push(n, `${n}~`);
      for (const cut of [1, 2, 3]) {
        if (n.length - cut >= 6) {
          conds.push('lot_key = ?');
          binds.push(n.slice(0, -cut));
        }
      }
    }
    lotIdx = r0.add(db.prepare(`SELECT DISTINCT lot_key, lot_number FROM lots WHERE tenant_id = ? AND (${conds.join(' OR ')}) LIMIT 200`).bind(tenantId, ...binds));
  }
  // What a lot prefix IS under a declared format ("104 = Darigold plant").
  const wantsSchemes = (scan?.lotTokens.some((t) => t.explicit) ?? false) || explicitIdent.some((c) => c.field === 'lot' && c.op === 'starts');
  const schemeIdx = wantsSchemes
    ? r0.add(db.prepare(
      `SELECT sls.supplier_id, s.name AS supplier_name, sls.spec, sls.version
         FROM supplier_lot_schemes sls JOIN suppliers s ON s.id = sls.supplier_id
        WHERE sls.tenant_id = ? ORDER BY sls.version DESC`,
    ).bind(tenantId))
    : null;
  // WMS orders: every typed number, and every explicit order / PO / identifier / invoice value.
  const orderValues = new Set<string>(scan ? scanOrderValues(scan) : []);
  for (const c of explicitIdent) {
    if (c.field === 'order' || c.field === 'po' || c.field === 'identifier' || c.field === 'invoice') {
      const v = c.values[0].trim();
      const bare = stripKeyword(stripKeyword(v, 'po'), 'invoice');
      for (const x of [v, v.toUpperCase(), bare, bare.toUpperCase()]) orderValues.add(x);
    }
  }
  const ov = [...orderValues].slice(0, 30);
  // A customer PO is compared folded ("90001" = "PO-90001"): look up every
  // spelling it may be stored under, so the index still serves the seek.
  const pov = [...new Set([...orderValues].map(foldCustomerPo).filter(Boolean))]
    .slice(0, 3).flatMap(customerPoSpellings).slice(0, 60);
  let ordersIdx: number | null = null;
  let itemsIdx: number | null = null;
  let suggIdx: number | null = null;
  if (ov.length) {
    const where = `o.tenant_id = ? AND o.staged_at IS NULL AND (o.order_number IN (${ph(ov.length)})${pov.length ? ` OR o.po_number IN (${ph(pov.length)})` : ''})`;
    const binds = [tenantId, ...ov, ...pov];
    ordersIdx = r0.add(db.prepare(`SELECT o.id, o.order_number, o.po_number, o.customer_name FROM orders o WHERE ${where} LIMIT 20`).bind(...binds));
    itemsIdx = r0.add(db.prepare(
      `SELECT oi.id, oi.order_id, oi.product_code, oi.product_name, oi.lot_number, oi.coa_document_id, oi.coa_match_status
         FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE ${where} ORDER BY oi.created_at, oi.id LIMIT 500`,
    ).bind(...binds));
    suggIdx = r0.add(db.prepare(
      `SELECT lms.order_item_id, lms.document_id, lms.status, lms.match_basis, lms.match_confidence
         FROM lot_match_suggestions lms JOIN order_items oi ON oi.id = lms.order_item_id JOIN orders o ON o.id = oi.order_id
        WHERE ${where} LIMIT 2000`,
    ).bind(...binds));
  }
  const lblStmt = labelStatement(db, tenantId, scope);
  const labelIdx = lblStmt ? r0.add(lblStmt) : null;
  // Words beside the typed candidates may name a product ("butter produced in
  // April") — asked in the same batch, only when a product is not already chosen.
  const catalogIdx = scan && detecting && scanMayNameProduct(scan) && !productChosen
    ? r0.add(productCatalogStatement(db, tenantId))
    : null;
  await r0.run(db);

  // --- read-repair -------------------------------------------------------------
  let keysPending = 0;
  const pending = r0.rows<{ id: string; entity_id: string }>(pendingIdx);
  let keyHitRows = r0.rows<{ kind: string; value_norm: string }>(keyHitIdx);
  if (pending.length) {
    const drained = await drainDocumentKeyJobs(db, { tenantId, maxJobs: repairLimit, pending });
    if (drained.remaining > 0) {
      const left = await db.prepare(
        `SELECT COUNT(*) AS n FROM search_reindex_jobs WHERE tenant_id = ? AND entity_kind = 'document_keys' AND status = 'pending'`,
      ).bind(tenantId).first<{ n: number }>();
      keysPending = Number(left?.n ?? drained.remaining);
    }
    if (norms.length) {
      keyHitRows = (await keyHitsStmt().all<{ kind: string; value_norm: string }>()).results ?? [];
      keyHitIdx = null;
    }
  }

  const lotSchemes: Array<{ supplier_name: string; spec: LotSchemeSpec }> = [];
  const seenSupplier = new Set<string>();
  for (const r of r0.rows<{ supplier_id: string; supplier_name: string; spec: string | null }>(schemeIdx)) {
    if (seenSupplier.has(r.supplier_id)) continue;
    seenSupplier.add(r.supplier_id);
    const spec = structuredScheme(r.spec);
    if (spec) lotSchemes.push({ supplier_name: r.supplier_name, spec });
  }
  const explicitWithNotes = explicitIdent.map((c) => (c.field === 'lot' && c.op === 'starts' && !c.note
    ? { ...c, note: lotPrefixNote(normalizeLotNumber(c.values[0]), lotSchemes) }
    : c));

  const labels: Record<string, string> = {};
  const schemes: SupplierScheme[] = [];
  for (const r of r0.rows<LabelRow>(labelIdx)) {
    labels[r.id] = r.name;
    if (r.kind === 'supplier') schemes.push({ id: r.id, name: r.name, spec: r.extra });
  }

  // --- detection -----------------------------------------------------------------
  let interpreted: { clauses: Clause[]; residual: string } | undefined;
  let residual = '';
  if (scan) {
    const lotRows = r0.rows<{ lot_key: string; lot_number: string }>(lotIdx);
    const hits: DetectionHits = {
      keys: new Map(),
      lotKeys: lotRows.map((r) => r.lot_key),
      lotNumbers: lotRows.map((r) => normalizeLotNumber(r.lot_number)),
      lotSchemes,
      orders: r0.rows<OrderRow>(ordersIdx),
    };
    for (const r of keyHitRows) {
      const s = hits.keys.get(r.value_norm) ?? new Set();
      s.add(r.kind as SearchKeyKind);
      hits.keys.set(r.value_norm, s);
    }
    const read = resolveDetections(scan, hits);
    const product = detectProduct(read, catalogIdx !== null ? catalogFromRows(r0.rows<CatalogRow>(catalogIdx)) : null, {
      otherConstraints: read.clauses.length > 0 || explicitIdent.length > 0,
    });
    const det = product.detection;
    Object.assign(labels, product.labels);
    interpreted = { clauses: det.clauses, residual: det.residual };
    residual = [det.residual, clauseText].filter(Boolean).join(' ');
  } else {
    residual = text;
  }
  // A product read from the words is a SCOPE clause (the Ask-AI mapping's
  // rule): it narrows what is judged, it never claims coverage itself.
  const detectedScope = (interpreted?.clauses ?? []).filter((c) => SEARCH_FIELDS[c.field].class === 'scope');
  if (detectedScope.length) scope = compileScope([...query.clauses, ...detectedScope], now);
  const identClauses = [...explicitWithNotes, ...(interpreted?.clauses ?? []).filter((c) => SEARCH_FIELDS[c.field].class === 'identifying')];

  // The text read as nothing identifying after all: back to the scope/text path.
  if (identClauses.length === 0) {
    // A product the words NAMED took those words: they are not searched as text as well.
    const res = await runScopePath(db, tenantId, scope, detectedScope.length ? residual : text, input, stats);
    return withClauseSummaries({ ...res, ...(interpreted ? { interpreted } : {}) }, query.clauses, [], stats);
  }

  const res = await runIdentifyingPath({
    db, tenantId, scope, identClauses, interpreted, residual, labels, schemes,
    orders: r0.rows<OrderRow>(ordersIdx),
    items: r0.rows<OrderItemRow>(itemsIdx),
    suggestions: r0.rows<OrderSuggestionRow>(suggIdx),
    keysPending, input, stats,
  });
  const own = query.clauses.map((c) => explicitWithNotes.find((x) => x.id === c.id) ?? c);
  return withClauseSummaries(res, own, interpreted?.clauses ?? [], stats);
}

const DOC_LOTS_CAP = 24;

/** The lot rows a document carries, for the result row and the preview pane. */
function docLotsOf(subject: CoverageSubject): SearchDocLot[] {
  const seen = new Set<string>();
  const out: SearchDocLot[] = [];
  for (const l of subject.lots) {
    const key = `${l.lot_number}|${l.sub_lot_code}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      lot_number: l.lot_number,
      sub_lot_code: l.sub_lot_code,
      lot_key: l.lot_key,
      production_date: l.production_date ?? null,
      production_date_source: l.production_date_source ?? null,
    });
    if (out.length >= DOC_LOTS_CAP) break;
  }
  return out;
}

function withClauseSummaries(res: SearchQueryResponse, own: Clause[], detected: Clause[], stats: StatementStats): SearchQueryResponse {
  const clauses = [...own, ...detected].map((c) => ({
    id: c.id,
    field: c.field,
    class: SEARCH_FIELDS[c.field].class,
    source: c.source,
    label: describeClause(c, res.labels),
  }));
  return { ...res, clauses, stats: { ...res.stats, statements: stats.statements, round_trips: stats.round_trips } };
}
