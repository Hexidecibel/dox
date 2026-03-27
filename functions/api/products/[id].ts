import { logAudit, getClientIp } from '../../lib/db';
import {
  requireRole,
  NotFoundError,
  errorToResponse,
} from '../../lib/permissions';
import { sanitizeString } from '../../lib/validation';
import type { Env, User } from '../../lib/types';

/**
 * GET /api/products/:id
 * Get a single product by ID. Any authenticated user.
 */
export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const productId = context.params.id as string;

    const product = await context.env.DB.prepare(
      'SELECT * FROM products WHERE id = ?'
    )
      .bind(productId)
      .first();

    if (!product) {
      throw new NotFoundError('Product not found');
    }

    return new Response(
      JSON.stringify({ product }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;

    console.error('Get product error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};

/**
 * PUT /api/products/:id
 * Update a product. Only super_admin.
 * Fields: name, description, active.
 */
export const onRequestPut: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const productId = context.params.id as string;

    requireRole(user, 'super_admin');

    const product = await context.env.DB.prepare(
      'SELECT * FROM products WHERE id = ?'
    )
      .bind(productId)
      .first();

    if (!product) {
      throw new NotFoundError('Product not found');
    }

    const body = (await context.request.json()) as {
      name?: string;
      description?: string;
      active?: number;
    };

    const updates: string[] = [];
    const params: (string | number | null)[] = [];

    if (body.name !== undefined) {
      const name = sanitizeString(body.name);
      if (!name) {
        return new Response(
          JSON.stringify({ error: 'name cannot be empty' }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        );
      }
      updates.push('name = ?');
      params.push(name);
    }

    if (body.description !== undefined) {
      updates.push('description = ?');
      params.push(body.description ? sanitizeString(body.description) : null);
    }

    if (body.active !== undefined) {
      if (body.active !== 0 && body.active !== 1) {
        return new Response(
          JSON.stringify({ error: 'active must be 0 or 1' }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        );
      }
      updates.push('active = ?');
      params.push(body.active);
    }

    if (updates.length === 0) {
      return new Response(
        JSON.stringify({ error: 'No fields to update' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    updates.push("updated_at = datetime('now')");
    params.push(productId);

    await context.env.DB.prepare(
      `UPDATE products SET ${updates.join(', ')} WHERE id = ?`
    )
      .bind(...params)
      .run();

    await logAudit(
      context.env.DB,
      user.id,
      null,
      'product_updated',
      'product',
      productId,
      JSON.stringify({ changes: body }),
      getClientIp(context.request)
    );

    const updated = await context.env.DB.prepare(
      'SELECT * FROM products WHERE id = ?'
    )
      .bind(productId)
      .first();

    return new Response(
      JSON.stringify({ product: updated }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;

    console.error('Update product error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};

/**
 * DELETE /api/products/:id
 * Soft-delete a product (set active=0). Only super_admin.
 */
export const onRequestDelete: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const productId = context.params.id as string;

    requireRole(user, 'super_admin');

    const product = await context.env.DB.prepare(
      'SELECT * FROM products WHERE id = ?'
    )
      .bind(productId)
      .first();

    if (!product) {
      throw new NotFoundError('Product not found');
    }

    await context.env.DB.prepare(
      "UPDATE products SET active = 0, updated_at = datetime('now') WHERE id = ?"
    )
      .bind(productId)
      .run();

    await logAudit(
      context.env.DB,
      user.id,
      null,
      'product_deleted',
      'product',
      productId,
      JSON.stringify({ name: product.name }),
      getClientIp(context.request)
    );

    return new Response(
      JSON.stringify({ success: true }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;

    console.error('Delete product error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
