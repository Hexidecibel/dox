/**
 * bin/lib/supplierProductLinkPlan.js — the plan behind `bin/link-supplier-products`.
 *
 *   1. An orphan gets both halves: a product_suppliers row and the NULL legacy column.
 *   2. A legacy column naming another supplier is never overwritten.
 *   3. Already linked = nothing planned (idempotent re-run).
 *   4. A named product that does not resolve, or is another tenant's, is an error.
 *   5. Every changed product carries one audit row.
 */
import { describe, it, expect } from 'vitest';
// @ts-expect-error — plain CJS module, no types.
import mod from '../../bin/lib/supplierProductLinkPlan.js';

const { planSupplierProductLinks, supplierProductLinksToSql } = mod;
const supplier = { id: 'sup_cmf', name: 'Country Morning Farms' };
const q = (v: unknown) => (v === null ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);
const base = { tenant_id: 't1', active: 1, created_at: '2026-09-20 20:48:39' };

describe('planSupplierProductLinks', () => {
  it('links an orphan fully and audits it', () => {
    const plan = planSupplierProductLinks({
      supplier, tenantId: 't1',
      products: [{ ...base, id: 'p1', name: 'MS H&H HG (9/CS)', supplier_id: null, linked_supplier_ids: [] }],
    });
    expect(plan.errors).toEqual([]);
    expect(plan.links).toHaveLength(1);
    expect(plan.links[0]).toMatchObject({ insert_link: true, set_legacy_supplier_id: true });
    const sql = supplierProductLinksToSql('t1', supplier, plan.links, q, () => 'newid');
    expect(sql).toHaveLength(3);
    expect(sql[0]).toContain('INSERT INTO product_suppliers');
    expect(sql[0]).toContain('ON CONFLICT(product_id, supplier_id) DO NOTHING');
    expect(sql[1]).toContain('AND supplier_id IS NULL');
    expect(sql[2]).toContain("'product.supplier_linked'");
    expect(sql[2]).toContain('bin/link-supplier-products');
  });

  it('never overwrites a legacy column naming another supplier', () => {
    const plan = planSupplierProductLinks({
      supplier, tenantId: 't1',
      products: [{ ...base, id: 'p2', name: 'Whip', supplier_id: 'sup_other', linked_supplier_ids: ['sup_other'] }],
    });
    expect(plan.links[0]).toMatchObject({ insert_link: true, set_legacy_supplier_id: false, other_suppliers: ['sup_other'] });
    const sql = supplierProductLinksToSql('t1', supplier, plan.links, q, () => 'id');
    expect(sql.some((s: string) => s.startsWith('UPDATE products'))).toBe(false);
  });

  it('plans nothing for a product already linked (idempotent)', () => {
    const plan = planSupplierProductLinks({
      supplier, tenantId: 't1',
      products: [{ ...base, id: 'p3', name: 'Done', supplier_id: 'sup_cmf', linked_supplier_ids: ['sup_cmf'] }],
    });
    expect(plan.links).toEqual([]);
    expect(plan.unchanged).toHaveLength(1);
  });

  it('refuses a named product that is missing or belongs to another tenant', () => {
    const plan = planSupplierProductLinks({
      supplier, tenantId: 't1', requestedIds: ['nope', 'p4'],
      products: [{ ...base, tenant_id: 't2', id: 'p4', name: 'Theirs', supplier_id: null, linked_supplier_ids: [] }],
    });
    expect(plan.errors).toHaveLength(2);
    expect(plan.links).toEqual([]);
  });
});
