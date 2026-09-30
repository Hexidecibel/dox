-- Migration 0132: "you already have this" -- a PERSON decides, on the card.
--
-- WHY
-- ---
-- 0108 suppressed an arrival byte-identical to an approved document before a
-- reviewer ever saw it (a ledger row, "Received again" on the document, and
-- "Review anyway" to replay). Owner decision 2026-09-30: a file we already
-- have is raised at import and a person decides what it is. The arrival now
-- goes INTO the Review Queue carrying a proposal, and approving it requires a
-- choice:
--
--   replace    -- the arrival becomes a NEW VERSION of the existing document
--                 (document_versions; every earlier version stays in history,
--                 nothing is deleted), with the new extraction, confirmed
--                 through the normal card.
--   keep_both  -- a separate document, exactly as a non-duplicate approves.
--   discard    -- "don't need this copy": the card closes as a REJECTION with
--                 the reason 'duplicate_discarded' (so the bytes follow the
--                 normal rejected-file retention, never an immediate delete)
--                 and the existing document is not touched.
--
-- Reject stays available as always. The proposal is computed when the queue
-- is read, not stored: it vanishes if the matched document is deleted, and a
-- second kind of match -- the SAME DOCUMENT, NEWER REVISION (same supplier +
-- type + document number / certificate number / exact lot set, different
-- bytes) -- can only be known after extraction anyway.
--
-- WHAT THIS ADDS TO THE LEDGER
-- ----------------------------
-- `intake_duplicates` stays the ledger (extended, not replaced). New rows:
--
--   match_basis  -- 'identical_bytes' / 'document_number' /
--                   'certificate_number' / 'lot_set'. NULL on every 0108 row,
--                   all of which were byte-identical; no backfill, because
--                   "nobody recorded a basis" is the literal truth of them.
--   disposition  -- 'queued': the arrival went to the Review Queue with the
--                   proposal (queue_id is the card). NULL = a 0108
--                   suppression (queue_id NULL = still suppressed, non-NULL =
--                   "Review anyway"). Distinguishes a card that exists because
--                   intake queued it from one a person pulled out of the ledger.
--   decision     -- what the person chose: 'replace' / 'keep_both' /
--                   'discard', or 'rejected' when the card was rejected for
--                   some other reason. NULL = not decided yet.
--   decided_by / decided_at, decision_document_id (the document the decision
--   produced or versioned), decision_version_number (the version it created).
--
-- match_kind keeps 0108's CHECK: a newer revision IS matched to an already
-- approved document, so it is 'already_approved' with basis 'document_number'
-- etc. Widening that CHECK would mean rebuilding the table for a word the
-- basis column already says.
--
-- Existing suppressed rows stay exactly as they are: history, not a backlog to
-- push into the queue.
--
-- Additive only. Plain-ASCII header (the 0110 D1 import finding).

ALTER TABLE intake_duplicates ADD COLUMN match_basis TEXT
  CHECK (match_basis IS NULL OR match_basis IN ('identical_bytes', 'document_number', 'certificate_number', 'lot_set'));

ALTER TABLE intake_duplicates ADD COLUMN disposition TEXT
  CHECK (disposition IS NULL OR disposition IN ('queued'));

ALTER TABLE intake_duplicates ADD COLUMN decision TEXT
  CHECK (decision IS NULL OR decision IN ('replace', 'keep_both', 'discard', 'rejected'));

ALTER TABLE intake_duplicates ADD COLUMN decided_by TEXT REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE intake_duplicates ADD COLUMN decided_at TEXT;

ALTER TABLE intake_duplicates ADD COLUMN decision_document_id TEXT REFERENCES documents(id) ON DELETE SET NULL;

ALTER TABLE intake_duplicates ADD COLUMN decision_version_number INTEGER;

CREATE INDEX IF NOT EXISTS idx_intake_duplicates_decision_document
  ON intake_duplicates(decision_document_id) WHERE decision_document_id IS NOT NULL;
