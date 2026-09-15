-- Migration 0108: a file we have already seen does not become a second review.
--
-- WHY
-- ---
-- Every intake door computes a SHA-256 of the bytes and stores it on
-- `processing_queue.checksum`, and nothing ever compared it. The connector
-- doors dedupe by R2 STORAGE PATH (`connector_processed_keys`, 0046), which a
-- forwarded email defeats by construction: the same attachment forwarded twice
-- twenty minutes apart lands under two paths, becomes two queue items, and on
-- prod both were approved. 54 same-title groups / 60 surplus documents on
-- 2026-09-14; bin/audit-duplicate-documents on 2026-09-15, which also groups
-- by the arrival's checksum and leaves out one-file sublot splits, finds 61
-- groups / 74 later copies, each with its own spec register rows reading as
-- duplicate results.
--
-- WHAT THIS RECORDS
-- -----------------
-- `intake_duplicates` is the ledger of arrivals the intake path did NOT turn
-- into a new review card, because the exact bytes were:
--
--   already_approved  - identical to a file a reviewer already approved (the
--                       document it became is `matched_document_id`; an order
--                       or shipment approval produces records, not a document,
--                       so that column can be NULL and `matched_queue_id`
--                       names the approved item instead).
--   already_waiting   - identical to an item still in the Review Queue
--                       (pending, whatever its processing state). The card for
--                       that item says "also received from <source>".
--
-- An arrival identical to a REJECTED item is NOT recorded here: it is queued
-- normally, because a resend after a rejection is often deliberate, and the
-- card carries "this exact file was rejected on <date> for <reason>", computed
-- when the queue is read. So every row in this table is a suppression, and
-- the duplicates list is exactly "what did not reach a reviewer".
--
-- NOTHING IS SILENTLY DROPPED, AND EVERY SUPPRESSION IS REVERSIBLE
-- ---------------------------------------------------------------
-- The bytes stay in R2 at `file_r2_key`, and `enqueue_params` is the exact
-- enqueue call the door made (JSON). "Review anyway" replays it with the check
-- skipped, stamps `queue_id` + `overridden_by`/`overridden_at`, and audits.
-- `queue_id IS NULL` is therefore "still suppressed"; non-NULL is "a person
-- sent it for review anyway". No row is ever deleted by the application.
--
-- BYTE-IDENTICAL ONLY
-- -------------------
-- A re-scan of the same paper is a different checksum and is out of scope on
-- purpose: a fuzzy "looks like the same document" match that suppressed a
-- review would be the system deciding, which is the one thing it must not do.
--
-- FK CHOICES
-- ----------
-- Every pointer is ON DELETE SET NULL (tenant is CASCADE): a ledger row is
-- history and must outlive a queue item that is later purged. No CHECK ties
-- `match_kind` to a non-NULL pointer, because SET NULL would then make the
-- parent delete fail. `created_by` is NULL for vendor doors (drop, S3 poll,
-- supplier portal), same as `processing_queue.created_by`.
CREATE TABLE IF NOT EXISTS intake_duplicates (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  checksum TEXT NOT NULL,
  match_kind TEXT NOT NULL CHECK (match_kind IN ('already_approved', 'already_waiting')),
  matched_document_id TEXT REFERENCES documents(id) ON DELETE SET NULL,
  matched_queue_id TEXT REFERENCES processing_queue(id) ON DELETE SET NULL,
  source TEXT NOT NULL,
  source_detail TEXT,
  source_id TEXT,
  connector_run_id TEXT,
  request_upload_id TEXT REFERENCES request_uploads(id) ON DELETE SET NULL,
  file_name TEXT NOT NULL,
  file_size INTEGER NOT NULL,
  mime_type TEXT NOT NULL,
  file_r2_key TEXT NOT NULL,
  enqueue_params TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  queue_id TEXT REFERENCES processing_queue(id) ON DELETE SET NULL,
  overridden_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  overridden_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_intake_duplicates_tenant_received
  ON intake_duplicates(tenant_id, received_at);

CREATE INDEX IF NOT EXISTS idx_intake_duplicates_document
  ON intake_duplicates(matched_document_id) WHERE matched_document_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_intake_duplicates_matched_queue
  ON intake_duplicates(matched_queue_id) WHERE matched_queue_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_intake_duplicates_queue
  ON intake_duplicates(queue_id) WHERE queue_id IS NOT NULL;

-- The comparison itself. Neither checksum column was ever indexed because
-- nothing ever read either one.
CREATE INDEX IF NOT EXISTS idx_processing_queue_tenant_checksum
  ON processing_queue(tenant_id, checksum) WHERE checksum IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_document_versions_checksum
  ON document_versions(checksum) WHERE checksum IS NOT NULL;
