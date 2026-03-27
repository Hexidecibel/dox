import { generateId } from '../../lib/db';
import { logAudit, getClientIp } from '../../lib/db';
import { requireRole, requireTenantAccess, errorToResponse } from '../../lib/permissions';
import { sanitizeString } from '../../lib/validation';
import type { Env, User } from '../../lib/types';

/**
 * GET /api/documents
 * List documents with optional filters.
 * Non-admins are restricted to their own tenant.
 */
export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const url = new URL(context.request.url);

    let tenantId = url.searchParams.get('tenantId');
    const category = url.searchParams.get('category');
    const status = url.searchParams.get('status') || 'active';
    const documentTypeId = url.searchParams.get('document_type_id');
    const lotNumber = url.searchParams.get('lot_number');
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200);
    const offset = parseInt(url.searchParams.get('offset') || '0', 10);

    // Non-super-admins are forced to their own tenant
    if (user.role !== 'super_admin') {
      tenantId = user.tenant_id;
    }

    const conditions: string[] = ['d.status = ?'];
    const params: (string | number)[] = [status];

    if (tenantId) {
      conditions.push('d.tenant_id = ?');
      params.push(tenantId);
    }

    if (category) {
      conditions.push('d.category = ?');
      params.push(category);
    }

    if (documentTypeId) {
      conditions.push('d.document_type_id = ?');
      params.push(documentTypeId);
    }

    if (lotNumber) {
      conditions.push('d.lot_number = ?');
      params.push(lotNumber);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Get total count
    const countQuery = `SELECT COUNT(*) as total FROM documents d ${whereClause}`;
    const countResult = await context.env.DB.prepare(countQuery)
      .bind(...params)
      .first<{ total: number }>();

    // Get documents with creator info
    const query = `
      SELECT d.*, u.name as creator_name, u.email as creator_email, t.name as tenant_name,
             dt.name as document_type_name, dt.slug as document_type_slug
      FROM documents d
      LEFT JOIN users u ON d.created_by = u.id
      LEFT JOIN tenants t ON d.tenant_id = t.id
      LEFT JOIN document_types dt ON d.document_type_id = dt.id
      ${whereClause}
      ORDER BY d.updated_at DESC
      LIMIT ? OFFSET ?
    `;

    const results = await context.env.DB.prepare(query)
      .bind(...params, limit, offset)
      .all();

    return new Response(
      JSON.stringify({
        documents: results.results,
        total: countResult?.total || 0,
        limit,
        offset,
      }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;

    console.error('List documents error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};

/**
 * POST /api/documents
 * Create a new document (metadata only, no file yet).
 * Requires user or admin role.
 */
export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireRole(user, 'super_admin', 'org_admin', 'user');

    const body = (await context.request.json()) as {
      title?: string;
      description?: string;
      category?: string;
      tags?: string[];
      tenantId?: string;
      document_type_id?: string;
      lot_number?: string;
      po_number?: string;
      code_date?: string;
      expiration_date?: string;
    };

    if (!body.title) {
      return new Response(
        JSON.stringify({ error: 'title is required' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Sanitize inputs
    body.title = sanitizeString(body.title);
    if (body.description) body.description = sanitizeString(body.description);
    if (body.category) body.category = sanitizeString(body.category);
    if (body.lot_number) body.lot_number = sanitizeString(body.lot_number);
    if (body.po_number) body.po_number = sanitizeString(body.po_number);
    if (body.code_date) body.code_date = sanitizeString(body.code_date);
    if (body.expiration_date) body.expiration_date = sanitizeString(body.expiration_date);

    // Determine tenant: non-super-admin users are forced to their own tenant
    let tenantId = body.tenantId || null;
    if (user.role !== 'super_admin') {
      tenantId = user.tenant_id;
    }

    if (!tenantId) {
      return new Response(
        JSON.stringify({ error: 'tenantId is required' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Verify tenant access
    requireTenantAccess(user, tenantId);

    // Verify tenant exists
    const tenant = await context.env.DB.prepare(
      'SELECT id FROM tenants WHERE id = ? AND active = 1'
    )
      .bind(tenantId)
      .first();

    if (!tenant) {
      return new Response(
        JSON.stringify({ error: 'Tenant not found or inactive' }),
        { status: 404, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const id = generateId();
    const tags = JSON.stringify(body.tags || []);

    await context.env.DB.prepare(
      `INSERT INTO documents (id, tenant_id, title, description, category, tags, current_version, status, created_by, document_type_id, lot_number, po_number, code_date, expiration_date)
       VALUES (?, ?, ?, ?, ?, ?, 0, 'active', ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        id,
        tenantId,
        body.title,
        body.description || null,
        body.category || null,
        tags,
        user.id,
        body.document_type_id || null,
        body.lot_number || null,
        body.po_number || null,
        body.code_date || null,
        body.expiration_date || null
      )
      .run();

    await logAudit(
      context.env.DB,
      user.id,
      tenantId,
      'document_created',
      'document',
      id,
      JSON.stringify({ title: body.title }),
      getClientIp(context.request)
    );

    return new Response(
      JSON.stringify({
        document: {
          id,
          tenant_id: tenantId,
          title: body.title,
          description: body.description || null,
          category: body.category || null,
          tags,
          current_version: 0,
          status: 'active',
          created_by: user.id,
          document_type_id: body.document_type_id || null,
          lot_number: body.lot_number || null,
          po_number: body.po_number || null,
          code_date: body.code_date || null,
          expiration_date: body.expiration_date || null,
        },
      }),
      { status: 201, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;

    console.error('Create document error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
