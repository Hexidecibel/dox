import { requireRole, errorToResponse } from '../lib/permissions';
import type { Env, User } from '../lib/types';
import type { OrderProductOption } from '../../shared/types';

/**
 * GET /api/order-products?search=&limit=
 * Distinct products that appear on order_items for the tenant (the distributor
 * catalog — real `products` rows, typically supplier_id NULL). Joins
 * order_items -> orders (tenant scope) -> products. The distributor SKU lives on
 * order_items.product_code, so it is surfaced via MAX() per product.
 * Returns { products: OrderProductOption[] }.
 */
export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireRole(user, 'super_admin', 'org_admin', 'user', 'reader');

    const url = new URL(context.request.url);
    const search = url.searchParams.get('search');
    const limit = Math.min(
      parseInt(url.searchParams.get('limit') || '50', 10) || 50,
      200
    );

    // Tenant scope: non-super_admin always scoped to their own tenant.
    // super_admin may optionally pass ?tenant_id=, else sees all tenants.
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (user.role !== 'super_admin') {
      conditions.push('o.tenant_id = ?');
      params.push(user.tenant_id!);
    } else {
      const tenantIdParam = url.searchParams.get('tenant_id');
      if (tenantIdParam) {
        conditions.push('o.tenant_id = ?');
        params.push(tenantIdParam);
      }
    }

    conditions.push('oi.product_id IS NOT NULL');

    if (search && search.trim()) {
      const like = `%${search.trim()}%`;
      conditions.push('(p.name LIKE ? OR oi.product_code LIKE ?)');
      params.push(like, like);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const result = await context.env.DB.prepare(
      `SELECT
         oi.product_id AS product_id,
         MAX(oi.product_code) AS product_code,
         MAX(p.name) AS product_name
       FROM order_items oi
       JOIN orders o ON oi.order_id = o.id
       LEFT JOIN products p ON oi.product_id = p.id
       ${where}
       GROUP BY oi.product_id
       ORDER BY product_name COLLATE NOCASE
       LIMIT ?`
    )
      .bind(...params, limit)
      .all<OrderProductOption>();

    return new Response(
      JSON.stringify({ products: result.results ?? [] }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Get order-products error:', err);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
