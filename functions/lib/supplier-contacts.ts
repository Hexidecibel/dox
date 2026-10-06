/**
 * Supplier contacts (migration 0133): who at a supplier receives document
 * requests.
 *
 * One fact matters to the renewal send and it is the only one this module is
 * careful about: a supplier has AT MOST ONE active document contact. The
 * approval screen shows a "To" line, and a "To" line with two possible answers
 * is how a certificate request goes to the sales rep. A partial unique index
 * enforces it; `saveSupplierContact` makes room first (demoting the previous
 * document contact in the same batch) so the index is a backstop rather than a
 * 500.
 *
 * `email_norm` is the identity and is computed HERE, never in SQL: trimmed and
 * lower-cased, the same conservative fold `owner_routes.owner_key` uses. No
 * plus-address stripping and no domain aliasing -- guessing that two addresses
 * are one person would merge contacts on a hunch.
 *
 * Three producers write contacts: an admin on Supplier > Contacts, the verified
 * supplier list import (`source = 'import'`), and a supplier merge (which
 * moves rows). All three go through this file.
 */

import { generateId } from './db';
import { BadRequestError, ConflictError, NotFoundError } from './permissions';
import { sanitizeString, validateEmail } from './validation';
import type { SupplierContact } from '../../shared/types';

export interface SupplierContactRow {
  id: string;
  tenant_id: string;
  supplier_id: string;
  name: string | null;
  email: string;
  email_norm: string;
  role: string | null;
  priority: number | null;
  is_document_contact: number;
  active: number;
  source: string | null;
  created_at: string;
  created_by: string | null;
  updated_at: string;
  updated_by: string | null;
}

export function normalizeContactEmail(email: unknown): string | null {
  if (typeof email !== 'string') return null;
  const norm = email.trim().toLowerCase();
  return norm.length > 0 ? norm : null;
}

function cleanText(v: unknown, max: number): string | null {
  if (v === null || v === undefined) return null;
  const s = sanitizeString(String(v)).slice(0, max);
  return s.length > 0 ? s : null;
}

