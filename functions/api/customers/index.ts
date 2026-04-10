import { generateId, logAudit, getClientIp } from '../../lib/db';
import {
  requireRole,
  requireTenantAccess,
  BadRequestError,
  errorToResponse,
} from '../../lib/permissions';
import { sanitizeString } from '../../lib/validation';
import type { Env, User } from '../../lib/types';

/**
 * GET /api/customers
 * List customers for a tenant.
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
      // Default to showing only active customers
      conditions.push('active = 1');
    }

    if (search) {
      conditions.push('(name LIKE ? OR customer_number LIKE ? OR email LIKE ?)');
      const term = `%${search}%`;
      params.push(term, term, term);
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;

    const countResult = await context.env.DB.prepare(
      `SELECT COUNT(*) as total FROM customers ${whereClause}`
    )
      .bind(...params)
      .first<{ total: number }>();

    const results = await context.env.DB.prepare(
      `SELECT * FROM customers ${whereClause} ORDER BY name ASC LIMIT ? OFFSET ?`
    )
      .bind(...params, limit, offset)
      .all();

    return new Response(
      JSON.stringify({
        customers: results.results,
        total: countResult?.total || 0,
      }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;

    console.error('List customers error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};

/**
 * POST /api/customers
 * Create a new customer.
 */
export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireRole(user, 'super_admin', 'org_admin');

    const body = (await context.request.json()) as {
      customer_number?: string;
      name?: string;
      email?: string;
      coa_delivery_method?: string;
      coa_requirements?: object;
      tenant_id?: string;
    };

    if (!body.customer_number?.trim()) {
      throw new BadRequestError('customer_number is required');
    }

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

    const customerNumber = sanitizeString(body.customer_number.trim());
    const name = sanitizeString(body.name.trim());
    const email = body.email ? sanitizeString(body.email.trim()) : null;
    const coaDeliveryMethod = body.coa_delivery_method || 'email';
    const coaRequirements = body.coa_requirements ? JSON.stringify(body.coa_requirements) : null;
    const id = generateId();

    await context.env.DB.prepare(
      `INSERT INTO customers (id, tenant_id, customer_number, name, email, coa_delivery_method, coa_requirements, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
    )
      .bind(id, tenantId, customerNumber, name, email, coaDeliveryMethod, coaRequirements)
      .run();

    await logAudit(
      context.env.DB,
      user.id,
      tenantId,
      'customer.created',
      'customer',
      id,
      JSON.stringify({ name, customer_number: customerNumber }),
      getClientIp(context.request)
    );

    const customer = await context.env.DB.prepare(
      'SELECT * FROM customers WHERE id = ?'
    )
      .bind(id)
      .first();

    return new Response(
      JSON.stringify({ customer }),
      { status: 201, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;

    console.error('Create customer error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
