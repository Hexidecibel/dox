-- Migration 0080: registry facet vocabularies (layer 2 + layer 3).
--
-- BACKGROUND — the three questions a document answers
-- ---------------------------------------------------
-- The shipped registry collapses three independent questions into ONE
-- vocabulary (document_types):
--
--   1. What it IS       — the document type. ONE value per document.
--                         "Specification Sheet", "Kosher Certificate".
--   2. What it SATISFIES — which checklist line items this file CLOSES. MANY.
--                         One spec sheet typically closes seven (Spec Sheet,
--                         Micro Limits, Pack Size, 100g Nutritionals, Allergen
--                         Matrix, Country of Origin, GTIN).
--   3. What it TRIGGERS  — claims the document ASSERTS that require a
--                         DIFFERENT document to prove. A spec sheet saying
--                         "Organic" is not an organic document; it makes an
--                         organic certificate newly applicable and MISSING.
--
-- Layer 2 CLOSES checklist items. Layer 3 OPENS them. Layer 3 does not exist
-- today at all.
--
-- Layer 1 stays exactly where it is: documents.document_type_id (already
-- single-valued, already tenant+supplier scoped). No new table for it.
--
-- This migration adds layers 2 and 3:
--   requirements             layer-2 vocabulary (the checklist line items)
--   document_requirements    junction — what this document CLOSES
--   claim_types              layer-3 vocabulary (the assertable claims)
--   document_claims          junction — what this document ASSERTS
--   claim_type_requirements  claim -> what proves it (what a claim OPENS)
--
-- DESIGN NOTE — why claims point at REQUIREMENTS, not document_types.
-- Layer 2 is the currency of the checklist. A document CLOSES requirements; a
-- claim OPENS requirements. Same currency on both sides means gap detection
-- (P4) is a pure set difference over one vocabulary:
--
--     (requirements opened by confirmed claims)
--   MINUS
--     (requirements closed by documents in scope)
--
-- If claims pointed at document_types instead, every gap query would have to
-- bridge two different vocabularies. This is the table AJ did not name but
-- without which a detected claim cannot resolve to a NAMED missing document,
-- which is the whole point of layer 3.
--
-- DESIGN NOTE — everything here is per-tenant ROWS, never code. Aiming the
-- platform at a non-food vertical (the Medosweet finance module) must be a
-- configuration exercise, not a rebuild. No food-specific value is hardcoded
-- in this schema; the starter packs that populate it are P2.
--
-- DEFERRED — the layer-0 "program section" facet (the Food Safety Manual's
-- folders 100-126) is deliberately NOT built. The other three facets already
-- record what a doc IS, what it SATISFIES and what it TRIGGERS, so a folder
-- number only preserves the binder's shelf layout. Revisit only if the client
-- confirms he needs it; it would be a fifth table plus a junction plus an FTS
-- column plus a picker.
--
-- 0076 document_categories DISPOSITION — RETIRED, in two steps.
-- document_requirements supersedes it: document_categories is a junction onto
-- document_types (layer-1 vocabulary) but is used with layer-2 semantics
-- ("pick every document type this satisfies", DocumentCreate.tsx:294). It
-- cannot simply be dropped here: migration 0079's documents_fts_source VIEW
-- selects from it to build category_text, and every documents/versions/
-- products/lots FTS trigger inserts through that view. Dropping the table
-- would leave a dangling view reference and every document write would fail at
-- runtime. The physical DROP therefore belongs to P3's 0079-style FTS
-- DROP+recreate, which replaces category_text with requirements_text in the
-- same statement batch. Until then document_categories keeps working, unread
-- by anything new. See the P3 checklist in plan.md.

------------------------------------------------------------
-- Layer 2 — requirements (what a document SATISFIES)
------------------------------------------------------------
-- One row per checklist line item, per tenant. For AJ this is SOP 102.2's
-- line items; for a finance tenant it is whatever their records checklist
-- enumerates. `checklist` is an optional free-text grouping label so several
-- checklists can coexist in one tenant without another table.
CREATE TABLE IF NOT EXISTS requirements (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  checklist TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(tenant_id, slug)
);

CREATE INDEX IF NOT EXISTS idx_requirements_tenant ON requirements(tenant_id, active);
CREATE INDEX IF NOT EXISTS idx_requirements_checklist ON requirements(tenant_id, checklist);

