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
 * GET /api/customers/:id
 * Get a single customer by ID with order count.
 */
export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const customerId = context.params.id as string;

    const customer = await context.env.DB.prepare(
      `SELECT c.*,
        (SELECT COUNT(*) FROM orders WHERE customer_id = c.id) as order_count
      FROM customers c WHERE c.id = ?`
    )
      .bind(customerId)
      .first();

    if (!customer) {
      throw new NotFoundError('Customer not found');
    }

    // Check tenant access
    if (user.role !== 'super_admin' && customer.tenant_id !== user.tenant_id) {
      throw new NotFoundError('Customer not found');
    }

    // Parse coa_requirements from JSON string
    let coaRequirements = null;
    if (customer.coa_requirements) {
      try {
        coaRequirements = JSON.parse(customer.coa_requirements as string);
      } catch {
        coaRequirements = null;
      }
    }

    return new Response(
      JSON.stringify({ customer: { ...customer, coa_requirements: coaRequirements } }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;

    console.error('Get customer error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};

/**
 * PUT /api/customers/:id
 * Update a customer. org_admin+ for their tenant, super_admin for any.
 */
export const onRequestPut: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const customerId = context.params.id as string;

    requireRole(user, 'super_admin', 'org_admin');

    const customer = await context.env.DB.prepare(
      'SELECT * FROM customers WHERE id = ?'
    )
      .bind(customerId)
      .first();

    if (!customer) {
      throw new NotFoundError('Customer not found');
    }

    // Verify tenant access
    requireTenantAccess(user, customer.tenant_id as string);

    const body = (await context.request.json()) as {
      name?: string;
      email?: string;
      customer_number?: string;
      coa_delivery_method?: string;
      coa_requirements?: object;
      active?: number | boolean;
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

    if (body.customer_number !== undefined) {
      const customerNumber = sanitizeString(body.customer_number);
      if (!customerNumber) {
        return new Response(
          JSON.stringify({ error: 'customer_number cannot be empty' }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        );
      }
      updates.push('customer_number = ?');
      params.push(customerNumber);
    }

    if (body.email !== undefined) {
      updates.push('email = ?');
      params.push(body.email ? sanitizeString(body.email) : null);
    }

    if (body.coa_delivery_method !== undefined) {
      updates.push('coa_delivery_method = ?');
      params.push(body.coa_delivery_method);
    }

    if (body.coa_requirements !== undefined) {
      updates.push('coa_requirements = ?');
      params.push(body.coa_requirements ? JSON.stringify(body.coa_requirements) : null);
    }

    if (body.active !== undefined) {
      // Coerce boolean to integer
      let activeVal: number;
      if (typeof body.active === 'boolean') {
        activeVal = body.active ? 1 : 0;
      } else {
        activeVal = body.active;
      }
      if (activeVal !== 0 && activeVal !== 1) {
        return new Response(
          JSON.stringify({ error: 'active must be 0 or 1' }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        );
      }
      updates.push('active = ?');
      params.push(activeVal);
    }

    if (updates.length === 0) {
      return new Response(
        JSON.stringify({ error: 'No fields to update' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    updates.push("updated_at = datetime('now')");
    params.push(customerId);

    await context.env.DB.prepare(
      `UPDATE customers SET ${updates.join(', ')} WHERE id = ?`
    )
      .bind(...params)
      .run();

    await logAudit(
      context.env.DB,
      user.id,
      customer.tenant_id as string,
      'customer.updated',
      'customer',
      customerId,
      JSON.stringify({ changes: body, tenant_id: customer.tenant_id }),
      getClientIp(context.request)
    );

    const updated = await context.env.DB.prepare(
      'SELECT * FROM customers WHERE id = ?'
    )
      .bind(customerId)
      .first();

    // Parse coa_requirements for response
    let coaRequirements = null;
    if (updated?.coa_requirements) {
      try {
        coaRequirements = JSON.parse(updated.coa_requirements as string);
      } catch {
        coaRequirements = null;
      }
    }

    return new Response(
      JSON.stringify({ customer: { ...updated, coa_requirements: coaRequirements } }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;

    console.error('Update customer error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};

/**
 * DELETE /api/customers/:id
 * Soft-delete a customer (set active=0). org_admin+ for their tenant, super_admin for any.
 */
export const onRequestDelete: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const customerId = context.params.id as string;

    requireRole(user, 'super_admin', 'org_admin');

    const customer = await context.env.DB.prepare(
      'SELECT * FROM customers WHERE id = ?'
    )
      .bind(customerId)
      .first();

    if (!customer) {
      throw new NotFoundError('Customer not found');
    }

    // Verify tenant access
    requireTenantAccess(user, customer.tenant_id as string);

    await context.env.DB.prepare(
      "UPDATE customers SET active = 0, updated_at = datetime('now') WHERE id = ?"
    )
      .bind(customerId)
      .run();

    await logAudit(
      context.env.DB,
      user.id,
      customer.tenant_id as string,
      'customer.deleted',
      'customer',
      customerId,
      JSON.stringify({ name: customer.name, tenant_id: customer.tenant_id }),
      getClientIp(context.request)
    );

    return new Response(
      JSON.stringify({ success: true }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;

    console.error('Delete customer error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
