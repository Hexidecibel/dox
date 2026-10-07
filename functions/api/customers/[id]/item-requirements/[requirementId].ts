/**
 * PUT    /api/customers/:id/item-requirements/:requirementId -- change what
 *   the customer needs for the item (never WHICH item: that is another row).
 * DELETE /api/customers/:id/item-requirements/:requirementId -- remove it.
 *
 * org_admin / super_admin; every change audited with the previous value.
 */

import { getClientIp, logAudit } from '../../../../lib/db';
import { errorToResponse, requireRole, requireTenantAccess } from '../../../../lib/permissions';
import {
  buildItemRequirementsResponse,
  deleteCustomerItemRequirement,
  loadCoaCustomer,
  updateCustomerItemRequirement,
} from '../../../../lib/customer-coa';
import type { Env, User } from '../../../../lib/types';
import type { CustomerItemRequirement, CustomerItemRequirementWriteRequest } from '../../../../../shared/types';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function snapshot(r: CustomerItemRequirement) {
  return {
    coa_required: r.coa_required,
    must_show: r.must_show,
    timing: r.timing,
    delivery_contact_id: r.delivery_contact_id,
    notes: r.notes,
  };
}

export const onRequestPut: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireRole(user, 'super_admin', 'org_admin');
    const customer = await loadCoaCustomer(context.env.DB, user, context.params.id as string);
    requireTenantAccess(user, customer.tenant_id);

    let body: CustomerItemRequirementWriteRequest;
    try {
      body = (await context.request.json()) as CustomerItemRequirementWriteRequest;
    } catch {
      return json({ error: 'Body must be JSON' }, 400);
    }

    const saved = await updateCustomerItemRequirement(
      context.env.DB,
      customer,
      context.params.requirementId as string,
      body ?? {},
      user.id,
    );

    if (saved.changed) {
      await logAudit(
        context.env.DB,
        user.id,
        customer.tenant_id,
        'customer.item_requirement_updated',
        'customer',
        customer.id,
        JSON.stringify({
          customer_name: customer.name,
          requirement_id: saved.row.id,
          product_id: saved.row.product_id,
          product_name: saved.row.product_name,
          previous: snapshot(saved.previous),
          current: snapshot(saved.row),
        }),
        getClientIp(context.request),
      );
    }

    return json({ ...(await buildItemRequirementsResponse(context.env.DB, customer)), requirement: saved.row });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Update customer item requirement error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
};

export const onRequestDelete: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireRole(user, 'super_admin', 'org_admin');
    const customer = await loadCoaCustomer(context.env.DB, user, context.params.id as string);
    requireTenantAccess(user, customer.tenant_id);

    const removed = await deleteCustomerItemRequirement(
      context.env.DB,
      customer,
      context.params.requirementId as string,
    );

    await logAudit(
      context.env.DB,
      user.id,
      customer.tenant_id,
      'customer.item_requirement_removed',
      'customer',
      customer.id,
      JSON.stringify({
        customer_name: customer.name,
        // The whole row: a DELETE leaves nothing else to reconstruct it from.
        removed: {
          requirement_id: removed.id,
          product_id: removed.product_id,
          product_name: removed.product_name,
          ...snapshot(removed),
          source: removed.source,
        },
      }),
      getClientIp(context.request),
    );

    return json(await buildItemRequirementsResponse(context.env.DB, customer));
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Remove customer item requirement error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
};
