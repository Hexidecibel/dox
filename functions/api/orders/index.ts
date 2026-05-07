import { generateId, logAudit, getClientIp } from '../../lib/db';
import {
  requireRole,
  requireTenantAccess,
  BadRequestError,
  errorToResponse,
} from '../../lib/permissions';
import { sanitizeString } from '../../lib/validation';
import { buildMatchExpr } from '../../lib/search-fts';
import type { Env, User } from '../../lib/types';

/**
 * GET /api/orders
 * List orders for a tenant with item counts and joined names.
 */
export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const url = new URL(context.request.url);

    let tenantId = url.searchParams.get('tenant_id');
    const status = url.searchParams.get('status');
    const customerId = url.searchParams.get('customer_id');
    const connectorId = url.searchParams.get('connector_id');
    const search = url.searchParams.get('search');
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 500);
    const offset = parseInt(url.searchParams.get('offset') || '0', 10);

    if (user.role !== 'super_admin') {
      tenantId = user.tenant_id;
    }

    if (!tenantId) {
      throw new BadRequestError('tenant_id is required');
    }

    requireTenantAccess(user, tenantId);

    const conditions: string[] = ['o.tenant_id = ?'];
    const params: (string | number)[] = [tenantId];

    if (status) {
      conditions.push('o.status = ?');
      params.push(status);
    }

    if (customerId) {
      conditions.push('o.customer_id = ?');
      params.push(customerId);
    }

    if (connectorId) {
      conditions.push('o.connector_id = ?');
      params.push(connectorId);
    }

    // FTS5 swap (Phase 4c). When `search` is non-empty and parses to at
    // least one token, we narrow `orders` via `orders_fts MATCH` against
    // the same denormalized view that backs the universal /api/search
    // endpoint. Customer name + order_number + po_number + items are all
    // indexed, so no extra `LEFT JOIN order_items` is needed for the
    // search predicate. We still join `order_items` for the item_count /
    // matched_count projections, but those are scalar subqueries below.
    let ftsClause = '';
    const matchExpr = search ? buildMatchExpr(search) : null;
    if (matchExpr) {
      ftsClause = `AND o.id IN (
        SELECT f.order_id
        FROM orders_fts f
        WHERE f.tenant_id = ? AND orders_fts MATCH ?
      )`;
      params.push(tenantId, matchExpr);
    }

    const whereClause = `WHERE ${conditions.join(' AND ')} ${ftsClause}`;

    const countResult = await context.env.DB.prepare(
      `SELECT COUNT(DISTINCT o.id) as total FROM orders o ${whereClause}`,
    )
      .bind(...params)
      .first<{ total: number }>();

    const results = await context.env.DB.prepare(
      `SELECT o.*,
        (SELECT COUNT(*) FROM order_items oi2 WHERE oi2.order_id = o.id) as item_count,
        (SELECT COUNT(*) FROM order_items oi2 WHERE oi2.order_id = o.id AND oi2.lot_matched = 1) as matched_count,
        c.name as connector_name,
        cust.name as customer_name_resolved
      FROM orders o
      LEFT JOIN connectors c ON c.id = o.connector_id
      LEFT JOIN customers cust ON cust.id = o.customer_id
      ${whereClause}
      GROUP BY o.id
      ORDER BY o.created_at DESC
      LIMIT ? OFFSET ?`,
    )
      .bind(...params, limit, offset)
      .all();

    return new Response(
      JSON.stringify({
        orders: results.results,
        total: countResult?.total || 0,
        limit,
        offset,
      }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;

    console.error('List orders error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};

/**
 * POST /api/orders
 * Create an order with optional items.
 */
export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireRole(user, 'super_admin', 'org_admin', 'user');

    const body = (await context.request.json()) as {
      order_number?: string;
      po_number?: string;
      customer_id?: string;
      customer_number?: string;
      customer_name?: string;
      tenant_id?: string;
      items?: Array<{
        product_id?: string;
        product_name?: string;
        product_code?: string;
        quantity?: number;
        lot_number?: string;
      }>;
    };

    if (!body.order_number?.trim()) {
      throw new BadRequestError('order_number is required');
    }

    let tenantId = body.tenant_id || null;
    if (user.role !== 'super_admin') {
      tenantId = user.tenant_id;
    }

    if (!tenantId) {
      throw new BadRequestError('tenant_id is required');
    }

    requireTenantAccess(user, tenantId);

    const orderId = generateId();
    const orderNumber = sanitizeString(body.order_number.trim());
    const poNumber = body.po_number ? sanitizeString(body.po_number.trim()) : null;
    const customerName = body.customer_name ? sanitizeString(body.customer_name.trim()) : null;
    const customerNumber = body.customer_number ? sanitizeString(body.customer_number.trim()) : null;
    const customerId = body.customer_id || null;

    await context.env.DB.prepare(
      `INSERT INTO orders (id, tenant_id, order_number, po_number, customer_id, customer_number, customer_name, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', datetime('now'), datetime('now'))`
    )
      .bind(orderId, tenantId, orderNumber, poNumber, customerId, customerNumber, customerName)
      .run();

    // Create items if provided
    if (body.items && body.items.length > 0) {
      for (const item of body.items) {
        const itemId = generateId();
        await context.env.DB.prepare(
          `INSERT INTO order_items (id, order_id, product_id, product_name, product_code, quantity, lot_number, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`
        )
          .bind(
            itemId,
            orderId,
            item.product_id || null,
            item.product_name ? sanitizeString(item.product_name) : null,
            item.product_code ? sanitizeString(item.product_code) : null,
            item.quantity ?? null,
            item.lot_number ? sanitizeString(item.lot_number) : null
          )
          .run();
      }
    }

    await logAudit(
      context.env.DB,
      user.id,
      tenantId,
      'order.created',
      'order',
      orderId,
      JSON.stringify({ order_number: orderNumber, item_count: body.items?.length || 0 }),
      getClientIp(context.request)
    );

    const order = await context.env.DB.prepare(
      'SELECT * FROM orders WHERE id = ?'
    )
      .bind(orderId)
      .first();

    return new Response(
      JSON.stringify({ order }),
      { status: 201, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;

    console.error('Create order error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
