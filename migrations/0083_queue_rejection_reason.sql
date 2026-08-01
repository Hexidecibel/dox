-- Persist WHY a queue item was rejected, and STOP destroying the evidence.
--
-- Before this migration, rejecting an item wrote `{"file_name": "..."}` to the
-- audit log and then DELETED the R2 object. Two consequences, both measured in
-- the 2026-08-01 rejected-population study:
--
--   * 9 of 132 studied rejections could never be graded at all — R2 404, the
--     source PDF was gone, so "the extractor was wrong" and "the OCR produced
--     garbage" can never be separated after the fact.
--   * Every rejection is otherwise a bare fact with no cause. The study had to
--     reconstruct the A/B/C split with an LLM grader at 29% precision because
--     the reviewer's own reason — free, accurate, known at the moment of the
--     click — was never recorded.
--
-- rejection_reason is a small closed enum mirroring that study's taxonomy so
-- future rejections are countable without a grader:
--   'extraction_defect'   (A) usable document, we extracted it wrongly
--   'duplicate'           (B) an already-approved twin exists
--   'wrong_document_type' (B) not a COA / not what this queue is for
--   'unreadable'          (B) scan/OCR unusable, no human could extract it
--   'other'               (C) process reason — see rejection_note
-- NULL means "rejected before this column existed" — never conflate with 'other'.
--
-- rejection_note is optional free text; it is the only place a reviewer can say
-- something the enum cannot.
--
-- file_retain_until is the R2 retention tombstone. The reject path no longer
-- deletes the object; it stamps a date (default +90 days) after which a sweeper
-- may reclaim it. Diagnosability wins over storage here: a rejected COA is a
-- few hundred KB, rejections are a minority of the corpus, and without the
-- bytes a post-mortem is guesswork. NULL on non-rejected rows.
--
-- All three columns are additive and nullable — existing rows are untouched.
ALTER TABLE processing_queue ADD COLUMN rejection_reason TEXT;
ALTER TABLE processing_queue ADD COLUMN rejection_note TEXT;
ALTER TABLE processing_queue ADD COLUMN file_retain_until TEXT;

-- Lets a sweeper (and "what got rejected and why last month") find rows without
-- a full scan of a table that also holds extracted_text blobs.
CREATE INDEX IF NOT EXISTS idx_processing_queue_rejection
  ON processing_queue (status, rejection_reason);
CREATE INDEX IF NOT EXISTS idx_processing_queue_file_retain
  ON processing_queue (file_retain_until);