export function toSupplierContact(r: SupplierContactRow): SupplierContact {
  return {
    id: r.id,
    supplier_id: r.supplier_id,
    name: r.name ?? null,
    email: r.email,
    role: r.role ?? null,
    priority: r.priority ?? null,
    is_document_contact: Number(r.is_document_contact) === 1,
    active: Number(r.active) === 1,
    source: r.source ?? null,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

export async function listSupplierContacts(
  db: D1Database,
  tenantId: string,
  supplierId: string,
): Promise<SupplierContactRow[]> {
  const res = await db
    .prepare(
      `SELECT * FROM supplier_contacts
        WHERE tenant_id = ? AND supplier_id = ?
        ORDER BY active DESC, is_document_contact DESC, COALESCE(priority, 999999), created_at, id`,
    )
    .bind(tenantId, supplierId)
    .all<SupplierContactRow>();
  return res.results ?? [];
}

export async function loadSupplierContact(
  db: D1Database,
  tenantId: string,
  supplierId: string,
  contactId: string,
): Promise<SupplierContactRow> {
  const row = await db
    .prepare('SELECT * FROM supplier_contacts WHERE id = ? AND tenant_id = ? AND supplier_id = ?')
    .bind(contactId, tenantId, supplierId)
    .first<SupplierContactRow>();
  if (!row) throw new NotFoundError('Contact not found');
  return row;
}

/** The one address a document request to this supplier goes to, or null. */
export async function loadDocumentContact(
  db: D1Database,
  tenantId: string,
  supplierId: string,
): Promise<SupplierContactRow | null> {
  const row = await db
    .prepare(
      `SELECT * FROM supplier_contacts
        WHERE tenant_id = ? AND supplier_id = ? AND is_document_contact = 1 AND active = 1
        LIMIT 1`,
    )
    .bind(tenantId, supplierId)
    .first<SupplierContactRow>();
  return row ?? null;
}

/** Every supplier's document contact in a tenant, keyed by supplier id. */
export async function loadDocumentContactsByTenant(
  db: D1Database,
  tenantId: string,
): Promise<Map<string, SupplierContactRow>> {
  const res = await db
    .prepare(
      `SELECT * FROM supplier_contacts
        WHERE tenant_id = ? AND is_document_contact = 1 AND active = 1`,
    )
    .bind(tenantId)
    .all<SupplierContactRow>();
  return new Map((res.results ?? []).map((r) => [r.supplier_id, r]));
}

export interface SupplierContactInput {
  name?: unknown;
  email?: unknown;
  role?: unknown;
  priority?: unknown;
  is_document_contact?: unknown;
  active?: unknown;
}

function parsePriority(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 9999) {
    throw new BadRequestError('priority must be a whole number between 0 and 9999');
  }
  return n;
}

function parseFlag(v: unknown, field: string): boolean {
  if (v === true || v === 1) return true;
  if (v === false || v === 0) return false;
  throw new BadRequestError(`${field} must be true or false`);
}

/** Statement that clears the supplier's current document contact, except `keepId`. */
function demoteOthers(
  db: D1Database,
  tenantId: string,
  supplierId: string,
  keepId: string,
  userId: string | null,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE supplier_contacts
          SET is_document_contact = 0, updated_at = datetime('now'), updated_by = ?
        WHERE tenant_id = ? AND supplier_id = ? AND id <> ? AND is_document_contact = 1`,
    )
    .bind(userId, tenantId, supplierId, keepId);
}

export interface SaveContactResult {
  row: SupplierContactRow;
  /** The contact that stopped being the document contact because of this save. */
  demoted: SupplierContactRow | null;
}

/**
 * Add a contact. The first contact a supplier gets is its document contact
 * unless the caller says otherwise -- a supplier with one address on file and
 * nobody to send requests to is the configuration nobody means.
 */
export async function createSupplierContact(
  db: D1Database,
  tenantId: string,
  supplierId: string,
  input: SupplierContactInput,
  opts: { userId: string | null; source: string },
): Promise<SaveContactResult> {
  const emailRaw = typeof input.email === 'string' ? input.email.trim() : '';
  if (!emailRaw || !validateEmail(emailRaw)) {
    throw new BadRequestError('A valid email address is required');
  }
  const emailNorm = normalizeContactEmail(emailRaw)!;

  const existing = await db
    .prepare('SELECT id FROM supplier_contacts WHERE supplier_id = ? AND email_norm = ?')
    .bind(supplierId, emailNorm)
    .first<{ id: string }>();
  if (existing) {
    throw new ConflictError('This supplier already has a contact with that email address');
  }

  const current = await loadDocumentContact(db, tenantId, supplierId);
  const wantsDocumentContact =
    input.is_document_contact === undefined
      ? current === null
      : parseFlag(input.is_document_contact, 'is_document_contact');

  const id = generateId();
  const statements: D1PreparedStatement[] = [];
  // Make room BEFORE the insert: the partial unique index allows one.
  if (wantsDocumentContact) statements.push(demoteOthers(db, tenantId, supplierId, id, opts.userId));
  statements.push(
    db
      .prepare(
        `INSERT INTO supplier_contacts
           (id, tenant_id, supplier_id, name, email, email_norm, role, priority,
            is_document_contact, active, source, created_by, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      )
      .bind(
        id,
        tenantId,
        supplierId,
        cleanText(input.name, 200),
        emailRaw,
        emailNorm,
        cleanText(input.role, 100),
        parsePriority(input.priority),
        wantsDocumentContact ? 1 : 0,
        opts.source,
        opts.userId,
        opts.userId,
      ),
  );
  await db.batch(statements);

  return {
    row: await loadSupplierContact(db, tenantId, supplierId, id),
    demoted: wantsDocumentContact && current ? current : null,
  };
}

