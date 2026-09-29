/**
 * GET /api/documents/search — FTS5 backed (Phase 4a of the
 * Document Search v2 plan).
 *
 * Plan ref: `/home/hexi/.claude/plans/peppy-coalescing-platypus.md` § 1.6.
 *
 * Replaces the legacy LIKE-based search with `documents_fts MATCH ?`.
 * Same query-string contract:
 *
 *   q                  — free-text search (FTS5 multi-token AND, prefix
 *                        on the last token; sanitized via search-fts.ts)
 *   tenant_id          — required (taken from caller for non-super_admin)
 *   category           — `documents.category` literal match
 *   document_type_id   — `documents.document_type_id` literal match
 *   supplier_id        — `documents.supplier_id` literal match
 *   limit / offset     — paging, capped at 200
 *
 * New in Phase 4:
 *   sort               — relevance (default) | newest | oldest | name
 *   facets=1           — include faceted counts on the response
 *
 * Search redesign Phase 1 STOPGAP (the /documents screen now calls
 * POST /api/search/query; this contract stays honest while other callers move):
 *   supplier_id, document_type_id, product_id, status — may REPEAT (or be
 *   comma-separated); values inside one filter OR together, filters AND.
 *   product_id matches a document_products link OR a linked lot row's product.
 *   status defaults to active; 'deleted' is never searchable.
 *   date_from / date_to — bounds on created_at (they used to be ignored).
 *   Facets go out in ONE batch, each leaving out only its own filter.
 *
 * Response shape:
 *   {
 *     documents: Array<DocumentRow & { snippet?: string }>,
 *     total: number,
 *     limit: number,
 *     offset: number,
 *     facets?: {
 *       supplier:    Array<{ value, label, count }>,
 *       doc_type:    Array<{ value, label, count }>,
 *       product:     Array<{ value, label, count }>,
 *       date_bucket: Array<{ value, label, count }>,
 *     },
 *   }
 *
 * Behavior notes:
 *   - When `q` is empty (or sanitizes to nothing) we skip the MATCH and
 *     fall back to a plain `documents` listing with the structured
 *     filters applied. Snippets are not produced in that mode.
 *   - Faceted counts use the "sticky-filter exclusion" rule from the
 *     plan: each facet's count is computed against the same query and
 *     filter set EXCEPT that the facet's own filter is removed. So the
 *     supplier-facet count for supplier X is computed without applying
 *     supplier_id, even if the caller passed one. Implementation: build
 *     a base CTE expression and re-issue per-facet COUNTs with the
 *     facet's filter dropped.
 *   - Tenant isolation: `documents_fts.tenant_id UNINDEXED` is included
 *     in every MATCH branch; for the no-MATCH branch the `documents.tenant_id`
 *     filter does the work.
 */

import { buildMatchExprWithLot, DOCUMENTS_FTS_COLS, documentsBm25Expr } from '../../../lib/search-fts';
import type { Env, User } from '../../../lib/types';

type SortMode = 'relevance' | 'newest' | 'oldest' | 'name';

const VALID_SORTS: ReadonlyArray<SortMode> = ['relevance', 'newest', 'oldest', 'name'];

function parseSort(raw: string | null): SortMode {
  if (raw && (VALID_SORTS as readonly string[]).includes(raw)) return raw as SortMode;
  return 'relevance';
}

interface FacetEntry {
  value: string;
  label: string;
  count: number;
}

/**
 * Build a `documents_fts MATCH` SQL fragment + bind args, OR a plain
 * `1 = 1` fragment when there's no query. The caller composes this
 * with the structured filters and the rank/snippet projections.
 */
