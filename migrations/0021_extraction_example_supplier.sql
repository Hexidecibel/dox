-- Add supplier column to extraction_examples and processing_queue for supplier-aware training gate

ALTER TABLE extraction_examples ADD COLUMN supplier TEXT;
CREATE INDEX idx_extraction_examples_supplier ON extraction_examples(document_type_id, tenant_id, supplier);

ALTER TABLE processing_queue ADD COLUMN supplier TEXT;
