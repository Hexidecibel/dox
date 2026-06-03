/**
 * Unit tests for the Learning Interface uncertainty analyzer.
 *
 * Drives functions/lib/teach/uncertainty.ts directly against env.DB. Seeds a
 * handful of processing_queue rows with crafted ai_fields:
 *   - product_code that looks like a phone number  -> implausible
 *   - lot_number empty in most docs                -> often-empty
 *   - grade with many distinct values              -> inconsistent
 * and asserts the right issues come back. Adds no migration.
 */

import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { analyzeUncertainty } from '../../functions/lib/teach/uncertainty';
import { runMigrations } from '../helpers/db';

const db = env.DB;

const TENANT = 'tu-tenant';
const SUPPLIER = 'tu-supplier-1';
const SUPPLIER_NAME = 'Acme Chemicals';
const DOCTYPE = 'tu-doctype-coa';

function row(id: string, fields: Record<string, string | null>, opts: { supplierId?: string | null; supplier?: string | null } = {}) {
  return db
    .prepare(
      `INSERT INTO processing_queue
        (id, tenant_id, document_type_id, file_r2_key, file_name, file_size, mime_type,
         ai_fields, processing_status, supplier_id, supplier, output_kind, status, created_at)
       VALUES (?, ?, ?, ?, ?, 100, 'application/pdf', ?, 'ready', ?, ?, 'coa', 'pending', datetime('now'))`,
    )
    .bind(
      id,
      TENANT,
      DOCTYPE,
      `queue/${id}/file.pdf`,
      `${id}.pdf`,
      JSON.stringify(fields),
      opts.supplierId === undefined ? SUPPLIER : opts.supplierId,
      opts.supplier === undefined ? null : opts.supplier,
    )
    .run();
}

async function reset() {
  await db.prepare(`DELETE FROM processing_queue WHERE tenant_id = ?`).bind(TENANT).run();
  await db.prepare(`DELETE FROM suppliers WHERE id = ?`).bind(SUPPLIER).run();
  await db.prepare(`DELETE FROM document_types WHERE id = ?`).bind(DOCTYPE).run();
  await db.prepare(`DELETE FROM tenants WHERE id = ?`).bind(TENANT).run();
}

beforeAll(async () => {
  await runMigrations(db);
});

beforeEach(async () => {
  await reset();
  await db
    .prepare(`INSERT INTO tenants (id, name, slug, active, created_at, updated_at) VALUES (?, ?, ?, 1, datetime('now'), datetime('now'))`)
    .bind(TENANT, 'TU Tenant', 'tu-tenant')
    .run();
  await db
    .prepare(`INSERT INTO suppliers (id, tenant_id, name, slug) VALUES (?, ?, ?, ?)`)
    .bind(SUPPLIER, TENANT, SUPPLIER_NAME, 'acme-chemicals')
    .run();
  await db
    .prepare(`INSERT INTO document_types (id, tenant_id, name, slug, created_at) VALUES (?, ?, ?, ?, datetime('now'))`)
    .bind(DOCTYPE, TENANT, 'COA', 'coa')
    .run();
});

