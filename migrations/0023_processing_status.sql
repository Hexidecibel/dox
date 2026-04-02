-- Add processing_status column to track async AI processing state separately from review status
ALTER TABLE processing_queue ADD COLUMN processing_status TEXT DEFAULT 'queued' CHECK (processing_status IN ('queued', 'processing', 'ready', 'error'));
ALTER TABLE processing_queue ADD COLUMN error_message TEXT;
ALTER TABLE processing_queue ADD COLUMN checksum TEXT;
ALTER TABLE processing_queue ADD COLUMN tables TEXT;
ALTER TABLE processing_queue ADD COLUMN summary TEXT;

CREATE INDEX idx_processing_queue_processing_status ON processing_queue(processing_status, created_at);
