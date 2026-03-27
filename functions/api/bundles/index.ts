import { generateId, logAudit, getClientIp } from '../../lib/db';
import {
  requireRole,
  requireTenantAccess,
  errorToResponse,
} from '../../lib/permissions';
import { sanitizeString } from '../../lib/validation';
import type { Env, User } from '../../lib/types';

/**
 * GET /api/bundles
 * List bundles for the user's tenant (or all for super_admin).
 * Supports pagination via limit/offset.
 */
export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const url = new URL(context.request.url);
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200);
    const offset = parseInt(url.searchParams.get('offset') || '0', 10);

    const conditions: string[] = [];
    const params: (string | number)[] = [];

    // Tenant scoping
    if (user.role !== 'super_admin') {
      if (!user.tenant_id) {
        return new Response(
          JSON.stringify({ bundles: [], total: 0, limit, offset }),
          { headers: { 'Content-Type': 'application/json' } }
        );
      }
      conditions.push('b.tenant_id = ?');
      params.push(user.tenant_id);
    } else {
      const tenantFilter = url.searchParams.get('tenant_id');
      if (tenantFilter) {
        conditions.push('b.tenant_id = ?');
        params.push(tenantFilter);
      }
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countResult = await context.env.DB.prepare(
      `SELECT COUNT(*) as total FROM document_bundles b ${whereClause}`
    )
      .bind(...params)
      .first<{ total: number }>();

    const results = await context.env.DB.prepare(
      `SELECT b.*, u.name as creator_name, p.name as product_name,
              (SELECT COUNT(*) FROM document_bundle_items WHERE bundle_id = b.id) as item_count
       FROM document_bundles b
       LEFT JOIN users u ON b.created_by = u.id
       LEFT JOIN products p ON b.product_id = p.id
       ${whereClause}
       ORDER BY b.updated_at DESC
       LIMIT ? OFFSET ?`
    )
      .bind(...params, limit, offset)
      .all();

    return new Response(
      JSON.stringify({
        bundles: results.results,
        total: countResult?.total || 0,
        limit,
        offset,
      }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;

    console.error('List bundles error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};

/**
 * POST /api/bundles
 * Create a new bundle. Requires user+ role.
 * Body: { name, description?, product_id? }
 */
export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireRole(user, 'super_admin', 'org_admin', 'user');

    const body = (await context.request.json()) as {
      name?: string;
      description?: string;
      product_id?: string;
    };

    if (!body.name || !body.name.trim()) {
      return new Response(
        JSON.stringify({ error: 'name is required' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const tenantId = user.tenant_id;
    if (!tenantId && user.role !== 'super_admin') {
      return new Response(
        JSON.stringify({ error: 'No tenant assigned' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // For super_admin without tenant, require tenant_id in body or use first tenant
    const effectiveTenantId = tenantId || (body as any).tenant_id;
    if (!effectiveTenantId) {
      return new Response(
        JSON.stringify({ error: 'tenant_id is required for super_admin' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const id = generateId();
    const name = sanitizeString(body.name);
    const description = body.description ? sanitizeString(body.description) : null;
    const productId = body.product_id || null;

    await context.env.DB.prepare(
      `INSERT INTO document_bundles (id, tenant_id, name, description, product_id, status, created_by)
       VALUES (?, ?, ?, ?, ?, 'draft', ?)`
    )
      .bind(id, effectiveTenantId, name, description, productId, user.id)
      .run();

    await logAudit(
      context.env.DB,
      user.id,
      effectiveTenantId,
      'bundle_created',
      'bundle',
      id,
      JSON.stringify({ name }),
      getClientIp(context.request)
    );

    const bundle = await context.env.DB.prepare(
      `SELECT b.*, u.name as creator_name, p.name as product_name
       FROM document_bundles b
       LEFT JOIN users u ON b.created_by = u.id
       LEFT JOIN products p ON b.product_id = p.id
       WHERE b.id = ?`
    )
      .bind(id)
      .first();

    return new Response(
      JSON.stringify({ bundle }),
      { status: 201, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;

    console.error('Create bundle error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
