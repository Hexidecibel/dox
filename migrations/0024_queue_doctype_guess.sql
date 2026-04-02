-- Allow AI to guess document type: add guess column and make document_type_id nullable
-- SQLite doesn't support ALTER COLUMN, so we recreate the table

ALTER TABLE processing_queue ADD COLUMN document_type_guess TEXT;

-- Recreate processing_queue with document_type_id nullable
CREATE TABLE processing_queue_new (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  document_type_id TEXT REFERENCES document_types(id),
  file_r2_key TEXT NOT NULL,
  file_name TEXT NOT NULL,
  file_size INTEGER NOT NULL,
  mime_type TEXT NOT NULL,
  extracted_text TEXT,
  ai_fields TEXT,
  ai_confidence TEXT,
  confidence_score REAL,
  product_names TEXT,
  supplier TEXT,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  processing_status TEXT DEFAULT 'queued' CHECK (processing_status IN ('queued', 'processing', 'ready', 'error')),
  error_message TEXT,
  checksum TEXT,
  tables TEXT,
  summary TEXT,
  document_type_guess TEXT,
  reviewed_by TEXT REFERENCES users(id),
  reviewed_at TEXT,
  created_by TEXT REFERENCES users(id),
  created_at TEXT DEFAULT (datetime('now'))
);

INSERT INTO processing_queue_new
  SELECT id, tenant_id, document_type_id, file_r2_key, file_name, file_size, mime_type,
         extracted_text, ai_fields, ai_confidence, confidence_score, product_names, supplier,
         status, processing_status, error_message, checksum, tables, summary, document_type_guess,
         reviewed_by, reviewed_at, created_by, created_at
  FROM processing_queue;

DROP TABLE processing_queue;
ALTER TABLE processing_queue_new RENAME TO processing_queue;

CREATE INDEX idx_processing_queue_status ON processing_queue(tenant_id, status, created_at);
CREATE INDEX idx_processing_queue_processing_status ON processing_queue(processing_status, created_at);
