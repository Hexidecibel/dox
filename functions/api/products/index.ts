import { generateId } from '../../lib/db';
import { logAudit, getClientIp } from '../../lib/db';
import { requireRole, errorToResponse } from '../../lib/permissions';
import { sanitizeString } from '../../lib/validation';
import type { Env, User } from '../../lib/types';

function slugify(text: string): string {
  return text.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/**
 * GET /api/products
 * List all products. Supports ?search=, ?active=1, pagination (limit, offset).
 * Any authenticated user can read.
 */
export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const url = new URL(context.request.url);
    const search = url.searchParams.get('search');
    const activeFilter = url.searchParams.get('active');
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200);
    const offset = parseInt(url.searchParams.get('offset') || '0', 10);

    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (activeFilter !== null) {
      conditions.push('active = ?');
      params.push(Number(activeFilter));
    }

    if (search) {
      conditions.push('(name LIKE ? OR description LIKE ?)');
      const pattern = `%${search}%`;
      params.push(pattern, pattern);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Get total count
    const countResult = await context.env.DB.prepare(
      `SELECT COUNT(*) as total FROM products ${whereClause}`
    )
      .bind(...params)
      .first<{ total: number }>();

    // Get products
    const results = await context.env.DB.prepare(
      `SELECT * FROM products ${whereClause} ORDER BY name ASC LIMIT ? OFFSET ?`
    )
      .bind(...params, limit, offset)
      .all();

    return new Response(
      JSON.stringify({
        products: results.results,
        total: countResult?.total || 0,
        limit,
        offset,
      }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;

    console.error('List products error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};

/**
 * POST /api/products
 * Create a new product. Only super_admin.
 * Fields: name (required), description (optional).
 * Auto-generates slug from name.
 */
export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireRole(user, 'super_admin');

    const body = (await context.request.json()) as {
      name?: string;
      description?: string;
    };

    if (!body.name || !body.name.trim()) {
      return new Response(
        JSON.stringify({ error: 'name is required' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Sanitize inputs
    body.name = sanitizeString(body.name);
    if (body.description) body.description = sanitizeString(body.description);

    const slug = slugify(body.name);

    if (!slug) {
      return new Response(
        JSON.stringify({ error: 'Could not generate a valid slug from name' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Check slug uniqueness
    const existing = await context.env.DB.prepare(
      'SELECT id FROM products WHERE slug = ?'
    )
      .bind(slug)
      .first();

    if (existing) {
      return new Response(
        JSON.stringify({ error: 'A product with this slug already exists' }),
        { status: 409, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const id = generateId();

    await context.env.DB.prepare(
      `INSERT INTO products (id, name, slug, description, active)
       VALUES (?, ?, ?, ?, 1)`
    )
      .bind(id, body.name, slug, body.description || null)
      .run();

    await logAudit(
      context.env.DB,
      user.id,
      null,
      'product_created',
      'product',
      id,
      JSON.stringify({ name: body.name, slug }),
      getClientIp(context.request)
    );

    const product = await context.env.DB.prepare(
      'SELECT * FROM products WHERE id = ?'
    )
      .bind(id)
      .first();

    return new Response(JSON.stringify({ product }), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;

    console.error('Create product error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
