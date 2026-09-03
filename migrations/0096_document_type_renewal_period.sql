-- Migration 0096: how long a document of this TYPE is good for.
--
-- WHY
-- ---
-- Confirmed with the client's subject-matter expert (AJ Conner, 2026-09-02).
-- These are regulatory definitions, not house preferences:
--
--   * Annual is the default renewal period — roughly 90% of a supplier file is
--     re-collected yearly.
--   * A SPECIFICATION SHEET renews at three years. Both major food-safety
--     schemes define a current spec sheet the same way: revised within three
--     years, or carrying history showing someone reviewed or refreshed it
--     inside that window. An auditor applies that definition whether or not
--     this system does.
--   * Everything else is one year, OR whatever the document itself states.
--
-- Only the first two are configuration. The third is precedence and lives in
-- code (`resolveRenewalExpiry` in shared/renewalPeriod.ts): a document that
-- prints its own expiry — an insurance certificate saying 09/01/2027 — expires
-- then, and no per-type default may override it. A default is a guess about a
-- document that did not say.
--
--
-- NULLABLE, AND NULL MEANS "THE ANNUAL DEFAULT"
-- ---------------------------------------------
-- Not `NOT NULL DEFAULT 12`. A stored value should be there because it DIFFERS
-- from the default; stamping 12 onto every existing row would make "annual
-- because nobody said otherwise" indistinguishable from "annual because a QA
-- manager decided so", and would freeze today's default into 300 rows that a
-- future change to it could not reach.
--
--
-- THE BACKFILL IS A NAME MATCH, WHICH IS UGLY AND IS THE ONLY OPTION
-- -----------------------------------------------------------------
-- `document_types` rows are free text created per tenant by admins; the slug
-- is generated from the name and nothing in the schema marks a type as "the
-- spec sheet one". So spec-sheet detection is a name match, mirrored from
-- `looksLikeSpecSheetType` in shared/renewalPeriod.ts, which is the same match
-- applied when a NEW type is created. It runs exactly twice — here, once — and
-- at creation time. It never runs at read time: what a type renews at is this
-- stored column, visible and editable on the Document Types screen. A guess
-- that writes itself into a visible setting can be corrected by the person who
-- sees it; a guess re-derived on every read cannot.

ALTER TABLE document_types ADD COLUMN renewal_interval_months INTEGER;

-- Three years for anything that reads as a specification sheet. Restricted to
-- rows that have no value yet so a re-run cannot stamp over a human's choice.
-- Safe to write `updated_at` here: both document_types UPDATE triggers are
-- column-scoped (`AFTER UPDATE OF name, slug[, description]`), so this backfill
-- does not churn the FTS index or the reindex queue.
UPDATE document_types
SET renewal_interval_months = 36,
    updated_at = datetime('now')
WHERE renewal_interval_months IS NULL
  AND (
    lower(name) LIKE '%specification%'
    OR lower(name) LIKE '%spec sheet%'
    OR lower(name) LIKE '%spec-sheet%'
    OR lower(name) LIKE '%specs sheet%'
    OR lower(name) LIKE '%product spec%'
    OR slug LIKE '%specification%'
    OR slug LIKE '%spec-sheet%'
    OR slug LIKE '%product-spec%'
  );
