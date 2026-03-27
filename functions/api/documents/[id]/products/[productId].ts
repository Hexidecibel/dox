import { logAudit, getClientIp } from '../../../../lib/db';
import {
  requireRole,
  requireTenantAccess,
  NotFoundError,
  BadRequestError,
  errorToResponse,
} from '../../../../lib/permissions';
import type { Env, User } from '../../../../lib/types';

/**
 * PUT /api/documents/:id/products/:productId
 * Update a document-product link (expires_at, notes).
 * Requires user+ role with tenant access.
 */
export const onRequestPut: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const docId = context.params.id as string;
    const productId = context.params.productId as string;

    requireRole(user, 'super_admin', 'org_admin', 'user');

    // Verify document exists and user has tenant access
    const doc = await context.env.DB.prepare(
      "SELECT id, tenant_id FROM documents WHERE id = ? AND status != 'deleted'"
    )
      .bind(docId)
      .first<{ id: string; tenant_id: string }>();

    if (!doc) {
      throw new NotFoundError('Document not found');
    }

    requireTenantAccess(user, doc.tenant_id);

    // Verify the link exists
    const link = await context.env.DB.prepare(
      'SELECT id FROM document_products WHERE document_id = ? AND product_id = ?'
    )
      .bind(docId, productId)
      .first<{ id: string }>();

    if (!link) {
      throw new NotFoundError('Document-product link not found');
    }

    const body = (await context.request.json()) as {
      expires_at?: string | null;
      notes?: string | null;
    };

    const updates: string[] = [];
    const params: (string | null)[] = [];

    if (body.expires_at !== undefined) {
      updates.push('expires_at = ?');
      params.push(body.expires_at || null);
    }

    if (body.notes !== undefined) {
      updates.push('notes = ?');
      params.push(body.notes || null);
    }

    if (updates.length === 0) {
      throw new BadRequestError('No fields to update');
    }

    updates.push("updated_at = datetime('now')");
    params.push(link.id);

    await context.env.DB.prepare(
      `UPDATE document_products SET ${updates.join(', ')} WHERE id = ?`
    )
      .bind(...params)
      .run();

    // Return updated link
    const updated = await context.env.DB.prepare(
      `SELECT dp.*, p.name as product_name, p.slug as product_slug
       FROM document_products dp
       INNER JOIN products p ON dp.product_id = p.id
       WHERE dp.id = ?`
    )
      .bind(link.id)
      .first();

    return new Response(
      JSON.stringify({ documentProduct: updated }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;

    console.error('Update document product link error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};

/**
 * DELETE /api/documents/:id/products/:productId
 * Remove a document-product link.
 * Requires user+ role with tenant access.
 */
export const onRequestDelete: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const docId = context.params.id as string;
    const productId = context.params.productId as string;

    requireRole(user, 'super_admin', 'org_admin', 'user');

    // Verify document exists and user has tenant access
    const doc = await context.env.DB.prepare(
      "SELECT id, tenant_id FROM documents WHERE id = ? AND status != 'deleted'"
    )
      .bind(docId)
      .first<{ id: string; tenant_id: string }>();

    if (!doc) {
      throw new NotFoundError('Document not found');
    }

    requireTenantAccess(user, doc.tenant_id);

    // Verify the link exists
    const link = await context.env.DB.prepare(
      'SELECT dp.id, p.name as product_name FROM document_products dp INNER JOIN products p ON dp.product_id = p.id WHERE dp.document_id = ? AND dp.product_id = ?'
    )
      .bind(docId, productId)
      .first<{ id: string; product_name: string }>();

    if (!link) {
      throw new NotFoundError('Document-product link not found');
    }

    await context.env.DB.prepare(
      'DELETE FROM document_products WHERE id = ?'
    )
      .bind(link.id)
      .run();

    await logAudit(
      context.env.DB,
      user.id,
      doc.tenant_id,
      'document_product_unlinked',
      'document',
      docId,
      JSON.stringify({ product_id: productId, product_name: link.product_name }),
      getClientIp(context.request)
    );

    return new Response(
      JSON.stringify({ success: true }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;

    console.error('Unlink document product error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
