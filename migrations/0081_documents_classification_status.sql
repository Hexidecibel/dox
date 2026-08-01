-- Migration 0081: documents.classification_status — the "unclassified /
-- needs review" bucket (client asked for this by name).
--
-- Today an untyped document is silently blank: documents.document_type_id is
-- NULL and nothing distinguishes "nobody has looked at this yet" from "a human
-- looked and it genuinely does not fit any type". Neither is countable, so an
-- unclassified backlog is invisible.
--
-- Four states, chosen so the two ends of the review lifecycle are separable:
--
--   unclassified   never touched. Nothing proposed, nobody looked. DEFAULT.
--   needs_review   something WAS proposed (extraction, a rule, an import) but
--                  no human has confirmed it. This is the no-auto-confirm
--                  landing state — an AI-proposed type parks here.
--   classified     a human affirmed the classification.
--   unclassifiable reviewed by a human who decided it genuinely fits no type.
--                  A terminal state, NOT a backlog item. Without this,
--                  permanently-odd documents pollute the unclassified count
--                  forever and the number stops meaning anything.
--
-- The reviewed_at/by columns are what make 'unclassifiable' trustworthy: the
-- state asserts a human made a judgment, so the record has to say which human
-- and when. They also let P4 report review throughput for free.
--
-- SAFETY NOTES
--   * ADD COLUMN with NOT NULL is legal in SQLite when a constant DEFAULT is
--     supplied; existing rows take 'unclassified', which satisfies the CHECK.
--     (Migration 0077 already established that ADD COLUMN ... CHECK works on
--     this table.)
--   * Adding a column to `documents` does NOT disturb the FTS machinery:
--     0079's documents_fts_source view and every trigger that writes through
--     it enumerate columns explicitly. Same reasoning as 0069's note on
--     document_types. No trigger or view change is required here.

ALTER TABLE documents ADD COLUMN classification_status TEXT NOT NULL DEFAULT 'unclassified'
  CHECK (classification_status IN ('unclassified','needs_review','classified','unclassifiable'));
ALTER TABLE documents ADD COLUMN classification_reviewed_at TEXT;
ALTER TABLE documents ADD COLUMN classification_reviewed_by TEXT;

-- Tenant-scoped so "how many unclassified docs does this tenant have" is an
-- index-only count.
CREATE INDEX IF NOT EXISTS idx_documents_classification_status
  ON documents(tenant_id, classification_status);
