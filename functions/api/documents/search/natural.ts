import {
  requireRole,
  requireTenantAccess,
  BadRequestError,
  errorToResponse,
} from '../../../lib/permissions';
import { parseNaturalQuery } from '../../../lib/llm';
import type { Env, User } from '../../../lib/types';

function generateSnippets(
  doc: any,
  parsedQuery: any,
  maxSnippets: number = 3
): { field: string; snippet: string }[] {
  const snippets: { field: string; snippet: string }[] = [];
  const allTerms = [
    ...parsedQuery.keywords,
    ...(parsedQuery.content_search ? [parsedQuery.content_search] : []),
    ...(parsedQuery.metadata_filters || []).map((f: any) => f.value),
  ].filter(Boolean);

  if (allTerms.length === 0) return snippets;

  const searchIn = [
    { field: 'title', text: doc.title || '' },
    { field: 'primary_metadata', text: doc.primary_metadata || '' },
    { field: 'supplier_name', text: doc.supplier_name || '' },
  ];

  for (const { field, text } of searchIn) {
    if (snippets.length >= maxSnippets) break;
    for (const term of allTerms) {
      const idx = text.toLowerCase().indexOf(term.toLowerCase());
      if (idx >= 0) {
        const start = Math.max(0, idx - 60);
        const end = Math.min(text.length, idx + term.length + 60);
        let snippet = text.substring(start, end);
        if (start > 0) snippet = '...' + snippet;
        if (end < text.length) snippet = snippet + '...';
        snippets.push({ field, snippet });
        break;
      }
    }
  }

  return snippets;
}

