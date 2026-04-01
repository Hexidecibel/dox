import {
  requireRole,
  requireTenantAccess,
  NotFoundError,
  BadRequestError,
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
 * GET /api/document-types/by-slug?slug=X&tenant_id=Y
 * Also accepts: ?name=X&tenant_id=Y (derives slug server-side)
 * Look up a document type by slug within a tenant.
 */
export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireRole(user, 'super_admin', 'org_admin', 'user', 'reader');

    const url = new URL(context.request.url);
    const slugParam = url.searchParams.get('slug');
    const nameParam = url.searchParams.get('name');
    const tenantId = url.searchParams.get('tenant_id');

    if (!tenantId) {
      throw new BadRequestError('tenant_id query parameter is required');
    }

    if (!slugParam && !nameParam) {
      throw new BadRequestError('Either slug or name query parameter is required');
    }

    requireTenantAccess(user, tenantId);

    let lookupSlug: string;
    if (slugParam) {
      lookupSlug = sanitizeString(slugParam);
    } else {
      lookupSlug = slugify(sanitizeString(nameParam!));
      if (!lookupSlug) {
        throw new BadRequestError('Could not derive a valid slug from name');
      }
    }

    const documentType = await context.env.DB.prepare(
      'SELECT * FROM document_types WHERE slug = ? AND tenant_id = ? AND active = 1'
    )
      .bind(lookupSlug, tenantId)
      .first();

    if (!documentType) {
      throw new NotFoundError('Document type not found');
    }

    parseExtractionFields(documentType as Record<string, unknown>);

    return new Response(
      JSON.stringify({ documentType }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;

    console.error('[Document type by-slug] error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
