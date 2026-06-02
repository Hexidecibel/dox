CREATE TABLE product_suppliers (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  product_id TEXT NOT NULL REFERENCES products(id),
  supplier_id TEXT NOT NULL REFERENCES suppliers(id),
  supplier_sku TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(product_id, supplier_id)
);
CREATE INDEX idx_product_suppliers_product  ON product_suppliers(product_id);
CREATE INDEX idx_product_suppliers_supplier ON product_suppliers(supplier_id);
CREATE INDEX idx_product_suppliers_tenant   ON product_suppliers(tenant_id);

-- Backfill 1: existing products that already carry a supplier_id.
INSERT OR IGNORE INTO product_suppliers (id, tenant_id, product_id, supplier_id)
SELECT lower(hex(randomblob(16))), tenant_id, id, supplier_id
FROM products WHERE supplier_id IS NOT NULL;

-- Backfill 2: orphaned products (supplier_id NULL) — infer supplier from the
-- documents they're linked to via document_products.
INSERT OR IGNORE INTO product_suppliers (id, tenant_id, product_id, supplier_id)
SELECT DISTINCT lower(hex(randomblob(16))), p.tenant_id, p.id, d.supplier_id
FROM products p
JOIN document_products dp ON dp.product_id = p.id
JOIN documents d ON d.id = dp.document_id
WHERE d.supplier_id IS NOT NULL;