function buildSearchClause(
  rawQuery: string,
  tenantId: string,
): { matchExpr: string | null; bindArgs: (string | number)[] } {
  // Lot-aware: documents_fts has a lot_text column (migration 0074), so a
  // main-lot term returns all sublot COAs and separators don't matter.
  const expr = buildMatchExprWithLot(rawQuery);
  if (!expr) {
    return { matchExpr: null, bindArgs: [] };
  }
  return { matchExpr: expr, bindArgs: [tenantId, expr] };
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const url = new URL(context.request.url);

    const q = url.searchParams.get('q') ?? '';
    let tenantId = url.searchParams.get('tenant_id');
    const category = url.searchParams.get('category');
    // Multi-category aware filter (migration 0076 document_categories): a
    // doctype id that matches ANY of a doc's category mappings, not just the
    // denormalized primary document_type_id. Enables "show all Allergen docs"
    // across docs mapped to multiple categories.
    const categoryId = url.searchParams.get('category_id');
    const multi = (key: string) => [...new Set(url.searchParams.getAll(key).flatMap((v) => v.split(',')).map((v) => v.trim()).filter(Boolean))].slice(0, 90);
    const supplierIds = multi('supplier_id');
    const documentTypeIds = multi('document_type_id');
    const productIds = multi('product_id');
    const statuses = multi('status').filter((v) => v === 'active' || v === 'archived');
    const dateFrom = url.searchParams.get('date_from');
    const dateTo = url.searchParams.get('date_to');
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200);
    const offset = parseInt(url.searchParams.get('offset') || '0', 10);
    const sort = parseSort(url.searchParams.get('sort'));
    const wantFacets = url.searchParams.get('facets') === '1';

    // Non-admins are pinned to their own tenant regardless of the query.
    if (user.role !== 'super_admin') {
      tenantId = user.tenant_id;
    }

    if (!tenantId) {
      return new Response(
        JSON.stringify({ error: 'tenant_id is required' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      );
    }

    const { matchExpr } = buildSearchClause(q, tenantId);
    const hasMatch = matchExpr !== null;

    // ----------------------------------------------------------------
    // Build the structured-filter predicate (everything that's NOT the
    // FTS MATCH). We collect it as { sql, params } so we can re-use it
    // for both the page query and the facet COUNTs (with one facet
    // removed at a time).
    // ----------------------------------------------------------------
    interface Predicate { sql: string; params: (string | number)[] }
    const filters: Record<string, Predicate> = {};

    filters.tenant = { sql: 'd.tenant_id = ?', params: [tenantId] };
    filters.status = statuses.length
      ? { sql: `d.status IN (${statuses.map(() => '?').join(',')})`, params: statuses }
      : { sql: "d.status = 'active'", params: [] };

    if (category) {
      filters.category = { sql: 'd.category = ?', params: [category] };
    }
    if (documentTypeIds.length) {
      filters.doc_type = { sql: `d.document_type_id IN (${documentTypeIds.map(() => '?').join(',')})`, params: documentTypeIds };
    }
    if (productIds.length) {
      const p = productIds.map(() => '?').join(',');
      filters.product = {
        sql: `(EXISTS (SELECT 1 FROM document_products dpf WHERE dpf.document_id = d.id AND dpf.product_id IN (${p}))
           OR EXISTS (SELECT 1 FROM document_lots dlf JOIN lots lf ON lf.id = dlf.lot_id WHERE dlf.document_id = d.id AND lf.product_id IN (${p})))`,
        params: [...productIds, ...productIds],
      };
    }
    if (dateFrom || dateTo) {
      const parts: string[] = [];
      const params: string[] = [];
      if (dateFrom) { parts.push('d.created_at >= ?'); params.push(dateFrom); }
      if (dateTo) { parts.push('d.created_at <= ?'); params.push(dateTo); }
      filters.date = { sql: parts.join(' AND '), params };
    }
    if (categoryId) {
      // EXISTS against the multi-category junction — matches docs mapped to
      // this category as EITHER their primary or a secondary category.
      filters.category_multi = {
        sql: 'EXISTS (SELECT 1 FROM document_categories dc WHERE dc.document_id = d.id AND dc.document_type_id = ?)',
        params: [categoryId],
      };
    }
    if (supplierIds.length) {
      filters.supplier = { sql: `d.supplier_id IN (${supplierIds.map(() => '?').join(',')})`, params: supplierIds };
    }

    // ----------------------------------------------------------------
    // ORDER BY
    // ----------------------------------------------------------------
    let orderBy: string;
    switch (sort) {
      case 'newest':
        orderBy = 'd.created_at DESC, d.id DESC';
        break;
      case 'oldest':
        orderBy = 'd.created_at ASC, d.id ASC';
        break;
      case 'name':
        orderBy = 'd.title ASC, d.id ASC';
        break;
      case 'relevance':
      default:
        orderBy = hasMatch ? 'm.rank, d.created_at DESC' : 'd.updated_at DESC';
        break;
    }

    // ----------------------------------------------------------------
    // Compose page + count query.
    //
    // With MATCH:
    //   WITH matches AS (SELECT doc_id, bm25() AS rank, snippet() AS snip
    //                    FROM documents_fts
    //                    WHERE tenant_id = ? AND documents_fts MATCH ?)
    //   SELECT d.*, ..., m.rank, m.snip, COUNT(*) OVER () AS total_count
    //   FROM matches m JOIN documents d ON d.id = m.doc_id
    //   <left joins>
    //   WHERE <structured filters minus 'tenant' since FTS handled it>
    //   ORDER BY <orderBy> LIMIT ? OFFSET ?
    //
    // Without MATCH:
    //   SELECT d.*, ..., COUNT(*) OVER () AS total_count
    //   FROM documents d <left joins>
    //   WHERE <structured filters>
    //   ORDER BY <orderBy> LIMIT ? OFFSET ?
    // ----------------------------------------------------------------
    const select: string[] = [
      'd.*',
      'u.name as creator_name',
      't.name as tenant_name',
      'dt.name as document_type_name',
      'dt.slug as document_type_slug',
      's.name as supplier_name',
      'COUNT(*) OVER () AS total_count',
    ];

    const joins: string[] = [
      'LEFT JOIN users u ON d.created_by = u.id',
      'LEFT JOIN tenants t ON d.tenant_id = t.id',
      'LEFT JOIN document_types dt ON d.document_type_id = dt.id',
      'LEFT JOIN suppliers s ON d.supplier_id = s.id',
    ];

    const whereParts: string[] = [];
    const whereParams: (string | number)[] = [];

    // When MATCH is in play, tenant isolation comes from the CTE; the
    // `documents` table side only needs status + category + doc_type +
    // supplier. We KEEP the tenant filter on `d` as well — defense in
    // depth — but it's a no-op join filter.
    for (const k of ['status', 'tenant', 'category', 'category_multi', 'doc_type', 'supplier', 'product', 'date']) {
      const f = filters[k];
      if (!f) continue;
      whereParts.push(f.sql);
      whereParams.push(...f.params);
    }

    let pageSql: string;
    const pageParams: (string | number)[] = [];

    if (hasMatch) {
      select.unshift('m.rank');
      select.unshift(
        `snippet(documents_fts, -1, '<mark>', '</mark>', '…', 12) AS snippet`,
      );
      // Snippet column references — also expose extracted_text and
      // supplier-text snippets for callers that want a deeper breakdown.
      select.push(
        `snippet(documents_fts, ${DOCUMENTS_FTS_COLS.extracted_text}, '<mark>', '</mark>', '…', 12) AS snippet_extracted`,
      );
      select.push(
        `snippet(documents_fts, ${DOCUMENTS_FTS_COLS.supplier_text}, '<mark>', '</mark>', '…', 8) AS snippet_supplier`,
      );

      const ctePredicate = 'f.tenant_id = ? AND documents_fts MATCH ?';
      pageParams.push(tenantId!, matchExpr!);

      pageSql = `
        WITH matches AS (
          SELECT
            f.doc_id,
            ${documentsBm25Expr()} AS rank,
            snippet(documents_fts, -1, '<mark>', '</mark>', '…', 12) AS snippet,
            snippet(documents_fts, ${DOCUMENTS_FTS_COLS.extracted_text}, '<mark>', '</mark>', '…', 12) AS snippet_extracted,
            snippet(documents_fts, ${DOCUMENTS_FTS_COLS.supplier_text}, '<mark>', '</mark>', '…', 8) AS snippet_supplier
          FROM documents_fts f
          WHERE ${ctePredicate}
        )
        SELECT
          m.snippet AS snippet,
          m.snippet_extracted AS snippet_extracted,
          m.snippet_supplier AS snippet_supplier,
          m.rank AS rank,
          d.*,
          u.name as creator_name,
          t.name as tenant_name,
          dt.name as document_type_name,
          dt.slug as document_type_slug,
          dt.name as primary_category_name,
          s.name as supplier_name,
          COALESCE(d.renewal_due_date, json_extract(d.primary_metadata, '$.expiration_date')) AS expiration,
          COUNT(*) OVER () AS total_count
        FROM matches m
        JOIN documents d ON d.id = m.doc_id
        ${joins.join('\n')}
        ${whereParts.length ? 'WHERE ' + whereParts.join(' AND ') : ''}
        ORDER BY ${orderBy}
        LIMIT ? OFFSET ?
      `;
      pageParams.push(...whereParams, limit, offset);
    } else {
      pageSql = `
        SELECT
          d.*,
          u.name as creator_name,
          t.name as tenant_name,
          dt.name as document_type_name,
          dt.slug as document_type_slug,
          dt.name as primary_category_name,
          s.name as supplier_name,
          COALESCE(d.renewal_due_date, json_extract(d.primary_metadata, '$.expiration_date')) AS expiration,
          COUNT(*) OVER () AS total_count
        FROM documents d
        ${joins.join('\n')}
        ${whereParts.length ? 'WHERE ' + whereParts.join(' AND ') : ''}
        ORDER BY ${orderBy}
        LIMIT ? OFFSET ?
      `;
      pageParams.push(...whereParams, limit, offset);
    }

    const pageResult = await context.env.DB.prepare(pageSql)
      .bind(...pageParams)
      .all<Record<string, unknown> & { total_count?: number }>();

    const documents = (pageResult.results ?? []).map((row) => {
      const { total_count: _drop, ...rest } = row;
      return rest;
    });
    const total = pageResult.results && pageResult.results.length > 0
      ? Number(pageResult.results[0].total_count ?? 0)
      : 0;

    // ----------------------------------------------------------------
    // Faceted counts — one query per facet against the same matches CTE
    // (or against `documents` when there's no q), with that facet's own
    // filter excluded so users always see "5 from supplier B" even when
    // they've already pinned supplier A.
    // ----------------------------------------------------------------
    let facets: Record<string, FacetEntry[]> | undefined;

    if (wantFacets) {
      // One batch, one round trip; each facet leaves out only its own filter.
      const kinds: FacetKind[] = ['supplier', 'doc_type', 'product', 'status', 'date_bucket'];
      const ctx: FacetCtx = { matchExpr, tenantId: tenantId!, filters };
      const results = await context.env.DB.batch(
        kinds.map((k) => {
          const f = buildFacet(k, ctx);
          return context.env.DB.prepare(f.sql).bind(...f.params);
        }),
      );
      facets = {};
      kinds.forEach((k, i) => {
        facets![k] = ((results[i]?.results ?? []) as Array<{ value: string | null; label: string | null; count: number }>)
          .filter((r) => r.value !== null)
          .map((r) => ({
            value: String(r.value),
            label: r.label !== null ? String(r.label) : String(r.value),
            count: Number(r.count ?? 0),
          }));
      });
    }

    const responseBody: Record<string, unknown> = {
      documents,
      total,
      limit,
      offset,
    };
    if (facets) responseBody.facets = facets;

    return new Response(JSON.stringify(responseBody), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('Search error:', err);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

// =====================================================================
// Facet helpers — keep these out of the hot-path read so the typecheck
// surface is small and reuse-friendly.
// =====================================================================

type FacetKind = 'supplier' | 'doc_type' | 'product' | 'status' | 'date_bucket';

interface FacetCtx {
  matchExpr: string | null;
  tenantId: string;
  filters: Record<string, { sql: string; params: (string | number)[] }>;
}

function buildFacet(
  kind: FacetKind,
  ctx: FacetCtx,
): { sql: string; params: (string | number)[] } {
  // Pick which filter to drop for the sticky-filter rule.
  const facetOwnFilterKey: Record<FacetKind, string | null> = {
    supplier: 'supplier',
    doc_type: 'doc_type',
    product: 'product',
    status: 'status',
    date_bucket: 'date',
  };
  const dropKey = facetOwnFilterKey[kind];

  const whereParts: string[] = [];
  const whereParams: (string | number)[] = [];
  for (const [k, f] of Object.entries(ctx.filters)) {
    if (k === dropKey) {
      // The status facet counts every searchable status, never 'deleted'.
      if (k === 'status') whereParts.push("d.status IN ('active', 'archived')");
      continue;
    }
    whereParts.push(f.sql);
    whereParams.push(...f.params);
  }

  // Aggregation column + label come from the joined source.
  let groupCol: string;
  let labelCol: string;
  let extraJoins = '';

  switch (kind) {
    case 'supplier':
      groupCol = 's.id';
      labelCol = 's.name';
      // Supplier join already in `joins` below.
      break;
    case 'doc_type':
      groupCol = 'dt.id';
      labelCol = 'dt.name';
      break;
    case 'product':
      groupCol = 'p.id';
      labelCol = 'p.name';
      // A split COA is linked to its product only through its lot row.
      extraJoins = `
        LEFT JOIN (SELECT dp.document_id, dp.product_id FROM document_products dp
                   UNION SELECT dl.document_id, l.product_id FROM document_lots dl JOIN lots l ON l.id = dl.lot_id
                    WHERE l.product_id IS NOT NULL) dpx ON dpx.document_id = d.id
        LEFT JOIN products p ON p.id = dpx.product_id
      `;
      break;
    case 'status':
      groupCol = 'd.status';
      labelCol = 'd.status';
      break;
    case 'date_bucket': {
      // Coarse buckets: today / 7d / 30d / 90d / older
      groupCol = `CASE
        WHEN d.created_at >= datetime('now', '-1 day')   THEN 'last_24h'
        WHEN d.created_at >= datetime('now', '-7 days')  THEN 'last_7d'
        WHEN d.created_at >= datetime('now', '-30 days') THEN 'last_30d'
        WHEN d.created_at >= datetime('now', '-90 days') THEN 'last_90d'
        ELSE 'older'
      END`;
      labelCol = groupCol;
      break;
    }
  }

  const standardJoins = `
    LEFT JOIN document_types dt ON d.document_type_id = dt.id
    LEFT JOIN suppliers s ON d.supplier_id = s.id
  `;

  let sql: string;
  const params: (string | number)[] = [];

  if (ctx.matchExpr) {
    sql = `
      WITH matches AS (
        SELECT f.doc_id
        FROM documents_fts f
        WHERE f.tenant_id = ? AND documents_fts MATCH ?
      )
      SELECT ${groupCol} AS value, ${labelCol} AS label, COUNT(DISTINCT d.id) AS count
      FROM matches m
      JOIN documents d ON d.id = m.doc_id
      ${standardJoins}
      ${extraJoins}
      ${whereParts.length ? 'WHERE ' + whereParts.join(' AND ') : ''}
      GROUP BY ${groupCol}
      HAVING ${groupCol} IS NOT NULL
      ORDER BY count DESC, label ASC
      LIMIT 50
    `;
    params.push(ctx.tenantId, ctx.matchExpr, ...whereParams);
  } else {
    sql = `
      SELECT ${groupCol} AS value, ${labelCol} AS label, COUNT(DISTINCT d.id) AS count
      FROM documents d
      ${standardJoins}
      ${extraJoins}
      ${whereParts.length ? 'WHERE ' + whereParts.join(' AND ') : ''}
      GROUP BY ${groupCol}
      HAVING ${groupCol} IS NOT NULL
      ORDER BY count DESC, label ASC
      LIMIT 50
    `;
    params.push(...whereParams);
  }

  return { sql, params };
}
