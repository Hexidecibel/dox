import {
  requireRole,
  requireTenantAccess,
  BadRequestError,
  errorToResponse,
} from '../../../lib/permissions';
import type { Env, User } from '../../../lib/types';

interface ParsedOrderQuery {
  search_text: string | null;
  customer_name: string | null;
  customer_number: string | null;
  order_number: string | null;
  po_number: string | null;
  product_name: string | null;
  lot_number: string | null;
  status: string | null;
  date_from: string | null;
  date_to: string | null;
  sort_by: string;
  limit: number;
  explanation: string;
}

async function parseOrderQuery(
  query: string,
  customers: { customer_number: string; name: string }[],
  env: { QWEN_URL?: string; QWEN_SECRET?: string }
): Promise<ParsedOrderQuery> {
  const baseUrl = (env.QWEN_URL || 'http://127.0.0.1:9600').replace(/\/+$/, '');
  const today = new Date().toISOString().split('T')[0];

  const systemPrompt = [
    'You are a search query parser for an order management system that tracks customer orders, their line items (products, quantities, lot numbers), and fulfillment status.',
    '',
    'Parse the user\'s natural language query into structured search parameters.',
    'Return ONLY a valid JSON object with these optional fields:',
    '- search_text: general text to search across all order fields',
    '- customer_name: customer name to filter by',
    '- customer_number: customer code/number',
    '- order_number: specific order number',
    '- po_number: purchase order number',
    '- product_name: product in order items',
    '- lot_number: lot number in order items',
    '- status: order status (pending, enriched, matched, fulfilled, delivered, error)',
    '- date_from: start date (ISO format YYYY-MM-DD)',
    '- date_to: end date (ISO format YYYY-MM-DD)',
    '- sort_by: relevance, date, customer, status (default: relevance)',
    '- limit: max results (default 20)',
    '- explanation: human-readable summary of what was understood',
    '',
    'Only include fields that the query specifically mentions or implies.',
    '',
    `Today's date: ${today}`,
    '',
    'AVAILABLE CUSTOMERS:',
    ...customers.slice(0, 50).map(c => `- ${c.customer_number}: "${c.name}"`),
    ...(customers.length === 0 ? ['(none yet)'] : []),
    '',
    'AVAILABLE STATUSES: pending, enriched, matched, fulfilled, delivered, error',
    '',
    'EXAMPLES:',
    'Query: "orders for ACME Corp from last week"',
    `Output: {"customer_name":"ACME Corp","date_from":"${today}","date_to":"${today}","sort_by":"date","explanation":"Orders for ACME Corp from last week"}`,
    '',
    'Query: "pending orders with lot 776764"',
    'Output: {"status":"pending","lot_number":"776764","sort_by":"relevance","explanation":"Pending orders containing lot number 776764"}',
    '',
    'Query: "PO-44821"',
    'Output: {"po_number":"PO-44821","sort_by":"relevance","explanation":"Orders matching PO number PO-44821"}',
    '',
    'RULES:',
    '1. Fuzzy customer matching: "acme" matches "ACME Corporation" - pick the closest match from the list.',
    '2. Temporal reasoning: "last week" = date_from/date_to for that week. "last month" = first/last day of previous month. "today" = today\'s date. "recent" = last 7 days.',
    '3. If query mentions a specific order number or PO, use the exact value.',
    '4. Always provide an explanation field.',
    '5. Don\'t force matches - if nothing matches, leave fields null/absent.',
  ].join('\n');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);

  let response: Response;
  try {
    response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(env.QWEN_SECRET ? { Authorization: `Bearer ${env.QWEN_SECRET}` } : {}),
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: 'Qwen3-5-35B-A3B',
        temperature: 0,
        max_tokens: 500,
        messages: [
          { role: 'system', content: systemPrompt },
          {
            role: 'user',
            content: `Parse this search query: "${query}" /no_think`,
          },
        ],
      }),
    });
  } catch (err: unknown) {
    clearTimeout(timeout);
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error('LLM request timed out after 30 seconds');
    }
    throw new Error(`LLM server not reachable at ${baseUrl}. Is Qwen running?`);
  } finally {
    clearTimeout(timeout);
  }

  const data = (await response.json()) as {
    choices: { message: { content: string } }[];
  };

  let content = data.choices?.[0]?.message?.content || '';

  // Strip Qwen3 <think>...</think> blocks
  content = content.replace(/<think>[\s\S]*?<\/think>\s*/g, '').trim();

  const fenceMatch = content.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/);
  if (fenceMatch) {
    content = fenceMatch[1].trim();
  }

  try {
    const parsed = JSON.parse(content);
    return {
      search_text: parsed.search_text || null,
      customer_name: parsed.customer_name || null,
      customer_number: parsed.customer_number || null,
      order_number: parsed.order_number || null,
      po_number: parsed.po_number || null,
      product_name: parsed.product_name || null,
      lot_number: parsed.lot_number || null,
      status: parsed.status || null,
      date_from: parsed.date_from || null,
      date_to: parsed.date_to || null,
      sort_by: parsed.sort_by || 'relevance',
      limit: typeof parsed.limit === 'number' ? Math.min(parsed.limit, 100) : 20,
      explanation: parsed.explanation || query,
    };
  } catch {
    // Fallback: treat entire query as search_text
    return {
      search_text: query,
      customer_name: null,
      customer_number: null,
      order_number: null,
      po_number: null,
      product_name: null,
      lot_number: null,
      status: null,
      date_from: null,
      date_to: null,
      sort_by: 'relevance',
      limit: 20,
      explanation: query,
    };
  }
}

