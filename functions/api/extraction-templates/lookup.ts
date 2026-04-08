import {
  requireRole,
  requireTenantAccess,
  NotFoundError,
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
 * GET /api/extraction-templates/lookup?supplier_id=X&document_type_id=Y&tenant_id=Z
 * Look up a single extraction template by supplier + document type.
 * This is the hot path used by the results endpoint and frontend.
 * Auth: super_admin, org_admin, user (accessible for API key auth from worker).
 */
export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireRole(user, 'super_admin', 'org_admin', 'user');

    const url = new URL(context.request.url);
    const supplierId = url.searchParams.get('supplier_id');
    const documentTypeId = url.searchParams.get('document_type_id');
    const tenantIdParam = url.searchParams.get('tenant_id');

    if (!supplierId) {
      throw new BadRequestError('supplier_id is required');
    }
    if (!documentTypeId) {
      throw new BadRequestError('document_type_id is required');
    }

    // Determine tenant
    let tenantId: string;
    if (user.role === 'super_admin') {
      if (!tenantIdParam) {
        throw new BadRequestError('tenant_id is required for super_admin');
      }
      tenantId = tenantIdParam;
    } else {
      tenantId = user.tenant_id!;
    }

    // Tenant access check
    requireTenantAccess(user, tenantId);

    const template = await context.env.DB.prepare(
      `SELECT et.*, s.name as supplier_name, dt.name as document_type_name
       FROM extraction_templates et
       LEFT JOIN suppliers s ON et.supplier_id = s.id
       LEFT JOIN document_types dt ON et.document_type_id = dt.id
       WHERE et.tenant_id = ? AND et.supplier_id = ? AND et.document_type_id = ?`
    )
      .bind(tenantId, supplierId, documentTypeId)
      .first();

    if (!template) {
      throw new NotFoundError('Extraction template not found');
    }

    parseFieldMappings(template as Record<string, unknown>);

    return new Response(
      JSON.stringify({ template }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;

    console.error('Lookup extraction template error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
