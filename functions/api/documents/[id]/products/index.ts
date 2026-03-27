import { generateId } from '../../../../lib/db';
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
 * GET /api/documents/:id/products
 * List products linked to a document via document_products.
 * Tenant-scoped: user must have access to the document's tenant.
 */
export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const docId = context.params.id as string;

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

    const results = await context.env.DB.prepare(
      `SELECT dp.*, p.name as product_name, p.slug as product_slug
       FROM document_products dp
       INNER JOIN products p ON dp.product_id = p.id
       WHERE dp.document_id = ?
       ORDER BY p.name ASC`
    )
      .bind(docId)
      .all();

    return new Response(
      JSON.stringify({ products: results.results }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;

    console.error('List document products error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};

/**
 * POST /api/documents/:id/products
 * Link a product to a document.
 * Body: { product_id: string, expires_at?: string, notes?: string }
 * Requires user+ role with tenant access.
 */
export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const docId = context.params.id as string;

    requireRole(user, 'super_admin', 'org_admin', 'user');

    // Verify document exists and user has tenant access
    const doc = await context.env.DB.prepare(
      "SELECT id, tenant_id, title FROM documents WHERE id = ? AND status != 'deleted'"
    )
      .bind(docId)
      .first<{ id: string; tenant_id: string; title: string }>();

    if (!doc) {
      throw new NotFoundError('Document not found');
    }

    requireTenantAccess(user, doc.tenant_id);

    const body = (await context.request.json()) as {
      product_id?: string;
      expires_at?: string;
      notes?: string;
    };

    if (!body.product_id) {
      throw new BadRequestError('product_id is required');
    }

    // Verify product exists and is active
    const product = await context.env.DB.prepare(
      'SELECT id, name, active FROM products WHERE id = ?'
    )
      .bind(body.product_id)
      .first<{ id: string; name: string; active: number }>();

    if (!product) {
      throw new NotFoundError('Product not found');
    }

    if (!product.active) {
      throw new BadRequestError('Product is not active');
    }

    const id = generateId();

    try {
      await context.env.DB.prepare(
        `INSERT INTO document_products (id, document_id, product_id, expires_at, notes)
         VALUES (?, ?, ?, ?, ?)`
      )
        .bind(id, docId, body.product_id, body.expires_at || null, body.notes || null)
        .run();
    } catch (e: any) {
      if (e.message?.includes('UNIQUE constraint')) {
        throw new BadRequestError('This product is already linked to this document');
      }
      throw e;
    }

    await logAudit(
      context.env.DB,
      user.id,
      doc.tenant_id,
      'document_product_linked',
      'document',
      docId,
      JSON.stringify({ product_id: body.product_id, product_name: product.name, expires_at: body.expires_at || null }),
      getClientIp(context.request)
    );

    // Return the created link with product info
    const link = await context.env.DB.prepare(
      `SELECT dp.*, p.name as product_name, p.slug as product_slug
       FROM document_products dp
       INNER JOIN products p ON dp.product_id = p.id
       WHERE dp.id = ?`
    )
      .bind(id)
      .first();

    return new Response(
      JSON.stringify({ documentProduct: link }),
      { status: 201, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;

    console.error('Link document product error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
