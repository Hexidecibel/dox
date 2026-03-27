import { logAudit, getClientIp } from '../../lib/db';
import {
  requireRole,
  requireTenantAccess,
  NotFoundError,
  errorToResponse,
} from '../../lib/permissions';
import { sanitizeString } from '../../lib/validation';
import type { Env, User } from '../../lib/types';

/**
 * GET /api/bundles/:id
 * Get a bundle with its items.
 */
export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const bundleId = context.params.id as string;

    const bundle = await context.env.DB.prepare(
      `SELECT b.*, u.name as creator_name, p.name as product_name,
              (SELECT COUNT(*) FROM document_bundle_items WHERE bundle_id = b.id) as item_count
       FROM document_bundles b
       LEFT JOIN users u ON b.created_by = u.id
       LEFT JOIN products p ON b.product_id = p.id
       WHERE b.id = ?`
    )
      .bind(bundleId)
      .first();

    if (!bundle) {
      throw new NotFoundError('Bundle not found');
    }

    requireTenantAccess(user, bundle.tenant_id as string);

    // Get items with document details
    const items = await context.env.DB.prepare(
      `SELECT bi.*, d.title as document_title, dt.name as document_type_name,
              dv.file_name, dv.file_size, dv.mime_type
       FROM document_bundle_items bi
       INNER JOIN documents d ON bi.document_id = d.id
       LEFT JOIN document_types dt ON d.document_type_id = dt.id
       LEFT JOIN document_versions dv ON dv.document_id = d.id
         AND dv.version_number = COALESCE(bi.version_number, d.current_version)
       WHERE bi.bundle_id = ?
       ORDER BY bi.sort_order ASC, bi.created_at ASC`
    )
      .bind(bundleId)
      .all();

    return new Response(
      JSON.stringify({ bundle, items: items.results }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;

    console.error('Get bundle error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};

/**
 * PUT /api/bundles/:id
 * Update bundle metadata. Only draft bundles (unless super_admin).
 */
export const onRequestPut: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const bundleId = context.params.id as string;

    requireRole(user, 'super_admin', 'org_admin', 'user');

    const bundle = await context.env.DB.prepare(
      'SELECT * FROM document_bundles WHERE id = ?'
    )
      .bind(bundleId)
      .first();

    if (!bundle) {
      throw new NotFoundError('Bundle not found');
    }

    requireTenantAccess(user, bundle.tenant_id as string);

    // Only allow updates on draft bundles unless super_admin
    if (bundle.status !== 'draft' && user.role !== 'super_admin') {
      return new Response(
        JSON.stringify({ error: 'Cannot modify a finalized bundle' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const body = (await context.request.json()) as {
      name?: string;
      description?: string;
      product_id?: string | null;
      status?: 'draft' | 'finalized';
    };

    const updates: string[] = [];
    const params: (string | null)[] = [];

    if (body.name !== undefined) {
      updates.push('name = ?');
      params.push(sanitizeString(body.name));
    }
    if (body.description !== undefined) {
      updates.push('description = ?');
      params.push(body.description ? sanitizeString(body.description) : null);
    }
    if (body.product_id !== undefined) {
      updates.push('product_id = ?');
      params.push(body.product_id);
    }
    if (body.status !== undefined) {
      if (!['draft', 'finalized'].includes(body.status)) {
        return new Response(
          JSON.stringify({ error: 'status must be draft or finalized' }),
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

    updates.push("updated_at = datetime('now')");
    params.push(bundleId);

    await context.env.DB.prepare(
      `UPDATE document_bundles SET ${updates.join(', ')} WHERE id = ?`
    )
      .bind(...params)
      .run();

    await logAudit(
      context.env.DB,
      user.id,
      bundle.tenant_id as string,
      'bundle_updated',
      'bundle',
      bundleId,
      JSON.stringify({ changes: body }),
      getClientIp(context.request)
    );

    const updated = await context.env.DB.prepare(
      `SELECT b.*, u.name as creator_name, p.name as product_name,
              (SELECT COUNT(*) FROM document_bundle_items WHERE bundle_id = b.id) as item_count
       FROM document_bundles b
       LEFT JOIN users u ON b.created_by = u.id
       LEFT JOIN products p ON b.product_id = p.id
       WHERE b.id = ?`
    )
      .bind(bundleId)
      .first();

    return new Response(
      JSON.stringify({ bundle: updated }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;

    console.error('Update bundle error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};

/**
 * DELETE /api/bundles/:id
 * Delete a bundle. Requires user+ with tenant access.
 */
export const onRequestDelete: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const bundleId = context.params.id as string;

    requireRole(user, 'super_admin', 'org_admin', 'user');

    const bundle = await context.env.DB.prepare(
      'SELECT * FROM document_bundles WHERE id = ?'
    )
      .bind(bundleId)
      .first();

    if (!bundle) {
      throw new NotFoundError('Bundle not found');
    }

    requireTenantAccess(user, bundle.tenant_id as string);

    // CASCADE will delete bundle items
    await context.env.DB.prepare(
      'DELETE FROM document_bundles WHERE id = ?'
    )
      .bind(bundleId)
      .run();

    await logAudit(
      context.env.DB,
      user.id,
      bundle.tenant_id as string,
      'bundle_deleted',
      'bundle',
      bundleId,
      JSON.stringify({ name: bundle.name }),
      getClientIp(context.request)
    );

    return new Response(
      JSON.stringify({ success: true }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;

    console.error('Delete bundle error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
