ALTER TABLE order_items ADD COLUMN lot_id TEXT REFERENCES lots(id);
ALTER TABLE order_items ADD COLUMN coa_match_status TEXT DEFAULT 'unmatched';
ALTER TABLE order_items ADD COLUMN coa_matched_at TEXT;
-- NB: idx_order_items_lot is already taken by migration 0030 (on lot_number),
-- so the new lot_id index uses a distinct name.
CREATE INDEX idx_order_items_lot_id ON order_items(lot_id);

CREATE TABLE lot_match_suggestions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  order_item_id TEXT NOT NULL REFERENCES order_items(id),
  document_id TEXT NOT NULL REFERENCES documents(id),
  lot_id TEXT REFERENCES lots(id),
  match_confidence REAL,
  match_basis TEXT,
  status TEXT DEFAULT 'pending',
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(order_item_id, document_id)
);
CREATE INDEX idx_lms_order_item ON lot_match_suggestions(order_item_id);
CREATE INDEX idx_lms_tenant_status ON lot_match_suggestions(tenant_id, status);
