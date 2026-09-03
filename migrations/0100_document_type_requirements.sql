-- Migration 0100: which checklist items a document of this TYPE normally
-- closes — the DEFAULT that makes an approved document mean something.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- WHY THIS TABLE EXISTS AT ALL
-- ═══════════════════════════════════════════════════════════════════════════
-- The registry's layer 2 (`requirements` + `document_requirements`, migration
-- 0080) and the gap engine built on top of it have been running on data that
-- NOTHING PRODUCES. `syncDocumentFacets` is reachable only from
-- POST /api/documents/ingest and PUT /api/documents/:id, and both require the
-- CALLER to name the requirement ids. The approve path — the door almost every
-- real document comes through — writes documents, versions, products, lots and
-- reviewer captures, and zero `document_requirements` rows.
--
-- So today an approved COA closes nothing, ever, unless a human opens the
-- document detail page and ticks boxes. This table is the missing input: a
-- per-tenant mapping from a document TYPE to the requirements a document of
-- that type is normally expected to satisfy, which
-- `functions/lib/requirement-defaults.ts` turns into 'suggested' links at the
-- moment the document row appears.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- DELIBERATELY NO `tier` AND NO `status` COLUMN
-- ═══════════════════════════════════════════════════════════════════════════
-- This is a DEFAULT, not an assertion. Three tables answer three different
-- questions and collapsing any two of them loses one of the answers:
--
--   supplier_requirements (0087)  APPLICABILITY — which requirements apply to
--                                 which supplier. `tier` (required /
--                                 recommended) lives THERE because it is a
--                                 property of the obligation, not of the
--                                 paperwork that discharges it.
--   document_requirements (0080)  THE ACTUAL LINK — this document, this
--                                 requirement, and a human-in-the-loop
--                                 `status` (suggested / confirmed / rejected).
--                                 A verdict about one real document.
--   document_type_requirements    THE GUESS, before any document exists. It
--   (here)                        has no tier because it is not an obligation
--                                 and no status because nobody has judged
--                                 anything yet.
--
-- A `tier` here would compete with 0087 the first time a tenant said
-- "recommended for supplier A, required for supplier B" and there would be no
-- principled winner. A `status` here would be a verdict on a mapping rather
-- than on a document, and the suggestion it produced would then carry two
-- statuses that could disagree.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- ZERO ROWS ON MIGRATION DAY, AND THAT IS THE SAFETY PROPERTY
-- ═══════════════════════════════════════════════════════════════════════════
-- This ships to existing tenants who never asked for it. The producer is gated
-- on rows existing: with no mapping rows for a type it performs no write at
-- all, so an approve/ingest is byte-identical to the day before. Rows arrive
-- from a starter pack, the setup wizard, or a human — hence `source`.
--
-- `source` is a plain TEXT with no CHECK, matching the reasoning already
-- recorded for `document_requirements.source` in functions/lib/registry.ts:
-- the set of pipelines that can propose a mapping grows, and SQLite cannot
-- alter a CHECK in place — each new producer would cost a table rebuild.
--
-- `created_by` is a bare TEXT with no FK to users, same as
-- `owner_routes.created_by` (0091) and `tenant_modules.updated_by` (0099):
-- provenance for a configuration decision must outlive the account that made
-- it.
--
-- UNIQUE(document_type_id, requirement_id) needs no COALESCE trick (0086) and
-- no thought about NULL-distinctness: both key columns are NOT NULL, so the
-- SQLite rule that makes NULLs distinct in a UNIQUE index cannot apply. It
-- omits `tenant_id` on purpose — `document_type_id` already belongs to exactly
-- one tenant, so adding it would widen the key without excluding anything.
-- `tenant_id` is carried anyway, denormalized, so the producer can scope its
-- read by tenant without a join and so a cross-tenant mapping is visible as
-- data rather than only inferable through two FKs.

CREATE TABLE IF NOT EXISTS document_type_requirements (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  document_type_id TEXT NOT NULL REFERENCES document_types(id) ON DELETE CASCADE,
  requirement_id TEXT NOT NULL REFERENCES requirements(id) ON DELETE CASCADE,
  source TEXT NOT NULL DEFAULT 'pack',   -- 'pack' | 'wizard' | 'human'
  created_at TEXT DEFAULT (datetime('now')),
  created_by TEXT,
  UNIQUE (document_type_id, requirement_id)
);

-- The producer's only read: "what does THIS type default to, for THIS tenant".
CREATE INDEX IF NOT EXISTS idx_dtr_tenant_type
  ON document_type_requirements(tenant_id, document_type_id);

-- ═══════════════════════════════════════════════════════════════════════════
-- documents.owner, defaulted from the type
-- ═══════════════════════════════════════════════════════════════════════════
-- `documents.owner` (0077) is the free-text departmental label that
-- `owner_routes` (0091) resolves into real renewal-alert recipients. It is set
-- by hand today, which means the overwhelming majority of documents have none,
-- which means the renewal engine reports a routing gap instead of mailing
-- anybody. But the label is nearly always a property of the KIND of document —
-- a certificate of insurance is Insurance's problem at every supplier — so it
-- belongs next to the type as a default.
--
-- NULLABLE, and NULL means "nobody has said". Not `NOT NULL DEFAULT 'QA'`:
-- same reasoning as 0096's renewal period — a stored value should be there
-- because somebody chose it, and stamping a guess onto 300 existing rows makes
-- "QA because it was decided" indistinguishable from "QA because the migration
-- had to write something".
--
-- The producer applies it ONLY when `documents.owner` IS NULL and NEVER
-- overwrites a value a human set. This migration writes no rows and no
-- backfill: every existing type keeps a NULL default_owner, so no document's
-- owner changes today.

ALTER TABLE document_types ADD COLUMN default_owner TEXT;
