CREATE TABLE lots (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  supplier_id TEXT REFERENCES suppliers(id),
  product_id  TEXT REFERENCES products(id),
  lot_number  TEXT NOT NULL,
  lot_key     TEXT NOT NULL,
  code_date TEXT, expiration_date TEXT, mfg_date TEXT,
  primary_metadata TEXT,
  first_seen_source TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX idx_lots_identity ON lots(tenant_id, product_id, lot_key);
CREATE INDEX idx_lots_lotkey   ON lots(tenant_id, lot_key);
CREATE INDEX idx_lots_supplier ON lots(tenant_id, supplier_id);

CREATE TABLE document_lots (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id),
  lot_id TEXT NOT NULL REFERENCES lots(id),
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(document_id, lot_id)
);
CREATE INDEX idx_document_lots_doc ON document_lots(document_id);
CREATE INDEX idx_document_lots_lot ON document_lots(lot_id);
