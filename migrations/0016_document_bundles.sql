-- Document bundles for compliance packages
CREATE TABLE IF NOT EXISTS document_bundles (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  name TEXT NOT NULL,
  description TEXT,
  product_id TEXT REFERENCES products(id),
  status TEXT DEFAULT 'draft' CHECK (status IN ('draft', 'finalized')),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_document_bundles_tenant ON document_bundles(tenant_id);
CREATE INDEX IF NOT EXISTS idx_document_bundles_product ON document_bundles(product_id);

CREATE TABLE IF NOT EXISTS document_bundle_items (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  bundle_id TEXT NOT NULL REFERENCES document_bundles(id) ON DELETE CASCADE,
  document_id TEXT NOT NULL REFERENCES documents(id),
  version_number INTEGER,
  sort_order INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(bundle_id, document_id)
);

CREATE INDEX IF NOT EXISTS idx_document_bundle_items_bundle ON document_bundle_items(bundle_id);
