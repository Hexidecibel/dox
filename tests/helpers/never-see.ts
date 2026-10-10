/**
 * The client's test for every page and mail an outsider reads: "plant an
 * internal note, a limit and another tenant's record, and confirm none of them
 * leak."
 *
 * `plantNeverSee` writes those three things NEXT TO whatever the surface under
 * test reads -- on the same document and the same supplier -- and returns the
 * strings that must not appear in a byte of what leaves. `expectNothingPlanted`
 * names which one did, so a failure says what leaked rather than "expected
 * string not to contain".
 *
 * Used by the four outside surfaces that predate the Records leak tests
 * (supplier request page, export page, document-order links, COA order
 * sends); `tests/api/records-public-leak.test.ts` plants its own, richer
 * world.
 */

import { expect } from 'vitest';
import { generateTestId } from './db';

export interface PlantOptions {
  tenantId: string;
  /** A second tenant: gets a supplier, a document and a limit of its own. */
  otherTenantId: string;
  /** Any existing user id: author of the note, creator of the documents. */
  authorId: string;
  /** The document the surface under test shows, when it shows one. */
  documentId?: string;
  /** The supplier the surface under test is about, when it is about one. */
  supplierId?: string;
}

/** label -> the string that must never appear. */
export type Planted = Record<string, string>;

export async function plantNeverSee(db: D1Database, o: PlantOptions): Promise<Planted> {
  const tag = generateTestId().slice(0, 8).toUpperCase();
  const planted: Planted = {};

  // --- an internal note, on the document and on the supplier ---------------
  if (o.documentId) {
    planted.note_on_document = `NEVERSEE-NOTE-ON-DOCUMENT-${tag}`;
    await db
      .prepare(`INSERT INTO entity_notes (tenant_id, entity_type, entity_id, body, author_id) VALUES (?, 'document', ?, ?, ?)`)
      .bind(o.tenantId, o.documentId, planted.note_on_document, o.authorId)
      .run();
  }
  if (o.supplierId) {
    planted.note_on_supplier = `NEVERSEE-NOTE-ON-SUPPLIER-${tag}`;
    await db
      .prepare(`INSERT INTO entity_notes (tenant_id, entity_type, entity_id, body, author_id) VALUES (?, 'supplier', ?, ?, ?)`)
      .bind(o.tenantId, o.supplierId, planted.note_on_supplier, o.authorId)
      .run();
  }

  // --- a limit: the analyte, the threshold, its criticality, its note ------
  const specTestId = generateTestId();
  planted.spec_test = `NEVERSEE-ANALYTE-${tag}`;
  planted.spec_test_note = `NEVERSEE-ANALYTE-NOTE-${tag}`;
  planted.spec_limit_note = `NEVERSEE-LIMIT-NOTE-${tag}`;
  // A threshold nobody would print by coincidence.
  planted.spec_limit_value = '7.31337';
  await db
    .prepare('INSERT INTO spec_tests (id, tenant_id, name, notes) VALUES (?, ?, ?, ?)')
    .bind(specTestId, o.tenantId, planted.spec_test, planted.spec_test_note)
    .run();
  const limitId = generateTestId();
  await db
    .prepare(
      `INSERT INTO spec_limits (id, tenant_id, spec_test_id, supplier_id, operator, value_max, unit, notes, criticality)
       VALUES (?, ?, ?, ?, '<=', 7.31337, 'CFU/g', ?, 'high')`,
    )
    .bind(limitId, o.tenantId, specTestId, o.supplierId ?? null, planted.spec_limit_note)
    .run();
  if (o.documentId) {
    // The document was judged against it: the reasoning and the frozen
    // snapshot of the limit sit on the document itself.
    planted.spec_judgement = `NEVERSEE-JUDGEMENT-${tag}`;
    planted.spec_limit_text = `NEVERSEE-LIMIT-TEXT-${tag}`;
    await db
      .prepare(
        `INSERT INTO document_spec_checks
           (id, tenant_id, document_id, version_number, queue_item_id, spec_test_id,
            test_name_raw, value_raw, value_num, unit_raw, verdict, reason, source,
            limit_id, limit_snapshot)
         VALUES (?, ?, ?, 1, ?, ?, ?, '40', 40, 'CFU/g', 'out_of_spec', ?, 'limit', ?, ?)`,
      )
      .bind(
        generateTestId(),
        o.tenantId,
        o.documentId,
        `neversee-queue-${tag}`,
        specTestId,
        planted.spec_test,
        planted.spec_judgement,
        limitId,
        JSON.stringify({ operator: '<=', value_max: 7.31337, unit: 'CFU/g', text: planted.spec_limit_text, criticality: 'high' }),
      )
      .run();
  }

  // --- another tenant's records ---------------------------------------------
  const otherSupplierId = generateTestId();
  planted.other_tenant_supplier = `NEVERSEE-OTHER-TENANT-SUPPLIER-${tag}`;
  planted.other_tenant_supplier_id = otherSupplierId;
  await db
    .prepare('INSERT INTO suppliers (id, tenant_id, name, slug) VALUES (?, ?, ?, ?)')
    .bind(otherSupplierId, o.otherTenantId, planted.other_tenant_supplier, `neversee-${tag.toLowerCase()}`)
    .run();
  const otherDocumentId = generateTestId();
  planted.other_tenant_document = `NEVERSEE-OTHER-TENANT-DOCUMENT-${tag}`;
  planted.other_tenant_document_id = otherDocumentId;
  await db
    .prepare(
      `INSERT INTO documents (id, tenant_id, title, current_version, status, created_by, supplier_id)
       VALUES (?, ?, ?, 1, 'active', ?, ?)`,
    )
    .bind(otherDocumentId, o.otherTenantId, planted.other_tenant_document, o.authorId, otherSupplierId)
    .run();
  planted.other_tenant_note = `NEVERSEE-OTHER-TENANT-NOTE-${tag}`;
  await db
    .prepare(`INSERT INTO entity_notes (tenant_id, entity_type, entity_id, body, author_id) VALUES (?, 'document', ?, ?, ?)`)
    .bind(o.otherTenantId, otherDocumentId, planted.other_tenant_note, o.authorId)
    .run();
  planted.other_tenant_id = o.otherTenantId;

  return planted;
}

/** Fails naming every planted thing found in `text`. */
export function expectNothingPlanted(text: string, planted: Planted): void {
  const found = Object.entries(planted)
    .filter(([, value]) => value && text.includes(value))
    .map(([label]) => label);
  expect(found).toEqual([]);
}
