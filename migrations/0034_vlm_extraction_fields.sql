-- VLM dual-run extraction results stored alongside the text path.
-- Additive only — existing columns still hold the primary extraction result
-- (from whichever mode is active). The vlm_* columns always hold the VLM
-- result when the VLM path ran, regardless of mode. When QWEN_VLM_MODE=off
-- (the default) these columns are all NULL.
ALTER TABLE processing_queue ADD COLUMN vlm_extracted_fields TEXT;
ALTER TABLE processing_queue ADD COLUMN vlm_extracted_tables TEXT;
ALTER TABLE processing_queue ADD COLUMN vlm_confidence REAL;
ALTER TABLE processing_queue ADD COLUMN vlm_error TEXT;
ALTER TABLE processing_queue ADD COLUMN vlm_model TEXT;
ALTER TABLE processing_queue ADD COLUMN vlm_duration_ms INTEGER;
ALTER TABLE processing_queue ADD COLUMN vlm_extracted_at TEXT;
