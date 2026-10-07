/**
 * PUT    /api/suppliers/:id/facilities/:facilityId -- rename, change the plant
 *   code or notes, or retire / reactivate (`active`).
 * DELETE /api/suppliers/:id/facilities/:facilityId -- remove it.
 *
 * org_admin / super_admin. Retiring (`active: false`) is the gentle form: the
 * items that name the facility keep naming it and it takes no new ones.
 * Removing it sends those items back to "no facility recorded" -- they are
 * never deleted -- and the audit row lists which, because a foreign key's
 * SET NULL would otherwise do that with no record.
 */

import { getClientIp, logAudit } from '../../../../lib/db';
import { errorToResponse, requireRole, requireTenantAccess } from '../../../../lib/permissions';
import {
  buildFacilitiesResponse,
  loadSupplierFacility,
  removeSupplierFacility,
  toSupplierFacility,
  updateSupplierFacility,
  type SupplierFacilityRow,
} from '../../../../lib/item-approval';
import { loadContactSupplier } from '../../../../lib/supplier-contact-routes';
import type { Env, User } from '../../../../lib/types';
import type { SupplierFacilityWriteRequest } from '../../../../../shared/types';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function snapshot(r: SupplierFacilityRow) {
  return { name: r.name, plant_code: r.plant_code, notes: r.notes, active: Number(r.active) === 1 };
}

export const onRequestPut: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireRole(user, 'super_admin', 'org_admin');
    const supplier = await loadContactSupplier(context.env.DB, user, context.params.id as string);
    requireTenantAccess(user, supplier.tenant_id);

    let body: SupplierFacilityWriteRequest;
    try {
      body = (await context.request.json()) as SupplierFacilityWriteRequest;
    } catch {
      return json({ error: 'Body must be JSON' }, 400);
    }

    const existing = await loadSupplierFacility(
      context.env.DB,
      supplier.tenant_id,
      supplier.id,
      context.params.facilityId as string,
    );
    const saved = await updateSupplierFacility(context.env.DB, existing, body ?? {}, user.id);

    // A save that changed nothing writes no audit row.
    if (saved.changed) {
      await logAudit(
        context.env.DB,
        user.id,
        supplier.tenant_id,
        'supplier.facility_updated',
        'supplier',
        supplier.id,
        JSON.stringify({
          supplier_name: supplier.name,
          facility_id: existing.id,
          previous: snapshot(existing),
          current: snapshot(saved.row),
        }),
        getClientIp(context.request),
      );
    }

    return json({
      ...(await buildFacilitiesResponse(context.env.DB, supplier)),
      facility: toSupplierFacility(saved.row),
    });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Update supplier facility error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
};

export const onRequestDelete: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireRole(user, 'super_admin', 'org_admin');
    const supplier = await loadContactSupplier(context.env.DB, user, context.params.id as string);
    requireTenantAccess(user, supplier.tenant_id);

    const existing = await loadSupplierFacility(
      context.env.DB,
      supplier.tenant_id,
      supplier.id,
      context.params.facilityId as string,
    );
    const removed = await removeSupplierFacility(context.env.DB, existing);

    await logAudit(
      context.env.DB,
      user.id,
      supplier.tenant_id,
      'supplier.facility_removed',
      'supplier',
      supplier.id,
      JSON.stringify({
        supplier_name: supplier.name,
        // The whole row: a DELETE leaves nothing else to reconstruct it from.
        removed: { facility_id: existing.id, ...snapshot(existing) },
        // The items that named it and now have no facility recorded.
        cleared_product_ids: removed.cleared_product_ids,
      }),
      getClientIp(context.request),
    );

    return json({
      ...(await buildFacilitiesResponse(context.env.DB, supplier)),
      cleared_items: removed.cleared_product_ids.length,
    });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Remove supplier facility error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
};
