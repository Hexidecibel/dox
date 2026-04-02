import {
  requireRole,
  requireTenantAccess,
  BadRequestError,
  errorToResponse,
} from '../../../lib/permissions';
import { parseNaturalQuery } from '../../../lib/llm';
import type { Env, User } from '../../../lib/types';

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

    // Parse natural language query via LLM
    let parsedQuery;
    try {
      parsedQuery = await parseNaturalQuery(body.query, docTypes, products, context.env);
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

    // Keywords: LIKE on title, description, tags, extracted_text
    if (parsedQuery.keywords.length > 0) {
      const keywordConditions = parsedQuery.keywords.map(() =>
        '(d.title LIKE ? OR d.description LIKE ? OR d.tags LIKE ? OR dv.extracted_text LIKE ?)'
      );
      conditions.push(`(${keywordConditions.join(' AND ')})`);
      for (const kw of parsedQuery.keywords) {
        const term = `%${kw}%`;
        params.push(term, term, term, term);
      }
    }

    // Document type filter
    let needDocTypeJoin = false;
    if (parsedQuery.document_type_slug) {
      conditions.push('dt.slug = ?');
      params.push(parsedQuery.document_type_slug);
      needDocTypeJoin = true;
    }

    // Product filter
    let needProductJoin = false;
    if (parsedQuery.product_name) {
      conditions.push('LOWER(p.name) = LOWER(?)');
      params.push(parsedQuery.product_name);
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

    // Supplier filter
    let needSupplierJoin = false;
    if (parsedQuery.supplier_name) {
      conditions.push('LOWER(sup.name) = LOWER(?)');
      params.push(parsedQuery.supplier_name);
      needSupplierJoin = true;
    }

    // Metadata search (searches primary_metadata JSON text)
    if (parsedQuery.metadata_search) {
      conditions.push('(d.primary_metadata LIKE ? OR d.extended_metadata LIKE ?)');
      const term = `%${parsedQuery.metadata_search}%`;
      params.push(term, term);
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;

    // Build JOINs
    let joins = `
      LEFT JOIN users u ON d.created_by = u.id
      LEFT JOIN tenants t ON d.tenant_id = t.id
      LEFT JOIN document_versions dv ON dv.document_id = d.id
      LEFT JOIN document_types dt ON d.document_type_id = dt.id
      LEFT JOIN suppliers s ON d.supplier_id = s.id`;

    if (needProductJoin) {
      joins += `
      LEFT JOIN document_products dp ON dp.document_id = d.id
      LEFT JOIN products p ON dp.product_id = p.id`;
    }

    if (needSupplierJoin) {
      joins += `
      LEFT JOIN suppliers sup ON d.supplier_id = sup.id`;
    }

    // Count total
    const countResult = await context.env.DB.prepare(
      `SELECT COUNT(DISTINCT d.id) as total FROM documents d ${joins} ${whereClause}`
    )
      .bind(...params)
      .first<{ total: number }>();

    // Fetch results
    const results = await context.env.DB.prepare(
      `SELECT DISTINCT d.*, u.name as creator_name, u.email as creator_email, t.name as tenant_name,
              dt.name as document_type_name, dt.slug as document_type_slug,
              s.name as supplier_name
       FROM documents d
       ${joins}
       ${whereClause}
       ORDER BY d.updated_at DESC
       LIMIT 50`
    )
      .bind(...params)
      .all();

    return new Response(
      JSON.stringify({
        parsed_query: parsedQuery,
        results: results.results,
        total: countResult?.total || 0,
      }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;

    console.error('Natural search error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
