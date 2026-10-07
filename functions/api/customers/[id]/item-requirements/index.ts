/**
 * GET  /api/customers/:id/item-requirements -- what this customer needs for
 *   each item (migration 0135, decision C-004). Any role in the tenant.
 * POST /api/customers/:id/item-requirements -- add one (org_admin /
 *   super_admin). Body: { product_id, coa_required?, must_show?, timing?,
 *   delivery_contact_id?, notes? }.
 *
 * ONE ROW PER CUSTOMER AND ITEM: a second requirement for the same item is a
 * 409 naming the one that exists. `coa_required` is yes / no / on_request
 * (default yes); `must_show` and `timing` are free text. Thin on purpose.
 *
 * A requirement decides nothing. The order review prints it beside the line
 * and warns when a required item has no certificate on the order.
 */

import { getClientIp, logAudit } from '../../../../lib/db';
import { errorToResponse, requireRole, requireTenantAccess } from '../../../../lib/permissions';
import {
  buildItemRequirementsResponse,
  createCustomerItemRequirement,
  loadCoaCustomer,
} from '../../../../lib/customer-coa';
import type { Env, User } from '../../../../lib/types';
import type { CustomerItemRequirementWriteRequest } from '../../../../../shared/types';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const customer = await loadCoaCustomer(context.env.DB, user, context.params.id as string);
    requireTenantAccess(user, customer.tenant_id);
    return json(await buildItemRequirementsResponse(context.env.DB, customer));
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('List customer item requirements error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
};

export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireRole(user, 'super_admin', 'org_admin');
    const customer = await loadCoaCustomer(context.env.DB, user, context.params.id as string);
    requireTenantAccess(user, customer.tenant_id);

    let body: CustomerItemRequirementWriteRequest;
    try {
      body = (await context.request.json()) as CustomerItemRequirementWriteRequest;
    } catch {
      return json({ error: 'Body must be JSON: { product_id, coa_required?, must_show?, timing?, delivery_contact_id?, notes? }' }, 400);
    }

    const row = await createCustomerItemRequirement(context.env.DB, customer, body ?? {}, user.id);

    await logAudit(
      context.env.DB,
      user.id,
      customer.tenant_id,
      'customer.item_requirement_added',
      'customer',
      customer.id,
      JSON.stringify({
        customer_name: customer.name,
        requirement_id: row.id,
        product_id: row.product_id,
        product_name: row.product_name,
        coa_required: row.coa_required,
        must_show: row.must_show,
        timing: row.timing,
        delivery_contact_id: row.delivery_contact_id,
        notes: row.notes,
      }),
      getClientIp(context.request),
    );

    return json({ ...(await buildItemRequirementsResponse(context.env.DB, customer)), requirement: row }, 201);
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Add customer item requirement error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
};
