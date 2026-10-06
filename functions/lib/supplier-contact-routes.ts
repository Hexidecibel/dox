/**
 * Shared by the two /api/suppliers/:id/contacts route files: resolve the
 * supplier a contact call is about (tenant-scoped) and build the response
 * both of them return.
 */

import { NotFoundError } from './permissions';
import { listSupplierContacts, toSupplierContact } from './supplier-contacts';
import type { User } from './types';
import type { SupplierContactsResponse } from '../../shared/types';

export interface ContactSupplier {
  id: string;
  tenant_id: string;
  name: string;
}

export async function loadContactSupplier(
  db: D1Database,
  user: User,
  supplierId: string,
): Promise<ContactSupplier> {
  const supplier = await db
    .prepare('SELECT id, tenant_id, name FROM suppliers WHERE id = ?')
    .bind(supplierId)
    .first<ContactSupplier>();
  // Another tenant's supplier is indistinguishable from a missing one.
  if (!supplier || (user.role !== 'super_admin' && supplier.tenant_id !== user.tenant_id)) {
    throw new NotFoundError('Supplier not found');
  }
  return supplier;
}

export async function buildContactsResponse(
  db: D1Database,
  supplier: ContactSupplier,
): Promise<SupplierContactsResponse> {
  const contacts = (await listSupplierContacts(db, supplier.tenant_id, supplier.id)).map(toSupplierContact);
  return {
    supplier: { id: supplier.id, name: supplier.name },
    contacts,
    document_contact: contacts.find((c) => c.is_document_contact && c.active) ?? null,
  };
}
