-- Migration 0114: spellings a tenant has decided are NOT tests.
--
-- (Written against 0113. Renumber if a parallel 0114 lands first; nothing here
-- depends on the number.)
--
-- WHY THIS EXISTS
-- ---------------
-- The Spec Limits page now shows every printed test name the configuration does
-- not recognise, because a limit whose analyte never matches what suppliers
-- print is a limit that silently never runs. Measured on the live tenant that
-- list is 195 spellings across 522 approved certificates -- and only a dozen or
-- so of them are analytes. The rest are the other things a COA prints in a
-- results table: "Flavor", "Color", "Aroma", "LOT CODE", "Item #", "TIME IN",
-- "Best By Date".
--
-- A wall of 195 rows that can only ever get longer is the same failure
-- migration 0095 argues about criticality: a flat screen of things nobody can
-- act on trains the reader to skip the screen, and the ten spellings that ARE
-- costing real checks go down with it. So a person can say "that is not a
-- test", once, and have it stay said.
--
-- WHAT IT IS NOT
-- --------------
-- It is not a rule the engine reads. `shared/specCheck.ts` never loads this
-- table and no verdict changes because of a row in it: the result is still
-- unjudged, still reported as such on the document, and still counted. This
-- says one thing only -- do not offer this spelling on the configuration
-- worklist again -- which is a statement about a SCREEN, not about a
-- certificate.
--
-- NOT HIDDEN, EITHER. The dismissed list stays readable (`include_ignored=1`),
-- carries who dismissed it and when, and a dismissal is undone with one click.
-- A decision that cannot be reviewed is indistinguishable from a bug.
--
-- `name_key` IS THE MATCH KEY, not the printed text: `normalizeTestName` in
-- shared/specCheck.ts, the same fold `matchSpecTest` applies. Dismissing
-- "Flavor" therefore dismisses "FLAVOR" and "flavor", because an ALIAS for any
-- of them would have fixed all of them -- keying on raw text would ask the same
-- person the same question three times. `name_raw` keeps one spelling verbatim
-- as the evidence of what was actually seen.
--
-- Both key columns are NOT NULL, so a plain UNIQUE constrains properly and
-- 0086's NULL-distinctness trap cannot apply (0087 wrote that rule down).

CREATE TABLE IF NOT EXISTS spec_unmatched_ignores (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- normalizeTestName(name_raw): lower-cased, stripped to alphanumerics.
  name_key TEXT NOT NULL,
  -- As printed on the certificate, kept verbatim.
  name_raw TEXT NOT NULL,
  -- Optional: why this is not a test. Free text.
  reason TEXT,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_spec_unmatched_ignores_key
  ON spec_unmatched_ignores(tenant_id, name_key);
