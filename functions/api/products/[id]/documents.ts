import { NotFoundError, errorToResponse, requireTenantAccess } from '../../../lib/permissions';
import type { Env, User } from '../../../lib/types';

/**
 * GET /api/products/:id/documents
 * List documents linked to this product via the document_products join table.
 * Tenant-scoped: non-super_admins only see their tenant's documents.
 * Supports pagination (limit, offset).
 */
export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const productId = context.params.id as string;
    const url = new URL(context.request.url);
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200);
    const offset = parseInt(url.searchParams.get('offset') || '0', 10);

    // Verify product exists
    const product = await context.env.DB.prepare(
      'SELECT * FROM products WHERE id = ?'
    )
      .bind(productId)
      .first();

    if (!product) {
      throw new NotFoundError('Product not found');
    }

    // Build tenant filter for non-super_admins
    const tenantCondition = user.role !== 'super_admin' ? 'AND d.tenant_id = ?' : '';
    const tenantParams = user.role !== 'super_admin' ? [user.tenant_id] : [];

    // Get total count
    const countResult = await context.env.DB.prepare(
      `SELECT COUNT(*) as total
       FROM documents d
       INNER JOIN document_products dp ON d.id = dp.document_id
       WHERE dp.product_id = ? AND d.status != 'deleted' ${tenantCondition}`
    )
      .bind(productId, ...tenantParams)
      .first<{ total: number }>();

    // Get documents with link info
    const results = await context.env.DB.prepare(
      `SELECT d.*, u.name as creator_name, t.name as tenant_name,
              dt.name as document_type_name,
              dp.expires_at as link_expires_at, dp.notes as link_notes
       FROM documents d
       INNER JOIN document_products dp ON d.id = dp.document_id
       LEFT JOIN users u ON d.created_by = u.id
       LEFT JOIN tenants t ON d.tenant_id = t.id
       LEFT JOIN document_types dt ON d.document_type_id = dt.id
       WHERE dp.product_id = ? AND d.status != 'deleted' ${tenantCondition}
       ORDER BY d.updated_at DESC
       LIMIT ? OFFSET ?`
    )
      .bind(productId, ...tenantParams, limit, offset)
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

    console.error('List product documents error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
