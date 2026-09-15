-- 0105 — which RESULT a register row is about.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- THE PROBLEM, MEASURED ON PRODUCTION (2026-09-14)
-- ═══════════════════════════════════════════════════════════════════════════
-- `document_spec_checks` stores what was judged (test, value, unit, verdict,
-- limit) but not WHERE on the certificate it was printed. A multi-lot COA is a
-- crosstab with one row per lot, and five lots that each read "Coliform <10"
-- produce five rows that are byte-identical in every column a reader can see.
-- On prod that was 53 groups, 175 rows across 15 documents, and every one of
-- them read as a duplicate.
--
-- None of them was. Replaying the engine over each document's metadata put
-- every row in each group at a DISTINCT place on the page (table 1 rows 1-6,
-- column 5; or table 1 row 2 vs table 2 row 2 — two batches). The engine
-- walks each table once and each row once, so it cannot emit the same result
-- twice. The register was writing correct evidence that nobody could tell apart.
--
-- (The duplicates reported by name — "042026-14OLY 2.5-Gal COA" twice — are a
-- different thing again: two DOCUMENTS carrying the same file, from one email
-- forwarded twice twenty minutes apart and both queue items approved. Their
-- register rows are one per document, which is correct. That is an intake
-- problem and nothing in this migration addresses it.)
--
-- ═══════════════════════════════════════════════════════════════════════════
-- `result_key` — THE IDENTITY
-- ═══════════════════════════════════════════════════════════════════════════
-- The engine already had one: `specResultKey(scope, target)` in
-- shared/specCheck.ts ("ai_fields::t0r2c9" — table 0, row 2, column 9). It was
-- computed for every verdict and persisted nowhere; the backfill script's own
-- header named that as the reason it could not merge. It is stored verbatim.
-- It names a LOCATION, not a verdict: the COA's printed spec and our limit can
-- both judge the same cell, and `source` (already a column) tells them apart.
--
-- `result_location` is the same fact in words ("Table 1, row 3 (38292)"),
-- built once in shared/specSnapshot.ts and frozen like the limit is, so the
-- page never parses a key and a later change to the wording cannot relabel old
-- rows.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- THE UNIQUE INDEX — A TRUE DUPLICATE BECOMES UNWRITABLE
-- ═══════════════════════════════════════════════════════════════════════════
-- One document version, one location, one source: one row. Both producers
-- (`registerSpecChecks` at approval, `bin/backfill-spec-register`) also drop a
-- repeated identity in code before writing, so the index is the backstop that
-- makes the rule structural rather than the thing that fails a batch.
--
-- `version_number` is nullable, so it is COALESCEd in the key — the 0086
-- NULL-distinctness trap, which would otherwise exempt every NULL-version row.
-- PARTIAL on `result_key IS NOT NULL`: every row written before this migration
-- has no identity, and inventing one here (without replaying the engine) would
-- be a guess. `bin/backfill-spec-register --stamp-identity` replays and stamps
-- only where the replay reproduces the document's rows exactly.
--
-- No backfill UPDATE and no CHECK. Nothing reads either column to decide a
-- verdict, an acknowledgement or an alert.

ALTER TABLE document_spec_checks ADD COLUMN result_key TEXT;
ALTER TABLE document_spec_checks ADD COLUMN result_location TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_dsc_result_identity
  ON document_spec_checks(document_id, COALESCE(version_number, -1), result_key, source)
  WHERE result_key IS NOT NULL;
