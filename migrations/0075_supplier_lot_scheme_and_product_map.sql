-- Per-supplier lot numbering scheme. NULL/'auto'/'plain' = no transform (today's behavior).
ALTER TABLE suppliers ADD COLUMN lot_scheme TEXT NOT NULL DEFAULT 'auto';

-- Teachable COA-product -> order-product bridge.
CREATE TABLE supplier_product_map (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  supplier_id TEXT NOT NULL REFERENCES suppliers(id),
  coa_product_name_key TEXT NOT NULL,          -- normalized COA product name (durable across re-extraction)
  coa_product_id TEXT REFERENCES products(id), -- provenance only; nullable
  order_product_id TEXT NOT NULL REFERENCES products(id),
  distributor_sku TEXT,                        -- optional; lights up the lot+code path too
  created_by TEXT REFERENCES users(id),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(tenant_id, supplier_id, coa_product_name_key)
);
CREATE INDEX idx_supplier_product_map_lookup
  ON supplier_product_map(tenant_id, supplier_id, coa_product_name_key);
