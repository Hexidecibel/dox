ALTER TABLE documents ADD COLUMN external_ref TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_tenant_external_ref 
  ON documents(tenant_id, external_ref) WHERE external_ref IS NOT NULL;

ALTER TABLE documents ADD COLUMN source_metadata TEXT;
