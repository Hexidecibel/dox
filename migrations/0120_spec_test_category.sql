-- WHAT KIND OF ANALYTE THIS IS -- so the size of a miss means the right thing.
--
-- Rules table D3 (AJ, fully ruled 2026-09-27): risk does not climb the same way
-- for every analyte, so one ratio scale for "how far out is this?" is wrong
-- for most of them. The band a result falls in is a property of the analyte's
-- CATEGORY, four of them:
--
--   indicator           an indicator organism (coliform). Two lines, not a
--                       gradient: any exceedance is worth a review, an
--                       order-of-magnitude exceedance is a violation.
--   compositional       a compositional / quality parameter (fat, solids).
--                       Genuinely climbs with magnitude: light / look / urgent.
--   zero_tolerance      pathogens, drug residues, undeclared allergens --
--                       presence/absence. No band at all: anything is top
--                       priority.
--   regulatory_ceiling  a hard legal ceiling (aflatoxin M1). Graduated like
--                       compositional but TIGHTER, around the ceiling itself.
--
-- NULL = uncategorized, and that is the default for every existing analyte:
-- no band is computed and everything behaves exactly as before. Nothing here
-- changes a verdict (shared/specCheck.ts never reads these columns); the band
-- orders what a person reads and words the alert. No routing, no holds.
--
-- The ceiling columns are the per-analyte tenant config D3 rules the
-- regulatory band needs ("client/tenant config per analyte"):
--   regulatory_ceiling_value / _unit  the legal line itself, in its own unit
--                                     (converted onto the limit's unit by the
--                                     engine's exact unit arithmetic, or no
--                                     band at all when it cannot be).
--   regulatory_ceiling_source         where that number comes from ("FDA
--                                     action level, CPG 527.400"), because a
--                                     ceiling nobody can cite is a guess.
--   regulatory_band_factor            how far past the ceiling a result is
--                                     still "called" before it reads as a
--                                     violation. NULL = the code default (3x).
-- A WELL-KNOWN DEFAULT (aflatoxin M1, 0.5 ppb) lives in code
-- (shared/specBand.ts, KNOWN_REGULATORY_CEILINGS) and is offered by the editor
-- and used only when nothing is configured -- never written here by fiat, so
-- "0.5 because the FDA says so" and "0.5 because QA typed it" stay distinct.
--
-- D3's zero-tolerance SUBCATEGORIES (which pathogen routes to which owner) are
-- routing, which this does not do; deferred.
--
-- Additive, nullable, no backfill. Plain-ASCII header (the 0110 D1 import
-- finding).

ALTER TABLE spec_tests ADD COLUMN category TEXT
  CHECK (category IS NULL OR category IN ('indicator', 'compositional', 'zero_tolerance', 'regulatory_ceiling'));

ALTER TABLE spec_tests ADD COLUMN regulatory_ceiling_value REAL
  CHECK (regulatory_ceiling_value IS NULL OR regulatory_ceiling_value > 0);

ALTER TABLE spec_tests ADD COLUMN regulatory_ceiling_unit TEXT;

ALTER TABLE spec_tests ADD COLUMN regulatory_ceiling_source TEXT;

ALTER TABLE spec_tests ADD COLUMN regulatory_band_factor REAL
  CHECK (regulatory_band_factor IS NULL OR regulatory_band_factor > 1);
