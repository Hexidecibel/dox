/**
 * GET /api/search — universal grouped search (Phase 4d of the
 * Document Search v2 plan).
 *
 * Plan ref: `/home/hexi/.claude/plans/peppy-coalescing-platypus.md` § 1.8.
 *
 * Single backend round-trip that fans out per-entity FTS scans against
 * the FTS5 backbone (migration 0054) and returns the top-N results per
 * entity type plus the documents block reused from Phase 4a:
 *
 *   {
 *     documents:  { total, results: [...], facets? },
 *     suppliers:  { total, results: [...] },
 *     products:   { total, results: [...] },
 *     doc_types:  { total, results: [...] },
 *     orders:     { total, results: [...] },
 *     customers:  { total, results: [...] },
 *     bundles:    { total, results: [...] },
 *   }
 *
 * Tenant scoping rules:
 *   - super_admin: must pass `tenant_id` (we do NOT v1-support global
 *     universal scan; the per-entity FTS tables all carry tenant_id
 *     UNINDEXED so fan-out without scoping would mix tenants).
 *   - everyone else: tenant_id is taken from the user.
 *
 * Paging:
 *   - documents block accepts `limit` (default 20, max 200) + `offset`.
 *   - other entities are top-N only (`limit_per_type`, default 5,
 *     max 25). The plan calls them "top-5"; we expose a knob.
 *
 * Implementation notes:
 *   - We use `env.DB.batch([...])` for the per-entity scans so the
 *     round-trip is a single D1 transaction. The `documents` block goes
 *     last and is its own query (with the snippet/facet machinery from
 *     Phase 4a) — putting it inside the batch would force a contortion
 *     to share params with the COUNT(*) OVER () window, so we trade
 *     one extra D1 call for clarity.
 *   - The shared FTS5 sanitizer (`buildMatchExpr`) is reused.
 */

import { errorToResponse, BadRequestError } from '../../lib/permissions';
import { buildMatchExpr, buildMatchExprWithLot, DOCUMENTS_FTS_COLS } from '../../lib/search-fts';
import type { Env, User } from '../../lib/types';

const DEFAULT_LIMIT_PER_TYPE = 5;
const MAX_LIMIT_PER_TYPE = 25;
const DEFAULT_DOC_LIMIT = 20;
const MAX_DOC_LIMIT = 200;

interface PerEntityBlock<T> {
  total: number;
  results: T[];
}

interface UniversalResponse {
  documents: PerEntityBlock<Record<string, unknown>> & { facets?: Record<string, unknown> };
  suppliers: PerEntityBlock<Record<string, unknown>>;
  products: PerEntityBlock<Record<string, unknown>>;
  doc_types: PerEntityBlock<Record<string, unknown>>;
  orders: PerEntityBlock<Record<string, unknown>>;
  customers: PerEntityBlock<Record<string, unknown>>;
  bundles: PerEntityBlock<Record<string, unknown>>;
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const url = new URL(context.request.url);

    const q = url.searchParams.get('q') ?? '';
    let tenantId = url.searchParams.get('tenant_id');
    const docLimit = Math.min(
      parseInt(url.searchParams.get('limit') || `${DEFAULT_DOC_LIMIT}`, 10),
      MAX_DOC_LIMIT,
    );
    const docOffset = parseInt(url.searchParams.get('offset') || '0', 10);
    const limitPerType = Math.min(
      parseInt(url.searchParams.get('limit_per_type') || `${DEFAULT_LIMIT_PER_TYPE}`, 10),
      MAX_LIMIT_PER_TYPE,
    );

    if (user.role !== 'super_admin') {
      tenantId = user.tenant_id;
    }

    if (!tenantId) {
      throw new BadRequestError('tenant_id is required');
    }

    const matchExpr = buildMatchExpr(q);
    // documents_fts carries a `lot_text` column (migration 0074); the
    // doc-specific match expr ORs in a normalized, column-scoped lot
    // prefix so typing a main lot returns all its sublot COAs. Other
    // per-entity FTS tables have no lot_text column, so they keep the
    // plain matchExpr.
    const docMatchExpr = buildMatchExprWithLot(q);
    const empty: PerEntityBlock<Record<string, unknown>> = { total: 0, results: [] };