-- Junction: this document CLOSES these requirements.
--
-- status is the human-in-the-loop gate. The column DEFAULT is 'suggested'
-- (fail-safe: an ungoverned direct INSERT lands as a suggestion, never as an
-- assertion) while functions/lib/registry.ts defaults to 'confirmed' for the
-- human editing path. Nothing auto-confirms.
--
-- source is intentionally NOT constrained by a CHECK — it is an open set that
-- grows with new pipelines ('human', 'extraction', 'rule', ...) and a CHECK
-- would make each addition a table rebuild in SQLite. Validated in the lib
-- against REGISTRY_LINK_SOURCES. status IS constrained: it is a closed,
-- workflow-critical set of three.
CREATE TABLE IF NOT EXISTS document_requirements (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  requirement_id TEXT NOT NULL REFERENCES requirements(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'suggested'
    CHECK (status IN ('suggested','confirmed','rejected')),
  source TEXT NOT NULL DEFAULT 'human',
  confidence REAL,
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  created_by TEXT,
  confirmed_at TEXT,
  confirmed_by TEXT,
  UNIQUE(document_id, requirement_id)
);

CREATE INDEX IF NOT EXISTS idx_document_requirements_document
  ON document_requirements(document_id);
CREATE INDEX IF NOT EXISTS idx_document_requirements_requirement
  ON document_requirements(requirement_id, status);

------------------------------------------------------------
-- Layer 3 — claim_types (what a document TRIGGERS)
------------------------------------------------------------
-- The assertable claims vocabulary, per tenant: "Organic", "Kosher",
-- "Gluten Free", "SQF Certified". A claim is NOT a document type — asserting
-- it is what makes a DIFFERENT document applicable and missing.
--
-- subject_grain declares, at the vocabulary level, what a claim of this type
-- is ABOUT. The client has not yet answered whether claims are per-product or
-- per-supplier/facility, so the schema expresses both and lets a tenant
-- declare per claim type. 'any' means the tenant does not care to pin it.
-- Deliberately no CHECK constraint — see document_claims.subject_type.
CREATE TABLE IF NOT EXISTS claim_types (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  subject_grain TEXT NOT NULL DEFAULT 'any',
  sort_order INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(tenant_id, slug)
);

CREATE INDEX IF NOT EXISTS idx_claim_types_tenant ON claim_types(tenant_id, active);

-- Junction: this document ASSERTS these claims.
--
-- SUBJECT GRAIN — (subject_type, subject_id) is polymorphic on purpose.
-- The open question is whether a claim is about a specific PRODUCT or about a
-- SUPPLIER/facility; both must be expressible without a later migration, and
-- 'lot' or a finance-domain grain must be addable the same way.
--
-- A concrete nullable products(id)/suppliers(id) FK pair was considered and
-- rejected: SQLite cannot FK a polymorphic column, adding a third grain later
-- would mean another ALTER, and — decisively — an FK to products(id) would NOT
-- have bought tenant safety anyway (it cannot stop a cross-tenant product id).
-- Since subject validation has to live in the lib regardless, the FK buys
-- nothing it does not already cost in flexibility. resolveClaimSubject() in
-- functions/lib/registry.ts does the tenant-scoped existence check.
--
-- subject_type 'tenant' with a NULL subject_id means a tenant-wide claim.
--
-- The uniqueness guard is an expression index rather than a table-level
-- UNIQUE because SQLite treats NULLs as distinct, which would let the same
-- tenant-wide claim be inserted repeatedly. COALESCE is deterministic and
-- therefore legal in an index.
CREATE TABLE IF NOT EXISTS document_claims (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  claim_type_id TEXT NOT NULL REFERENCES claim_types(id) ON DELETE CASCADE,
  subject_type TEXT NOT NULL DEFAULT 'tenant',
  subject_id TEXT,
  status TEXT NOT NULL DEFAULT 'suggested'
    CHECK (status IN ('suggested','confirmed','rejected')),
  source TEXT NOT NULL DEFAULT 'human',
  confidence REAL,
  evidence TEXT,
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  created_by TEXT,
  confirmed_at TEXT,
  confirmed_by TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_document_claims_unique
  ON document_claims(document_id, claim_type_id, subject_type, COALESCE(subject_id, ''));
CREATE INDEX IF NOT EXISTS idx_document_claims_document
  ON document_claims(document_id);
CREATE INDEX IF NOT EXISTS idx_document_claims_type
  ON document_claims(claim_type_id, status);
CREATE INDEX IF NOT EXISTS idx_document_claims_subject
  ON document_claims(subject_type, subject_id, status);

------------------------------------------------------------
-- Layer 3 config — claim_type_requirements (what a claim OPENS)
------------------------------------------------------------
-- "If a document claims Organic, an Organic Certificate becomes applicable."
-- This is the client's "conditional triggers" config, expressed as rows.
--
-- tenant_id is denormalized off claim_types/requirements so gap queries can
-- scope without two joins, and so a mapping cannot silently straddle tenants
-- (enforced in the lib on write).
--
-- is_required 1 = the claim makes this requirement mandatory; 0 = recommended
-- only, surfaced as advisory rather than as a gap.
CREATE TABLE IF NOT EXISTS claim_type_requirements (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  claim_type_id TEXT NOT NULL REFERENCES claim_types(id) ON DELETE CASCADE,
  requirement_id TEXT NOT NULL REFERENCES requirements(id) ON DELETE CASCADE,
  is_required INTEGER NOT NULL DEFAULT 1,
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(claim_type_id, requirement_id)
);

CREATE INDEX IF NOT EXISTS idx_claim_type_requirements_tenant
  ON claim_type_requirements(tenant_id);
CREATE INDEX IF NOT EXISTS idx_claim_type_requirements_claim
  ON claim_type_requirements(claim_type_id);
CREATE INDEX IF NOT EXISTS idx_claim_type_requirements_requirement
  ON claim_type_requirements(requirement_id);
