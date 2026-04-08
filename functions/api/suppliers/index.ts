import { generateId, logAudit, getClientIp } from '../../lib/db';
import {
  requireRole,
  requireTenantAccess,
  BadRequestError,
  errorToResponse,
} from '../../lib/permissions';
import { sanitizeString } from '../../lib/validation';
import type { Env, User } from '../../lib/types';

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * GET /api/suppliers
 * List suppliers for a tenant.
 */
export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const url = new URL(context.request.url);

    let tenantId = url.searchParams.get('tenant_id');
    const search = url.searchParams.get('search');
    const active = url.searchParams.get('active');
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '100', 10), 500);
    const offset = parseInt(url.searchParams.get('offset') || '0', 10);

    if (user.role !== 'super_admin') {
      tenantId = user.tenant_id;
    }

    if (!tenantId) {
      throw new BadRequestError('tenant_id is required');
    }

    requireTenantAccess(user, tenantId);

    const conditions: string[] = ['tenant_id = ?'];
    const params: (string | number)[] = [tenantId];

    if (active !== null && active !== undefined && active !== '') {
      conditions.push('active = ?');
      params.push(parseInt(active, 10));
    } else {
      // Default to showing only active suppliers
      conditions.push('active = 1');
    }

    if (search) {
      conditions.push('(name LIKE ? OR aliases LIKE ?)');
      const term = `%${search}%`;
      params.push(term, term);
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;

    const countResult = await context.env.DB.prepare(
      `SELECT COUNT(*) as total FROM suppliers ${whereClause}`
    )
      .bind(...params)
      .first<{ total: number }>();

    const results = await context.env.DB.prepare(
      `SELECT * FROM suppliers ${whereClause} ORDER BY name ASC LIMIT ? OFFSET ?`
    )
      .bind(...params, limit, offset)
      .all();

    return new Response(
      JSON.stringify({
        suppliers: results.results,
        total: countResult?.total || 0,
      }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;

    console.error('List suppliers error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};

/**
 * POST /api/suppliers
 * Create a new supplier.
 */
export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireRole(user, 'super_admin', 'org_admin', 'user');

    const body = (await context.request.json()) as {
      name?: string;
      tenant_id?: string;
      aliases?: string;
    };

    if (!body.name?.trim()) {
      throw new BadRequestError('name is required');
    }

    let tenantId = body.tenant_id || null;
    if (user.role !== 'super_admin') {
      tenantId = user.tenant_id;
    }

    if (!tenantId) {
      throw new BadRequestError('tenant_id is required');
    }

    requireTenantAccess(user, tenantId);

    const name = sanitizeString(body.name.trim());
    const slug = slugify(name);
    const aliases = body.aliases ? sanitizeString(body.aliases) : null;
    const id = generateId();

    await context.env.DB.prepare(
      `INSERT INTO suppliers (id, tenant_id, name, slug, aliases) VALUES (?, ?, ?, ?, ?)`
    )
      .bind(id, tenantId, name, slug, aliases)
      .run();

    await logAudit(
      context.env.DB,
      user.id,
      tenantId,
      'supplier.created',
      'supplier',
      id,
      JSON.stringify({ name }),
      getClientIp(context.request)
    );

    const supplier = await context.env.DB.prepare(
      'SELECT * FROM suppliers WHERE id = ?'
    )
      .bind(id)
      .first();

    return new Response(
      JSON.stringify({ supplier }),
      { status: 201, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;

    console.error('Create supplier error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
