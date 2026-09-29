/**
 * bin/lib/supplierProductLinkPlan.js — the plan half of `bin/link-supplier-products`.
 *
 * Pure: no D1, no clock, no process. The CLI reads the rows, hands them in and
 * renders what this returns, so the rule is unit-testable.
 *
 * WHY IT EXISTS: until the fix to POST /api/products, "Add product" on a
 * supplier's Products tab created the product with NO supplier -- neither the
 * legacy `products.supplier_id` column nor a `product_suppliers` row -- so the
 * product never appeared on the tab it was added from (AJ, 2026-09-20). Those
 * rows are orphans a person meant to belong to one supplier. The fix stops new
 * ones; this repairs the ones already written.
 *
 * THE RULE (the same one `linkProductToSupplier` in
 * functions/lib/entities/products.ts applies at runtime):
 *   - write a `product_suppliers` row for (product, supplier) unless one exists;
 *   - set `products.supplier_id` ONLY when it is NULL -- a legacy column naming
 *     another supplier is somebody's association and is never overwritten;
 *   - one audit row per product actually changed.
 * A product of another tenant, or an unknown id, is an error, never a skip.
 */

'use strict';

/**
 * @param {object} input
 * @param {{id:string,name:string}} input.supplier
 * @param {Array<{id:string,name:string,tenant_id:string,supplier_id:string|null,active:number,created_at:string,linked_supplier_ids:string[]}>} input.products
 * @param {string} input.tenantId
 * @param {string[]} [input.requestedIds]  ids named with --product (each must resolve)
 */
function planSupplierProductLinks({ supplier, products, tenantId, requestedIds = [] }) {
  const errors = [];
  const byId = new Map(products.map((p) => [p.id, p]));
  for (const id of requestedIds) {
    const p = byId.get(id);
    if (!p) errors.push(`No product "${id}" in this database.`);
    else if (p.tenant_id !== tenantId) errors.push(`Product "${id}" (${p.name}) belongs to another tenant.`);
  }

  const links = [];
  const unchanged = [];
  for (const p of products) {
    if (p.tenant_id !== tenantId) continue;
    const hasLink = (p.linked_supplier_ids || []).includes(supplier.id);
    const setLegacy = p.supplier_id === null || p.supplier_id === undefined || p.supplier_id === '';
    if (hasLink && !setLegacy) {
      unchanged.push({ id: p.id, name: p.name, reason: 'already linked to this supplier' });
      continue;
    }
    links.push({
      product_id: p.id,
      name: p.name,
      active: !!p.active,
      created_at: p.created_at,
      insert_link: !hasLink,
      set_legacy_supplier_id: setLegacy,
      legacy_supplier_id: setLegacy ? null : p.supplier_id,
      other_suppliers: (p.linked_supplier_ids || []).filter((s) => s !== supplier.id),
    });
  }
  return { errors, links, unchanged };
}

/**
 * Render the plan as SQL. Every statement is guarded so a re-run (or a race
 * with the app) writes nothing twice.
 * @param {string} tenantId
 * @param {{id:string,name:string}} supplier
 * @param {ReturnType<typeof planSupplierProductLinks>['links']} links
 * @param {(v:unknown)=>string} q  SQL literal quoter
 * @param {()=>string} newId
 */
function supplierProductLinksToSql(tenantId, supplier, links, q, newId) {
  const out = [];
  for (const l of links) {
    if (l.insert_link) {
      out.push(
        `INSERT INTO product_suppliers (id, tenant_id, product_id, supplier_id) VALUES (${q(newId())}, ${q(tenantId)}, ${q(l.product_id)}, ${q(supplier.id)}) ON CONFLICT(product_id, supplier_id) DO NOTHING;`,
      );
    }
    if (l.set_legacy_supplier_id) {
      out.push(
        `UPDATE products SET supplier_id = ${q(supplier.id)}, updated_at = datetime('now') WHERE id = ${q(l.product_id)} AND tenant_id = ${q(tenantId)} AND supplier_id IS NULL;`,
      );
    }
    out.push(
      `INSERT INTO audit_log (user_id, tenant_id, action, resource_type, resource_id, details) VALUES (NULL, ${q(tenantId)}, 'product.supplier_linked', 'product', ${q(l.product_id)}, ${q(JSON.stringify({
        product_name: l.name,
        supplier_id: supplier.id,
        supplier_name: supplier.name,
        via: 'bin/link-supplier-products',
        link_written: l.insert_link,
        legacy_supplier_id_set: l.set_legacy_supplier_id,
      }))});`,
    );
  }
  return out;
}

module.exports = { planSupplierProductLinks, supplierProductLinksToSql };
