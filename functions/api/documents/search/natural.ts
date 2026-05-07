/**
 * POST /api/documents/search/natural — FTS5 backed (Phase 4b of the
 * Document Search v2 plan).
 *
 * Plan ref: `/home/hexi/.claude/plans/peppy-coalescing-platypus.md` § 1.6.
 *
 * Keeps the LLM-parsed structured query path. The LLM expands a natural
 * sentence into a `ParsedQuery` (keywords, doc_type slug, supplier name,
 * product names, dates, metadata filters, content_search, expiration
 * filter). Phase 4b swaps the SQL build for those keywords +
 * content_search to FTS5 `documents_fts MATCH`, while structured filters
 * stay as AND predicates on the joined documents table.
 *
 * Snippets come from FTS5 `snippet()` with `<mark>` tags — replaces the
 * previous hand-rolled `generateSnippets()`.
 *
 * LLM failures degrade gracefully: a thrown error from
 * `parseNaturalQuery` is mapped to a 503 with a user-facing fallback
 * message ("try the regular search"). This preserves the prior
 * behavior — the only change here is that the SQL after parsing is
 * different.
 */

import {
  requireRole,
  requireTenantAccess,
  BadRequestError,
  errorToResponse,
} from '../../../lib/permissions';
import { parseNaturalQuery } from '../../../lib/llm';
import { buildMatchExpr, DOCUMENTS_FTS_COLS } from '../../../lib/search-fts';
import type { Env, User } from '../../../lib/types';

