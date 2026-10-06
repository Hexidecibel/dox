/**
 * PUT    /api/suppliers/:id/contacts/:contactId -- edit a contact.
 *   Body: any of { name, email, role, priority, is_document_contact, active }.
 * DELETE /api/suppliers/:id/contacts/:contactId -- remove one.
 *
 * org_admin / super_admin. Both are audited with the previous row: this
 * address is where approved renewal requests go, so a change to it has to
 * leave a trace of what it was. Removing or deactivating the document contact
 * leaves the supplier with none -- nothing is promoted in its place, because
 * guessing who should now receive requests is exactly the decision this
 * screen exists for a person to make. Drafting simply stops, and says so.
 */

import { getClientIp, logAudit } from '../../../../lib/db';
import { errorToResponse, requireRole, requireTenantAccess } from '../../../../lib/permissions';
import {
  deleteSupplierContact,
  toSupplierContact,
  updateSupplierContact,
  type SupplierContactRow,
} from '../../../../lib/supplier-contacts';
import { buildContactsResponse, loadContactSupplier } from '../../../../lib/supplier-contact-routes';
import type { Env, User } from '../../../../lib/types';
import type { SupplierContactWriteRequest } from '../../../../../shared/types';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function snapshot(r: SupplierContactRow) {
  return {
    name: r.name,
    email: r.email,
    role: r.role,
    priority: r.priority,
    is_document_contact: Number(r.is_document_contact) === 1,
    active: Number(r.active) === 1,
  };
}

export const onRequestPut: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireRole(user, 'super_admin', 'org_admin');
    const supplier = await loadContactSupplier(context.env.DB, user, context.params.id as string);
    requireTenantAccess(user, supplier.tenant_id);

    let body: SupplierContactWriteRequest;
    try {
      body = (await context.request.json()) as SupplierContactWriteRequest;
    } catch {
      return json({ error: 'Body must be JSON' }, 400);
    }

    const saved = await updateSupplierContact(
      context.env.DB,
      supplier.tenant_id,
      supplier.id,
      context.params.contactId as string,
      body ?? {},
      { userId: user.id },
    );

    await logAudit(
      context.env.DB,
      user.id,
      supplier.tenant_id,
      'supplier.contact_updated',
      'supplier',
      supplier.id,
      JSON.stringify({
        supplier_name: supplier.name,
        contact_id: saved.row.id,
        previous: snapshot(saved.previous),
        current: snapshot(saved.row),
        replaced_document_contact: saved.demoted
          ? { contact_id: saved.demoted.id, email: saved.demoted.email }
          : null,
      }),
      getClientIp(context.request),
    );

    return json({
      ...(await buildContactsResponse(context.env.DB, supplier)),
      contact: toSupplierContact(saved.row),
    });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Update supplier contact error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
};

export const onRequestDelete: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireRole(user, 'super_admin', 'org_admin');
    const supplier = await loadContactSupplier(context.env.DB, user, context.params.id as string);
    requireTenantAccess(user, supplier.tenant_id);

    const removed = await deleteSupplierContact(
      context.env.DB,
      supplier.tenant_id,
      supplier.id,
      context.params.contactId as string,
    );

    await logAudit(
      context.env.DB,
      user.id,
      supplier.tenant_id,
      'supplier.contact_removed',
      'supplier',
      supplier.id,
      JSON.stringify({
        supplier_name: supplier.name,
        // The whole row: a DELETE leaves nothing else to reconstruct it from.
        removed: { contact_id: removed.id, ...snapshot(removed), source: removed.source },
      }),
      getClientIp(context.request),
    );

    return json(await buildContactsResponse(context.env.DB, supplier));
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Remove supplier contact error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
};
