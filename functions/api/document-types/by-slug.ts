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
 * Also accepts: ?name=X&tenant_id=Y
 * Look up a document type by slug within a tenant.
 *
 * `?slug=` is the stable form: a slug never changes after create (decision
 * C-154), so a renamed type still answers to the slug it was created with.
 *
 * `?name=` matches the type's CURRENT NAME first (case and spacing folded),
 * and only then the slug that name would have produced. It used to do the
 * second alone, which was the same thing while every rename re-slugged; now
 * that a rename leaves the slug, a lookup by a renamed type's new name would
 * otherwise miss it.
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

    let documentType: Record<string, unknown> | null = null;
    if (!slugParam && nameParam) {
      const wanted = sanitizeString(nameParam).toLowerCase().replace(/\s+/g, ' ').trim();
      const named = await context.env.DB.prepare(
        'SELECT * FROM document_types WHERE tenant_id = ? AND active = 1 AND lower(trim(name)) = ? ORDER BY created_at LIMIT 1'
      )
        .bind(tenantId, wanted)
        .first();
      documentType = (named as Record<string, unknown> | null) ?? null;
    }
    if (!documentType) {
      documentType = (await context.env.DB.prepare(
        'SELECT * FROM document_types WHERE slug = ? AND tenant_id = ? AND active = 1'
      )
        .bind(lookupSlug, tenantId)
        .first()) as Record<string, unknown> | null;
    }

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