    // ----------------------------------------------------------------
    // No-query mode — return empty per-entity blocks. The frontend will
    // swap in "recent items" lists in Phase 5 (per the plan's
    // open-implementation-detail). For v1 this is a 200 with zeros.
    // ----------------------------------------------------------------
    if (!matchExpr) {
      const responseBody: UniversalResponse = {
        documents: { ...empty },
        suppliers: { ...empty },
        products: { ...empty },
        doc_types: { ...empty },
        orders: { ...empty },
        customers: { ...empty },
        bundles: { ...empty },
      };
      return new Response(JSON.stringify(responseBody), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // ----------------------------------------------------------------
    // Per-entity FTS scans, fanned out via env.DB.batch().
    //
    // Each query is a small read against one FTS table. We project
    // (id, name, plus a snippet) along with a COUNT(*) OVER () window
    // so we only need one statement per entity (count + page).
    //
    // For documents the scan also feeds the snippet/joined-projection
    // path from Phase 4a (we re-issue against `documents_fts` here
    // rather than calling the existing handler — keeps the response
    // shape stable across entity types).
    // ----------------------------------------------------------------

    type RowWithCount = Record<string, unknown> & { __total?: number };

    // FTS5's `snippet()` only works on a SELECT directly off the FTS
    // virtual table — combining it with `COUNT(*) OVER ()` or a JOIN
    // (e.g. orders_fts JOIN orders) raises "unable to use function
    // snippet in the requested context". So per-entity blocks split
    // into two D1 statements: a count + a top-N page. We pair them
    // inside the same `batch()` call so the round-trip is still one
    // transaction. Documents are a simple FTS-only top-N here (the
    // /api/documents/search endpoint owns the heavy CTE+joins+facets
    // path; universal returns a lightweight projection).
    const stmts = [
      // 0: suppliers — count
      context.env.DB.prepare(
        `SELECT COUNT(*) AS total FROM suppliers_fts
         WHERE tenant_id = ? AND suppliers_fts MATCH ?`,
      ).bind(tenantId, matchExpr),
      // 1: suppliers — page
      context.env.DB.prepare(
        `SELECT
           f.supplier_id AS id,
           f.name AS name,
           snippet(suppliers_fts, -1, '<mark>', '</mark>', '…', 8) AS snippet
         FROM suppliers_fts f
         WHERE f.tenant_id = ? AND suppliers_fts MATCH ?
         ORDER BY rank
         LIMIT ?`,
      ).bind(tenantId, matchExpr, limitPerType),

      // 2: products — count
      context.env.DB.prepare(
        `SELECT COUNT(*) AS total FROM products_fts
         WHERE tenant_id = ? AND products_fts MATCH ?`,
      ).bind(tenantId, matchExpr),
      // 3: products — page
      context.env.DB.prepare(
        `SELECT
           f.product_id AS id,
           f.name AS name,
           snippet(products_fts, -1, '<mark>', '</mark>', '…', 8) AS snippet
         FROM products_fts f
         WHERE f.tenant_id = ? AND products_fts MATCH ?
         ORDER BY rank
         LIMIT ?`,
      ).bind(tenantId, matchExpr, limitPerType),

      // 4: doc_types — count
      context.env.DB.prepare(
        `SELECT COUNT(*) AS total FROM document_types_fts
         WHERE tenant_id = ? AND document_types_fts MATCH ?`,
      ).bind(tenantId, matchExpr),
      // 5: doc_types — page
      context.env.DB.prepare(
        `SELECT
           f.doc_type_id AS id,
           f.name AS name,
           f.slug AS slug,
           snippet(document_types_fts, -1, '<mark>', '</mark>', '…', 8) AS snippet
         FROM document_types_fts f
         WHERE f.tenant_id = ? AND document_types_fts MATCH ?
         ORDER BY rank
         LIMIT ?`,
      ).bind(tenantId, matchExpr, limitPerType),

      // 6: customers — count
      context.env.DB.prepare(
        `SELECT COUNT(*) AS total FROM customers_fts
         WHERE tenant_id = ? AND customers_fts MATCH ?`,
      ).bind(tenantId, matchExpr),
      // 7: customers — page
      context.env.DB.prepare(
        `SELECT
           f.customer_id AS id,
           f.name AS name,
           f.customer_number AS customer_number,
           snippet(customers_fts, -1, '<mark>', '</mark>', '…', 8) AS snippet
         FROM customers_fts f
         WHERE f.tenant_id = ? AND customers_fts MATCH ?
         ORDER BY rank
         LIMIT ?`,
      ).bind(tenantId, matchExpr, limitPerType),

      // 8: bundles — count
      context.env.DB.prepare(
        `SELECT COUNT(*) AS total FROM bundles_fts
         WHERE tenant_id = ? AND bundles_fts MATCH ?`,
      ).bind(tenantId, matchExpr),
      // 9: bundles — page
      context.env.DB.prepare(
        `SELECT
           f.bundle_id AS id,
           f.name AS name,
           snippet(bundles_fts, -1, '<mark>', '</mark>', '…', 8) AS snippet
         FROM bundles_fts f
         WHERE f.tenant_id = ? AND bundles_fts MATCH ?
         ORDER BY rank
         LIMIT ?`,
      ).bind(tenantId, matchExpr, limitPerType),

      // 10: orders — count. Staged orders sit in the FTS index (the trigger
      // doesn't gate on staged_at) so we filter via a join back to `orders`.
      context.env.DB.prepare(
        `SELECT COUNT(*) AS total FROM orders_fts f
         JOIN orders o ON o.id = f.order_id
         WHERE f.tenant_id = ? AND orders_fts MATCH ? AND o.staged_at IS NULL`,
      ).bind(tenantId, matchExpr),
      // 11: orders — page (FTS-only projection so snippet() works; the
      // canonical order row is fetched in a follow-up query below).
      context.env.DB.prepare(
        `SELECT
           f.order_id AS id,
           f.order_number AS order_number,
           f.po_number AS po_number,
           f.customer_text AS customer_name,
           snippet(orders_fts, -1, '<mark>', '</mark>', '…', 8) AS snippet
         FROM orders_fts f
         JOIN orders o ON o.id = f.order_id
         WHERE f.tenant_id = ? AND orders_fts MATCH ? AND o.staged_at IS NULL
         ORDER BY rank
         LIMIT ?`,
      ).bind(tenantId, matchExpr, limitPerType),

      // 12: documents — count (filter to active in the same shot since
      // status lives on `documents`, not the FTS index)
      context.env.DB.prepare(
        `SELECT COUNT(*) AS total
         FROM documents_fts f
         JOIN documents d ON d.id = f.doc_id
         WHERE f.tenant_id = ? AND documents_fts MATCH ? AND d.status = 'active'`,
      ).bind(tenantId, docMatchExpr),
      // 13: documents — page. snippet() is used inside a CTE on
      // documents_fts (no JOIN there), then the CTE is joined to
      // documents for projection.
      context.env.DB.prepare(
        `WITH matches AS (
           SELECT
             f.doc_id,
             bm25(documents_fts) AS rank,
             snippet(documents_fts, -1, '<mark>', '</mark>', '…', 12) AS snippet,
             snippet(documents_fts, ${DOCUMENTS_FTS_COLS.extracted_text}, '<mark>', '</mark>', '…', 12) AS snippet_extracted,
             snippet(documents_fts, ${DOCUMENTS_FTS_COLS.supplier_text}, '<mark>', '</mark>', '…', 8) AS snippet_supplier
           FROM documents_fts f
           WHERE f.tenant_id = ? AND documents_fts MATCH ?
         )
         SELECT
           d.*,
           -- (lot-aware match expr; see docMatchExpr)
           u.name AS creator_name,
           dt.name AS document_type_name,
           dt.slug AS document_type_slug,
           s.name AS supplier_name,
           m.rank AS rank,
           m.snippet AS snippet,
           m.snippet_extracted AS snippet_extracted,
           m.snippet_supplier AS snippet_supplier
         FROM matches m
         JOIN documents d ON d.id = m.doc_id
         LEFT JOIN users u ON d.created_by = u.id
         LEFT JOIN document_types dt ON d.document_type_id = dt.id
         LEFT JOIN suppliers s ON d.supplier_id = s.id
         WHERE d.status = 'active'
         ORDER BY m.rank
         LIMIT ? OFFSET ?`,
      ).bind(tenantId, docMatchExpr, docLimit, docOffset),
    ];

    const batchResults = await context.env.DB.batch<RowWithCount>(stmts);

    function blockFromPair<T>(countIdx: number, pageIdx: number, shape: (r: RowWithCount) => T): PerEntityBlock<T> {
      const totalRow = batchResults[countIdx]?.results?.[0] as { total?: number } | undefined;
      const total = totalRow ? Number(totalRow.total ?? 0) : 0;
      const rows = batchResults[pageIdx]?.results ?? [];
      const results = rows.map((r) => {
        const { __total: _drop, ...rest } = r;
        return shape(rest as RowWithCount);
      });
      return { total, results };
    }

    const responseBody: UniversalResponse = {
      suppliers: blockFromPair(0, 1, (r) => r as Record<string, unknown>),
      products: blockFromPair(2, 3, (r) => r as Record<string, unknown>),
      doc_types: blockFromPair(4, 5, (r) => r as Record<string, unknown>),
      customers: blockFromPair(6, 7, (r) => r as Record<string, unknown>),
      bundles: blockFromPair(8, 9, (r) => r as Record<string, unknown>),
      orders: blockFromPair(10, 11, (r) => r as Record<string, unknown>),
      documents: blockFromPair(12, 13, (r) => r as Record<string, unknown>),
    };

    return new Response(JSON.stringify(responseBody), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;

    console.error('Universal search error:', err);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
