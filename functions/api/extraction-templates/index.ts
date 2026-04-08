import { generateId } from '../../lib/db';
import { logAudit, getClientIp } from '../../lib/db';
import {
  requireRole,
  requireTenantAccess,
  BadRequestError,
  errorToResponse,
} from '../../lib/permissions';
import type { Env, User } from '../../lib/types';

function parseFieldMappings(row: Record<string, unknown>): void {
  if (row.field_mappings && typeof row.field_mappings === 'string') {
    try {
      row.field_mappings = JSON.parse(row.field_mappings as string);
    } catch {
      // leave as-is if invalid JSON
    }
  }
}

/**
 * GET /api/extraction-templates
 * List extraction templates. super_admin can query any tenant, others scoped to their tenant.
 * Supports ?tenant_id, ?supplier_id, ?document_type_id, ?limit, ?offset.
 */
export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireRole(user, 'super_admin', 'org_admin');

    const url = new URL(context.request.url);
    const tenantIdParam = url.searchParams.get('tenant_id');
    const supplierIdParam = url.searchParams.get('supplier_id');
    const documentTypeIdParam = url.searchParams.get('document_type_id');
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200);
    const offset = parseInt(url.searchParams.get('offset') || '0', 10);

    const conditions: string[] = [];
    const params: (string | number)[] = [];

    // Tenant scoping
    if (user.role === 'super_admin') {
      if (tenantIdParam) {
        conditions.push('et.tenant_id = ?');
        params.push(tenantIdParam);
      }
    } else {
      conditions.push('et.tenant_id = ?');
      params.push(user.tenant_id!);
    }

    if (supplierIdParam) {
      conditions.push('et.supplier_id = ?');
      params.push(supplierIdParam);
    }

    if (documentTypeIdParam) {
      conditions.push('et.document_type_id = ?');
      params.push(documentTypeIdParam);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Get total count
    const countResult = await context.env.DB.prepare(
      `SELECT COUNT(*) as total FROM extraction_templates et ${whereClause}`
    )
      .bind(...params)
      .first<{ total: number }>();

    // Get templates with joined supplier and document type names
    const results = await context.env.DB.prepare(
      `SELECT et.*, s.name as supplier_name, dt.name as document_type_name
       FROM extraction_templates et
       LEFT JOIN suppliers s ON et.supplier_id = s.id
       LEFT JOIN document_types dt ON et.document_type_id = dt.id
       ${whereClause}
       ORDER BY et.created_at DESC LIMIT ? OFFSET ?`
    )
      .bind(...params, limit, offset)
      .all();

    const templates = results.results.map((row) => {
      parseFieldMappings(row as Record<string, unknown>);
      return row;
    });

    return new Response(
      JSON.stringify({
        templates,
        total: countResult?.total || 0,
        limit,
        offset,
      }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;

    console.error('List extraction templates error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};

/**
 * POST /api/extraction-templates
 * Create a new extraction template. org_admin+ for their own tenant.
 * super_admin can specify tenant_id.
 */
export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireRole(user, 'super_admin', 'org_admin');

    const body = (await context.request.json()) as {
      tenant_id?: string;
      supplier_id?: string;
      document_type_id?: string;
      field_mappings?: unknown[];
      auto_ingest_enabled?: number;
      confidence_threshold?: number;
    };

    if (!body.supplier_id) {
      throw new BadRequestError('supplier_id is required');
    }
    if (!body.document_type_id) {
      throw new BadRequestError('document_type_id is required');
    }
    if (!body.field_mappings || !Array.isArray(body.field_mappings)) {
      throw new BadRequestError('field_mappings is required and must be an array');
    }

    // Determine tenant
    let tenantId: string;
    if (user.role === 'super_admin' && body.tenant_id) {
      tenantId = body.tenant_id;
    } else if (user.role === 'super_admin' && !body.tenant_id) {
      throw new BadRequestError('tenant_id is required for super_admin');
    } else {
      tenantId = user.tenant_id!;
    }

    // Validate supplier belongs to tenant
    const supplier = await context.env.DB.prepare(
      'SELECT id FROM suppliers WHERE id = ? AND tenant_id = ?'
    )
      .bind(body.supplier_id, tenantId)
      .first();

    if (!supplier) {
      throw new BadRequestError('Supplier not found or does not belong to this tenant');
    }

    // Validate document type belongs to tenant
    const docType = await context.env.DB.prepare(
      'SELECT id FROM document_types WHERE id = ? AND tenant_id = ?'
    )
      .bind(body.document_type_id, tenantId)
      .first();

    if (!docType) {
      throw new BadRequestError('Document type not found or does not belong to this tenant');
    }

    // Check uniqueness (tenant + supplier + doc type)
    const existing = await context.env.DB.prepare(
      'SELECT id FROM extraction_templates WHERE tenant_id = ? AND supplier_id = ? AND document_type_id = ?'
    )
      .bind(tenantId, body.supplier_id, body.document_type_id)
      .first();

    if (existing) {
      return new Response(
        JSON.stringify({ error: 'An extraction template already exists for this supplier and document type' }),
        { status: 409, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const id = generateId();
    const autoIngestEnabled = body.auto_ingest_enabled === 1 ? 1 : 0;
    const confidenceThreshold = typeof body.confidence_threshold === 'number'
      ? body.confidence_threshold
      : 0.85;

    await context.env.DB.prepare(
      `INSERT INTO extraction_templates (id, tenant_id, supplier_id, document_type_id, field_mappings, auto_ingest_enabled, confidence_threshold, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        id,
        tenantId,
        body.supplier_id,
        body.document_type_id,
        JSON.stringify(body.field_mappings),
        autoIngestEnabled,
        confidenceThreshold,
        user.id
      )
      .run();

    await logAudit(
      context.env.DB,
      user.id,
      tenantId,
      'extraction_template_created',
      'extraction_template',
      id,
      JSON.stringify({ supplier_id: body.supplier_id, document_type_id: body.document_type_id }),
      getClientIp(context.request)
    );

    // Return the created template with joined names
    const template = await context.env.DB.prepare(
      `SELECT et.*, s.name as supplier_name, dt.name as document_type_name
       FROM extraction_templates et
       LEFT JOIN suppliers s ON et.supplier_id = s.id
       LEFT JOIN document_types dt ON et.document_type_id = dt.id
       WHERE et.id = ?`
    )
      .bind(id)
      .first();

    if (template) {
      parseFieldMappings(template as Record<string, unknown>);
    }

    return new Response(JSON.stringify({ template }), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;

    console.error('Create extraction template error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
