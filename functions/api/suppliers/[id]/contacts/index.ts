/**
 * GET  /api/suppliers/:id/contacts -- the supplier's contacts and which one
 *   document requests go to (migration 0133). Any role in the tenant.
 * POST /api/suppliers/:id/contacts -- add one (org_admin / super_admin).
 *   Body: { email, name?, role?, priority?, is_document_contact? }.
 *
 * A supplier has at most ONE active document contact. The first contact added
 * becomes it unless the caller says otherwise; naming a new one demotes the
 * previous one in the same write, and the audit row says who it replaced --
 * "where did the request go, and since when" has to be answerable, because
 * this address is where an approved renewal request is sent.
 *
 * Adding a contact sends nothing. It only makes drafting possible.
 */

import { getClientIp, logAudit } from '../../../../lib/db';
import { errorToResponse, requireRole, requireTenantAccess } from '../../../../lib/permissions';
import { createSupplierContact, toSupplierContact } from '../../../../lib/supplier-contacts';
import { buildContactsResponse, loadContactSupplier } from '../../../../lib/supplier-contact-routes';
import type { Env, User } from '../../../../lib/types';
import type { SupplierContactWriteRequest } from '../../../../../shared/types';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const supplier = await loadContactSupplier(context.env.DB, user, context.params.id as string);
    requireTenantAccess(user, supplier.tenant_id);
    return json(await buildContactsResponse(context.env.DB, supplier));
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('List supplier contacts error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
};

export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireRole(user, 'super_admin', 'org_admin');
    const supplier = await loadContactSupplier(context.env.DB, user, context.params.id as string);
    requireTenantAccess(user, supplier.tenant_id);

    let body: SupplierContactWriteRequest;
    try {
      body = (await context.request.json()) as SupplierContactWriteRequest;
    } catch {
      return json({ error: 'Body must be JSON: { email, name?, role?, priority?, is_document_contact? }' }, 400);
    }

    const saved = await createSupplierContact(context.env.DB, supplier.tenant_id, supplier.id, body ?? {}, {
      userId: user.id,
      source: 'admin',
    });

    await logAudit(
      context.env.DB,
      user.id,
      supplier.tenant_id,
      'supplier.contact_added',
      'supplier',
      supplier.id,
      JSON.stringify({
        supplier_name: supplier.name,
        contact_id: saved.row.id,
        name: saved.row.name,
        email: saved.row.email,
        role: saved.row.role,
        is_document_contact: Number(saved.row.is_document_contact) === 1,
        replaced_document_contact: saved.demoted
          ? { contact_id: saved.demoted.id, email: saved.demoted.email }
          : null,
      }),
      getClientIp(context.request),
    );

    return json(
      { ...(await buildContactsResponse(context.env.DB, supplier)), contact: toSupplierContact(saved.row) },
      201,
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Add supplier contact error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
};
