import {
  requireRole,
  requireTenantAccess,
  NotFoundError,
  BadRequestError,
  errorToResponse,
} from '../../lib/permissions';
import type { Env, User, Document } from '../../lib/types';

/**
 * GET /api/documents/lookup?external_ref=X&tenant_id=Y
 * Look up a document by its external reference ID within a tenant.
 * Returns the document with current version info, or 404 if not found.
 */
export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;

    // Any authenticated role can look up
    requireRole(user, 'super_admin', 'org_admin', 'user', 'reader');

    const url = new URL(context.request.url);
    const externalRef = url.searchParams.get('external_ref');
    const tenantId = url.searchParams.get('tenant_id');

    if (!externalRef) {
      throw new BadRequestError('external_ref query parameter is required');
    }
    if (!tenantId) {
      throw new BadRequestError('tenant_id query parameter is required');
    }

    // Check tenant access
    requireTenantAccess(user, tenantId);

    // Look up document
    const doc = await context.env.DB.prepare(
      `SELECT d.*, u.name as creator_name, u.email as creator_email, t.name as tenant_name, t.slug as tenant_slug
       FROM documents d
       LEFT JOIN users u ON d.created_by = u.id
       LEFT JOIN tenants t ON d.tenant_id = t.id
       WHERE d.external_ref = ? AND d.tenant_id = ? AND d.status != 'deleted'`
    )
      .bind(externalRef, tenantId)
      .first();

    if (!doc) {
      throw new NotFoundError('Document not found');
    }

    // Get current version info
    const currentVersion = await context.env.DB.prepare(
      `SELECT dv.*, u.name as uploader_name, u.email as uploader_email
       FROM document_versions dv
       LEFT JOIN users u ON dv.uploaded_by = u.id
       WHERE dv.document_id = ? AND dv.version_number = ?`
    )
      .bind(doc.id as string, doc.current_version as number)
      .first();

    return new Response(
      JSON.stringify({
        document: doc,
        currentVersion: currentVersion || null,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;

    console.error('Lookup error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
