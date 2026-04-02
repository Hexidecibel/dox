-- Smart upload: extraction examples for few-shot learning and processing queue for review workflow

CREATE TABLE IF NOT EXISTS extraction_examples (
  id TEXT PRIMARY KEY,
  document_type_id TEXT NOT NULL REFERENCES document_types(id),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  input_text TEXT NOT NULL,
  ai_output TEXT NOT NULL,
  corrected_output TEXT NOT NULL,
  score REAL,
  created_by TEXT REFERENCES users(id),
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS processing_queue (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  document_type_id TEXT NOT NULL REFERENCES document_types(id),
  file_r2_key TEXT NOT NULL,
  file_name TEXT NOT NULL,
  file_size INTEGER NOT NULL,
  mime_type TEXT NOT NULL,
  extracted_text TEXT,
  ai_fields TEXT,
  ai_confidence TEXT,
  confidence_score REAL,
  product_names TEXT,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  reviewed_by TEXT REFERENCES users(id),
  reviewed_at TEXT,
  created_by TEXT REFERENCES users(id),
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX idx_extraction_examples_doctype ON extraction_examples(document_type_id, tenant_id);
CREATE INDEX idx_processing_queue_status ON processing_queue(tenant_id, status, created_at);

ALTER TABLE document_types ADD COLUMN auto_ingest_threshold REAL DEFAULT 0.8;
