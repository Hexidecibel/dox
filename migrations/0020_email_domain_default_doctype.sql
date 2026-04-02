-- Add default_document_type_id to email_domain_mappings for auto-classification on inbound email
ALTER TABLE email_domain_mappings ADD COLUMN default_document_type_id TEXT REFERENCES document_types(id);
