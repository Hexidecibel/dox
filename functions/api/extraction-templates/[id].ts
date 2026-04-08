import { logAudit, getClientIp } from '../../lib/db';
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
 * GET /api/extraction-templates/:id
 * Get a single extraction template. Must belong to user's tenant (or super_admin).
 */
export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const templateId = context.params.id as string;

    const template = await context.env.DB.prepare(
      `SELECT et.*, s.name as supplier_name, dt.name as document_type_name
       FROM extraction_templates et
       LEFT JOIN suppliers s ON et.supplier_id = s.id
       LEFT JOIN document_types dt ON et.document_type_id = dt.id
       WHERE et.id = ?`
    )
      .bind(templateId)
      .first();

    if (!template) {
      throw new NotFoundError('Extraction template not found');
    }

    // Tenant access check
    requireTenantAccess(user, template.tenant_id as string);

    parseFieldMappings(template as Record<string, unknown>);

    return new Response(
      JSON.stringify({ template }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;

    console.error('Get extraction template error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};

/**
 * PUT /api/extraction-templates/:id
 * Update an extraction template. org_admin+ for own tenant.
 * Fields: field_mappings, auto_ingest_enabled, confidence_threshold.
 */
export const onRequestPut: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const templateId = context.params.id as string;

    requireRole(user, 'super_admin', 'org_admin');

    const template = await context.env.DB.prepare(
      'SELECT * FROM extraction_templates WHERE id = ?'
    )
      .bind(templateId)
      .first();

    if (!template) {
      throw new NotFoundError('Extraction template not found');
    }

    // Tenant access check
    requireTenantAccess(user, template.tenant_id as string);

    const body = (await context.request.json()) as {
      field_mappings?: unknown[];
      auto_ingest_enabled?: number;
      confidence_threshold?: number;
    };

    const updates: string[] = [];
    const params: (string | number | null)[] = [];

    if (body.field_mappings !== undefined) {
      if (!Array.isArray(body.field_mappings)) {
        throw new BadRequestError('field_mappings must be an array');
      }
      updates.push('field_mappings = ?');
      params.push(JSON.stringify(body.field_mappings));
    }

    if (body.auto_ingest_enabled !== undefined) {
      if (body.auto_ingest_enabled !== 0 && body.auto_ingest_enabled !== 1) {
        throw new BadRequestError('auto_ingest_enabled must be 0 or 1');
      }
      updates.push('auto_ingest_enabled = ?');
      params.push(body.auto_ingest_enabled);
    }

    if (body.confidence_threshold !== undefined) {
      if (typeof body.confidence_threshold !== 'number' || body.confidence_threshold < 0 || body.confidence_threshold > 1) {
        throw new BadRequestError('confidence_threshold must be a number between 0 and 1');
      }
      updates.push('confidence_threshold = ?');
      params.push(body.confidence_threshold);
    }

    if (updates.length === 0) {
      throw new BadRequestError('No fields to update');
    }

    updates.push("updated_at = datetime('now')");
    params.push(templateId);

    await context.env.DB.prepare(
      `UPDATE extraction_templates SET ${updates.join(', ')} WHERE id = ?`
    )
      .bind(...params)
      .run();

    await logAudit(
      context.env.DB,
      user.id,
      template.tenant_id as string,
      'extraction_template_updated',
      'extraction_template',
      templateId,
      JSON.stringify({ changes: body }),
      getClientIp(context.request)
    );

    // Return updated template with joined names
    const updated = await context.env.DB.prepare(
      `SELECT et.*, s.name as supplier_name, dt.name as document_type_name
       FROM extraction_templates et
       LEFT JOIN suppliers s ON et.supplier_id = s.id
       LEFT JOIN document_types dt ON et.document_type_id = dt.id
       WHERE et.id = ?`
    )
      .bind(templateId)
      .first();

    if (updated) {
      parseFieldMappings(updated as Record<string, unknown>);
    }

    return new Response(
      JSON.stringify({ template: updated }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;

    console.error('Update extraction template error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};

/**
 * DELETE /api/extraction-templates/:id
 * Hard delete an extraction template. org_admin+ for own tenant.
 */
export const onRequestDelete: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const templateId = context.params.id as string;

    requireRole(user, 'super_admin', 'org_admin');

    const template = await context.env.DB.prepare(
      'SELECT * FROM extraction_templates WHERE id = ?'
    )
      .bind(templateId)
      .first();

    if (!template) {
      throw new NotFoundError('Extraction template not found');
    }

    // Tenant access check
    requireTenantAccess(user, template.tenant_id as string);

    // Hard delete
    await context.env.DB.prepare(
      'DELETE FROM extraction_templates WHERE id = ?'
    )
      .bind(templateId)
      .run();

    await logAudit(
      context.env.DB,
      user.id,
      template.tenant_id as string,
      'extraction_template_deleted',
      'extraction_template',
      templateId,
      JSON.stringify({ supplier_id: template.supplier_id, document_type_id: template.document_type_id }),
      getClientIp(context.request)
    );

    return new Response(
      JSON.stringify({ success: true }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;

    console.error('Delete extraction template error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