/**
 * POST /api/orders/search/natural
 * Natural language order search powered by Qwen LLM.
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

    // Fetch customers for this tenant
    const customersResult = await context.env.DB.prepare(
      'SELECT customer_number, name FROM customers WHERE tenant_id = ? AND active = 1'
    )
      .bind(tenantId)
      .all<{ customer_number: string; name: string }>();

    const customers = customersResult.results || [];

    // Parse natural language query via LLM
    let parsedQuery: ParsedOrderQuery;
    try {
      parsedQuery = await parseOrderQuery(body.query, customers, context.env);
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
    const conditions: string[] = ['o.tenant_id = ?'];
    const params: (string | number)[] = [tenantId];

    let needItemJoin = false;
    let relevanceComponents: string[] = [];

    // search_text: LIKE across multiple fields
    if (parsedQuery.search_text) {
      conditions.push(
        '(o.order_number LIKE ? OR o.po_number LIKE ? OR o.customer_name LIKE ? OR o.customer_number LIKE ? OR oi.product_name LIKE ? OR oi.lot_number LIKE ?)'
      );
      const term = `%${parsedQuery.search_text}%`;
      params.push(term, term, term, term, term, term);
      needItemJoin = true;
      relevanceComponents.push('2');
    }

    // customer_name
    if (parsedQuery.customer_name) {
      conditions.push('(o.customer_name LIKE ? OR c.name LIKE ?)');
      const term = `%${parsedQuery.customer_name}%`;
      params.push(term, term);
      relevanceComponents.push('(CASE WHEN o.customer_name LIKE ? OR c.name LIKE ? THEN 5 ELSE 0 END)');
      // Note: these extra params for relevance scoring are added after the WHERE params
    }

    // customer_number
    if (parsedQuery.customer_number) {
      conditions.push('o.customer_number = ?');
      params.push(parsedQuery.customer_number);
      relevanceComponents.push('5');
    }

    // order_number
    if (parsedQuery.order_number) {
      conditions.push('o.order_number LIKE ?');
      params.push(`%${parsedQuery.order_number}%`);
      relevanceComponents.push('10');
    }

    // po_number
    if (parsedQuery.po_number) {
      conditions.push('o.po_number LIKE ?');
      params.push(`%${parsedQuery.po_number}%`);
      relevanceComponents.push('10');
    }

    // product_name
    if (parsedQuery.product_name) {
      conditions.push('oi.product_name LIKE ?');
      params.push(`%${parsedQuery.product_name}%`);
      needItemJoin = true;
      relevanceComponents.push('5');
    }

    // lot_number
    if (parsedQuery.lot_number) {
      conditions.push('oi.lot_number LIKE ?');
      params.push(`%${parsedQuery.lot_number}%`);
      needItemJoin = true;
      relevanceComponents.push('8');
    }

    // status
    if (parsedQuery.status) {
      conditions.push('o.status = ?');
      params.push(parsedQuery.status);
      relevanceComponents.push('3');
    }

    // date_from
    if (parsedQuery.date_from) {
      conditions.push('o.created_at >= ?');
      params.push(parsedQuery.date_from);
    }

    // date_to
    if (parsedQuery.date_to) {
      conditions.push('o.created_at <= ?');
      params.push(parsedQuery.date_to + 'T23:59:59');
    }

    // Default base score
    relevanceComponents.push('1');

    const whereClause = `WHERE ${conditions.join(' AND ')}`;

    // Build JOINs
    let joins = `
      LEFT JOIN customers c ON o.customer_id = c.id`;

    if (needItemJoin) {
      joins += `
      LEFT JOIN order_items oi ON oi.order_id = o.id`;
    }

    // Build relevance score — avoid extra bind params by using simple constants
    // For customer_name relevance, we use a static score since the filter already matched
    const relevanceScore = relevanceComponents.join(' + ');

    // Build ORDER BY
    let orderBy: string;
    switch (parsedQuery.sort_by) {
      case 'date':
        orderBy = 'o.created_at DESC';
        break;
      case 'customer':
        orderBy = 'o.customer_name ASC, o.created_at DESC';
        break;
      case 'status':
        orderBy = 'o.status ASC, o.created_at DESC';
        break;
      case 'relevance':
      default:
        orderBy = `(${relevanceScore}) DESC, o.created_at DESC`;
        break;
    }

    const limit = parsedQuery.limit;

    // Count total
    const countSql = `SELECT COUNT(DISTINCT o.id) as total FROM orders o ${joins} ${whereClause}`;
    const countResult = await context.env.DB.prepare(countSql)
      .bind(...params)
      .first<{ total: number }>();

    // Fetch results
    const selectSql = `SELECT o.*,
        c.name as customer_name_resolved,
        COUNT(oi2.id) as item_count,
        SUM(CASE WHEN oi2.coa_document_id IS NOT NULL THEN 1 ELSE 0 END) as matched_count,
        GROUP_CONCAT(DISTINCT oi2.product_name) as product_names,
        GROUP_CONCAT(DISTINCT oi2.lot_number) as lot_numbers
      FROM orders o
      ${joins}
      LEFT JOIN order_items oi2 ON oi2.order_id = o.id
      ${whereClause}
      GROUP BY o.id
      ORDER BY ${orderBy}
      LIMIT ?`;

    const results = await context.env.DB.prepare(selectSql)
      .bind(...params, limit)
      .all();

    return new Response(
      JSON.stringify({
        results: results.results || [],
        query_interpretation: {
          original_query: body.query,
          parsed: parsedQuery,
          explanation: parsedQuery.explanation,
        },
        total: countResult?.total || 0,
      }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;

    console.error('Natural order search error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
