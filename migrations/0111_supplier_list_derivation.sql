-- Migration 0111: requirements DERIVED from a tenant's verified supplier list.
--
-- (Numbered after 0110. A parallel worktree may also claim 0111; renumber on
-- merge if so. Nothing here depends on the number.)
--
-- WHY THIS EXISTS
-- ---------------
-- AJ Conner, 2026-09-14 walkthrough: every supplier on the live tenant carries
-- the same invented requirement set (294 rows = 21 suppliers x 14 items, every
-- one with source IS NULL). His minimum for EVERY approved supplier is a
-- certificate of insurance and a third-party food safety certificate; beyond
-- that, what a supplier owes should FOLLOW FROM FACTS the company already
-- holds: which suppliers are approved, what category each is, which products
-- are bought from each, and which claims are made on those products.
--
-- "Easy mode" is a spreadsheet import of that list. A webhook/API caller comes
-- later and must reach the SAME rule function (shared/requirementDerivation.ts)
-- through the same endpoint (POST /api/supplier-list/import), so the rules are
-- not re-implemented per door.
--
-- 1. supplier_list_imports -- one row per APPLIED import run.
-- ---------------------------------------------------------------
-- Who, when, which file, what was asked for (the normalized input rows, so a
-- run is re-runnable), what came of each row, and the counts. A dry run is a
-- preview and writes nothing, including no row here: a preview is not an event.
-- `counts`, `row_outcomes` and `input_rows` are JSON validated in code, with
-- only json_valid in SQL -- the shapes will grow and SQLite cannot alter a
-- CHECK in place.
--
-- 2. supplier_requirements gains the derivation's provenance.
-- ---------------------------------------------------------------
-- `source` (0102) gains the value 'derived'. Still no CHECK (0102's reasoning).
-- The full vocabulary after this migration:
--   NULL      written before anybody recorded why -- the initial bulk seed. The
--             worklist. Never stamped retroactively.
--   'human'   a person attached it, changed its tier, or confirmed it.
--   'packet'  a person applied a requirement packet (packet_slug says which).
--   'derived' the verified supplier list implies it (derivation_run_id says
--             which import last supported it).
--
-- derivation_run_id   the import run that last derived or re-supported this
--                     row. A pointer, so "why does Darigold owe a Letter of
--                     Guarantee?" resolves to a file, a person and a date.
-- derivation_basis    JSON list of the reasons the rule function produced
--                     ("baseline", "category packet ingredient-supplier",
--                     "claim rbst-free on Salted Butter 25kg", "spec sheet for
--                     product 10042"). Rewritten on every re-derivation.
-- review_flag         'not_on_verified_list' when a later import no longer
--                     implies a DERIVED row. The row is NOT deleted and still
--                     counts in gap reports: a supplier dropping off a
--                     spreadsheet is a question for a person, and an
--                     obligation that silently vanishes is exactly the failure
--                     a compliance record must not have. Cleared if a later
--                     import supports the row again, or a person confirms it.
-- review_flagged_at   when the flag was raised.
--
-- A 'human' or 'packet' row is never touched by an import -- not its tier, not
-- its flag. A NULL (bulk-seed) row the list DOES imply is adopted as 'derived':
-- the guess finally has a basis, and what stays NULL afterwards is precisely
-- the part of the seed nothing supports.

CREATE TABLE IF NOT EXISTS supplier_list_imports (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  file_name TEXT,
  -- 'csv' | 'xlsx' | 'rows' (a structured JSON caller). Enforced in code.
  input_format TEXT NOT NULL,
  -- Which starter pack's packets the category rules resolved against.
  pack TEXT,
  counts TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(counts)),
  row_outcomes TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(row_outcomes)),
  input_rows TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(input_rows)),
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_supplier_list_imports_tenant
  ON supplier_list_imports(tenant_id, created_at);

ALTER TABLE supplier_requirements ADD COLUMN derivation_run_id TEXT;
ALTER TABLE supplier_requirements ADD COLUMN derivation_basis TEXT;
ALTER TABLE supplier_requirements ADD COLUMN review_flag TEXT;
ALTER TABLE supplier_requirements ADD COLUMN review_flagged_at TEXT;

-- The worklist's access path: "which rows need a person" -- unconfirmed seed
-- rows (source IS NULL) and flagged derived rows. Partial on the flag side;
-- the NULL-source side is served by the tenant index scan it already has.
CREATE INDEX IF NOT EXISTS idx_supplier_requirements_review_flag
  ON supplier_requirements(tenant_id, review_flag)
  WHERE review_flag IS NOT NULL;
