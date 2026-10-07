/**
 * A customer's contacts and its COA requirements per item (migration 0135;
 * decision C-004).
 *
 * `customer_contacts` has existed since 0031 and was written only by the order
 * connector; nothing read it and no screen edited it. It is now the list a
 * person keeps, and `coa_recipient` says which of them an order send is
 * pre-addressed to. The identity is the address, folded exactly as the 0031
 * unique index folds it (`lower(email)`), computed here before the write so a
 * duplicate is a 409 in words rather than a constraint error.
 *
 * `customer_item_requirements` is ONE ROW PER CUSTOMER AND ITEM: whether a COA
 * is required (yes / no / on request), what it must show, when, and to whom.
 * Thin on purpose -- it is widened when the client's column set arrives.
 *
 * Neither table decides anything. The order review prints what they say and
 * warns when a required item has no certificate on the order; nothing is
 * blocked (`loadOrderCustomerContext`, read by functions/lib/order-send.ts).
 */

import { generateId } from './db';
import { BadRequestError, ConflictError, NotFoundError } from './permissions';
import { sanitizeString, validateEmail } from './validation';
import { isCustomerCoaRequired } from '../../shared/itemApproval';
import type { User } from './types';
import type {
  CustomerCoaRequired,
  CustomerContact,
  CustomerContactWriteRequest,
  CustomerContactsResponse,
  CustomerItemRequirement,
  CustomerItemRequirementWriteRequest,
  CustomerItemRequirementsResponse,
} from '../../shared/types';

const NAME_MAX = 200;
const TEXT_MAX = 1000;

function cleanText(v: unknown, max: number): string | null {
  if (v === null || v === undefined) return null;
  const s = sanitizeString(String(v)).slice(0, max);
  return s.length > 0 ? s : null;
}

// ---------------------------------------------------------------------------
// The customer a sub-resource call is about
// ---------------------------------------------------------------------------

export interface CoaCustomer {
  id: string;
  tenant_id: string;
  name: string;
  email: string | null;
}

export async function loadCoaCustomer(db: D1Database, user: User, customerId: string): Promise<CoaCustomer> {
  const customer = await db
    .prepare('SELECT id, tenant_id, name, email FROM customers WHERE id = ?')
    .bind(customerId)
    .first<CoaCustomer>();
  // Another tenant's customer is indistinguishable from a missing one.
  if (!customer || (user.role !== 'super_admin' && customer.tenant_id !== user.tenant_id)) {
    throw new NotFoundError('Customer not found');
  }
  return customer;
}

// ---------------------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------------------

export interface CustomerContactRow {
  id: string;
  customer_id: string;
  tenant_id: string;
  name: string | null;
  email: string;
  role: string | null;
  is_primary: number;
  coa_recipient: number;
  created_at: string;
  updated_at: string;
}

const CONTACT_COLUMNS = 'id, customer_id, tenant_id, name, email, role, is_primary, coa_recipient, created_at, updated_at';

