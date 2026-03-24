import { logAudit, getClientIp } from '../../lib/db';
import { requireRole, requireTenantAccess, errorToResponse, ForbiddenError } from '../../lib/permissions';
import { sanitizeString } from '../../lib/validation';
import { computeDiff } from '../../lib/diff';
import type { Env, User, Tenant } from '../../lib/types';

export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const currentUser = context.data.user as User;
    const tenantId = context.params.id as string;

    // super_admin can see any tenant; others can only see their own
    if (currentUser.role !== 'super_admin') {
      requireTenantAccess(currentUser, tenantId);
    }

    const tenant = await context.env.DB.prepare(
      'SELECT * FROM tenants WHERE id = ?'
    )
      .bind(tenantId)
      .first<Tenant>();

    if (!tenant) {
      return new Response(
        JSON.stringify({ error: 'Tenant not found' }),
        { status: 404, headers: { 'Content-Type': 'application/json' } }
      );
    }

    return new Response(JSON.stringify(tenant), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};

export const onRequestPut: PagesFunction<Env> = async (context) => {
  try {
    const currentUser = context.data.user as User;
    const tenantId = context.params.id as string;

    // super_admin can update any tenant; org_admin can update their own
    if (currentUser.role === 'org_admin') {
      if (currentUser.tenant_id !== tenantId) {
        throw new ForbiddenError('You can only update your own tenant');
      }
    } else if (currentUser.role !== 'super_admin') {
      throw new ForbiddenError('Insufficient permissions');
    }

    const tenant = await context.env.DB.prepare(
      'SELECT * FROM tenants WHERE id = ?'
    )
      .bind(tenantId)
      .first<Tenant>();

    if (!tenant) {
      return new Response(
        JSON.stringify({ error: 'Tenant not found' }),
        { status: 404, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const body = (await context.request.json()) as {
      name?: string;
      slug?: string;
      description?: string;
      active?: number;
    };

    // org_admin can only update name and description
    if (currentUser.role === 'org_admin') {
      if (body.slug !== undefined || body.active !== undefined) {
        throw new ForbiddenError('Org admins can only update name and description');
      }
    }

    const updates: string[] = [];
    const values: (string | number | null)[] = [];

    if (body.name !== undefined) {
      updates.push('name = ?');
      values.push(sanitizeString(body.name));
    }
    if (body.slug !== undefined && currentUser.role === 'super_admin') {
      // Check slug uniqueness
      const existing = await context.env.DB.prepare(
        'SELECT id FROM tenants WHERE slug = ? AND id != ?'
      )
        .bind(body.slug, tenantId)
        .first();
      if (existing) {
        return new Response(
          JSON.stringify({ error: 'A tenant with this slug already exists' }),
          { status: 409, headers: { 'Content-Type': 'application/json' } }
        );
      }
      updates.push('slug = ?');
      values.push(sanitizeString(body.slug));
    }
    if (body.description !== undefined) {
      updates.push('description = ?');
      values.push(sanitizeString(body.description) || null);
    }
    if (body.active !== undefined && currentUser.role === 'super_admin') {
      updates.push('active = ?');
      values.push(body.active);
    }

    if (updates.length === 0) {
      return new Response(
        JSON.stringify({ error: 'No valid fields to update' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    updates.push("updated_at = datetime('now')");
    values.push(tenantId);

    // Build new values for diff
    const newValues: Record<string, any> = {
      name: body.name !== undefined ? sanitizeString(body.name) : tenant.name,
      description: body.description !== undefined ? (sanitizeString(body.description) || null) : tenant.description,
      active: body.active !== undefined && currentUser.role === 'super_admin' ? body.active : tenant.active,
    };

    const diff = computeDiff(tenant as unknown as Record<string, any>, newValues, ['name', 'description', 'active']);

    await context.env.DB.prepare(
      `UPDATE tenants SET ${updates.join(', ')} WHERE id = ?`
    )
      .bind(...values)
      .run();

    await logAudit(
      context.env.DB,
      currentUser.id,
      tenantId,
      'tenant_updated',
      'tenant',
      tenantId,
      JSON.stringify({ changes: diff }),
      getClientIp(context.request)
    );

    const updated = await context.env.DB.prepare(
      'SELECT * FROM tenants WHERE id = ?'
    )
      .bind(tenantId)
      .first<Tenant>();

    return new Response(JSON.stringify(updated), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};

export const onRequestDelete: PagesFunction<Env> = async (context) => {
  try {
    const currentUser = context.data.user as User;
    requireRole(currentUser, 'super_admin');

    const tenantId = context.params.id as string;

    const tenant = await context.env.DB.prepare(
      'SELECT * FROM tenants WHERE id = ?'
    )
      .bind(tenantId)
      .first<Tenant>();

    if (!tenant) {
      return new Response(
        JSON.stringify({ error: 'Tenant not found' }),
        { status: 404, headers: { 'Content-Type': 'application/json' } }
      );
    }

    await context.env.DB.prepare(
      "UPDATE tenants SET active = 0, updated_at = datetime('now') WHERE id = ?"
    )
      .bind(tenantId)
      .run();

    await logAudit(
      context.env.DB,
      currentUser.id,
      tenantId,
      'tenant_deactivated',
      'tenant',
      tenantId,
      null,
      getClientIp(context.request)
    );

    return new Response(JSON.stringify({ success: true }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
