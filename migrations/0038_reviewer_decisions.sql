-- Phase 2 capture tables: persist every reviewer decision so Phase 3 can read
-- it back for pre-fill learning. No behavior change — pure capture.
--
-- All three tables are tenant-scoped and reference processing_queue(id) with
-- ON DELETE CASCADE so cleanup follows queue item lifecycle. supplier_id and
-- document_type_id are nullable: at approve time they may be null (no
-- supplier resolved, no doctype guessed), and the (tenant, supplier, doctype,
-- field) lookup index still works for Phase 3 aggregation.

CREATE TABLE IF NOT EXISTS reviewer_field_picks (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  queue_item_id TEXT NOT NULL REFERENCES processing_queue(id) ON DELETE CASCADE,
  supplier_id TEXT REFERENCES suppliers(id),
  document_type_id TEXT REFERENCES document_types(id),
  field_key TEXT NOT NULL,
  text_value TEXT,
  vlm_value TEXT,
  chosen_source TEXT NOT NULL CHECK (chosen_source IN ('text','vlm','edited','dismissed')),
  final_value TEXT,
  created_at TEXT NOT NULL,
  created_by TEXT REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_picks_lookup
  ON reviewer_field_picks(tenant_id, supplier_id, document_type_id, field_key);

CREATE TABLE IF NOT EXISTS reviewer_field_dismissals (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  queue_item_id TEXT NOT NULL REFERENCES processing_queue(id) ON DELETE CASCADE,
  supplier_id TEXT REFERENCES suppliers(id),
  document_type_id TEXT REFERENCES document_types(id),
  field_key TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('dismissed','extended')),
  created_at TEXT NOT NULL,
  created_by TEXT REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_dismissals_lookup
  ON reviewer_field_dismissals(tenant_id, supplier_id, document_type_id, field_key);

CREATE TABLE IF NOT EXISTS reviewer_table_edits (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  queue_item_id TEXT NOT NULL REFERENCES processing_queue(id) ON DELETE CASCADE,
  supplier_id TEXT REFERENCES suppliers(id),
  document_type_id TEXT REFERENCES document_types(id),
  table_idx INTEGER NOT NULL,
  operation TEXT NOT NULL,
  detail TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_by TEXT REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_table_edits_lookup
  ON reviewer_table_edits(tenant_id, supplier_id, document_type_id);

-- Dedup hash on extraction_examples so Phase 3's synthetic backfill can't
-- accumulate duplicate rows for the same (doctype, tenant, supplier, input).
ALTER TABLE extraction_examples ADD COLUMN input_text_hash TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_extraction_examples_hash
  ON extraction_examples(document_type_id, tenant_id, supplier, input_text_hash)
  WHERE input_text_hash IS NOT NULL;
