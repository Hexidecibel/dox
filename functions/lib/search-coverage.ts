/**
 * Retrieval for coverage-aware search (the judging is shared/searchCoverage.ts).
 *
 * WHY A STRUCTURED SCAN AND NOT A SQL FILTER. The old natural-language handler
 * put every parsed constraint into the WHERE clause and dropped them one by one
 * until something came back. That is how a search for production date 7/31
 * returned a code-date 7/31 certificate as if it were the answer, and nobody
 * could tell. A coverage answer needs the opposite: the nearby documents that
 * do NOT match, each with the reason, and the ones that do. So this module reads
 * the tenant's documents' structured identity fields (dates, lots, supplier,
 * products — a narrow projection, never file bytes or result tables) and the
 * pending Review Queue, and hands every row to the pure judge.
 *
 * Bounded by `DOC_SCAN_CAP`; a tenant past it is told (`coverage_scan_truncated`)
 * rather than silently answered from a partial corpus.
 *
 * LOT ROWS ARE READ BY INDEX (Phase 2, migration 0106). A production-date or lot
 * constraint also asks `lots` directly — `idx_lots_production_date` for the day
 * (± the nearby window) and `idx_lots_lotkey` for the lot — and every document
 * linked to a row it finds is judged, whether or not the capped scan reached it.
 * Each document is judged row by row (shared/searchCoverage.evaluateSubject) and
 * the response names the row (`matched_lot`).
 */

import type {
  SearchConstraint,
  SearchConstraintCheck,
  SearchCoverage,
  SearchCoverageFields,
  SearchDroppedConstraint,
  SearchUnreviewedCandidate,
} from '../../shared/types';
import {
  coverageFor,
  coverageSummary,
  evaluateSubject,
  makeDateConstraint,
  makeLotConstraint,
  makeStructuredLotConstraint,
  matchedLotOf,
  NEAR_DATE_DAYS,
  parseQueryText,
  residualText,
  subjectLotIdentities,
  type CoverageSubject,
  type LotToken,
  type SubjectLot,
  type SubjectVerdict,
} from '../../shared/searchCoverage';
import { buildMatchExprWithLot, DOCUMENTS_FTS_COLS, documentsBm25Expr, queryTokenVariants } from './search-fts';

export const DOC_SCAN_CAP = 5000;
export const QUEUE_SCAN_CAP = 300;
/** How many non-matching candidates a response lists. */
export const CANDIDATE_CAP = 25;
export const UNREVIEWED_CAP = 10;

// ===========================================================================
// Corpus
// ===========================================================================

export interface QueueGroup {
  queue_id: string;
  file_name: string;
  supplier: string | null;
  created_at: string | null;
  records: Array<{ label: string | null; subject: CoverageSubject }>;
}

export interface CoverageCorpus {
  docs: CoverageSubject[];
  updatedAt: Map<string, string>;
  queue: QueueGroup[];
  truncated: boolean;
  /** Normalized non-lot identifiers on documents (PO, order, product code). */
  otherIdentifiers: Set<string>;
}

