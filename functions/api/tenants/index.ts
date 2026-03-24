import { generateId } from '../../lib/auth';
import { logAudit, getClientIp } from '../../lib/db';
import { requireRole, errorToResponse } from '../../lib/permissions';
import { sanitizeString } from '../../lib/validation';
import type { Env, User, Tenant } from '../../lib/types';

export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const currentUser = context.data.user as User;
    const url = new URL(context.request.url);
    const activeFilter = url.searchParams.get('active');

    let query: string;
    const bindings: (string | number)[] = [];

    if (currentUser.role === 'super_admin') {
      query = 'SELECT * FROM tenants';
      if (activeFilter !== null) {
        query += ' WHERE active = ?';
        bindings.push(Number(activeFilter));
      }
    } else {
      // Non-super_admin can only see their own tenant
      if (!currentUser.tenant_id) {
        return new Response(JSON.stringify([]), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      query = 'SELECT * FROM tenants WHERE id = ?';
      bindings.push(currentUser.tenant_id);
      if (activeFilter !== null) {
        query += ' AND active = ?';
        bindings.push(Number(activeFilter));
      }
    }

    query += ' ORDER BY name ASC';

    const result = await context.env.DB.prepare(query)
      .bind(...bindings)
      .all<Tenant>();

    return new Response(JSON.stringify(result.results), {
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

export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const currentUser = context.data.user as User;
    requireRole(currentUser, 'super_admin');

    const body = (await context.request.json()) as {
      name?: string;
      slug?: string;
      description?: string;
    };

    if (!body.name) {
      return new Response(
        JSON.stringify({ error: 'name is required' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Sanitize inputs
    body.name = sanitizeString(body.name);
    if (body.slug) body.slug = sanitizeString(body.slug);
    if (body.description) body.description = sanitizeString(body.description);

    const slug = (body.slug || body.name)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');

    if (!slug) {
      return new Response(
        JSON.stringify({ error: 'Could not generate a valid slug' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Check uniqueness
    const existing = await context.env.DB.prepare(
      'SELECT id FROM tenants WHERE slug = ?'
    )
      .bind(slug)
      .first();

    if (existing) {
      return new Response(
        JSON.stringify({ error: 'A tenant with this slug already exists' }),
        { status: 409, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const id = generateId();

    await context.env.DB.prepare(
      `INSERT INTO tenants (id, name, slug, description, active)
       VALUES (?, ?, ?, ?, 1)`
    )
      .bind(id, body.name.trim(), slug, body.description?.trim() || null)
      .run();

    await logAudit(
      context.env.DB,
      currentUser.id,
      id,
      'tenant_created',
      'tenant',
      id,
      JSON.stringify({ name: body.name, slug }),
      getClientIp(context.request)
    );

    const tenant = await context.env.DB.prepare(
      'SELECT * FROM tenants WHERE id = ?'
    )
      .bind(id)
      .first<Tenant>();

    return new Response(JSON.stringify(tenant), {
      status: 201,
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
