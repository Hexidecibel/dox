import { generateId, logAudit, getClientIp } from '../../../lib/db';
import {
  requireRole,
  requireTenantAccess,
  NotFoundError,
  errorToResponse,
} from '../../../lib/permissions';
import type { Env, User } from '../../../lib/types';

/**
 * GET /api/tenants/:id/products
 * List products associated with this tenant via tenant_products join.
 * Tenant members can read their own. Super_admin can read any.
 */
export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const tenantId = context.params.id as string;

    requireTenantAccess(user, tenantId);

    // Verify tenant exists
    const tenant = await context.env.DB.prepare(
      'SELECT id FROM tenants WHERE id = ?'
    )
      .bind(tenantId)
      .first();

    if (!tenant) {
      throw new NotFoundError('Tenant not found');
    }

    const url = new URL(context.request.url);
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200);
    const offset = parseInt(url.searchParams.get('offset') || '0', 10);

    // Get total count
    const countResult = await context.env.DB.prepare(
      `SELECT COUNT(*) as total
       FROM products p
       INNER JOIN tenant_products tp ON p.id = tp.product_id
       WHERE tp.tenant_id = ? AND p.active = 1`
    )
      .bind(tenantId)
      .first<{ total: number }>();

    // Get products for this tenant
    const results = await context.env.DB.prepare(
      `SELECT p.*, tp.created_at as associated_at
       FROM products p
       INNER JOIN tenant_products tp ON p.id = tp.product_id
       WHERE tp.tenant_id = ? AND p.active = 1
       ORDER BY p.name ASC
       LIMIT ? OFFSET ?`
    )
      .bind(tenantId, limit, offset)
      .all();

    return new Response(
      JSON.stringify({
        products: results.results,
        total: countResult?.total || 0,
        limit,
        offset,
      }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;

    console.error('List tenant products error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};

/**
 * POST /api/tenants/:id/products
 * Associate a product with a tenant.
 * org_admin+ for their own tenant, super_admin for any.
 * Body: { product_id: string }
 */
export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const tenantId = context.params.id as string;

    requireRole(user, 'super_admin', 'org_admin');
    requireTenantAccess(user, tenantId);

    // Verify tenant exists
    const tenant = await context.env.DB.prepare(
      'SELECT id FROM tenants WHERE id = ? AND active = 1'
    )
      .bind(tenantId)
      .first();

    if (!tenant) {
      throw new NotFoundError('Tenant not found');
    }

    const body = (await context.request.json()) as {
      product_id?: string;
    };

    if (!body.product_id) {
      return new Response(
        JSON.stringify({ error: 'product_id is required' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Verify product exists and is active
    const product = await context.env.DB.prepare(
      'SELECT id, name FROM products WHERE id = ? AND active = 1'
    )
      .bind(body.product_id)
      .first();

    if (!product) {
      throw new NotFoundError('Product not found or inactive');
    }

    // Check if association already exists
    const existing = await context.env.DB.prepare(
      'SELECT id FROM tenant_products WHERE tenant_id = ? AND product_id = ?'
    )
      .bind(tenantId, body.product_id)
      .first();

    if (existing) {
      return new Response(
        JSON.stringify({ error: 'Product is already associated with this tenant' }),
        { status: 409, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const id = generateId();

    await context.env.DB.prepare(
      `INSERT INTO tenant_products (id, tenant_id, product_id)
       VALUES (?, ?, ?)`
    )
      .bind(id, tenantId, body.product_id)
      .run();

    await logAudit(
      context.env.DB,
      user.id,
      tenantId,
      'tenant_product_added',
      'tenant_product',
      id,
      JSON.stringify({ product_id: body.product_id, product_name: product.name }),
      getClientIp(context.request)
    );

    return new Response(
      JSON.stringify({
        tenant_product: {
          id,
          tenant_id: tenantId,
          product_id: body.product_id,
        },
      }),
      { status: 201, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;

    console.error('Add tenant product error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};

/**
 * DELETE /api/tenants/:id/products?product_id=xxx
 * Remove a product association from a tenant.
 * org_admin+ for their own tenant, super_admin for any.
 */
export const onRequestDelete: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const tenantId = context.params.id as string;

    requireRole(user, 'super_admin', 'org_admin');
    requireTenantAccess(user, tenantId);

    const url = new URL(context.request.url);
    const productId = url.searchParams.get('product_id');

    if (!productId) {
      return new Response(
        JSON.stringify({ error: 'product_id query parameter is required' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Check if association exists
    const association = await context.env.DB.prepare(
      'SELECT id FROM tenant_products WHERE tenant_id = ? AND product_id = ?'
    )
      .bind(tenantId, productId)
      .first();

    if (!association) {
      throw new NotFoundError('Product association not found');
    }

    await context.env.DB.prepare(
      'DELETE FROM tenant_products WHERE tenant_id = ? AND product_id = ?'
    )
      .bind(tenantId, productId)
      .run();

    await logAudit(
      context.env.DB,
      user.id,
      tenantId,
      'tenant_product_removed',
      'tenant_product',
      association.id as string,
      JSON.stringify({ product_id: productId }),
      getClientIp(context.request)
    );

    return new Response(
      JSON.stringify({ success: true }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;

    console.error('Remove tenant product error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