function parseJsonObject(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string' || !raw) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function parseJsonArray(raw: unknown): string[] {
  if (typeof raw !== 'string' || !raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

const FIELD_SEP = '\u001f';
const PART_SEP = '\u001e';

interface DocScanRow {
  id: string;
  created_at: string | null;
  updated_at: string | null;
  renewal_due_date: string | null;
  primary_metadata: string | null;
  extended_lite: string | null;
  supplier_name: string | null;
  supplier_aliases: string | null;
  document_type_slug: string | null;
  document_type_name: string | null;
  product_names: string | null;
  lot_rows: string | null;
}

interface QueueScanRow {
  id: string;
  file_name: string;
  supplier: string | null;
  created_at: string | null;
  ai_fields: string | null;
  ai_records: string | null;
  document_type_slug: string | null;
  document_type_name: string | null;
}

function normAlnum(s: unknown): string {
  return String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** The narrow per-document projection the judge reads. `WHERE` is appended by the caller. */
const DOC_SUBJECT_SELECT = `SELECT d.id, d.created_at, d.updated_at, d.renewal_due_date, d.primary_metadata,
              CASE WHEN json_valid(d.extended_metadata) THEN json_remove(d.extended_metadata, '$.tables') END AS extended_lite,
              s.name AS supplier_name, s.aliases AS supplier_aliases,
              dt.slug AS document_type_slug, dt.name AS document_type_name,
              (SELECT GROUP_CONCAT(p.name, char(31))
                 FROM document_products dp JOIN products p ON p.id = dp.product_id
                WHERE dp.document_id = d.id) AS product_names,
              (SELECT GROUP_CONCAT(
                        COALESCE(l.lot_number, '') || char(30) || COALESCE(l.sub_lot_code, '') || char(30) ||
                        COALESCE(l.lot_key, '') || char(30) || l.id || char(30) ||
                        COALESCE(l.production_date, '') || char(30) || COALESCE(l.production_date_raw, '') || char(30) ||
                        COALESCE(l.production_date_source, '') || char(30) || COALESCE(l.production_date_status, ''),
                        char(31))
                 FROM document_lots dl JOIN lots l ON l.id = dl.lot_id
                WHERE dl.document_id = d.id) AS lot_rows
         FROM documents d
         LEFT JOIN suppliers s ON s.id = d.supplier_id
         LEFT JOIN document_types dt ON dt.id = d.document_type_id`;

function parseLotRows(raw: string | null): SubjectLot[] {
  if (!raw) return [];
  return raw.split(FIELD_SEP).map((row) => {
    const [lot_number = '', sub_lot_code = '', lot_key = '', lot_id = '', pd = '', pdRaw = '', pdSource = '', pdStatus = ''] = row.split(PART_SEP);
    return {
      lot_id: lot_id || null,
      lot_number,
      sub_lot_code,
      lot_key,
      provenance: 'linked_record' as const,
      production_date: pd || null,
      production_date_raw: pdRaw || null,
      production_date_source: (pdSource || null) as SubjectLot['production_date_source'],
      production_date_status: (pdStatus || null) as SubjectLot['production_date_status'],
    };
  }).filter((l) => l.lot_number || l.lot_key);
}

function addDocRow(corpus: Pick<CoverageCorpus, 'docs' | 'updatedAt' | 'otherIdentifiers'>, r: DocScanRow): void {
  const metadata = { ...parseJsonObject(r.extended_lite), ...parseJsonObject(r.primary_metadata) };
  for (const k of ['po_number', 'order_number', 'product_code', 'customer_po', 'shipment_number']) {
    const v = normAlnum(metadata[k]);
    if (v.length >= 4) corpus.otherIdentifiers.add(v);
  }
  corpus.docs.push({
    id: r.id,
    supplier_name: r.supplier_name,
    supplier_aliases: parseJsonArray(r.supplier_aliases),
    document_type_slug: r.document_type_slug,
    document_type_name: r.document_type_name,
    product_names: r.product_names ? r.product_names.split(FIELD_SEP).filter(Boolean) : [],
    metadata,
    lots: parseLotRows(r.lot_rows),
    created_at: r.created_at,
    renewal_due_date: r.renewal_due_date,
    text_match: null,
  });
  if (r.updated_at) corpus.updatedAt.set(r.id, r.updated_at);
}

export async function loadCoverageCorpus(db: D1Database, tenantId: string): Promise<CoverageCorpus> {
  const docRes = await db
    .prepare(
      `${DOC_SUBJECT_SELECT}
        WHERE d.tenant_id = ? AND d.status = 'active'
        ORDER BY d.updated_at DESC
        LIMIT ?`,
    )
    .bind(tenantId, DOC_SCAN_CAP + 1)
    .all<DocScanRow>();
  const rows = docRes.results ?? [];
  const truncated = rows.length > DOC_SCAN_CAP;
  const docs: CoverageSubject[] = [];
  const updatedAt = new Map<string, string>();
  const otherIdentifiers = new Set<string>();

  for (const r of rows.slice(0, DOC_SCAN_CAP)) addDocRow({ docs, updatedAt, otherIdentifiers }, r);

  const queueRes = await db
    .prepare(
      `SELECT q.id, q.file_name, q.supplier, q.created_at, q.ai_fields, q.ai_records,
              dt.slug AS document_type_slug, dt.name AS document_type_name
         FROM processing_queue q
         LEFT JOIN document_types dt ON dt.id = q.document_type_id
        WHERE q.tenant_id = ? AND q.status = 'pending' AND q.processing_status = 'ready'
        ORDER BY q.created_at DESC
        LIMIT ?`,
    )
    .bind(tenantId, QUEUE_SCAN_CAP)
    .all<QueueScanRow>();

  const queue: QueueGroup[] = (queueRes.results ?? []).map((q) => {
    const fields = parseJsonObject(q.ai_fields);
    const recordsDoc = parseJsonObject(q.ai_records);
    const pageMeta = (recordsDoc.page_metadata && typeof recordsDoc.page_metadata === 'object')
      ? (recordsDoc.page_metadata as Record<string, unknown>)
      : {};
    const recs = Array.isArray(recordsDoc.records) ? (recordsDoc.records as Array<Record<string, unknown>>) : [];
    const mk = (metadata: Record<string, unknown>, idx: number): CoverageSubject => ({
      id: `${q.id}#${idx}`,
      supplier_name: q.supplier ?? (typeof metadata.supplier_name === 'string' ? metadata.supplier_name : null),
      supplier_aliases: [],
      document_type_slug: q.document_type_slug,
      document_type_name: q.document_type_name,
      product_names: [],
      metadata,
      lots: [],
      created_at: q.created_at,
      renewal_due_date: null,
      text_match: null,
    });
    // A record's own fields over the page's shared fields — never ai_fields,
    // which on a multi-record certificate is the FIRST record's values and
    // would lend record 1's lot to record 4.
    const records = recs.length > 0
      ? recs.map((rec, i) => {
        const recFields = rec.fields && typeof rec.fields === 'object' ? (rec.fields as Record<string, unknown>) : {};
        return {
          label: recs.length > 1 ? `record ${i + 1} of ${recs.length}` : null,
          subject: mk({ ...pageMeta, ...recFields }, i),
        };
      })
      : [{ label: null, subject: mk(fields, 0) }];
    return { queue_id: q.id, file_name: q.file_name, supplier: q.supplier, created_at: q.created_at, records };
  });

  return { docs, updatedAt, queue, truncated, otherIdentifiers };
}

function addDaysIso(iso: string, n: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Documents linked to a lot row an indexed lookup finds for these constraints:
 *   - a production (or any-role) date with a day range -> `lots.production_date`
 *     over that range, widened by the nearby window for a single day, so the
 *     23-Jul row is judged (and labelled nearby) for a 22-Jul question;
 *   - a lot -> `lots.lot_key` equal to it, or sharing its base (sibling sublots
 *     are the likeliest near miss).
 * A year-less date ("produced 9/2") has no range to seek and is left to the scan.
 */
export async function indexedLotDocumentIds(db: D1Database, tenantId: string, constraints: SearchConstraint[]): Promise<Set<string>> {
  const out = new Set<string>();
  const collect = async (sql: string, ...binds: unknown[]) => {
    const res = await db.prepare(sql).bind(tenantId, ...binds).all<{ document_id: string }>();
    for (const r of res.results ?? []) out.add(r.document_id);
  };
  for (const c of constraints) {
    if (c.kind === 'date' && (c.role === 'production' || c.role === 'any') && (c.date_from || c.date_to)) {
      const single = !!c.date_from && c.date_from === c.date_to;
      const from = c.date_from ? (single ? addDaysIso(c.date_from, -NEAR_DATE_DAYS) : c.date_from) : '0000-01-01';
      const to = c.date_to ? (single ? addDaysIso(c.date_to, NEAR_DATE_DAYS) : c.date_to) : '9999-12-31';
      await collect(
        `SELECT DISTINCT dl.document_id
           FROM lots l JOIN document_lots dl ON dl.lot_id = l.id
          WHERE l.tenant_id = ? AND l.production_date BETWEEN ? AND ?
          LIMIT 2000`,
        from, to,
      );
    }
    if (c.kind === 'lot') {
      const base = c.lot_parts?.base ?? (c.value.length > 8 ? c.value.slice(0, -2) : c.value);
      // A prefix range on the index: every key starting with the base. Keys are
      // upper-case alphanumerics, and '~' sorts after all of them.
      await collect(
        `SELECT DISTINCT dl.document_id
           FROM lots l JOIN document_lots dl ON dl.lot_id = l.id
          WHERE l.tenant_id = ? AND ((l.lot_key >= ? AND l.lot_key < ?) OR l.lot_key = ?)
          LIMIT 2000`,
        base, `${base}~`, c.value,
      );
    }
  }
  return out;
}

/** Bring every document an indexed lot-row lookup found into the corpus. */
export async function extendCorpusWithLotRows(
  db: D1Database,
  tenantId: string,
  corpus: CoverageCorpus,
  constraints: SearchConstraint[],
): Promise<void> {
  const ids = await indexedLotDocumentIds(db, tenantId, constraints);
  const have = new Set(corpus.docs.map((d) => d.id));
  const missing = [...ids].filter((id) => !have.has(id));
  for (let i = 0; i < missing.length; i += 80) {
    const chunk = missing.slice(i, i + 80);
    const res = await db
      .prepare(`${DOC_SUBJECT_SELECT} WHERE d.tenant_id = ? AND d.status = 'active' AND d.id IN (${chunk.map(() => '?').join(',')})`)
      .bind(tenantId, ...chunk)
      .all<DocScanRow>();
    for (const r of res.results ?? []) addDocRow(corpus, r);
  }
}

// ===========================================================================
// Instant-search constraint planning
// ===========================================================================

export interface CoveragePlan {
  constraints: SearchConstraint[];
  dropped: SearchDroppedConstraint[];
  /** Free text left once constraint phrases are removed ('' = none). */
  residual: string;
  corpus: CoverageCorpus;
}

function lotTokenIsLot(t: LotToken, corpus: CoverageCorpus): boolean {
  if (t.explicit) return true;
  const n = t.norm;
  let exact = false;
  let partial = false;
  const consider = (s: CoverageSubject) => {
    for (const id of subjectLotIdentities(s)) {
      const composite = id.base + id.sub;
      if (n === composite || n === id.base || n === id.key) exact = true;
      else if (n.length >= 6 && composite.startsWith(n)) partial = true;
      else if (id.base.length >= 6 && n.startsWith(id.base) && n.length - id.base.length <= 3) partial = true;
    }
  };
  for (const d of corpus.docs) consider(d);
  for (const g of corpus.queue) for (const r of g.records) consider(r.subject);
  if (exact) return true;
  // A PO or product code that happens to start like a lot is still a PO.
  if (corpus.otherIdentifiers.has(n)) return false;
  if (partial) return true;
  // A long all-digit run (a WMS composite lot is ten) that is nobody's PO,
  // order or product code is asked for as a lot even when no lot on file
  // resembles it — so the answer is "no document covers lot X", not an
  // unlabelled empty text search. Seven digits and under stay text: customer
  // POs, Medosweet orders and shipment numbers live there.
  return /^\d{8,}$/.test(n);
}

function supplierWordIn(q: string, suppliers: Array<{ name: string; aliases: string[] }>): { name: string; start: number; end: number } | null {
  const lower = q.toLowerCase();
  for (const s of suppliers) {
    for (const candidate of [s.name, ...s.aliases]) {
      const words = candidate.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/)
        .filter((w) => w.length >= 4 && !['inc', 'llc', 'corp', 'company', 'farms', 'dairy', 'foods'].includes(w));
      const first = words[0];
      if (!first) continue;
      const re = new RegExp(`\\b${first.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
      const m = re.exec(lower);
      if (m) return { name: s.name, start: m.index, end: m.index + m[0].length };
    }
  }
  return null;
}

/**
 * Decide whether a typed query states constraints. Returns null for an
 * ordinary search ("butter", "K135797"), which keeps the plain FTS path and
 * pays for no scan. A supplier name counts only alongside a lot or a date —
 * "darigold" alone is browsing, "darigold 7/22/2026" is asking for a document.
 */
export async function planInstantSearch(
  db: D1Database,
  tenantId: string,
  q: string,
  structured: { lot?: string | null; sublot?: string | null } = {},
): Promise<CoveragePlan | null> {
  const parsed = parseQueryText(q);
  const structuredLot = structured.lot && structured.lot.trim()
    ? makeStructuredLotConstraint('c0', structured.lot, structured.sublot)
    : null;
  if (parsed.dates.length === 0 && parsed.lotTokens.length === 0 && !structuredLot) return null;

  const corpus = await loadCoverageCorpus(db, tenantId);
  const constraints: SearchConstraint[] = [];
  const spans: Array<[number, number]> = [];
  let n = 0;
  if (structuredLot) constraints.push({ ...structuredLot, id: `c${++n}` });

  for (const d of parsed.dates) {
    constraints.push(makeDateConstraint(`c${++n}`, d.role, d.date, 'query_text'));
    spans.push([d.start, d.end]);
    if (d.roleSpan) spans.push(d.roleSpan);
  }
  for (const t of parsed.lotTokens) {
    if (!lotTokenIsLot(t, corpus)) continue;
    constraints.push(makeLotConstraint(`c${++n}`, t, 'query_text'));
    spans.push([t.start, t.end]);
  }
  if (constraints.length === 0) return null;

  const supRes = await db
    .prepare('SELECT name, aliases FROM suppliers WHERE tenant_id = ? AND active = 1')
    .bind(tenantId)
    .all<{ name: string; aliases: string | null }>();
  const suppliers = (supRes.results ?? []).map((s) => ({ name: s.name, aliases: parseJsonArray(s.aliases) }));
  const residualBeforeSupplier = residualText(q, spans);
  const sup = supplierWordIn(residualBeforeSupplier ? q : '', suppliers);
  if (sup && !spans.some(([s, e]) => sup.start < e && sup.end > s)) {
    constraints.push({
      id: `c${++n}`, kind: 'supplier', label: `supplier ${sup.name}`, raw: q.slice(sup.start, sup.end),
      value: sup.name, fields: ['supplier'], source: 'query_text',
    });
    spans.push([sup.start, sup.end]);
  }

  const residual = residualText(q, spans);
  if (residual) {
    constraints.push({
      id: `c${++n}`, kind: 'text', label: `mentions "${residual}"`, raw: residual, value: residual,
      fields: ['title', 'file_name', 'extracted_text', 'supplier', 'product'], source: 'query_text',
    });
  }
  return { constraints, dropped: [], residual, corpus };
}

// ===========================================================================
// Running a coverage search
// ===========================================================================

export interface PoolHit {
  rank: number;
  snippet: string | null;
  snippet_extracted: string | null;
  snippet_supplier: string | null;
}

export async function ftsPool(db: D1Database, tenantId: string, text: string, limit = 500): Promise<Map<string, PoolHit>> {
  const expr = buildMatchExprWithLot(text);
  const out = new Map<string, PoolHit>();
  if (!expr) return out;
  const res = await db
    .prepare(
      `WITH matches AS (
         SELECT f.doc_id,
                ${documentsBm25Expr()} AS rank,
                snippet(documents_fts, -1, '<mark>', '</mark>', '…', 12) AS snippet,
                snippet(documents_fts, ${DOCUMENTS_FTS_COLS.extracted_text}, '<mark>', '</mark>', '…', 12) AS snippet_extracted,
                snippet(documents_fts, ${DOCUMENTS_FTS_COLS.supplier_text}, '<mark>', '</mark>', '…', 8) AS snippet_supplier
           FROM documents_fts f
          WHERE f.tenant_id = ? AND documents_fts MATCH ?
       )
       SELECT m.* FROM matches m JOIN documents d ON d.id = m.doc_id
        WHERE d.status = 'active'
        ORDER BY m.rank
        LIMIT ?`,
    )
    .bind(tenantId, expr, limit)
    .all<{ doc_id: string } & PoolHit>();
  for (const r of res.results ?? []) {
    out.set(r.doc_id, { rank: r.rank, snippet: r.snippet, snippet_extracted: r.snippet_extracted, snippet_supplier: r.snippet_supplier });
  }
  return out;
}

/** Queue items whose file name, supplier or extracted text holds every word. */
async function queueTextHits(db: D1Database, tenantId: string, text: string): Promise<Set<string>> {
  const words = text.split(/\s+/).map((w) => w.toLowerCase().replace(/[^a-z0-9\-./#%]/g, '')).filter((w) => w.length > 0).slice(0, 6);
  if (words.length === 0) return new Set();
  const conds: string[] = [];
  const params: string[] = [];
  for (const w of words) {
    // The shortest spelling ("bag" for "bags", "gal" for "gallon") as a substring.
    const stem = queryTokenVariants(w).sort((a, b) => a.length - b.length)[0] ?? w;
    conds.push(`LOWER(COALESCE(q.file_name, '') || ' ' || COALESCE(q.supplier, '') || ' ' || COALESCE(q.extracted_text, '')) LIKE ?`);
    params.push(`%${stem}%`);
  }
  const res = await db
    .prepare(
      `SELECT q.id FROM processing_queue q
        WHERE q.tenant_id = ? AND q.status = 'pending' AND q.processing_status = 'ready' AND ${conds.join(' AND ')}
        ORDER BY q.created_at DESC LIMIT ?`,
    )
    .bind(tenantId, ...params, QUEUE_SCAN_CAP)
    .all<{ id: string }>();
  return new Set((res.results ?? []).map((r) => r.id));
}

export async function fetchDocumentRows(db: D1Database, ids: string[]): Promise<Map<string, Record<string, unknown>>> {
  const out = new Map<string, Record<string, unknown>>();
  for (let i = 0; i < ids.length; i += 80) {
    const chunk = ids.slice(i, i + 80);
    if (chunk.length === 0) continue;
    const res = await db
      .prepare(
        `SELECT d.*,
                u.name AS creator_name,
                u.email AS creator_email,
                t.name AS tenant_name,
                dt.name AS document_type_name,
                dt.slug AS document_type_slug,
                dt.name AS primary_category_name,
                s.name AS supplier_name,
                COALESCE(d.renewal_due_date, json_extract(d.primary_metadata, '$.expiration_date')) AS expiration
           FROM documents d
           LEFT JOIN users u ON d.created_by = u.id
           LEFT JOIN tenants t ON d.tenant_id = t.id
           LEFT JOIN document_types dt ON d.document_type_id = dt.id
           LEFT JOIN suppliers s ON d.supplier_id = s.id
          WHERE d.id IN (${chunk.map(() => '?').join(',')})`,
      )
      .bind(...chunk)
      .all<Record<string, unknown>>();
    for (const r of res.results ?? []) out.set(String(r.id), r);
  }
  return out;
}

export interface CoverageRunResult extends Required<Pick<SearchCoverageFields,
  'coverage' | 'constraints' | 'dropped_constraints' | 'coverage_summary' | 'covering_count' | 'likely_count' | 'candidate_count' | 'unreviewed_candidates' | 'coverage_scan_truncated'>> {
  /** Covering documents first, then candidates — each annotated. Paged. */
  rows: Array<Record<string, unknown>>;
  total: number;
}

function reasonOf(checks: SearchConstraintCheck[]): string {
  return checks.filter((c) => c.outcome !== 'match').map((c) => c.message).join(' ');
}

/**
 * Judge the corpus against the constraints and page the answer.
 *
 * `textPool` is the FTS hit set for the query's free text: under a `text`
 * constraint it decides that constraint; otherwise (natural-language keywords)
 * it only makes a document eligible to be listed as a candidate and orders it.
 */
export async function runCoverageSearch(
  db: D1Database,
  tenantId: string,
  input: {
    constraints: SearchConstraint[];
    dropped: SearchDroppedConstraint[];
    corpus: CoverageCorpus;
    poolText: string | null;
    limit: number;
    offset: number;
  },
): Promise<CoverageRunResult> {
  const { constraints, dropped, corpus } = input;
  await extendCorpusWithLotRows(db, tenantId, corpus, constraints);
  const hasTextConstraint = constraints.some((c) => c.kind === 'text');
  const pool = input.poolText ? await ftsPool(db, tenantId, input.poolText) : new Map<string, PoolHit>();
  // A lot typed into search that a document only MENTIONS (in its text or its
  // file name — the D3 case, a filename naming one lot of four) is worth
  // showing, labelled: it is where a person would look next. It never covers.
  const mentions = new Map<string, string>();
  for (const c of constraints) {
    if (c.kind !== 'lot') continue;
    for (const id of (await ftsPool(db, tenantId, c.raw, 100)).keys()) {
      if (!mentions.has(id)) mentions.set(id, c.raw);
    }
  }
  const queueText = hasTextConstraint && input.poolText ? await queueTextHits(db, tenantId, input.poolText) : null;

  const judged: Array<{ id: string; verdict: SubjectVerdict; subject: CoverageSubject }> = [];
  for (const doc of corpus.docs) {
    const subject = hasTextConstraint ? { ...doc, text_match: pool.has(doc.id) } : doc;
    const verdict = evaluateSubject(subject, constraints, dropped, {
      inPool: (!hasTextConstraint && pool.has(doc.id)) || mentions.has(doc.id),
    });
    if (verdict.status !== 'covering' && mentions.has(doc.id)) {
      verdict.reason = `${verdict.reason ?? ''} Its text mentions "${mentions.get(doc.id)}".`.trim();
    }
    if (verdict.eligible) judged.push({ id: doc.id, verdict, subject: doc });
  }

  const byRank = (a: { id: string }, b: { id: string }) => {
    const ra = pool.get(a.id)?.rank;
    const rb = pool.get(b.id)?.rank;
    if (ra !== undefined && rb !== undefined && ra !== rb) return ra - rb;
    if (ra !== undefined && rb === undefined) return -1;
    if (rb !== undefined && ra === undefined) return 1;
    return (corpus.updatedAt.get(b.id) ?? '').localeCompare(corpus.updatedAt.get(a.id) ?? '');
  };
  const covering = judged.filter((j) => j.verdict.status === 'covering').sort(byRank);
  const likely = judged
    .filter((j) => j.verdict.status === 'likely_covering')
    .sort((a, b) => b.verdict.score - a.verdict.score || byRank(a, b));
  const candidates = judged
    .filter((j) => j.verdict.status === 'candidate_not_matching')
    .sort((a, b) => b.verdict.score - a.verdict.score || byRank(a, b))
    .slice(0, CANDIDATE_CAP);

  const ordered = [...covering, ...likely, ...candidates];
  const page = ordered.slice(input.offset, input.offset + input.limit);
  const rowsById = await fetchDocumentRows(db, page.map((p) => p.id));
  const rows: Array<Record<string, unknown>> = [];
  for (const p of page) {
    const row = rowsById.get(p.id);
    if (!row) continue;
    const hit = pool.get(p.id);
    rows.push({
      ...row,
      ...(hit ? { rank: hit.rank, snippet: hit.snippet, snippet_extracted: hit.snippet_extracted, snippet_supplier: hit.snippet_supplier } : {}),
      match_status: p.verdict.status,
      matched_lot: matchedLotOf(p.verdict, p.subject),
      match_checks: p.verdict.checks,
      match_reason: p.verdict.reason,
    });
  }

  // Review Queue: evaluated record by record, reported per file, never covering.
  const unreviewed: Array<SearchUnreviewedCandidate & { score: number }> = [];
  for (const g of corpus.queue) {
    let best: { label: string | null; verdict: SubjectVerdict } | null = null;
    for (const r of g.records) {
      const subject = hasTextConstraint ? { ...r.subject, text_match: queueText?.has(g.queue_id) ?? false } : r.subject;
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
        : `Still in the Review Queue. ${reasonOf(best.verdict.checks)}`,
      score: best.verdict.score + (all ? 1000 : 0),
    });
  }
  unreviewed.sort((a, b) => b.score - a.score);

  const coverage: SearchCoverage = coverageFor(constraints, dropped, covering.length, likely.length);
  return {
    rows,
    total: ordered.length,
    coverage,
    constraints,
    dropped_constraints: dropped,
    coverage_summary: coverageSummary(constraints, dropped, covering.length, likely.length),
    covering_count: covering.length,
    likely_count: likely.length,
    candidate_count: candidates.length,
    unreviewed_candidates: unreviewed.slice(0, UNREVIEWED_CAP).map(({ score: _s, ...u }) => u),
    coverage_scan_truncated: corpus.truncated,
  };
}

/**
 * Pending Review Queue files that mention every word of an ordinary
 * (unconstrained) search. Before this, a file sitting in the queue was
 * invisible to search entirely.
 */
export async function unreviewedTextCandidates(db: D1Database, tenantId: string, text: string): Promise<SearchUnreviewedCandidate[]> {
  const ids = await queueTextHits(db, tenantId, text);
  if (ids.size === 0) return [];
  const list = [...ids].slice(0, UNREVIEWED_CAP);
  const res = await db
    .prepare(`SELECT id, file_name, supplier, created_at FROM processing_queue WHERE tenant_id = ? AND id IN (${list.map(() => '?').join(',')}) ORDER BY created_at DESC`)
    .bind(tenantId, ...list)
    .all<{ id: string; file_name: string; supplier: string | null; created_at: string | null }>();
  return (res.results ?? []).map((q) => ({
    queue_id: q.id,
    file_name: q.file_name,
    supplier: q.supplier,
    created_at: q.created_at,
    review_url: `/review?item=${encodeURIComponent(q.id)}`,
    match_status: 'unreviewed_candidate' as const,
    matches_all_constraints: false,
    record_label: null,
    match_checks: [],
    match_reason: `Mentions "${text}", but it is still in the Review Queue — not on file until someone approves it.`,
  }));
}
