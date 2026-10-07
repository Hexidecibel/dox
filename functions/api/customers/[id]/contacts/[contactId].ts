/**
 * PUT    /api/customers/:id/contacts/:contactId -- change the name, address,
 *   role, whether it is the primary contact, or whether it receives COAs.
 * DELETE /api/customers/:id/contacts/:contactId -- remove it.
 *
 * org_admin / super_admin; every change audited with the previous value. A
 * customer has one primary contact: naming a new one steps the previous one
 * down in the same write. Removing a contact that a COA requirement names as
 * its delivery contact leaves that requirement with no delivery contact, and
 * the audit row says which.
 */

import { getClientIp, logAudit } from '../../../../lib/db';
import { errorToResponse, requireRole, requireTenantAccess } from '../../../../lib/permissions';
import {
  buildCustomerContactsResponse,
  deleteCustomerContact,
  loadCoaCustomer,
  toCustomerContact,
  updateCustomerContact,
  type CustomerContactRow,
} from '../../../../lib/customer-coa';
import type { Env, User } from '../../../../lib/types';
import type { CustomerContactWriteRequest } from '../../../../../shared/types';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function snapshot(r: CustomerContactRow) {
  return {
    name: r.name,
    email: r.email,
    role: r.role,
    is_primary: Number(r.is_primary) === 1,
    coa_recipient: Number(r.coa_recipient) === 1,
  };
}

export const onRequestPut: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireRole(user, 'super_admin', 'org_admin');
    const customer = await loadCoaCustomer(context.env.DB, user, context.params.id as string);
    requireTenantAccess(user, customer.tenant_id);

    let body: CustomerContactWriteRequest;
    try {
      body = (await context.request.json()) as CustomerContactWriteRequest;
    } catch {
      return json({ error: 'Body must be JSON' }, 400);
    }

    const saved = await updateCustomerContact(
      context.env.DB,
      customer,
      context.params.contactId as string,
      body ?? {},
    );

    if (saved.changed) {
      await logAudit(
        context.env.DB,
        user.id,
        customer.tenant_id,
        'customer.contact_updated',
        'customer',
        customer.id,
        JSON.stringify({
          customer_name: customer.name,
          contact_id: saved.row.id,
          previous: snapshot(saved.previous),
          current: snapshot(saved.row),
        }),
        getClientIp(context.request),
      );
    }

    return json({
      ...(await buildCustomerContactsResponse(context.env.DB, customer)),
      contact: toCustomerContact(saved.row),
    });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Update customer contact error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
};

export const onRequestDelete: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireRole(user, 'super_admin', 'org_admin');
    const customer = await loadCoaCustomer(context.env.DB, user, context.params.id as string);
    requireTenantAccess(user, customer.tenant_id);

    const result = await deleteCustomerContact(context.env.DB, customer, context.params.contactId as string);

    await logAudit(
      context.env.DB,
      user.id,
      customer.tenant_id,
      'customer.contact_removed',
      'customer',
      customer.id,
      JSON.stringify({
        customer_name: customer.name,
        // The whole row: a DELETE leaves nothing else to reconstruct it from.
        removed: { contact_id: result.removed.id, ...snapshot(result.removed) },
        cleared_delivery_contact_on: result.cleared_requirement_ids,
      }),
      getClientIp(context.request),
    );

    return json(await buildCustomerContactsResponse(context.env.DB, customer));
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Remove customer contact error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
};
