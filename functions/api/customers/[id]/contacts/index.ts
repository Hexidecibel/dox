/**
 * GET  /api/customers/:id/contacts -- the people at a customer and which of
 *   them receive COAs (migration 0135). Any role in the tenant.
 * POST /api/customers/:id/contacts -- add one (org_admin / super_admin).
 *   Body: { email, name?, role?, is_primary?, coa_recipient? }.
 *
 * `customer_contacts` was written only by the order connector until now. The
 * contacts flagged `coa_recipient` are the addresses an order send is
 * PRE-FILLED with; the sender still sees and can edit the list before anything
 * leaves. Adding a contact sends nothing.
 */

import { getClientIp, logAudit } from '../../../../lib/db';
import { errorToResponse, requireRole, requireTenantAccess } from '../../../../lib/permissions';
import {
  buildCustomerContactsResponse,
  createCustomerContact,
  loadCoaCustomer,
  toCustomerContact,
} from '../../../../lib/customer-coa';
import type { Env, User } from '../../../../lib/types';
import type { CustomerContactWriteRequest } from '../../../../../shared/types';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const customer = await loadCoaCustomer(context.env.DB, user, context.params.id as string);
    requireTenantAccess(user, customer.tenant_id);
    return json(await buildCustomerContactsResponse(context.env.DB, customer));
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('List customer contacts error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
};

export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireRole(user, 'super_admin', 'org_admin');
    const customer = await loadCoaCustomer(context.env.DB, user, context.params.id as string);
    requireTenantAccess(user, customer.tenant_id);

    let body: CustomerContactWriteRequest;
    try {
      body = (await context.request.json()) as CustomerContactWriteRequest;
    } catch {
      return json({ error: 'Body must be JSON: { email, name?, role?, is_primary?, coa_recipient? }' }, 400);
    }

    const row = await createCustomerContact(context.env.DB, customer, body ?? {});

    await logAudit(
      context.env.DB,
      user.id,
      customer.tenant_id,
      'customer.contact_added',
      'customer',
      customer.id,
      JSON.stringify({
        customer_name: customer.name,
        contact_id: row.id,
        name: row.name,
        email: row.email,
        role: row.role,
        is_primary: Number(row.is_primary) === 1,
        coa_recipient: Number(row.coa_recipient) === 1,
      }),
      getClientIp(context.request),
    );

    return json(
      { ...(await buildCustomerContactsResponse(context.env.DB, customer)), contact: toCustomerContact(row) },
      201,
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Add customer contact error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
};
