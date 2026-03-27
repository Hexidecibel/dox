-- Document-Product links with expiration tracking
CREATE TABLE IF NOT EXISTS document_products (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL REFERENCES products(id),
  expires_at TEXT,
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(document_id, product_id)
);

CREATE INDEX IF NOT EXISTS idx_document_products_document ON document_products(document_id);
CREATE INDEX IF NOT EXISTS idx_document_products_product ON document_products(product_id);
CREATE INDEX IF NOT EXISTS idx_document_products_expires ON document_products(expires_at);
