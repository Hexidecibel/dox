import { generateId, logAudit, getClientIp } from '../../lib/db';
import {
  requireRole,
  requireTenantAccess,
  BadRequestError,
  errorToResponse,
} from '../../lib/permissions';
import { sanitizeString } from '../../lib/validation';
import type { Env, User } from '../../lib/types';

function slugify(text: string): string {
  return text.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/**
 * POST /api/products/lookup-or-create-batch
 * Resolve an array of product names to IDs, creating any that don't exist.
 * Designed for agentic pipelines that extract multiple product names from documents.
 *
 * Request: { "names": ["Product A", "Product B"], "tenant_id": "xxx" }
 * Response: { "products": [{ "name": "Product A", "product": {...}, "created": false }, ...] }
 */
export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireRole(user, 'super_admin', 'org_admin', 'user');

    const body = (await context.request.json()) as {
      names?: string[];
      tenant_id?: string;
    };

    if (!body.names || !Array.isArray(body.names) || body.names.length === 0) {
      throw new BadRequestError('names is required and must be a non-empty array of strings');
    }
    if (body.names.length > 50) {
      throw new BadRequestError('Maximum 50 product names per batch');
    }
    if (!body.tenant_id) {
      throw new BadRequestError('tenant_id is required');
    }

    const tenantId = body.tenant_id;
    requireTenantAccess(user, tenantId);

    const results: Array<{
      name: string;
      product: Record<string, unknown>;
      created: boolean;
    }> = [];

    for (const rawName of body.names) {
      if (typeof rawName !== 'string' || !rawName.trim()) {
        throw new BadRequestError(`Invalid product name: "${rawName}"`);
      }

      const sanitizedName = sanitizeString(rawName);

      // Try to find existing product (case-insensitive exact match)
      const existing = await context.env.DB.prepare(
        'SELECT * FROM products WHERE LOWER(name) = LOWER(?) AND tenant_id = ? AND active = 1'
      )
        .bind(sanitizedName, tenantId)
        .first();

      if (existing) {
        results.push({ name: rawName, product: existing as Record<string, unknown>, created: false });
        continue;
      }

      // Create new product
      let slug = slugify(sanitizedName);
      if (!slug) {
        throw new BadRequestError(`Could not generate a valid slug from name: "${rawName}"`);
      }

      // Handle slug collisions
      let finalSlug = slug;
      for (let i = 2; i <= 6; i++) {
        const slugExists = await context.env.DB.prepare(
          'SELECT id FROM products WHERE slug = ? AND tenant_id = ?'
        )
          .bind(finalSlug, tenantId)
          .first();

        if (!slugExists) break;

        finalSlug = `${slug}-${i}`;
        if (i === 6) {
          throw new BadRequestError(`Could not generate a unique slug for: "${rawName}"`);
        }
      }

      const id = generateId();

      await context.env.DB.prepare(
        `INSERT INTO products (id, tenant_id, name, slug, description, active)
         VALUES (?, ?, ?, ?, NULL, 1)`
      )
        .bind(id, tenantId, sanitizedName, finalSlug)
        .run();

      await logAudit(
        context.env.DB,
        user.id,
        tenantId,
        'product_created',
        'product',
        id,
        JSON.stringify({ name: sanitizedName, slug: finalSlug, source: 'lookup-or-create-batch' }),
        getClientIp(context.request)
      );

      const product = await context.env.DB.prepare(
        'SELECT * FROM products WHERE id = ?'
      )
        .bind(id)
        .first();

      results.push({ name: rawName, product: product as Record<string, unknown>, created: true });
    }

    const anyCreated = results.some(r => r.created);

    return new Response(
      JSON.stringify({ products: results }),
      {
        status: anyCreated ? 201 : 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;

    console.error('[Product lookup-or-create-batch] error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
