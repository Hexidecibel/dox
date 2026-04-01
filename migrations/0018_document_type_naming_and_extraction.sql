-- Add naming_format and extraction_fields columns to document_types
ALTER TABLE document_types ADD COLUMN naming_format TEXT;
ALTER TABLE document_types ADD COLUMN extraction_fields TEXT;

-- Drop the now-redundant naming_templates table
DROP TABLE IF EXISTS naming_templates;
