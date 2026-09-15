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
 * Coverage (Any-Field COA Retrieval, R7/R9): parsed predicates are
 * CONSTRAINTS judged per document, never filters silently dropped until
 * something comes back. See the block comment in the handler.
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
import { loadCoverageCorpus, runCoverageSearch, unreviewedTextCandidates } from '../../../lib/search-coverage';
import { constraintsFromParsedQuery } from '../../../../shared/searchCoverage';
import type { Env, User } from '../../../lib/types';
import type { NaturalSearchResponse } from '../../../../shared/types';

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
    // Constraints, not filters.
    //
    // The previous handler ANDed each parsed predicate into SQL and, when
    // that returned nothing, DROPPED predicates one at a time (metadata →
    // product → supplier → doc_type → expiration → dates) until something
    // came back — and the response never said which. For "produced
    // 7/31/2026" that meant the date quietly fell away and the nearest
    // Darigold certificate came back looking like the answer (AJ Conner,
    // D6: "a confident wrong answer is worse than a null").
    //
    // Now every parsed predicate is a CONSTRAINT judged per document
    // (shared/searchCoverage.ts). Nothing is loosened: a document that
    // fails one is still listed, labelled with the reason, and a
    // constraint that cannot be applied at all is returned in
    // `dropped_constraints` — which forbids a 'covered' answer.
    // ----------------------------------------------------------------
    const ftsTerms: string[] = [];
    if (parsedQuery.keywords.length > 0) ftsTerms.push(...parsedQuery.keywords);
    if (parsedQuery.content_search) ftsTerms.push(parsedQuery.content_search);
    const poolText = ftsTerms.join(' ').trim();

    const { constraints, dropped } = constraintsFromParsedQuery(parsedQuery, body.query, {
      documentTypes: docTypes,
      today: new Date().toISOString().slice(0, 10),
    });

    if (constraints.length > 0 || dropped.length > 0) {
      const corpus = await loadCoverageCorpus(context.env.DB, tenantId);
      const run = await runCoverageSearch(context.env.DB, tenantId, {
        constraints,
        dropped,
        corpus,
        poolText: poolText || null,
        limit: 50,
        offset: 0,
      });
      const responseBody: NaturalSearchResponse = {
        parsed_query: parsedQuery,
        results: run.rows as unknown as NaturalSearchResponse['results'],
        total: run.total,
        coverage: run.coverage,
        constraints: run.constraints,
        dropped_constraints: run.dropped_constraints,
        coverage_summary: run.coverage_summary,
        covering_count: run.covering_count,
        likely_count: run.likely_count,
        candidate_count: run.candidate_count,
        unreviewed_candidates: run.unreviewed_candidates,
        coverage_scan_truncated: run.coverage_scan_truncated,
      };
      return new Response(JSON.stringify(responseBody), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // ----------------------------------------------------------------
    // Unconstrained: the question named nothing a document must BE, so
    // there is nothing to verify — rank by the keywords (or list recent
    // documents when there are none), exactly as before.
    // ----------------------------------------------------------------
    const matchExpr = poolText ? buildMatchExprWithLot(poolText) : null;
    const EXPIRATION_SELECT =
      "COALESCE(d.renewal_due_date, json_extract(d.primary_metadata, '$.expiration_date')) AS expiration";
    const projection = `
            d.*,
            u.name as creator_name,
            u.email as creator_email,
            t.name as tenant_name,
            dt.name as document_type_name,
            dt.slug as document_type_slug,
            dt.name as primary_category_name,
            s.name as supplier_name,
            ${EXPIRATION_SELECT}`;
    const joins = `
          LEFT JOIN users u ON d.created_by = u.id
          LEFT JOIN tenants t ON d.tenant_id = t.id
          LEFT JOIN document_types dt ON d.document_type_id = dt.id
          LEFT JOIN suppliers s ON d.supplier_id = s.id`;

    let results: Record<string, unknown>[] = [];
    let total = 0;
    if (matchExpr) {
      const page = await context.env.DB.prepare(
        `WITH matches AS (
            SELECT
              f.doc_id,
              ${documentsBm25Expr()} AS rank,
              snippet(documents_fts, -1, '<mark>', '</mark>', '…', 12) AS snippet,
              snippet(documents_fts, ${DOCUMENTS_FTS_COLS.extracted_text}, '<mark>', '</mark>', '…', 12) AS snippet_extracted,
              snippet(documents_fts, ${DOCUMENTS_FTS_COLS.supplier_text}, '<mark>', '</mark>', '…', 8) AS snippet_supplier
            FROM documents_fts f
            WHERE f.tenant_id = ? AND documents_fts MATCH ?
          )
          SELECT ${projection},
            m.rank AS rank,
            m.snippet AS snippet,
            m.snippet_extracted AS snippet_extracted,
            m.snippet_supplier AS snippet_supplier
          FROM matches m
          JOIN documents d ON d.id = m.doc_id
          ${joins}
          WHERE d.status = 'active' AND d.tenant_id = ?
          ORDER BY m.rank, d.updated_at DESC
          LIMIT 50`,
      )
        .bind(tenantId, matchExpr, tenantId)
        .all<Record<string, unknown>>();
      results = page.results ?? [];
      const count = await context.env.DB.prepare(
        `WITH matches AS (
            SELECT f.doc_id FROM documents_fts f
            WHERE f.tenant_id = ? AND documents_fts MATCH ?
          )
          SELECT COUNT(DISTINCT d.id) AS total
          FROM matches m JOIN documents d ON d.id = m.doc_id
          WHERE d.status = 'active' AND d.tenant_id = ?`,
      )
        .bind(tenantId, matchExpr, tenantId)
        .first<{ total: number }>();
      total = count?.total ?? 0;
    } else {
      const page = await context.env.DB.prepare(
        `SELECT ${projection}
          FROM documents d
          ${joins}
          WHERE d.status = 'active' AND d.tenant_id = ?
          ORDER BY d.updated_at DESC
          LIMIT 50`,
      )
        .bind(tenantId)
        .all<Record<string, unknown>>();
      results = page.results ?? [];
      const count = await context.env.DB.prepare(
        `SELECT COUNT(*) AS total FROM documents d WHERE d.status = 'active' AND d.tenant_id = ?`,
      )
        .bind(tenantId)
        .first<{ total: number }>();
      total = count?.total ?? 0;
    }

    const responseBody: NaturalSearchResponse = {
      parsed_query: parsedQuery,
      results: results as unknown as NaturalSearchResponse['results'],
      total,
      coverage: 'unconstrained',
      constraints: [],
      dropped_constraints: [],
      coverage_summary: null,
      unreviewed_candidates: poolText
        ? await unreviewedTextCandidates(context.env.DB, tenantId, poolText)
        : [],
    };
    return new Response(JSON.stringify(responseBody), {
      headers: { 'Content-Type': 'application/json' },
    });
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
