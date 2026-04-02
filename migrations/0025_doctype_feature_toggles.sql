-- Add feature toggle columns to document_types
-- auto_ingest: whether to auto-import high-confidence documents (default OFF - conservative)
-- extract_tables: whether to extract tabular data (default ON)
ALTER TABLE document_types ADD COLUMN auto_ingest INTEGER DEFAULT 0;
ALTER TABLE document_types ADD COLUMN extract_tables INTEGER DEFAULT 1;
