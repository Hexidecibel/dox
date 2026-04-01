import { logAudit, getClientIp } from '../../lib/db';
import {
  requireRole,
  requireTenantAccess,
  NotFoundError,
  errorToResponse,
} from '../../lib/permissions';
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
 * GET /api/document-types/:id
 * Get a single document type. Must belong to user's tenant (or super_admin).
 */
export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const docTypeId = context.params.id as string;

    const documentType = await context.env.DB.prepare(
      'SELECT * FROM document_types WHERE id = ?'
    )
      .bind(docTypeId)
      .first();

    if (!documentType) {
      throw new NotFoundError('Document type not found');
    }

    // Tenant access check
    requireTenantAccess(user, documentType.tenant_id as string);

    parseExtractionFields(documentType as Record<string, unknown>);

    return new Response(
      JSON.stringify({ documentType }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;

    console.error('Get document type error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};

/**
 * PUT /api/document-types/:id
 * Update a document type. org_admin+ for own tenant.
 * Fields: name, description, active. If name changes, slug is updated too.
 */
export const onRequestPut: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const docTypeId = context.params.id as string;

    requireRole(user, 'super_admin', 'org_admin');

    const documentType = await context.env.DB.prepare(
      'SELECT * FROM document_types WHERE id = ?'
    )
      .bind(docTypeId)
      .first();

    if (!documentType) {
      throw new NotFoundError('Document type not found');
    }

    // Tenant access check (org_admin can only update their own tenant's types)
    requireTenantAccess(user, documentType.tenant_id as string);

    const body = (await context.request.json()) as {
      name?: string;
      description?: string;
      active?: number;
      naming_format?: string | null;
      extraction_fields?: Array<{ name: string; hint?: string; aliases?: string[] }> | null;
    };

    const updates: string[] = [];
    const params: (string | number | null)[] = [];

    if (body.name !== undefined) {
      const name = sanitizeString(body.name);
      if (!name) {
        return new Response(
          JSON.stringify({ error: 'name cannot be empty' }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        );
      }
      updates.push('name = ?');
      params.push(name);

      // Update slug when name changes
      const newSlug = slugify(name);
      if (!newSlug) {
        return new Response(
          JSON.stringify({ error: 'Could not generate a valid slug from name' }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        );
      }

      // Check slug uniqueness within tenant (exclude current record)
      const existing = await context.env.DB.prepare(
        'SELECT id FROM document_types WHERE slug = ? AND tenant_id = ? AND id != ?'
      )
        .bind(newSlug, documentType.tenant_id, docTypeId)
        .first();

      if (existing) {
        return new Response(
          JSON.stringify({ error: 'A document type with this slug already exists for this tenant' }),
          { status: 409, headers: { 'Content-Type': 'application/json' } }
        );
      }

      updates.push('slug = ?');
      params.push(newSlug);
    }

    if (body.description !== undefined) {
      updates.push('description = ?');
      params.push(body.description ? sanitizeString(body.description) : null);
    }

    if (body.active !== undefined) {
      if (body.active !== 0 && body.active !== 1) {
        return new Response(
          JSON.stringify({ error: 'active must be 0 or 1' }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        );
      }
      updates.push('active = ?');
      params.push(body.active);
    }

    if (body.naming_format !== undefined) {
      if (body.naming_format !== null && typeof body.naming_format !== 'string') {
        return new Response(
          JSON.stringify({ error: 'naming_format must be a string or null' }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (body.naming_format && body.naming_format.length > 500) {
        return new Response(
          JSON.stringify({ error: 'naming_format must be 500 characters or less' }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        );
      }
      updates.push('naming_format = ?');
      params.push(body.naming_format ? body.naming_format.trim() : null);
    }

    if (body.extraction_fields !== undefined) {
      if (body.extraction_fields === null) {
        updates.push('extraction_fields = ?');
        params.push(null);
      } else {
        if (!Array.isArray(body.extraction_fields)) {
          return new Response(
            JSON.stringify({ error: 'extraction_fields must be an array or null' }),
            { status: 400, headers: { 'Content-Type': 'application/json' } }
          );
        }
        for (const ef of body.extraction_fields) {
          if (typeof ef.name !== 'string' || !ef.name.trim()) {
            return new Response(
              JSON.stringify({ error: 'extraction_fields: each entry must have a non-empty name string' }),
              { status: 400, headers: { 'Content-Type': 'application/json' } }
            );
          }
          if (ef.hint !== undefined && typeof ef.hint !== 'string') {
            return new Response(
              JSON.stringify({ error: 'extraction_fields: hint must be a string if provided' }),
              { status: 400, headers: { 'Content-Type': 'application/json' } }
            );
          }
          if (ef.aliases !== undefined && (!Array.isArray(ef.aliases) || !ef.aliases.every((a: unknown) => typeof a === 'string'))) {
            return new Response(
              JSON.stringify({ error: 'extraction_fields: aliases must be an array of strings if provided' }),
              { status: 400, headers: { 'Content-Type': 'application/json' } }
            );
          }
        }
        updates.push('extraction_fields = ?');
        params.push(JSON.stringify(body.extraction_fields));
      }
    }

    if (updates.length === 0) {
      return new Response(
        JSON.stringify({ error: 'No fields to update' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    updates.push("updated_at = datetime('now')");
    params.push(docTypeId);

    await context.env.DB.prepare(
      `UPDATE document_types SET ${updates.join(', ')} WHERE id = ?`
    )
      .bind(...params)
      .run();

    await logAudit(
      context.env.DB,
      user.id,
      documentType.tenant_id as string,
      'document_type_updated',
      'document_type',
      docTypeId,
      JSON.stringify({ changes: body }),
      getClientIp(context.request)
    );

    const updated = await context.env.DB.prepare(
      'SELECT * FROM document_types WHERE id = ?'
    )
      .bind(docTypeId)
      .first();

    if (updated) {
      parseExtractionFields(updated as Record<string, unknown>);
    }

    return new Response(
      JSON.stringify({ documentType: updated }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;

    console.error('Update document type error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};

/**
 * DELETE /api/document-types/:id
 * Soft-delete a document type (set active=0). org_admin+ for own tenant.
 */
export const onRequestDelete: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const docTypeId = context.params.id as string;

    requireRole(user, 'super_admin', 'org_admin');

    const documentType = await context.env.DB.prepare(
      'SELECT * FROM document_types WHERE id = ?'
    )
      .bind(docTypeId)
      .first();

    if (!documentType) {
      throw new NotFoundError('Document type not found');
    }

    // Tenant access check
    requireTenantAccess(user, documentType.tenant_id as string);

    // Soft-delete
    await context.env.DB.prepare(
      "UPDATE document_types SET active = 0, updated_at = datetime('now') WHERE id = ?"
    )
      .bind(docTypeId)
      .run();

    await logAudit(
      context.env.DB,
      user.id,
      documentType.tenant_id as string,
      'document_type_deleted',
      'document_type',
      docTypeId,
      JSON.stringify({ name: documentType.name }),
      getClientIp(context.request)
    );

    return new Response(
      JSON.stringify({ success: true }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;

    console.error('Delete document type error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
