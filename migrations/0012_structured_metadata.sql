-- Add structured metadata fields to documents
ALTER TABLE documents ADD COLUMN document_type_id TEXT REFERENCES document_types(id);
ALTER TABLE documents ADD COLUMN lot_number TEXT;
ALTER TABLE documents ADD COLUMN po_number TEXT;
ALTER TABLE documents ADD COLUMN code_date TEXT;
ALTER TABLE documents ADD COLUMN expiration_date TEXT;

CREATE INDEX IF NOT EXISTS idx_documents_document_type ON documents(document_type_id);
CREATE INDEX IF NOT EXISTS idx_documents_lot_number ON documents(lot_number);
CREATE INDEX IF NOT EXISTS idx_documents_po_number ON documents(po_number);