export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireRole(user, 'super_admin', 'org_admin', 'user', 'reader');

    const body = (await context.request.json()) as {
      query?: string;
      tenant_id?: string;
    };

    if (!body.query || !body.query.trim()) {
      throw new BadRequestError('query is required');
    }

    // Determine tenant
    let tenantId = body.tenant_id || null;
    if (user.role !== 'super_admin') {
      tenantId = user.tenant_id;
    }

    if (!tenantId) {
      throw new BadRequestError('tenant_id is required');
    }

    requireTenantAccess(user, tenantId);

    // Fetch tenant context for the LLM prompt — same as before.
    const docTypesResult = await context.env.DB.prepare(
      'SELECT slug, name FROM document_types WHERE tenant_id = ? AND active = 1',
    )
      .bind(tenantId)
      .all<{ slug: string; name: string }>();
    const docTypes = docTypesResult.results || [];

    const productsResult = await context.env.DB.prepare(
      'SELECT DISTINCT name FROM products WHERE tenant_id = ? AND active = 1',
    )
      .bind(tenantId)
      .all<{ name: string }>();
    const products = productsResult.results || [];

    const suppliersResult = await context.env.DB.prepare(
      'SELECT DISTINCT name FROM suppliers WHERE tenant_id = ? AND active = 1',
    )
      .bind(tenantId)
      .all<{ name: string }>();
    const suppliers = suppliersResult.results || [];

    // Parse natural language query via LLM — preserved from prior impl.
    let parsedQuery;
    try {
      parsedQuery = await parseNaturalQuery(body.query, docTypes, products, suppliers, context.env);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'LLM unavailable';
      return new Response(
        JSON.stringify({
          error: `Natural language parsing failed: ${message}. Try using the regular search instead.`,
        }),
        { status: 503, headers: { 'Content-Type': 'application/json' } },
      );
    }

    // ----------------------------------------------------------------
    // Build the FTS5 MATCH expression from parsed.keywords +
    // parsed.content_search. Both feed the same MATCH clause so they
    // combine via FTS5's default AND semantics.
    // ----------------------------------------------------------------
    const ftsTerms: string[] = [];
    if (parsedQuery.keywords.length > 0) {
      ftsTerms.push(...parsedQuery.keywords);
    }
    if (parsedQuery.content_search) {
      ftsTerms.push(parsedQuery.content_search);
    }
    const matchExpr = ftsTerms.length > 0 ? buildMatchExpr(ftsTerms.join(' ')) : null;

    // ----------------------------------------------------------------
    // Compose structured filter predicates on the joined `documents`
    // table. These are AND-ed with the MATCH-narrowed result set.
    // ----------------------------------------------------------------
    const conditions: string[] = ["d.status = 'active'", 'd.tenant_id = ?'];
    const params: (string | number)[] = [tenantId];

    let needProductJoin = false;
    let needSupplierAliasJoin = false;

    if (parsedQuery.document_type_slug) {
      conditions.push('dt.slug = ?');
      params.push(parsedQuery.document_type_slug);
    }

    if (parsedQuery.product_names.length > 0) {
      const productConditions = parsedQuery.product_names.map(
        () => 'LOWER(p.name) LIKE LOWER(?)',
      );
      conditions.push(`(${productConditions.join(' OR ')})`);
      for (const pn of parsedQuery.product_names) {
        params.push(`%${pn}%`);
      }
      needProductJoin = true;
    }

    if (parsedQuery.date_from) {
      conditions.push('d.created_at >= ?');
      params.push(parsedQuery.date_from);
    }
    if (parsedQuery.date_to) {
      conditions.push('d.created_at <= ?');
      params.push(parsedQuery.date_to + 'T23:59:59');
    }

    if (parsedQuery.supplier_name) {
      conditions.push('(LOWER(sup.name) LIKE LOWER(?) OR sup.aliases LIKE ?)');
      params.push(`%${parsedQuery.supplier_name}%`, `%${parsedQuery.supplier_name}%`);
      needSupplierAliasJoin = true;
    }

    if (parsedQuery.metadata_filters && parsedQuery.metadata_filters.length > 0) {
      for (const filter of parsedQuery.metadata_filters) {
        const field = filter.field.replace(/[^a-z0-9_]/g, ''); // sanitize
        switch (filter.operator) {
          case 'equals':
            conditions.push(
              `(json_extract(d.primary_metadata, '$.${field}') = ? OR json_extract(d.extended_metadata, '$.${field}') = ?)`,
            );
            params.push(filter.value, filter.value);
            break;
          case 'contains':
            conditions.push(
              `(json_extract(d.primary_metadata, '$.${field}') LIKE ? OR json_extract(d.extended_metadata, '$.${field}') LIKE ?)`,
            );
            params.push(`%${filter.value}%`, `%${filter.value}%`);
            break;
          case 'gt':
            conditions.push(`json_extract(d.primary_metadata, '$.${field}') > ?`);
            params.push(filter.value);
            break;
          case 'lt':
            conditions.push(`json_extract(d.primary_metadata, '$.${field}') < ?`);
            params.push(filter.value);
            break;
        }
      }
    }

    if (parsedQuery.expiration_filter) {
      const ef = parsedQuery.expiration_filter;
      needProductJoin = true; // dp.expires_at lives on the join

      switch (ef.operator) {
        case 'before':
          conditions.push(
            `(json_extract(d.primary_metadata, '$.expiration_date') <= ? OR dp.expires_at <= ?)`,
          );
          params.push(ef.date1, ef.date1);
          conditions.push(
            `(json_extract(d.primary_metadata, '$.expiration_date') >= date('now') OR dp.expires_at >= date('now'))`,
          );
          break;
        case 'after':
          conditions.push(
            `(json_extract(d.primary_metadata, '$.expiration_date') >= ? OR dp.expires_at >= ?)`,
          );
          params.push(ef.date1, ef.date1);
          break;
        case 'between':
          conditions.push(
            `(json_extract(d.primary_metadata, '$.expiration_date') BETWEEN ? AND ? OR dp.expires_at BETWEEN ? AND ?)`,
          );
          params.push(ef.date1, ef.date2!, ef.date1, ef.date2!);
          break;
      }
    }

    let joins = `
      LEFT JOIN users u ON d.created_by = u.id
      LEFT JOIN tenants t ON d.tenant_id = t.id
      LEFT JOIN document_types dt ON d.document_type_id = dt.id
      LEFT JOIN suppliers s ON d.supplier_id = s.id`;

    if (needProductJoin) {
      joins += `
      LEFT JOIN document_products dp ON dp.document_id = d.id
      LEFT JOIN products p ON dp.product_id = p.id`;
    }

    if (needSupplierAliasJoin) {
      // Re-aliased supplier join so the `sup.aliases` predicate doesn't
      // collide with the `s.*` projection below. (Both join through
      // d.supplier_id; the duplicate is harmless and matches the prior
      // behavior.)
      joins += `
      LEFT JOIN suppliers sup ON d.supplier_id = sup.id`;
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;

    // ----------------------------------------------------------------
    // Compose page query. Two branches:
    //
    //   A. With MATCH: WITH matches AS (FTS5 scan) SELECT ... JOIN
    //      Snippets come from `snippet()` with <mark> wrapping.
    //
    //   B. Without MATCH: structured-filters-only branch. No FTS scan
    //      because the LLM produced no keywords / content_search.
    // ----------------------------------------------------------------
    let pageSql: string;
    const pageParams: (string | number)[] = [];

    if (matchExpr) {
      pageSql = `
        WITH matches AS (
          SELECT
            f.doc_id,
            bm25(documents_fts) AS rank,
            snippet(documents_fts, -1, '<mark>', '</mark>', '…', 12) AS snippet,
            snippet(documents_fts, ${DOCUMENTS_FTS_COLS.extracted_text}, '<mark>', '</mark>', '…', 12) AS snippet_extracted,
            snippet(documents_fts, ${DOCUMENTS_FTS_COLS.supplier_text}, '<mark>', '</mark>', '…', 8) AS snippet_supplier
          FROM documents_fts f
          WHERE f.tenant_id = ? AND documents_fts MATCH ?
        )
        SELECT DISTINCT
          d.*,
          u.name as creator_name,
          u.email as creator_email,
          t.name as tenant_name,
          dt.name as document_type_name,
          dt.slug as document_type_slug,
          s.name as supplier_name,
          m.rank AS rank,
          m.snippet AS snippet,
          m.snippet_extracted AS snippet_extracted,
          m.snippet_supplier AS snippet_supplier
        FROM matches m
        JOIN documents d ON d.id = m.doc_id
        ${joins}
        ${whereClause}
        ORDER BY m.rank, d.updated_at DESC
        LIMIT 50
      `;
      pageParams.push(tenantId, matchExpr, ...params);
    } else {
      pageSql = `
        SELECT DISTINCT
          d.*,
          u.name as creator_name,
          u.email as creator_email,
          t.name as tenant_name,
          dt.name as document_type_name,
          dt.slug as document_type_slug,
          s.name as supplier_name
        FROM documents d
        ${joins}
        ${whereClause}
        ORDER BY d.updated_at DESC
        LIMIT 50
      `;
      pageParams.push(...params);
    }

    // Count query mirrors the same WHERE shape (without the snippet
    // overhead) so total_count stays consistent with the page.
    let countSql: string;
    const countParams: (string | number)[] = [];

    if (matchExpr) {
      countSql = `
        WITH matches AS (
          SELECT f.doc_id
          FROM documents_fts f
          WHERE f.tenant_id = ? AND documents_fts MATCH ?
        )
        SELECT COUNT(DISTINCT d.id) AS total
        FROM matches m
        JOIN documents d ON d.id = m.doc_id
        ${joins}
        ${whereClause}
      `;
      countParams.push(tenantId, matchExpr, ...params);
    } else {
      countSql = `
        SELECT COUNT(DISTINCT d.id) AS total
        FROM documents d
        ${joins}
        ${whereClause}
      `;
      countParams.push(...params);
    }

    const countResult = await context.env.DB.prepare(countSql)
      .bind(...countParams)
      .first<{ total: number }>();

    const results = await context.env.DB.prepare(pageSql)
      .bind(...pageParams)
      .all();

    return new Response(
      JSON.stringify({
        parsed_query: parsedQuery,
        results: results.results || [],
        total: countResult?.total || 0,
      }),
      { headers: { 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;

    console.error('Natural search error:', err);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
