import {
  requireRole,
  requireTenantAccess,
  NotFoundError,
  BadRequestError,
  errorToResponse,
} from '../../lib/permissions';
import type { Env, User } from '../../lib/types';

/**
 * GET /api/customers/lookup?customer_number=X&tenant_id=Y
 * Look up a customer by customer_number within a tenant.
 * Returns the customer or 404 if not found.
 */
export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;

    // Any authenticated role can look up
    requireRole(user, 'super_admin', 'org_admin', 'user', 'reader');

    const url = new URL(context.request.url);
    const customerNumber = url.searchParams.get('customer_number');
    let tenantId = url.searchParams.get('tenant_id');

    if (!customerNumber) {
      throw new BadRequestError('customer_number query parameter is required');
    }

    if (user.role !== 'super_admin') {
      tenantId = user.tenant_id;
    }

    if (!tenantId) {
      throw new BadRequestError('tenant_id is required');
    }

    // Check tenant access
    requireTenantAccess(user, tenantId);

    const customer = await context.env.DB.prepare(
      `SELECT * FROM customers WHERE customer_number = ? AND tenant_id = ? AND active = 1`
    )
      .bind(customerNumber, tenantId)
      .first();

    if (!customer) {
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

    console.error('Customer lookup error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