describe('analyzeUncertainty', () => {
  it('returns no issues when there are no docs', async () => {
    const { issues } = await analyzeUncertainty(db, {
      tenantId: TENANT,
      supplierId: SUPPLIER,
      documentTypeId: DOCTYPE,
    });
    expect(issues).toEqual([]);
  });

  it('detects phone-like product_code, often-empty lot, inconsistent grade', async () => {
    // 5 docs. product_code is a phone number in 4/5; lot_number empty in 4/5;
    // grade takes 4 distinct values; supplier_name stable (control).
    await row('q1', { product_code: '800-555-1212', lot_number: 'L001', grade: 'Tech A', supplier_name: SUPPLIER_NAME, net_weight: '50kg' });
    await row('q2', { product_code: '800.555.1212', lot_number: '', grade: 'Tech B', supplier_name: SUPPLIER_NAME, net_weight: '50kg' });
    await row('q3', { product_code: '8005551212', lot_number: null, grade: 'Industrial', supplier_name: SUPPLIER_NAME, net_weight: '50kg' });
    await row('q4', { product_code: '212-867-5309', lot_number: 'N/A', grade: 'Food', supplier_name: SUPPLIER_NAME, net_weight: '' });
    await row('q5', { product_code: 'PC-44821', lot_number: '', grade: 'Tech A', supplier_name: SUPPLIER_NAME, net_weight: '50kg' });

    const { issues } = await analyzeUncertainty(db, {
      tenantId: TENANT,
      supplierId: SUPPLIER,
      documentTypeId: DOCTYPE,
    });

    const byId = new Map(issues.map((i) => [i.id, i]));

    // implausible product_code (phone-like)
    const phone = byId.get('product_code:phone-like');
    expect(phone).toBeDefined();
    expect(phone!.kind).toBe('implausible');
    expect(phone!.field).toBe('product_code');
    expect(phone!.examples.length).toBeGreaterThan(0);
    expect(phone!.examples.every((e) => /\d{3}[-.\s]?\d{3}[-.\s]?\d{4}/.test(e.value || ''))).toBe(true);

    // often-empty lot_number (empty/'' /null/'N/A' = 4 of 5)
    const lot = byId.get('lot_number:often-empty');
    expect(lot).toBeDefined();
    expect(lot!.kind).toBe('often-empty');
    expect(lot!.examples.every((e) => e.value === null || e.value === '' || e.value === 'N/A')).toBe(true);

    // inconsistent grade (4 distinct values, should be stable)
    const grade = byId.get('grade:inconsistent');
    expect(grade).toBeDefined();
    expect(grade!.kind).toBe('inconsistent');

    // net_weight is mostly stable & present -> should NOT be flagged inconsistent or often-empty
    expect(byId.has('net_weight:inconsistent')).toBe(false);
    expect(byId.has('net_weight:often-empty')).toBe(false);

    // supplier_name is stable -> no inconsistent issue
    expect(byId.has('supplier_name:inconsistent')).toBe(false);

    // implausible should sort above inconsistent (higher severity)
    expect(phone!.severity).toBeGreaterThan(grade!.severity);
    // sorted descending by severity
    for (let i = 1; i < issues.length; i++) {
      expect(issues[i - 1].severity).toBeGreaterThanOrEqual(issues[i].severity);
    }
  });

  it('resolves older rows by supplier name when supplier_id is null', async () => {
    await row('qn1', { product_code: '800-555-0000', lot_number: 'X1' }, { supplierId: null, supplier: SUPPLIER_NAME });
    await row('qn2', { product_code: '800-555-0001', lot_number: 'X2' }, { supplierId: null, supplier: SUPPLIER_NAME });
    await row('qn3', { product_code: '800-555-0002', lot_number: 'X3' }, { supplierId: null, supplier: SUPPLIER_NAME });

    const { issues } = await analyzeUncertainty(db, {
      tenantId: TENANT,
      supplierId: SUPPLIER,
      documentTypeId: DOCTYPE,
    });
    expect(issues.some((i) => i.id === 'product_code:phone-like')).toBe(true);
  });

  it('ignores rows from other suppliers / output_kind / non-ready status', async () => {
    // different supplier
    await row('w1', { product_code: '800-555-1212' }, { supplierId: 'tu-supplier-other' });
    // wrong output_kind (order, not coa)
    await db
      .prepare(
        `INSERT INTO processing_queue (id, tenant_id, document_type_id, file_r2_key, file_name, file_size, mime_type, ai_fields, processing_status, supplier_id, output_kind, status, created_at)
         VALUES ('w3', ?, ?, 'k', 'w3.pdf', 1, 'application/pdf', ?, 'ready', ?, 'order', 'pending', datetime('now'))`,
      )
      .bind(TENANT, DOCTYPE, JSON.stringify({ product_code: '800-555-1212' }), SUPPLIER)
      .run();
    // not ready/approved
    await db
      .prepare(
        `INSERT INTO processing_queue (id, tenant_id, document_type_id, file_r2_key, file_name, file_size, mime_type, ai_fields, processing_status, supplier_id, output_kind, status, created_at)
         VALUES ('w2', ?, ?, 'k', 'w2.pdf', 1, 'application/pdf', ?, 'queued', ?, 'coa', 'pending', datetime('now'))`,
      )
      .bind(TENANT, DOCTYPE, JSON.stringify({ product_code: '800-555-1212' }), SUPPLIER)
      .run();

    const { issues } = await analyzeUncertainty(db, {
      tenantId: TENANT,
      supplierId: SUPPLIER,
      documentTypeId: DOCTYPE,
    });
    expect(issues).toEqual([]);
  });
});
