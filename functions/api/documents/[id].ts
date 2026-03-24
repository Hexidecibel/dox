import { logAudit, getClientIp } from '../../lib/db';
import {
  requireRole,
  requireTenantAccess,
  NotFoundError,
  errorToResponse,
} from '../../lib/permissions';
import { sanitizeString } from '../../lib/validation';
import { computeDiff } from '../../lib/diff';
import type { Env, User, Document } from '../../lib/types';

/**
 * GET /api/documents/:id
 * Get a single document with its current version info.
 */
export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const docId = context.params.id as string;

    const doc = await context.env.DB.prepare(
      `SELECT d.*, u.name as creator_name, u.email as creator_email, t.name as tenant_name, t.slug as tenant_slug
       FROM documents d
       LEFT JOIN users u ON d.created_by = u.id
       LEFT JOIN tenants t ON d.tenant_id = t.id
       WHERE d.id = ? AND d.status != 'deleted'`
    )
      .bind(docId)
      .first();

    if (!doc) {
      throw new NotFoundError('Document not found');
    }

    requireTenantAccess(user, doc.tenant_id as string);

    // Get current version info if one exists
    let currentVersion = null;
    if ((doc.current_version as number) > 0) {
      currentVersion = await context.env.DB.prepare(
        `SELECT dv.*, u.name as uploader_name
         FROM document_versions dv
         LEFT JOIN users u ON dv.uploaded_by = u.id
         WHERE dv.document_id = ? AND dv.version_number = ?`
      )
        .bind(docId, doc.current_version)
        .first();
    }

    return new Response(
      JSON.stringify({ document: doc, currentVersion }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;

    console.error('Get document error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};

/**
 * PUT /api/documents/:id
 * Update document metadata (title, description, category, tags, status).
 * Requires user (own tenant) or admin.
 */
export const onRequestPut: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const docId = context.params.id as string;

    requireRole(user, 'super_admin', 'org_admin', 'user');

    const doc = await context.env.DB.prepare(
      'SELECT * FROM documents WHERE id = ? AND status != \'deleted\''
    )
      .bind(docId)
      .first<Document>();

    if (!doc) {
      throw new NotFoundError('Document not found');
    }

    requireTenantAccess(user, doc.tenant_id);

    const body = (await context.request.json()) as {
      title?: string;
      description?: string;
      category?: string;
      tags?: string[];
      status?: 'active' | 'archived';
    };

    const updates: string[] = [];
    const params: (string | null)[] = [];

    if (body.title !== undefined) {
      updates.push('title = ?');
      params.push(sanitizeString(body.title));
    }
    if (body.description !== undefined) {
      updates.push('description = ?');
      params.push(sanitizeString(body.description));
    }
    if (body.category !== undefined) {
      updates.push('category = ?');
      params.push(sanitizeString(body.category));
    }
    if (body.tags !== undefined) {
      updates.push('tags = ?');
      params.push(JSON.stringify(body.tags));
    }
    if (body.status !== undefined) {
      if (!['active', 'archived'].includes(body.status)) {
        return new Response(
          JSON.stringify({ error: 'status must be active or archived' }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        );
      }
      updates.push('status = ?');
      params.push(body.status);
    }

    if (updates.length === 0) {
      return new Response(
        JSON.stringify({ error: 'No fields to update' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    updates.push('updated_at = datetime(\'now\')');
    params.push(docId);

    // Build new values for diff computation
    const newValues: Record<string, any> = {
      title: body.title !== undefined ? sanitizeString(body.title) : doc.title,
      description: body.description !== undefined ? sanitizeString(body.description) : doc.description,
      category: body.category !== undefined ? sanitizeString(body.category) : doc.category,
      tags: body.tags !== undefined ? body.tags : (doc.tags ? JSON.parse(doc.tags as string) : null),
      status: body.status !== undefined ? body.status : doc.status,
    };

    // Parse tags from old doc for comparison
    const oldDoc: Record<string, any> = {
      ...doc,
      tags: doc.tags ? JSON.parse(doc.tags as string) : null,
    };

    const diff = computeDiff(oldDoc, newValues, ['title', 'description', 'category', 'tags', 'status']);

    await context.env.DB.prepare(
      `UPDATE documents SET ${updates.join(', ')} WHERE id = ?`
    )
      .bind(...params)
      .run();

    await logAudit(
      context.env.DB,
      user.id,
      doc.tenant_id,
      'document_updated',
      'document',
      docId,
      JSON.stringify({ changes: diff }),
      getClientIp(context.request)
    );

    // Fetch updated document
    const updated = await context.env.DB.prepare(
      'SELECT * FROM documents WHERE id = ?'
    )
      .bind(docId)
      .first();

    return new Response(
      JSON.stringify({ document: updated }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;

    console.error('Update document error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};

/**
 * DELETE /api/documents/:id
 * Soft-delete a document by setting status to 'deleted'.
 * Requires user (own tenant) or admin.
 */
export const onRequestDelete: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const docId = context.params.id as string;

    requireRole(user, 'super_admin', 'org_admin', 'user');

    const doc = await context.env.DB.prepare(
      'SELECT * FROM documents WHERE id = ? AND status != \'deleted\''
    )
      .bind(docId)
      .first<Document>();

    if (!doc) {
      throw new NotFoundError('Document not found');
    }

    requireTenantAccess(user, doc.tenant_id);

    await context.env.DB.prepare(
      'UPDATE documents SET status = \'deleted\', updated_at = datetime(\'now\') WHERE id = ?'
    )
      .bind(docId)
      .run();

    await logAudit(
      context.env.DB,
      user.id,
      doc.tenant_id,
      'document_deleted',
      'document',
      docId,
      JSON.stringify({ title: doc.title, previous_status: doc.status }),
      getClientIp(context.request)
    );

    return new Response(
      JSON.stringify({ success: true }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;

    console.error('Delete document error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
