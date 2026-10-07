/**
 * GET  /api/suppliers/:id/facilities -- the supplier's facilities and how
 *   many of its items name each (migration 0135). Any role in the tenant.
 * POST /api/suppliers/:id/facilities -- add one (org_admin / super_admin).
 *   Body: { name, plant_code?, notes? }.
 *
 * A facility is added by a PERSON (decision C-002). Nothing creates one from a
 * certificate, and adding one changes no gap, renewal or search answer: it is
 * a name an item can be said to come from. There is no "line".
 */

import { getClientIp, logAudit } from '../../../../lib/db';
import { errorToResponse, requireRole, requireTenantAccess } from '../../../../lib/permissions';
import { buildFacilitiesResponse, createSupplierFacility, toSupplierFacility } from '../../../../lib/item-approval';
import { loadContactSupplier } from '../../../../lib/supplier-contact-routes';
import type { Env, User } from '../../../../lib/types';
import type { SupplierFacilityWriteRequest } from '../../../../../shared/types';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const supplier = await loadContactSupplier(context.env.DB, user, context.params.id as string);
    requireTenantAccess(user, supplier.tenant_id);
    return json(await buildFacilitiesResponse(context.env.DB, supplier));
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('List supplier facilities error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
};

export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireRole(user, 'super_admin', 'org_admin');
    const supplier = await loadContactSupplier(context.env.DB, user, context.params.id as string);
    requireTenantAccess(user, supplier.tenant_id);

    let body: SupplierFacilityWriteRequest;
    try {
      body = (await context.request.json()) as SupplierFacilityWriteRequest;
    } catch {
      return json({ error: 'Body must be JSON: { name, plant_code?, notes? }' }, 400);
    }

    const row = await createSupplierFacility(context.env.DB, supplier.tenant_id, supplier.id, body ?? {}, user.id);

    await logAudit(
      context.env.DB,
      user.id,
      supplier.tenant_id,
      'supplier.facility_added',
      'supplier',
      supplier.id,
      JSON.stringify({
        supplier_name: supplier.name,
        facility_id: row.id,
        name: row.name,
        plant_code: row.plant_code,
        notes: row.notes,
      }),
      getClientIp(context.request),
    );

    return json(
      { ...(await buildFacilitiesResponse(context.env.DB, supplier)), facility: toSupplierFacility(row) },
      201,
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Add supplier facility error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
};
