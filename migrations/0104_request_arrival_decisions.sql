-- Migration 0104: a person decides what a supplier's file actually satisfies.
--
-- WHY
-- ---
-- 0092 built the supplier's door and wrote down the rule that governs it: an
-- arrival is a CLAIM ("this file covers that requirement"), it moves the line
-- to `received` and never to `accepted`, and nothing a supplier does can move
-- the progress number. 0094 made the arrival READ on arrival (it is enqueued
-- for extraction like every other door), and the approve path in
-- functions/api/queue/[id].ts fills `request_uploads.document_id` once a
-- reviewer has approved the extraction.
--
-- What never existed is the other half: a place where one of OUR people looks
-- at what arrived and says "yes, this satisfies what we asked for" or "no, and
-- here is why". The only way a line reached `accepted` was a hand-edited
-- status dropdown with no record of WHICH file it was accepted from. So the
-- request knew a line was accepted, the arrival knew it had become a document,
-- and nothing joined the two. This migration is that join, plus the columns
-- the decision needs.
--
--
-- TWO JUDGEMENTS, STILL TWO. LOAD-BEARING.
-- ---------------------------------------
-- Approving a queue item asks "is this extraction faithful to this file?".
-- Accepting a request line asks "does this document satisfy what we asked this
-- supplier for?". The approve helper in queue/[id].ts explains at length why
-- the first must never write the second, and nothing here changes that.
-- Decisions are recorded on their own columns, written by their own endpoint
-- (POST /api/request-uploads/:id/decide), gated on their own role check.
--
-- The one coupling is a precondition, and it runs in the safe direction: a
-- line cannot be ACCEPTED from an arrival until that arrival has an approved
-- document. Accepting a file nobody has confirmed the contents of would be
-- accepting the supplier's own description of it, which is the exact thing
-- 0092 said a claim is not. Needs-attention has no such precondition — "this
-- is the wrong certificate" is sayable the moment the file is opened.
--
--
-- THE DECISION LIVES ON THE CLAIM, NOT ON THE UPLOAD
-- -------------------------------------------------
-- One file may be claimed against seven requirements, and the reviewer may
-- well accept five and send two back. A decision column on `request_uploads`
-- could only say one thing about seven questions. So the decision is written
-- per (upload, line) on the existing `request_upload_lines` row — the claim
-- row the supplier's upload already created.
--
-- A reviewer can also see that a file covers something the supplier did NOT
-- tick. That is a claim too, just made by someone else, so it is a row in the
-- same table with `claimed_by = 'staff'` and `added_by` naming who. It is not
-- a second table: "what was this file held to cover, and by whom" is one
-- question and splitting it across two tables would make every read UNION.
-- The DEFAULT is 'supplier' so every existing row is described truthfully
-- without a backfill.
--
--
-- WHICH DOCUMENT, NAMED ON BOTH SIDES
-- ----------------------------------
-- `decision_document_id` on the claim says which document the decision was
-- made about. It is usually `request_uploads.document_id`, but not always: a
-- records-shaped COA splits one file into several documents and the column on
-- the upload can only hold the first (see the approve helper), so the reviewer
-- may pick another.
--
-- `request_lines.accepted_document_id` says the same thing from the line's
-- side, and is what the request screen reads. It is deliberately NOT just a
-- join through the claim: a line can be accepted by hand through
-- PUT /api/request-lines/:id (the escape hatch stays), and a line's history
-- can hold several decided claims from several files. The line column is "the
-- document this line currently stands accepted on", and it is nulled whenever
-- the line leaves `accepted` — by a reviewer moving it, or by the supplier
-- sending a newer file, which reopens the line for review exactly as 0092
-- intended. Carried across an amendment with the status it belongs to
-- (`carryStatuses` in functions/lib/document-requests.ts).
--
-- Both are ON DELETE SET NULL. A document being purged is housekeeping; it
-- must not delete the record that a decision was made, nor the line.
--
--
-- AMENDMENT RE-MINTS LINE IDS, SO A CLAIM MAY POINT AT A SUPERSEDED LINE
-- --------------------------------------------------------------------
-- 0090 copies every line into the new version with a fresh id. A claim made
-- against version 1 keeps pointing at version 1's row, which is correct — it
-- is what the supplier ticked. The decide endpoint therefore works in CURRENT
-- line ids and maps claims onto them by line identity (a typed line is its
-- requirement, a free-text line its trimmed name), the same identity
-- `loadReceivedCounts` and `lineKey` already use. The decision is written to
-- the claim row that exists; no claim row is rewritten to point elsewhere.
--
--
-- NO NULL-IN-UNIQUE TRAP HERE
-- --------------------------
-- The existing UNIQUE(upload_id, line_id) on `request_upload_lines` has two
-- NOT NULL columns, so it constrains every row (0087's case). A staff claim
-- for a line the supplier already claimed is simply the same row; the endpoint
-- decides on it rather than inserting a duplicate.

ALTER TABLE request_upload_lines
  ADD COLUMN claimed_by TEXT NOT NULL DEFAULT 'supplier'
    CHECK (claimed_by IN ('supplier', 'staff'));

-- Who added a staff claim. NULL for a supplier claim: a supplier is not a
-- user, and this is a nullable FK to users(id), so NULL is the only value that
-- is both true and legal (the same reasoning as processing_queue.created_by on
-- this door).
ALTER TABLE request_upload_lines
  ADD COLUMN added_by TEXT REFERENCES users(id);

-- NULL = nobody has decided this claim yet. That is the reviewer's inbox.
ALTER TABLE request_upload_lines
  ADD COLUMN decision TEXT CHECK (decision IN ('accepted', 'needs_attention'));

ALTER TABLE request_upload_lines
  ADD COLUMN decision_document_id TEXT REFERENCES documents(id) ON DELETE SET NULL;

ALTER TABLE request_upload_lines ADD COLUMN decided_at TEXT;

ALTER TABLE request_upload_lines
  ADD COLUMN decided_by TEXT REFERENCES users(id);

-- The document this line currently stands accepted on. NULL whenever the line
-- is not `accepted`. See the header for why this is not merely a join.
ALTER TABLE request_lines
  ADD COLUMN accepted_document_id TEXT REFERENCES documents(id) ON DELETE SET NULL;

-- The inbox read: undecided claims for a tenant, grouped by upload. Partial,
-- because decided claims are history and the inbox never looks at them.
CREATE INDEX IF NOT EXISTS idx_request_upload_lines_undecided
  ON request_upload_lines(tenant_id, upload_id) WHERE decision IS NULL;
