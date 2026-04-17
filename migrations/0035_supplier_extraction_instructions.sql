-- Supplier extraction instructions: per (supplier, document_type) natural-language
-- guidance authored by reviewers. Injected into the Qwen prompt on every future
-- extraction for the same supplier + document type. Complements the silent
-- few-shot example loop (extraction_examples) with an explicit "teach the model"
-- surface that the reviewer can edit directly from the review UI.
CREATE TABLE IF NOT EXISTS supplier_extraction_instructions (
  id TEXT PRIMARY KEY,
  supplier_id TEXT NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  document_type_id TEXT NOT NULL REFERENCES document_types(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  instructions TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  updated_by TEXT REFERENCES users(id),
  UNIQUE (supplier_id, document_type_id)
);

CREATE INDEX IF NOT EXISTS idx_sei_supplier_doctype
  ON supplier_extraction_instructions(supplier_id, document_type_id);

CREATE INDEX IF NOT EXISTS idx_sei_tenant
  ON supplier_extraction_instructions(tenant_id);
