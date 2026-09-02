/**
 * Shared helpers for `entity_notes` (migration 0088) — the generic notes
 * facility.
 *
 * The table is polymorphic: (entity_type, entity_id) names the parent and no
 * foreign key can enforce it. That makes THIS module the only thing standing
 * between a note and the wrong tenant's record, so the resolver table below is
 * load-bearing, not a convenience.
 *
 * Adding a new parent type is: add a row to NOTE_PARENTS, and (only if the
 * value is not already in the migration's CHECK) widen the CHECK. It is not a
 * new table, a new endpoint or a new UI component.
 */

import { BadRequestError, NotFoundError } from './permissions';

/**
 * Parent types the API will accept.
 *
 * NARROWER THAN THE DB CHECK BY DESIGN. The migration's CHECK is an integrity
 * backstop seeded with the types this facility is intended to serve (widening a
 * CHECK in SQLite is a table rebuild). This list is the precise gate: a type is
 * only usable once it has a tenant-scoped existence query below, so a note can
 * never be hung off an id the caller does not own.
 */
export const NOTE_ENTITY_TYPES = [
  'supplier',
  'document',
  'requirement',
  'supplier_requirement',
] as const;

export type NoteEntityType = (typeof NOTE_ENTITY_TYPES)[number];

export function isValidNoteEntityType(value: string): value is NoteEntityType {
  return (NOTE_ENTITY_TYPES as readonly string[]).includes(value);
}

/**
 * How to prove a parent exists INSIDE a given tenant, per type.
 *
 * Every entry must filter on tenant_id. A resolver that looks up by id alone
 * would let an org_admin attach a note to another tenant's record and then read
 * it back through the same (entity_type, entity_id) pair — the tenant-isolation
 * hole this table's lack of a foreign key would otherwise open.
 */
const NOTE_PARENTS: Record<NoteEntityType, { table: string; label: string }> = {
  supplier: { table: 'suppliers', label: 'Supplier' },
  document: { table: 'documents', label: 'Document' },
  requirement: { table: 'requirements', label: 'Requirement' },
  supplier_requirement: {
    table: 'supplier_requirements',
    label: 'Supplier requirement',
  },
};

/**
 * Assert that `entityId` names a real record of `entityType` in `tenantId`.
 *
 * Throws BadRequestError for an unknown type (the caller sent nonsense) and
 * NotFoundError for a good type with a bad id (the record is not there, or not
 * theirs — the two are deliberately indistinguishable from outside, so this
 * cannot be used to probe another tenant for id existence).
 */
export async function assertNoteParent(
  db: D1Database,
  tenantId: string,
  entityType: string,
  entityId: string,
): Promise<NoteEntityType> {
  if (!isValidNoteEntityType(entityType)) {
    throw new BadRequestError(
      `entity_type must be one of: ${NOTE_ENTITY_TYPES.join(', ')}`,
    );
  }
  if (!entityId) throw new BadRequestError('entity_id is required');

  const parent = NOTE_PARENTS[entityType];
  const row = await db
    .prepare(`SELECT id FROM ${parent.table} WHERE id = ? AND tenant_id = ?`)
    .bind(entityId, tenantId)
    .first();

  if (!row) throw new NotFoundError(`${parent.label} not found`);
  return entityType;
}
