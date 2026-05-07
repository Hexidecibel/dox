-- 0058_drop_extraction_evaluations.sql
-- Removes the A/B eval feature's evaluation table.
-- The text-vs-VLM A/B comparison surface (originally added in 0036) is being retired.
-- Reviewers now select the extraction model directly rather than scoring two side-by-side.

DROP TABLE IF EXISTS extraction_evaluations;
