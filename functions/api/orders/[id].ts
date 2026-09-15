import { logAudit, getClientIp } from '../../lib/db';
import {
  requireRole,
  requireTenantAccess,
  NotFoundError,
  errorToResponse,
} from '../../lib/permissions';
import { sanitizeString } from '../../lib/validation';
import type { Env, User } from '../../lib/types';

/**
 * GET /api/orders/:id
 * Get a single order by ID with items, joined connector/customer/product/document names.
 */
export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const orderId = context.params.id as string;

    const order = await context.env.DB.prepare(
      `SELECT o.*,
        c.name as connector_name,
        cust.name as customer_name_resolved
      FROM orders o
      LEFT JOIN connectors c ON c.id = o.connector_id
      LEFT JOIN customers cust ON cust.id = o.customer_id
      WHERE o.id = ?`
    )
      .bind(orderId)
      .first();

    if (!order) {
      throw new NotFoundError('Order not found');
    }

    // Check tenant access
    if (user.role !== 'super_admin' && order.tenant_id !== user.tenant_id) {
      throw new NotFoundError('Order not found');
    }

    const itemsResult = await context.env.DB.prepare(
      `SELECT oi.*,
        p.name as product_name_resolved,
        d.title as coa_document_title
      FROM order_items oi
      LEFT JOIN products p ON p.id = oi.product_id
      LEFT JOIN documents d ON d.id = oi.coa_document_id
      WHERE oi.order_id = ?
      ORDER BY oi.created_at ASC`
    )
      .bind(orderId)
      .all();

    // Pending lot-match suggestions for this order's lines. The matcher never
    // links a COA to a line on its own (functions/lib/entities/matching.ts), so
    // this is where a person sees the evidence and makes the call, one click
    // each via POST /api/lot-matches/:id. Highest confidence first.
    const suggestionsResult = await context.env.DB.prepare(
      `SELECT lms.id, lms.order_item_id, lms.document_id, d.title AS document_title,
              lms.lot_id, l.lot_number, lms.match_basis, lms.match_confidence, lms.match_note, lms.status
         FROM lot_match_suggestions lms
         JOIN order_items oi ON oi.id = lms.order_item_id
         LEFT JOIN documents d ON d.id = lms.document_id
         LEFT JOIN lots l ON l.id = lms.lot_id
        WHERE oi.order_id = ? AND lms.status = 'pending'
        ORDER BY lms.match_confidence DESC, lms.created_at DESC`
    )
      .bind(orderId)
      .all();

    return new Response(
      JSON.stringify({ order, items: itemsResult.results, suggestions: suggestionsResult.results ?? [] }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;

    console.error('Get order error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};

/**
 * PUT /api/orders/:id
 * Update an order. user+ for their tenant, super_admin for any.
 */
export const onRequestPut: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const orderId = context.params.id as string;

    requireRole(user, 'super_admin', 'org_admin', 'user');

    const order = await context.env.DB.prepare(
      'SELECT * FROM orders WHERE id = ?'
    )
      .bind(orderId)
      .first();

    if (!order) {
      throw new NotFoundError('Order not found');
    }

    // Verify tenant access
    requireTenantAccess(user, order.tenant_id as string);

    const body = (await context.request.json()) as {
      status?: string;
      po_number?: string;
      customer_id?: string;
      customer_number?: string;
      customer_name?: string;
      error_message?: string;
    };

    const updates: string[] = [];
    const params: (string | number | null)[] = [];

    if (body.status !== undefined) {
      const validStatuses = ['pending', 'enriched', 'matched', 'fulfilled', 'delivered', 'error'];
      if (!validStatuses.includes(body.status)) {
        return new Response(
          JSON.stringify({ error: `status must be one of: ${validStatuses.join(', ')}` }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        );
      }
      updates.push('status = ?');
      params.push(body.status);
    }

    if (body.po_number !== undefined) {
      updates.push('po_number = ?');
      params.push(body.po_number ? sanitizeString(body.po_number) : null);
    }

    if (body.customer_id !== undefined) {
      updates.push('customer_id = ?');
      params.push(body.customer_id || null);
    }

    if (body.customer_number !== undefined) {
      updates.push('customer_number = ?');
      params.push(body.customer_number ? sanitizeString(body.customer_number) : null);
    }

    if (body.customer_name !== undefined) {
      updates.push('customer_name = ?');
      params.push(body.customer_name ? sanitizeString(body.customer_name) : null);
    }

    if (body.error_message !== undefined) {
      updates.push('error_message = ?');
      params.push(body.error_message || null);
    }

    if (updates.length === 0) {
      return new Response(
        JSON.stringify({ error: 'No fields to update' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    updates.push("updated_at = datetime('now')");
    params.push(orderId);

    await context.env.DB.prepare(
      `UPDATE orders SET ${updates.join(', ')} WHERE id = ?`
    )
      .bind(...params)
      .run();

    await logAudit(
      context.env.DB,
      user.id,
      order.tenant_id as string,
      'order.updated',
      'order',
      orderId,
      JSON.stringify({ changes: body, tenant_id: order.tenant_id }),
      getClientIp(context.request)
    );

    const updated = await context.env.DB.prepare(
      'SELECT * FROM orders WHERE id = ?'
    )
      .bind(orderId)
      .first();

    return new Response(
      JSON.stringify({ order: updated }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;

    console.error('Update order error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};

/**
 * DELETE /api/orders/:id
 * Hard-delete an order (CASCADE removes items). org_admin+ only.
 */
export const onRequestDelete: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const orderId = context.params.id as string;

    requireRole(user, 'super_admin', 'org_admin');

    const order = await context.env.DB.prepare(
      'SELECT * FROM orders WHERE id = ?'
    )
      .bind(orderId)
      .first();

    if (!order) {
      throw new NotFoundError('Order not found');
    }

    // Verify tenant access
    requireTenantAccess(user, order.tenant_id as string);

    await context.env.DB.prepare(
      'DELETE FROM orders WHERE id = ?'
    )
      .bind(orderId)
      .run();

    await logAudit(
      context.env.DB,
      user.id,
      order.tenant_id as string,
      'order.deleted',
      'order',
      orderId,
      JSON.stringify({ order_number: order.order_number, tenant_id: order.tenant_id }),
      getClientIp(context.request)
    );

    return new Response(
      JSON.stringify({ success: true }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;

    console.error('Delete order error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
