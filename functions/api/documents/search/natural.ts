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
import { buildMatchExprWithLot, DOCUMENTS_FTS_COLS, documentsBm25Expr } from '../../../lib/search-fts';
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
    // combine via FTS5's default AND semantics. Lot-aware
    // (buildMatchExprWithLot) so a lot/identifier survives separator
    // differences and prefix-matches the linked-lot column — same as the
    // instant search endpoint.
    // ----------------------------------------------------------------
    const ftsTerms: string[] = [];
    if (parsedQuery.keywords.length > 0) {
      ftsTerms.push(...parsedQuery.keywords);
    }
    if (parsedQuery.content_search) {
      ftsTerms.push(parsedQuery.content_search);
    }
    const matchExpr = ftsTerms.length > 0 ? buildMatchExprWithLot(ftsTerms.join(' ')) : null;

    // ----------------------------------------------------------------
    // SOFT structured filters + loosen-and-retry.
    //
    // The old handler hard-ANDed every parsed predicate onto the FTS
    // MATCH. When the LLM over-parsed (e.g. a doc_type slug that didn't
    // apply, a supplier the doc wasn't linked to), the combined query
    // collapsed to ZERO rows — the single worst outcome for a
    // non-technical user asking once. Now each structured predicate is an
    // OPTIONAL group that we DROP, one at a time, when the fully
    // constrained query returns nothing:
    //
    //   drop order (front dropped first): metadata → product → supplier
    //                                     → doc_type → expiration → dates
    //
    // Two ladders run in sequence, stopping at the first that yields rows:
    //   1. MATCH ladder     — keywords in FTS5 MATCH + structured groups,
    //                         loosened until non-empty (ending at pure
    //                         keyword match).
    //   2. structured-only  — drop the MATCH entirely and rank by the
    //                         structured predicates. This rescues
    //                         "which docs expire before 2026"-style asks
    //                         where the LLM's leftover keywords match no
    //                         FTS token but the expiration filter is the
    //                         real intent. Only runs when there is at
    //                         least one structured group (so a genuinely
    //                         unmatched keyword search still returns 0
    //                         rather than dumping the whole corpus).
    // Tenant isolation + status='active' are ALWAYS kept.
    // ----------------------------------------------------------------
    interface Group {
      key: string;
      conds: string[];
      params: (string | number)[];
      needProductJoin?: boolean;
      needSupplierAliasJoin?: boolean;
    }
    const groups: Record<string, Group> = {};

    if (parsedQuery.document_type_slug) {
      groups.doc_type = {
        key: 'doc_type',
        conds: ['dt.slug = ?'],
        params: [parsedQuery.document_type_slug],
      };
    }

    if (parsedQuery.product_names.length > 0) {
      const productConditions = parsedQuery.product_names.map(
        () => 'LOWER(p.name) LIKE LOWER(?)',
      );
      groups.product = {
        key: 'product',
        conds: [`(${productConditions.join(' OR ')})`],
        params: parsedQuery.product_names.map((pn) => `%${pn}%`),
        needProductJoin: true,
      };
    }

    if (parsedQuery.date_from || parsedQuery.date_to) {
      const dateConds: string[] = [];
      const dateParams: (string | number)[] = [];
      if (parsedQuery.date_from) {
        dateConds.push('d.created_at >= ?');
        dateParams.push(parsedQuery.date_from);
      }
      if (parsedQuery.date_to) {
        dateConds.push('d.created_at <= ?');
        dateParams.push(parsedQuery.date_to + 'T23:59:59');
      }
      groups.dates = { key: 'dates', conds: dateConds, params: dateParams };
    }

    if (parsedQuery.supplier_name) {
      groups.supplier = {
        key: 'supplier',
        conds: ['(LOWER(sup.name) LIKE LOWER(?) OR sup.aliases LIKE ?)'],
        params: [`%${parsedQuery.supplier_name}%`, `%${parsedQuery.supplier_name}%`],
        needSupplierAliasJoin: true,
      };
    }

    if (parsedQuery.metadata_filters && parsedQuery.metadata_filters.length > 0) {
      const metaConds: string[] = [];
      const metaParams: (string | number)[] = [];
      for (const filter of parsedQuery.metadata_filters) {
        const field = filter.field.replace(/[^a-z0-9_]/g, ''); // sanitize
        switch (filter.operator) {
          case 'equals':
            metaConds.push(
              `(json_extract(d.primary_metadata, '$.${field}') = ? OR json_extract(d.extended_metadata, '$.${field}') = ?)`,
            );
            metaParams.push(filter.value, filter.value);
            break;
          case 'contains':
            metaConds.push(
              `(json_extract(d.primary_metadata, '$.${field}') LIKE ? OR json_extract(d.extended_metadata, '$.${field}') LIKE ?)`,
            );
            metaParams.push(`%${filter.value}%`, `%${filter.value}%`);
            break;
          case 'gt':
            metaConds.push(`json_extract(d.primary_metadata, '$.${field}') > ?`);
            metaParams.push(filter.value);
            break;
          case 'lt':
            metaConds.push(`json_extract(d.primary_metadata, '$.${field}') < ?`);
            metaParams.push(filter.value);
            break;
        }
      }
      if (metaConds.length > 0) {
        groups.metadata = { key: 'metadata', conds: metaConds, params: metaParams };
      }
    }

    if (parsedQuery.expiration_filter) {
      const ef = parsedQuery.expiration_filter;
      const expConds: string[] = [];
      const expParams: (string | number)[] = [];
      switch (ef.operator) {
        case 'before':
          expConds.push(
            `(json_extract(d.primary_metadata, '$.expiration_date') <= ? OR d.renewal_due_date <= ? OR dp.expires_at <= ?)`,
          );
          expParams.push(ef.date1, ef.date1, ef.date1);
          expConds.push(
            `(json_extract(d.primary_metadata, '$.expiration_date') >= date('now') OR d.renewal_due_date >= date('now') OR dp.expires_at >= date('now'))`,
          );
          break;
        case 'after':
          expConds.push(
            `(json_extract(d.primary_metadata, '$.expiration_date') >= ? OR d.renewal_due_date >= ? OR dp.expires_at >= ?)`,
          );
          expParams.push(ef.date1, ef.date1, ef.date1);
          break;
        case 'between':
          expConds.push(
            `(json_extract(d.primary_metadata, '$.expiration_date') BETWEEN ? AND ? OR d.renewal_due_date BETWEEN ? AND ? OR dp.expires_at BETWEEN ? AND ?)`,
          );
          expParams.push(ef.date1, ef.date2!, ef.date1, ef.date2!, ef.date1, ef.date2!);
          break;
      }
      if (expConds.length > 0) {
        groups.expiration = {
          key: 'expiration',
          conds: expConds,
          params: expParams,
          needProductJoin: true, // dp.expires_at lives on the join
        };
      }
    }

    // Priority order for DROPPING groups (front dropped first).
    const DROP_ORDER = ['metadata', 'product', 'supplier', 'doc_type', 'expiration', 'dates'];
    const presentKeys = DROP_ORDER.filter((k) => groups[k]);
    const hasStructured = presentKeys.length > 0;

    // Shared projection — expiration + current version + primary category
    // ride along inline so a result reads "Letter of Guarantee, v2, expires
    // 2027-03-24" without a second lookup. current_version / renewal_type /
    // renewal_due_date come from d.*.
    const EXPIRATION_SELECT =
      "COALESCE(d.renewal_due_date, json_extract(d.primary_metadata, '$.expiration_date')) AS expiration";

    // Compose a page + count query for a given ladder (useMatch) and the
    // set of still-active structured group keys.
    function compose(useMatch: boolean, activeKeys: string[]) {
      const conditions: string[] = ["d.status = 'active'", 'd.tenant_id = ?'];
      const condParams: (string | number)[] = [tenantId!];
      let needProductJoin = false;
      let needSupplierAliasJoin = false;

      for (const k of activeKeys) {
        const g = groups[k];
        if (!g) continue;
        conditions.push(...g.conds);
        condParams.push(...g.params);
        if (g.needProductJoin) needProductJoin = true;
        if (g.needSupplierAliasJoin) needSupplierAliasJoin = true;
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
        joins += `
        LEFT JOIN suppliers sup ON d.supplier_id = sup.id`;
      }

      const whereClause = `WHERE ${conditions.join(' AND ')}`;

      let pageSql: string;
      const pageParams: (string | number)[] = [];
      let countSql: string;
      const countParams: (string | number)[] = [];

      if (useMatch) {
        pageSql = `
          WITH matches AS (
            SELECT
              f.doc_id,
              ${documentsBm25Expr()} AS rank,
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
            dt.name as primary_category_name,
            s.name as supplier_name,
            ${EXPIRATION_SELECT},
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
        pageParams.push(tenantId!, matchExpr!, ...condParams);

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
        countParams.push(tenantId!, matchExpr!, ...condParams);
      } else {
        pageSql = `
          SELECT DISTINCT
            d.*,
            u.name as creator_name,
            u.email as creator_email,
            t.name as tenant_name,
            dt.name as document_type_name,
            dt.slug as document_type_slug,
            dt.name as primary_category_name,
            s.name as supplier_name,
            ${EXPIRATION_SELECT}
          FROM documents d
          ${joins}
          ${whereClause}
          ORDER BY d.updated_at DESC
          LIMIT 50
        `;
        pageParams.push(...condParams);

        countSql = `
          SELECT COUNT(DISTINCT d.id) AS total
          FROM documents d
          ${joins}
          ${whereClause}
        `;
        countParams.push(...condParams);
      }

      return { pageSql, pageParams, countSql, countParams };
    }

    // Build the ordered list of attempts (each a { useMatch, activeKeys }).
    // MATCH ladder loosens down to zero groups (pure keyword). The
    // structured-only ladder keeps at least one group when a MATCH existed
    // (so we never dump the whole corpus for an unmatched keyword search),
    // and may loosen to zero only when there were no keywords at all.
    const attempts: Array<{ useMatch: boolean; activeKeys: string[] }> = [];
    if (matchExpr) {
      for (let drop = 0; drop <= presentKeys.length; drop++) {
        attempts.push({ useMatch: true, activeKeys: presentKeys.slice(drop) });
      }
    }
    if (!matchExpr || hasStructured) {
      const minKeep = matchExpr ? 1 : 0; // keep ≥1 group as a structured anchor when keywords existed
      for (let drop = 0; drop <= presentKeys.length - minKeep; drop++) {
        attempts.push({ useMatch: false, activeKeys: presentKeys.slice(drop) });
      }
    }

    // Execute attempts in order; stop at the first that yields rows, or fall
    // through to the last attempt's (possibly empty) result.
    let results: D1Result<Record<string, unknown>> | null = null;
    let winning = attempts[attempts.length - 1];
    for (let i = 0; i < attempts.length; i++) {
      const a = attempts[i];
      const { pageSql, pageParams } = compose(a.useMatch, a.activeKeys);
      const r = await context.env.DB.prepare(pageSql)
        .bind(...pageParams)
        .all<Record<string, unknown>>();
      results = r;
      winning = a;
      if ((r.results?.length ?? 0) > 0) break;
    }

    // Count matches the winning attempt so total is consistent with the page.
    const { countSql, countParams } = compose(winning.useMatch, winning.activeKeys);
    const countResult = await context.env.DB.prepare(countSql)
      .bind(...countParams)
      .first<{ total: number }>();

    return new Response(
      JSON.stringify({
        parsed_query: parsedQuery,
        results: results?.results || [],
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
