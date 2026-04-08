-- Extraction templates: per-supplier + doc-type field mapping configurations
CREATE TABLE IF NOT EXISTS extraction_templates (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  supplier_id TEXT NOT NULL REFERENCES suppliers(id),
  document_type_id TEXT NOT NULL REFERENCES document_types(id),
  field_mappings TEXT NOT NULL,
  auto_ingest_enabled INTEGER DEFAULT 0,
  confidence_threshold REAL DEFAULT 0.85,
  created_by TEXT REFERENCES users(id),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(tenant_id, supplier_id, document_type_id)
);

CREATE INDEX IF NOT EXISTS idx_extraction_templates_lookup
  ON extraction_templates(tenant_id, supplier_id, document_type_id);

ALTER TABLE processing_queue ADD COLUMN template_id TEXT REFERENCES extraction_templates(id);
ALTER TABLE processing_queue ADD COLUMN auto_ingested INTEGER DEFAULT 0;
