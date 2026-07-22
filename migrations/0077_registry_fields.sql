-- Migration 0077: IDP Document Registry fields on documents.
--
-- These columns turn a plain document into a registry record: a natural-
-- language retrieval surface (aliases), regulatory context (criteria,
-- applies_to), ownership, and a renewal/next-action model the future
-- expiration engine reads. All are nullable / defaulted so existing rows
-- and inserts are unaffected.
--
--   aliases                 JSON array — alternate names / phrasings the
--                           NL-retrieval engine matches against (flattened
--                           into documents_fts.aliases_text in 0079).
--   criteria                JSON array — regulatory references / criteria.
--   applies_to              JSON array — facility scope, e.g. ["Kent"],
--                           ["Kent","Portland"], or ["company"].
--   owner                   free-text owner (person / department).
--   renewal_type            one of renewal_application | hard_expiry |
--                           keep_current | review_cycle (nullable).
--   renewal_interval_months cadence in months for cyclic renewals.
--   renewal_due_date        canonical next-action date the expiration
--                           engine reads.

ALTER TABLE documents ADD COLUMN aliases TEXT DEFAULT '[]';
ALTER TABLE documents ADD COLUMN criteria TEXT DEFAULT '[]';
ALTER TABLE documents ADD COLUMN applies_to TEXT DEFAULT '[]';
ALTER TABLE documents ADD COLUMN owner TEXT;
ALTER TABLE documents ADD COLUMN renewal_type TEXT
  CHECK (renewal_type IN ('renewal_application','hard_expiry','keep_current','review_cycle'));
ALTER TABLE documents ADD COLUMN renewal_interval_months INTEGER;
ALTER TABLE documents ADD COLUMN renewal_due_date TEXT;

CREATE INDEX IF NOT EXISTS idx_documents_renewal_type ON documents(renewal_type);
CREATE INDEX IF NOT EXISTS idx_documents_renewal_due_date ON documents(renewal_due_date);
