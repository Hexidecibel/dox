import { generateId } from '../../lib/db';
import { logAudit, getClientIp } from '../../lib/db';
import { requireRole, requireTenantAccess, errorToResponse } from '../../lib/permissions';
import { sanitizeString } from '../../lib/validation';
import type { Env, User } from '../../lib/types';

function slugify(text: string): string {
  return text.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function parseExtractionFields(docType: Record<string, unknown>): void {
  if (docType.extraction_fields && typeof docType.extraction_fields === 'string') {
    try {
      docType.extraction_fields = JSON.parse(docType.extraction_fields as string);
    } catch {
      // leave as-is if invalid JSON
    }
  }
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

    // Get document types (with tenant name for super_admin view)
    const results = await context.env.DB.prepare(
      `SELECT dt.*, t.name as tenant_name
       FROM document_types dt
       LEFT JOIN tenants t ON dt.tenant_id = t.id
       ${whereClause ? whereClause.replace(/tenant_id/g, 'dt.tenant_id').replace(/active/g, 'dt.active') : ''}
       ORDER BY dt.name ASC LIMIT ? OFFSET ?`
    )
      .bind(...params, limit, offset)
      .all();

    const documentTypes = results.results.map((dt) => {
      parseExtractionFields(dt as Record<string, unknown>);
      return dt;
    });

    return new Response(
      JSON.stringify({
        documentTypes,
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
      auto_ingest?: number;
      extract_tables?: number;
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

    const autoIngest = body.auto_ingest === 1 ? 1 : 0;
    const extractTables = body.extract_tables === 0 ? 0 : 1;

    await context.env.DB.prepare(
      `INSERT INTO document_types (id, tenant_id, name, slug, description, active, auto_ingest, extract_tables)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?)`
    )
      .bind(id, tenantId, body.name, slug, body.description || null, autoIngest, extractTables)
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

    if (documentType) {
      parseExtractionFields(documentType as Record<string, unknown>);
    }

    return new Response(JSON.stringify({ documentType }), {
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
