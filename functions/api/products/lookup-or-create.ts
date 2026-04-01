import { generateId, logAudit, getClientIp } from '../../lib/db';
import { requireRole, requireTenantAccess, NotFoundError, BadRequestError, errorToResponse } from '../../lib/permissions';
import { sanitizeString } from '../../lib/validation';
import type { Env, User } from '../../lib/types';

function slugify(text: string): string {
  return text.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// GET /api/products/lookup-or-create?name=X&tenant_id=Y — lookup only
export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireRole(user, 'super_admin', 'org_admin', 'user', 'reader');

    const url = new URL(context.request.url);
    const name = url.searchParams.get('name');
    const tenantId = url.searchParams.get('tenant_id');

    if (!name) {
      throw new BadRequestError('name query parameter is required');
    }
    if (!tenantId) {
      throw new BadRequestError('tenant_id query parameter is required');
    }

    requireTenantAccess(user, tenantId);

    const sanitizedName = sanitizeString(name);

    const product = await context.env.DB.prepare(
      'SELECT * FROM products WHERE LOWER(name) = LOWER(?) AND tenant_id = ? AND active = 1'
    )
      .bind(sanitizedName, tenantId)
      .first();

    if (!product) {
      throw new NotFoundError('Product not found');
    }

    return new Response(
      JSON.stringify({ product, created: false }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;

    console.error('[Product lookup] error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};

// POST /api/products/lookup-or-create — lookup, create if missing
export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireRole(user, 'super_admin', 'org_admin', 'user');

    const body = (await context.request.json()) as {
      name?: string;
      tenant_id?: string;
    };

    if (!body.name || !body.name.trim()) {
      throw new BadRequestError('name is required');
    }
    if (!body.tenant_id) {
      throw new BadRequestError('tenant_id is required');
    }

    const tenantId = body.tenant_id;
    requireTenantAccess(user, tenantId);

    const sanitizedName = sanitizeString(body.name);

    // Try to find existing product (case-insensitive exact match)
    const existing = await context.env.DB.prepare(
      'SELECT * FROM products WHERE LOWER(name) = LOWER(?) AND tenant_id = ? AND active = 1'
    )
      .bind(sanitizedName, tenantId)
      .first();

    if (existing) {
      return new Response(
        JSON.stringify({ product: existing, created: false }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Create new product
    let slug = slugify(sanitizedName);
    if (!slug) {
      throw new BadRequestError('Could not generate a valid slug from name');
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
        throw new BadRequestError('Could not generate a unique slug');
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
      JSON.stringify({ name: sanitizedName, slug: finalSlug, source: 'lookup-or-create' }),
      getClientIp(context.request)
    );

    const product = await context.env.DB.prepare(
      'SELECT * FROM products WHERE id = ?'
    )
      .bind(id)
      .first();

    return new Response(
      JSON.stringify({ product, created: true }),
      { status: 201, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;

    console.error('[Product lookup-or-create] error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
