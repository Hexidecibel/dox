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
 * POST /api/suppliers/lookup-or-create
 * Fuzzy match: try exact slug match first, then LIKE on name and aliases.
 * If found: return existing. If not: create and return.
 */
export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireRole(user, 'super_admin', 'org_admin', 'user');

    const body = (await context.request.json()) as {
      name?: string;
      tenant_id?: string;
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

    // 1. Try exact slug match
    let supplier = await context.env.DB.prepare(
      'SELECT * FROM suppliers WHERE tenant_id = ? AND slug = ?'
    )
      .bind(tenantId, slug)
      .first();

    if (supplier) {
      return new Response(
        JSON.stringify({ supplier, created: false }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    }

    // 2. Try LIKE on name and aliases
    supplier = await context.env.DB.prepare(
      `SELECT * FROM suppliers
       WHERE tenant_id = ? AND (LOWER(name) = LOWER(?) OR aliases LIKE ?)
       LIMIT 1`
    )
      .bind(tenantId, name, `%${name}%`)
      .first();

    if (supplier) {
      return new Response(
        JSON.stringify({ supplier, created: false }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    }

    // 3. Create new supplier
    const id = generateId();
    await context.env.DB.prepare(
      `INSERT INTO suppliers (id, tenant_id, name, slug) VALUES (?, ?, ?, ?)`
    )
      .bind(id, tenantId, name, slug)
      .run();

    await logAudit(
      context.env.DB,
      user.id,
      tenantId,
      'supplier.created',
      'supplier',
      id,
      JSON.stringify({ name, source: 'lookup-or-create' }),
      getClientIp(context.request)
    );

    const newSupplier = await context.env.DB.prepare(
      'SELECT * FROM suppliers WHERE id = ?'
    )
      .bind(id)
      .first();

    return new Response(
      JSON.stringify({ supplier: newSupplier, created: true }),
      { status: 201, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;

    console.error('Supplier lookup-or-create error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
