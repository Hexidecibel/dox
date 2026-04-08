ALTER TABLE processing_queue ADD COLUMN source TEXT DEFAULT 'import';
ALTER TABLE processing_queue ADD COLUMN source_detail TEXT;
