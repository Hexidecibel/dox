-- Phase 3a sidecar columns on processing_queue. Both are JSON-stringified
-- payloads written by the worker after VLM canonicalization and read back by
-- the Review Queue UI.
--
-- learned_field_hints: per-field suggestions derived from the Phase 2 capture
--   tables (reviewer_field_picks etc). Shape:
--     { [field_key]: { preferred_source, suggested_value, confidence, pick_count } }
--   Worker writes this only when getLearnedPreferences() returns a field with
--   confidence >= 0.8 for the resolved (supplier, doctype) pair.
--
-- uncertainty: per-field 0..1 confidence scores from the heuristic uncertainty
--   pass. Empty/short/regex-failing values bump up; dual-mode disagreement
--   forces >= 0.7 so the field surfaces under the "needs your eyes" banner.
--   Shape: { [field_key]: number }

ALTER TABLE processing_queue ADD COLUMN learned_field_hints TEXT;
ALTER TABLE processing_queue ADD COLUMN uncertainty TEXT;