/**
 * POST /api/documents/search/natural
 * Natural language document search powered by Qwen LLM.
 */
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

    // Fetch document types for this tenant
    const docTypesResult = await context.env.DB.prepare(
      'SELECT slug, name FROM document_types WHERE tenant_id = ? AND active = 1'
    )
      .bind(tenantId)
      .all<{ slug: string; name: string }>();

    const docTypes = docTypesResult.results || [];

    // Fetch products for this tenant
    const productsResult = await context.env.DB.prepare(
      `SELECT DISTINCT name FROM products WHERE tenant_id = ? AND active = 1`
    )
      .bind(tenantId)
      .all<{ name: string }>();

    const products = productsResult.results || [];

    // Fetch suppliers for this tenant
    const suppliersResult = await context.env.DB.prepare(
      'SELECT DISTINCT name FROM suppliers WHERE tenant_id = ? AND active = 1'
    )
      .bind(tenantId)
      .all<{ name: string }>();

    const suppliers = suppliersResult.results || [];

    // Parse natural language query via LLM
    let parsedQuery;
    try {
      parsedQuery = await parseNaturalQuery(body.query, docTypes, products, suppliers, context.env);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'LLM unavailable';
      return new Response(
        JSON.stringify({
          error: `Natural language parsing failed: ${message}. Try using the regular search instead.`,
        }),
        { status: 503, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Build SQL query from parsed result
    const conditions: string[] = ["d.status = 'active'", 'd.tenant_id = ?'];
    const params: (string | number)[] = [tenantId];

    // Track which joins we need
    let needProductJoin = false;
    let needSupplierJoin = false;
    let needDocTypeJoin = false;
    const needVersionJoin = true; // always need for extracted_text

    // Keywords: LIKE on title, description, tags, extracted_text, metadata
    if (parsedQuery.keywords.length > 0) {
      const keywordConditions = parsedQuery.keywords.map(
        () =>
          '(d.title LIKE ? OR d.description LIKE ? OR d.tags LIKE ? OR dv.extracted_text LIKE ? OR d.primary_metadata LIKE ? OR d.extended_metadata LIKE ?)'
      );
      conditions.push(`(${keywordConditions.join(' AND ')})`);
      for (const kw of parsedQuery.keywords) {
        const term = `%${kw}%`;
        params.push(term, term, term, term, term, term);
      }
    }

    // Document type filter
    if (parsedQuery.document_type_slug) {
      conditions.push('dt.slug = ?');
      params.push(parsedQuery.document_type_slug);
      needDocTypeJoin = true;
    }

    // Product filter (array, fuzzy LIKE matching)
    if (parsedQuery.product_names.length > 0) {
      const productConditions = parsedQuery.product_names.map(() => 'LOWER(p.name) LIKE LOWER(?)');
      conditions.push(`(${productConditions.join(' OR ')})`);
      for (const pn of parsedQuery.product_names) {
        params.push(`%${pn}%`);
      }
      needProductJoin = true;
    }

    // Date range
    if (parsedQuery.date_from) {
      conditions.push('d.created_at >= ?');
      params.push(parsedQuery.date_from);
    }
    if (parsedQuery.date_to) {
      conditions.push('d.created_at <= ?');
      params.push(parsedQuery.date_to + 'T23:59:59');
    }

    // Supplier filter (fuzzy LIKE)
    if (parsedQuery.supplier_name) {
      conditions.push('(LOWER(sup.name) LIKE LOWER(?) OR sup.aliases LIKE ?)');
      params.push(`%${parsedQuery.supplier_name}%`, `%${parsedQuery.supplier_name}%`);
      needSupplierJoin = true;
    }

    // Structured metadata filters via json_extract
    if (parsedQuery.metadata_filters && parsedQuery.metadata_filters.length > 0) {
      for (const filter of parsedQuery.metadata_filters) {
        const field = filter.field.replace(/[^a-z0-9_]/g, ''); // sanitize field name
        switch (filter.operator) {
          case 'equals':
            conditions.push(
              `(json_extract(d.primary_metadata, '$.${field}') = ? OR json_extract(d.extended_metadata, '$.${field}') = ?)`
            );
            params.push(filter.value, filter.value);
            break;
          case 'contains':
            conditions.push(
              `(json_extract(d.primary_metadata, '$.${field}') LIKE ? OR json_extract(d.extended_metadata, '$.${field}') LIKE ?)`
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

    // Expiration filter
    if (parsedQuery.expiration_filter) {
      const ef = parsedQuery.expiration_filter;
      needProductJoin = true; // need dp join for expires_at

      switch (ef.operator) {
        case 'before':
          conditions.push(
            `(json_extract(d.primary_metadata, '$.expiration_date') <= ? OR dp.expires_at <= ?)`
          );
          params.push(ef.date1, ef.date1);
          conditions.push(
            `(json_extract(d.primary_metadata, '$.expiration_date') >= date('now') OR dp.expires_at >= date('now'))`
          );
          break;
        case 'after':
          conditions.push(
            `(json_extract(d.primary_metadata, '$.expiration_date') >= ? OR dp.expires_at >= ?)`
          );
          params.push(ef.date1, ef.date1);
          break;
        case 'between':
          conditions.push(
            `(json_extract(d.primary_metadata, '$.expiration_date') BETWEEN ? AND ? OR dp.expires_at BETWEEN ? AND ?)`
          );
          params.push(ef.date1, ef.date2!, ef.date1, ef.date2!);
          break;
      }
    }

    // Content search (free-text in extracted_text and source_metadata)
    if (parsedQuery.content_search) {
      conditions.push('(dv.extracted_text LIKE ? OR d.source_metadata LIKE ?)');
      const term = `%${parsedQuery.content_search}%`;
      params.push(term, term);
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;

    // Build JOINs
    let joins = `
      LEFT JOIN users u ON d.created_by = u.id
      LEFT JOIN tenants t ON d.tenant_id = t.id
      LEFT JOIN document_types dt ON d.document_type_id = dt.id
      LEFT JOIN suppliers s ON d.supplier_id = s.id`;

    if (needVersionJoin) {
      joins += `
      LEFT JOIN document_versions dv ON dv.document_id = d.id AND dv.version_number = d.current_version`;
    }

    if (needProductJoin) {
      joins += `
      LEFT JOIN document_products dp ON dp.document_id = d.id
      LEFT JOIN products p ON dp.product_id = p.id`;
    }

    if (needSupplierJoin) {
      joins += `
      LEFT JOIN suppliers sup ON d.supplier_id = sup.id`;
    }

    // Build relevance scoring components
    const scoreComponents: string[] = [];
    if (parsedQuery.document_type_slug) {
      scoreComponents.push(
        "(CASE WHEN dt.slug = '" +
          parsedQuery.document_type_slug.replace(/'/g, "''") +
          "' THEN 10 ELSE 0 END)"
      );
    }
    if (parsedQuery.supplier_name) {
      scoreComponents.push('(CASE WHEN sup.name IS NOT NULL THEN 8 ELSE 0 END)');
    }
    if (parsedQuery.product_names.length > 0) {
      scoreComponents.push('(CASE WHEN p.name IS NOT NULL THEN 6 ELSE 0 END)');
    }
    if (parsedQuery.metadata_filters.length > 0) {
      scoreComponents.push('15');
    }
    // Default base score
    scoreComponents.push('1');

    const relevanceScore = scoreComponents.join(' + ');

    // Count total
    const countResult = await context.env.DB.prepare(
      `SELECT COUNT(DISTINCT d.id) as total FROM documents d ${joins} ${whereClause}`
    )
      .bind(...params)
      .first<{ total: number }>();

    // Fetch results with relevance scoring
    const results = await context.env.DB.prepare(
      `SELECT DISTINCT d.*, u.name as creator_name, u.email as creator_email, t.name as tenant_name,
              dt.name as document_type_name, dt.slug as document_type_slug,
              s.name as supplier_name,
              (${relevanceScore}) as relevance_score
       FROM documents d
       ${joins}
       ${whereClause}
       ORDER BY relevance_score DESC, d.updated_at DESC
       LIMIT 50`
    )
      .bind(...params)
      .all();

    // Add match context to results
    const enrichedResults = (results.results || []).map((doc: any) => ({
      ...doc,
      match_context: generateSnippets(doc, parsedQuery),
    }));

    return new Response(
      JSON.stringify({
        parsed_query: parsedQuery,
        results: enrichedResults,
        total: countResult?.total || 0,
      }),
      { headers: { 'Content-Type': 'application/json' } }
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