export async function updateSupplierContact(
  db: D1Database,
  tenantId: string,
  supplierId: string,
  contactId: string,
  input: SupplierContactInput,
  opts: { userId: string | null },
): Promise<SaveContactResult & { previous: SupplierContactRow }> {
  const previous = await loadSupplierContact(db, tenantId, supplierId, contactId);

  let email = previous.email;
  let emailNorm = previous.email_norm;
  if (input.email !== undefined) {
    const emailRaw = typeof input.email === 'string' ? input.email.trim() : '';
    if (!emailRaw || !validateEmail(emailRaw)) {
      throw new BadRequestError('A valid email address is required');
    }
    email = emailRaw;
    emailNorm = normalizeContactEmail(emailRaw)!;
    if (emailNorm !== previous.email_norm) {
      const clash = await db
        .prepare('SELECT id FROM supplier_contacts WHERE supplier_id = ? AND email_norm = ? AND id <> ?')
        .bind(supplierId, emailNorm, contactId)
        .first<{ id: string }>();
      if (clash) {
        throw new ConflictError('This supplier already has a contact with that email address');
      }
    }
  }

  const active = input.active === undefined ? Number(previous.active) === 1 : parseFlag(input.active, 'active');
  let isDocumentContact =
    input.is_document_contact === undefined
      ? Number(previous.is_document_contact) === 1
      : parseFlag(input.is_document_contact, 'is_document_contact');
  // An inactive contact cannot be the address requests go to.
  if (!active) isDocumentContact = false;

  const current = await loadDocumentContact(db, tenantId, supplierId);
  const demoted = isDocumentContact && current && current.id !== contactId ? current : null;

  const statements: D1PreparedStatement[] = [];
  if (isDocumentContact) statements.push(demoteOthers(db, tenantId, supplierId, contactId, opts.userId));
  statements.push(
    db
      .prepare(
        `UPDATE supplier_contacts
            SET name = ?, email = ?, email_norm = ?, role = ?, priority = ?,
                is_document_contact = ?, active = ?, updated_at = datetime('now'), updated_by = ?
          WHERE id = ? AND tenant_id = ? AND supplier_id = ?`,
      )
      .bind(
        input.name === undefined ? previous.name : cleanText(input.name, 200),
        email,
        emailNorm,
        input.role === undefined ? previous.role : cleanText(input.role, 100),
        input.priority === undefined ? previous.priority : parsePriority(input.priority),
        isDocumentContact ? 1 : 0,
        active ? 1 : 0,
        opts.userId,
        contactId,
        tenantId,
        supplierId,
      ),
  );
  await db.batch(statements);

  return {
    row: await loadSupplierContact(db, tenantId, supplierId, contactId),
    demoted,
    previous,
  };
}

export async function deleteSupplierContact(
  db: D1Database,
  tenantId: string,
  supplierId: string,
  contactId: string,
): Promise<SupplierContactRow> {
  const previous = await loadSupplierContact(db, tenantId, supplierId, contactId);
  await db
    .prepare('DELETE FROM supplier_contacts WHERE id = ? AND tenant_id = ? AND supplier_id = ?')
    .bind(contactId, tenantId, supplierId)
    .run();
  return previous;
}

export type ImportedContactOutcome = 'created' | 'exists' | 'invalid';

/**
 * Record an address from the verified supplier list. Idempotent: an address
 * the supplier already has is left exactly as it is (a person may since have
 * renamed it, demoted it or switched it off, and a re-import is not a reason
 * to undo that). A new address becomes the document contact only when the
 * supplier has none.
 */
export async function recordImportedContact(
  db: D1Database,
  tenantId: string,
  supplierId: string,
  email: string,
  userId: string | null,
): Promise<ImportedContactOutcome> {
  const emailRaw = String(email ?? '').trim();
  if (!emailRaw || !validateEmail(emailRaw)) return 'invalid';
  const emailNorm = normalizeContactEmail(emailRaw)!;
  const existing = await db
    .prepare('SELECT id FROM supplier_contacts WHERE supplier_id = ? AND email_norm = ?')
    .bind(supplierId, emailNorm)
    .first<{ id: string }>();
  if (existing) return 'exists';
  const current = await loadDocumentContact(db, tenantId, supplierId);
  await db
    .prepare(
      `INSERT OR IGNORE INTO supplier_contacts
         (id, tenant_id, supplier_id, name, email, email_norm, is_document_contact, active,
          source, created_by, updated_by)
       VALUES (?, ?, ?, NULL, ?, ?, ?, 1, 'import', ?, ?)`,
    )
    .bind(generateId(), tenantId, supplierId, emailRaw, emailNorm, current ? 0 : 1, userId, userId)
    .run();
  return 'created';
}
