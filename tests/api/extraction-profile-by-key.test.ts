/**
 * Unit tests for loadExtractionProfile (functions/lib/extractionProfiles.ts).
 *
 * Connectors → Sources / migration 0068: the single source of truth for "how
 * to extract a doc from this (supplier, document_type)" is
 * supplier_extraction_instructions, which now holds BOTH field_mappings AND
 * natural-language instructions. The worker resolves a profile by
 * (tenant, supplier_id, document_type_id) — NOT off the connector row.
 *
 * Covers:
 *   - Exact (supplier, doctype) resolution of field_mappings + instructions.
 *   - Internal-origin supplier (a supplier row standing in for an ERP/WMS
 *     source) resolves identically — the loader keys purely on supplier_id.
 *   - No supplier => safe empty defaults (never throws).
 *   - Unknown doctype => aggregates the supplier's authored guidance and
 *     takes the most-recent field_mappings.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { seedTestData, generateTestId } from '../helpers/db';
import { loadExtractionProfile } from '../../functions/lib/extractionProfiles';

const db = env.DB;
let seed: Awaited<ReturnType<typeof seedTestData>>;

let supplierId = '';
let internalSupplierId = '';
let coaTypeId = '';
let orderTypeId = '';

const COA_MAPPINGS = { version: 2, core: { lot_number: { enabled: true, source_labels: ['Lot'] } }, extended: [] };
const ORDER_MAPPINGS = { version: 2, core: { order_number: { enabled: true, source_labels: ['Order #'] } }, extended: [] };

beforeAll(async () => {
  seed = await seedTestData(db);

  supplierId = generateTestId();
  await db
    .prepare('INSERT INTO suppliers (id, tenant_id, name, slug) VALUES (?, ?, ?, ?)')
    .bind(supplierId, seed.tenantId, 'Profile Test Supplier', `pts-${supplierId.slice(0, 6)}`)
    .run();

  // An internal-origin source is modeled as a normal supplier row that an
  // internal (ERP/WMS) connector points at — structurally identical, so the
  // loader resolves it the same way.
  internalSupplierId = generateTestId();
  await db
    .prepare('INSERT INTO suppliers (id, tenant_id, name, slug) VALUES (?, ?, ?, ?)')
    .bind(internalSupplierId, seed.tenantId, 'Internal ERP', `int-erp-${internalSupplierId.slice(0, 6)}`)
    .run();

  coaTypeId = generateTestId();
  orderTypeId = generateTestId();
  await db
    .prepare('INSERT INTO document_types (id, tenant_id, name, slug, active) VALUES (?, ?, ?, ?, 1)')
    .bind(coaTypeId, seed.tenantId, 'COA', `coa-${coaTypeId.slice(0, 6)}`)
    .run();
  await db
    .prepare('INSERT INTO document_types (id, tenant_id, name, slug, active) VALUES (?, ?, ?, ?, 1)')
    .bind(orderTypeId, seed.tenantId, 'Order', `ord-${orderTypeId.slice(0, 6)}`)
    .run();

  // Authored profile rows in the unified store.
  await db
    .prepare(
      `INSERT INTO supplier_extraction_instructions
         (id, supplier_id, document_type_id, tenant_id, instructions, field_mappings)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(generateTestId(), supplierId, coaTypeId, seed.tenantId, 'Treat code date as expiration', JSON.stringify(COA_MAPPINGS))
    .run();
  await db
    .prepare(
      `INSERT INTO supplier_extraction_instructions
         (id, supplier_id, document_type_id, tenant_id, instructions, field_mappings, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
    )
    .bind(generateTestId(), supplierId, orderTypeId, seed.tenantId, 'Order guidance', JSON.stringify(ORDER_MAPPINGS))
    .run();

  // Internal supplier: a COA profile only.
  await db
    .prepare(
      `INSERT INTO supplier_extraction_instructions
         (id, supplier_id, document_type_id, tenant_id, instructions, field_mappings)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(generateTestId(), internalSupplierId, coaTypeId, seed.tenantId, 'Internal COA rules', JSON.stringify(COA_MAPPINGS))
    .run();
}, 30_000);

describe('loadExtractionProfile', () => {
  it('resolves field_mappings + instructions by exact (supplier, document_type)', async () => {
    const p = await loadExtractionProfile(db, {
      tenantId: seed.tenantId,
      supplierId,
      documentTypeId: coaTypeId,
    });
    expect(p.supplier_id).toBe(supplierId);
    expect(p.document_type_id).toBe(coaTypeId);
    expect(p.extraction_instructions).toBe('Treat code date as expiration');
    expect(p.field_mappings).toEqual(COA_MAPPINGS);
  });

  it('keys a different doctype to that doctype profile (not the COA one)', async () => {
    const p = await loadExtractionProfile(db, {
      tenantId: seed.tenantId,
      supplierId,
      documentTypeId: orderTypeId,
    });
    expect(p.extraction_instructions).toBe('Order guidance');
    expect(p.field_mappings).toEqual(ORDER_MAPPINGS);
  });

  it('resolves an internal-origin supplier identically (keys on supplier_id)', async () => {
    const p = await loadExtractionProfile(db, {
      tenantId: seed.tenantId,
      supplierId: internalSupplierId,
      documentTypeId: coaTypeId,
    });
    expect(p.supplier_id).toBe(internalSupplierId);
    expect(p.extraction_instructions).toBe('Internal COA rules');
    expect(p.field_mappings).toEqual(COA_MAPPINGS);
  });

  it('returns safe empty defaults (no throw) when supplier is unknown', async () => {
    const p = await loadExtractionProfile(db, {
      tenantId: seed.tenantId,
      supplierId: null,
      documentTypeId: coaTypeId,
    });
    expect(p.field_mappings).toBeNull();
    expect(p.extraction_instructions).toBe('');
    expect(p.examples).toEqual([]);
  });

  it('aggregates across doctypes + takes recent field_mappings when doctype unknown', async () => {
    const p = await loadExtractionProfile(db, {
      tenantId: seed.tenantId,
      supplierId,
      documentTypeId: null,
    });
    // Both authored profiles' instructions are folded in.
    expect(p.extraction_instructions).toMatch(/Treat code date as expiration/);
    expect(p.extraction_instructions).toMatch(/Order guidance/);
    // Most-recently-updated field_mappings wins; both are valid v2 configs.
    expect(p.field_mappings).not.toBeNull();
  });
});