export function toCustomerContact(r: CustomerContactRow): CustomerContact {
  return {
    id: r.id,
    customer_id: r.customer_id,
    name: r.name ?? null,
    email: r.email,
    role: r.role ?? null,
    is_primary: Number(r.is_primary) === 1,
    coa_recipient: Number(r.coa_recipient) === 1,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

export async function listCustomerContacts(
  db: D1Database,
  tenantId: string,
  customerId: string,
): Promise<CustomerContactRow[]> {
  const res = await db
    .prepare(
      `SELECT ${CONTACT_COLUMNS} FROM customer_contacts
        WHERE tenant_id = ? AND customer_id = ?
        ORDER BY is_primary DESC, created_at, email COLLATE NOCASE`,
    )
    .bind(tenantId, customerId)
    .all<CustomerContactRow>();
  return res.results ?? [];
}

export async function buildCustomerContactsResponse(
  db: D1Database,
  customer: CoaCustomer,
): Promise<CustomerContactsResponse> {
  return {
    customer: { id: customer.id, name: customer.name, email: customer.email ?? null },
    contacts: (await listCustomerContacts(db, customer.tenant_id, customer.id)).map(toCustomerContact),
  };
}

async function loadContact(db: D1Database, customer: CoaCustomer, contactId: string): Promise<CustomerContactRow> {
  const row = await db
    .prepare(`SELECT ${CONTACT_COLUMNS} FROM customer_contacts WHERE id = ? AND customer_id = ? AND tenant_id = ?`)
    .bind(contactId, customer.id, customer.tenant_id)
    .first<CustomerContactRow>();
  if (!row) throw new NotFoundError('Contact not found');
  return row;
}

function cleanEmail(v: unknown): string {
  const email = typeof v === 'string' ? v.trim() : '';
  if (!email) throw new BadRequestError('A contact needs an email address');
  if (!validateEmail(email)) throw new BadRequestError(`"${email}" is not a valid email address`);
  return email;
}

async function refuseDuplicateAddress(
  db: D1Database,
  customerId: string,
  email: string,
  exceptId: string | null,
): Promise<void> {
  const clash = await db
    .prepare('SELECT id FROM customer_contacts WHERE customer_id = ? AND lower(email) = lower(?)')
    .bind(customerId, email)
    .first<{ id: string }>();
  if (clash && clash.id !== exceptId) {
    throw new ConflictError(`This customer already has a contact at ${email}.`);
  }
}

export async function createCustomerContact(
  db: D1Database,
  customer: CoaCustomer,
  body: CustomerContactWriteRequest,
): Promise<CustomerContactRow> {
  const email = cleanEmail(body.email);
  await refuseDuplicateAddress(db, customer.id, email, null);

  const existing = await db
    .prepare('SELECT COUNT(*) AS n FROM customer_contacts WHERE customer_id = ? AND tenant_id = ?')
    .bind(customer.id, customer.tenant_id)
    .first<{ n: number }>();
  // The first contact a customer gets is its primary unless the caller says
  // otherwise -- the rule the order connector has always applied.
  const primary = body.is_primary === undefined ? (existing?.n ?? 0) === 0 : Boolean(body.is_primary);

  const id = generateId();
  const stmts: D1PreparedStatement[] = [];
  if (primary) {
    stmts.push(
      db
        .prepare(`UPDATE customer_contacts SET is_primary = 0, updated_at = datetime('now') WHERE customer_id = ? AND tenant_id = ? AND is_primary = 1`)
        .bind(customer.id, customer.tenant_id),
    );
  }
  stmts.push(
    db
      .prepare(
        `INSERT INTO customer_contacts (id, customer_id, tenant_id, name, email, role, is_primary, coa_recipient)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        customer.id,
        customer.tenant_id,
        cleanText(body.name, NAME_MAX),
        email,
        cleanText(body.role, NAME_MAX),
        primary ? 1 : 0,
        body.coa_recipient === false ? 0 : 1,
      ),
  );
  await db.batch(stmts);
  return loadContact(db, customer, id);
}

export async function updateCustomerContact(
  db: D1Database,
  customer: CoaCustomer,
  contactId: string,
  body: CustomerContactWriteRequest,
): Promise<{ row: CustomerContactRow; previous: CustomerContactRow; changed: boolean }> {
  const previous = await loadContact(db, customer, contactId);
  const sets: string[] = [];
  const params: Array<string | number | null> = [];

  if (body.email !== undefined) {
    const email = cleanEmail(body.email);
    if (email !== previous.email) {
      await refuseDuplicateAddress(db, customer.id, email, previous.id);
      sets.push('email = ?');
      params.push(email);
    }
  }
  if (body.name !== undefined) {
    const name = cleanText(body.name, NAME_MAX);
    if (name !== (previous.name ?? null)) {
      sets.push('name = ?');
      params.push(name);
    }
  }
  if (body.role !== undefined) {
    const role = cleanText(body.role, NAME_MAX);
    if (role !== (previous.role ?? null)) {
      sets.push('role = ?');
      params.push(role);
    }
  }
  if (body.coa_recipient !== undefined) {
    const v = body.coa_recipient ? 1 : 0;
    if (v !== Number(previous.coa_recipient)) {
      sets.push('coa_recipient = ?');
      params.push(v);
    }
  }
  const makePrimary = body.is_primary === true && Number(previous.is_primary) !== 1;
  if (body.is_primary !== undefined) {
    const v = body.is_primary ? 1 : 0;
    if (v !== Number(previous.is_primary)) {
      sets.push('is_primary = ?');
      params.push(v);
    }
  }
  if (sets.length === 0) return { row: previous, previous, changed: false };

  const stmts: D1PreparedStatement[] = [];
  if (makePrimary) {
    // One primary per customer: the previous one steps down in the same batch.
    stmts.push(
      db
        .prepare(`UPDATE customer_contacts SET is_primary = 0, updated_at = datetime('now') WHERE customer_id = ? AND tenant_id = ? AND is_primary = 1`)
        .bind(customer.id, customer.tenant_id),
    );
  }
  stmts.push(
    db
      .prepare(`UPDATE customer_contacts SET ${sets.join(', ')}, updated_at = datetime('now') WHERE id = ? AND tenant_id = ?`)
      .bind(...params, previous.id, customer.tenant_id),
  );
  await db.batch(stmts);
  return { row: await loadContact(db, customer, contactId), previous, changed: true };
}

export async function deleteCustomerContact(
  db: D1Database,
  customer: CoaCustomer,
  contactId: string,
): Promise<{ removed: CustomerContactRow; cleared_requirement_ids: string[] }> {
  const removed = await loadContact(db, customer, contactId);
  // Requirements that named this contact fall back to "no delivery contact".
  // Named in the audit row, because the foreign key would do it silently.
  const used = await db
    .prepare('SELECT id FROM customer_item_requirements WHERE delivery_contact_id = ? AND tenant_id = ?')
    .bind(contactId, customer.tenant_id)
    .all<{ id: string }>();
  await db.batch([
    db
      .prepare(`UPDATE customer_item_requirements SET delivery_contact_id = NULL, updated_at = datetime('now') WHERE delivery_contact_id = ? AND tenant_id = ?`)
      .bind(contactId, customer.tenant_id),
    db.prepare('DELETE FROM customer_contacts WHERE id = ? AND tenant_id = ?').bind(contactId, customer.tenant_id),
  ]);
  return { removed, cleared_requirement_ids: (used.results ?? []).map((r) => r.id) };
}

// ---------------------------------------------------------------------------
// COA requirements by item
// ---------------------------------------------------------------------------

interface RequirementSqlRow {
  id: string;
  customer_id: string;
  product_id: string;
  product_name: string;
  product_active: number | null;
  coa_required: CustomerCoaRequired;
  must_show: string | null;
  timing: string | null;
  delivery_contact_id: string | null;
  delivery_contact_name: string | null;
  delivery_contact_email: string | null;
  source: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

const REQUIREMENT_SELECT = `
  SELECT r.id, r.customer_id, r.product_id, p.name AS product_name, p.active AS product_active,
         r.coa_required, r.must_show, r.timing, r.delivery_contact_id,
         cc.name AS delivery_contact_name, cc.email AS delivery_contact_email,
         r.source, r.notes, r.created_at, r.updated_at
    FROM customer_item_requirements r
    JOIN products p ON p.id = r.product_id
    LEFT JOIN customer_contacts cc ON cc.id = r.delivery_contact_id`;

function toRequirement(r: RequirementSqlRow): CustomerItemRequirement {
  return {
    id: r.id,
    customer_id: r.customer_id,
    product_id: r.product_id,
    product_name: r.product_name,
    product_active: Number(r.product_active ?? 1) === 1,
    coa_required: r.coa_required,
    must_show: r.must_show ?? null,
    timing: r.timing ?? null,
    delivery_contact_id: r.delivery_contact_id ?? null,
    delivery_contact:
      r.delivery_contact_id && r.delivery_contact_email
        ? { id: r.delivery_contact_id, name: r.delivery_contact_name ?? null, email: r.delivery_contact_email }
        : null,
    source: r.source ?? null,
    notes: r.notes ?? null,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

export async function listCustomerItemRequirements(
  db: D1Database,
  tenantId: string,
  customerId: string,
): Promise<CustomerItemRequirement[]> {
  const res = await db
    .prepare(`${REQUIREMENT_SELECT} WHERE r.tenant_id = ? AND r.customer_id = ? ORDER BY p.name COLLATE NOCASE, r.id`)
    .bind(tenantId, customerId)
    .all<RequirementSqlRow>();
  return (res.results ?? []).map(toRequirement);
}

export async function buildItemRequirementsResponse(
  db: D1Database,
  customer: CoaCustomer,
): Promise<CustomerItemRequirementsResponse> {
  return {
    customer: { id: customer.id, name: customer.name },
    requirements: await listCustomerItemRequirements(db, customer.tenant_id, customer.id),
  };
}

export async function loadCustomerItemRequirement(
  db: D1Database,
  customer: CoaCustomer,
  requirementId: string,
): Promise<CustomerItemRequirement> {
  const row = await db
    .prepare(`${REQUIREMENT_SELECT} WHERE r.id = ? AND r.customer_id = ? AND r.tenant_id = ?`)
    .bind(requirementId, customer.id, customer.tenant_id)
    .first<RequirementSqlRow>();
  if (!row) throw new NotFoundError('Requirement not found');
  return toRequirement(row);
}

async function resolveDeliveryContact(
  db: D1Database,
  customer: CoaCustomer,
  contactId: unknown,
): Promise<string | null> {
  if (contactId === null || contactId === undefined || contactId === '') return null;
  if (typeof contactId !== 'string') throw new BadRequestError('delivery_contact_id must be a contact id or null');
  const row = await db
    .prepare('SELECT id FROM customer_contacts WHERE id = ? AND customer_id = ? AND tenant_id = ?')
    .bind(contactId, customer.id, customer.tenant_id)
    .first<{ id: string }>();
  if (!row) throw new BadRequestError('That contact does not belong to this customer');
  return row.id;
}

function readCoaRequired(v: unknown): CustomerCoaRequired {
  if (!isCustomerCoaRequired(v)) throw new BadRequestError('coa_required must be yes, no or on_request');
  return v;
}

export async function createCustomerItemRequirement(
  db: D1Database,
  customer: CoaCustomer,
  body: CustomerItemRequirementWriteRequest,
  actorId: string,
): Promise<CustomerItemRequirement> {
  if (typeof body.product_id !== 'string' || !body.product_id) {
    throw new BadRequestError('product_id is required');
  }
  const product = await db
    .prepare('SELECT id, name FROM products WHERE id = ? AND tenant_id = ?')
    .bind(body.product_id, customer.tenant_id)
    .first<{ id: string; name: string }>();
  if (!product) throw new BadRequestError('That product is not in this organization');

  const coaRequired = body.coa_required === undefined ? 'yes' : readCoaRequired(body.coa_required);
  const deliveryContactId = await resolveDeliveryContact(db, customer, body.delivery_contact_id);

  const clash = await db
    .prepare('SELECT id FROM customer_item_requirements WHERE tenant_id = ? AND customer_id = ? AND product_id = ?')
    .bind(customer.tenant_id, customer.id, product.id)
    .first<{ id: string }>();
  if (clash) {
    throw new ConflictError(`${customer.name} already has a COA requirement for ${product.name}. Edit that one.`);
  }

  const id = generateId();
  await db
    .prepare(
      `INSERT INTO customer_item_requirements
         (id, tenant_id, customer_id, product_id, coa_required, must_show, timing, delivery_contact_id,
          source, notes, created_by, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'admin', ?, ?, ?)`,
    )
    .bind(
      id,
      customer.tenant_id,
      customer.id,
      product.id,
      coaRequired,
      cleanText(body.must_show, TEXT_MAX),
      cleanText(body.timing, NAME_MAX),
      deliveryContactId,
      cleanText(body.notes, TEXT_MAX),
      actorId,
      actorId,
    )
    .run();
  return loadCustomerItemRequirement(db, customer, id);
}

export async function updateCustomerItemRequirement(
  db: D1Database,
  customer: CoaCustomer,
  requirementId: string,
  body: CustomerItemRequirementWriteRequest,
  actorId: string,
): Promise<{ row: CustomerItemRequirement; previous: CustomerItemRequirement; changed: boolean }> {
  const previous = await loadCustomerItemRequirement(db, customer, requirementId);
  if (body.product_id !== undefined && body.product_id !== previous.product_id) {
    // A requirement IS (customer, item). Another item is another requirement.
    throw new BadRequestError('A requirement cannot be moved to another item. Remove it and add one for that item.');
  }
  const sets: string[] = [];
  const params: Array<string | null> = [];

  if (body.coa_required !== undefined) {
    const v = readCoaRequired(body.coa_required);
    if (v !== previous.coa_required) {
      sets.push('coa_required = ?');
      params.push(v);
    }
  }
  if (body.must_show !== undefined) {
    const v = cleanText(body.must_show, TEXT_MAX);
    if (v !== previous.must_show) {
      sets.push('must_show = ?');
      params.push(v);
    }
  }
  if (body.timing !== undefined) {
    const v = cleanText(body.timing, NAME_MAX);
    if (v !== previous.timing) {
      sets.push('timing = ?');
      params.push(v);
    }
  }
  if (body.notes !== undefined) {
    const v = cleanText(body.notes, TEXT_MAX);
    if (v !== previous.notes) {
      sets.push('notes = ?');
      params.push(v);
    }
  }
  if (body.delivery_contact_id !== undefined) {
    const v = await resolveDeliveryContact(db, customer, body.delivery_contact_id);
    if (v !== previous.delivery_contact_id) {
      sets.push('delivery_contact_id = ?');
      params.push(v);
    }
  }
  if (sets.length === 0) return { row: previous, previous, changed: false };

  await db
    .prepare(
      `UPDATE customer_item_requirements SET ${sets.join(', ')}, updated_at = datetime('now'), updated_by = ?
        WHERE id = ? AND tenant_id = ?`,
    )
    .bind(...params, actorId, requirementId, customer.tenant_id)
    .run();
  return { row: await loadCustomerItemRequirement(db, customer, requirementId), previous, changed: true };
}

export async function deleteCustomerItemRequirement(
  db: D1Database,
  customer: CoaCustomer,
  requirementId: string,
): Promise<CustomerItemRequirement> {
  const removed = await loadCustomerItemRequirement(db, customer, requirementId);
  await db
    .prepare('DELETE FROM customer_item_requirements WHERE id = ? AND tenant_id = ?')
    .bind(requirementId, customer.tenant_id)
    .run();
  return removed;
}

// ---------------------------------------------------------------------------
// What an order send reads
// ---------------------------------------------------------------------------

export interface OrderCustomerContext {
  /** COA contacts in the order they are pre-filled: primary first. */
  coa_contacts: Array<{ id: string; name: string | null; email: string }>;
  /** The customer's requirement per item, keyed on product id. */
  requirements: Map<string, CustomerItemRequirement>;
}

/**
 * Everything the order review needs from the customer's record. Reads only.
 * A customer with no contact and no requirement returns two empty answers, so
 * an organisation that never opens these screens sends exactly as before.
 */
export async function loadOrderCustomerContext(
  db: D1Database,
  tenantId: string,
  customerId: string | null,
): Promise<OrderCustomerContext> {
  if (!customerId) return { coa_contacts: [], requirements: new Map() };
  const contacts = (await listCustomerContacts(db, tenantId, customerId)).filter(
    (c) => Number(c.coa_recipient) === 1,
  );
  const requirements = await listCustomerItemRequirements(db, tenantId, customerId);
  return {
    coa_contacts: contacts.map((c) => ({ id: c.id, name: c.name ?? null, email: c.email })),
    requirements: new Map(requirements.map((r) => [r.product_id, r])),
  };
}
