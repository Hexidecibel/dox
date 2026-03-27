import { generateId } from '../../lib/db';
import { logAudit, getClientIp } from '../../lib/db';
import { requireRole, requireTenantAccess, errorToResponse } from '../../lib/permissions';
import { sanitizeString } from '../../lib/validation';
import type { Env, User } from '../../lib/types';

function slugify(text: string): string {
  return text.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/**
 * GET /api/document-types
 * List document types. Non-super_admins see only their tenant's types.
 * super_admin can filter by ?tenant_id=. Supports ?active=1 filter.
 */
export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const url = new URL(context.request.url);
    const activeFilter = url.searchParams.get('active');
    const tenantIdParam = url.searchParams.get('tenant_id');
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200);
    const offset = parseInt(url.searchParams.get('offset') || '0', 10);

    const conditions: string[] = [];
    const params: (string | number)[] = [];

    // Tenant scoping
    if (user.role === 'super_admin') {
      if (tenantIdParam) {
        conditions.push('tenant_id = ?');
        params.push(tenantIdParam);
      }
    } else {
      conditions.push('tenant_id = ?');
      params.push(user.tenant_id!);
    }

    if (activeFilter !== null) {
      conditions.push('active = ?');
      params.push(Number(activeFilter));
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Get total count
    const countResult = await context.env.DB.prepare(
      `SELECT COUNT(*) as total FROM document_types ${whereClause}`
    )
      .bind(...params)
      .first<{ total: number }>();

    // Get document types
    const results = await context.env.DB.prepare(
      `SELECT * FROM document_types ${whereClause} ORDER BY name ASC LIMIT ? OFFSET ?`
    )
      .bind(...params, limit, offset)
      .all();

    return new Response(
      JSON.stringify({
        document_types: results.results,
        total: countResult?.total || 0,
        limit,
        offset,
      }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;

    console.error('List document types error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};

/**
 * POST /api/document-types
 * Create a new document type. org_admin+ for their own tenant.
 * super_admin can specify tenant_id.
 * Fields: name (required), description (optional), tenant_id (optional, super_admin only).
 * Auto-generates slug from name.
 */
export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireRole(user, 'super_admin', 'org_admin');

    const body = (await context.request.json()) as {
      name?: string;
      description?: string;
      tenant_id?: string;
    };

    if (!body.name || !body.name.trim()) {
      return new Response(
        JSON.stringify({ error: 'name is required' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Determine tenant
    let tenantId: string;
    if (user.role === 'super_admin' && body.tenant_id) {
      tenantId = body.tenant_id;
    } else if (user.role === 'super_admin' && !body.tenant_id) {
      return new Response(
        JSON.stringify({ error: 'tenant_id is required for super_admin' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    } else {
      tenantId = user.tenant_id!;
    }

    // Sanitize inputs
    body.name = sanitizeString(body.name);
    if (body.description) body.description = sanitizeString(body.description);

    const slug = slugify(body.name);

    if (!slug) {
      return new Response(
        JSON.stringify({ error: 'Could not generate a valid slug from name' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Check slug uniqueness within tenant
    const existing = await context.env.DB.prepare(
      'SELECT id FROM document_types WHERE slug = ? AND tenant_id = ?'
    )
      .bind(slug, tenantId)
      .first();

    if (existing) {
      return new Response(
        JSON.stringify({ error: 'A document type with this slug already exists for this tenant' }),
        { status: 409, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const id = generateId();

    await context.env.DB.prepare(
      `INSERT INTO document_types (id, tenant_id, name, slug, description, active)
       VALUES (?, ?, ?, ?, ?, 1)`
    )
      .bind(id, tenantId, body.name, slug, body.description || null)
      .run();

    await logAudit(
      context.env.DB,
      user.id,
      tenantId,
      'document_type_created',
      'document_type',
      id,
      JSON.stringify({ name: body.name, slug }),
      getClientIp(context.request)
    );

    const documentType = await context.env.DB.prepare(
      'SELECT * FROM document_types WHERE id = ?'
    )
      .bind(id)
      .first();

    return new Response(JSON.stringify({ document_type: documentType }), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;

    console.error('Create document type error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
