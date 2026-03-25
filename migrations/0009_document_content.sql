ALTER TABLE document_versions ADD COLUMN extracted_text TEXT;
CREATE INDEX IF NOT EXISTS idx_document_versions_text ON document_versions(document_id) WHERE extracted_text IS NOT NULL;
