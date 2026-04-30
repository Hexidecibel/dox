-- Migration 0052: connector_runs.retry_of_run_id
--
-- Phase B5 — replay path for failed runs. When a vendor-driven run hits
-- an error (parser blowup, mapping mismatch, transient downstream
-- failure) the file is already persisted in R2 (or the source bucket).
-- The owner can now hit a "Retry" button on the failed row in
-- ConnectorDetail; the backend refetches the file and dispatches a
-- fresh run. Both the original and the retry rows live as historical
-- record — they're linked via this nullable self-FK so the activity
-- feed and per-run drilldowns can reconstruct the chain.
--
-- Self-FK is best-effort: D1 doesn't enforce FKs by default but the
-- declaration documents the relationship. We do NOT cascade — if the
-- original row is ever pruned, the retry row stays (the retry has its
-- own complete record of what was dispatched).
--
-- Purely additive — nullable text, no defaults, no backfill. Indexed
-- so the UI's "show all retries of X" lookup is cheap.

ALTER TABLE connector_runs
  ADD COLUMN retry_of_run_id TEXT REFERENCES connector_runs(id);

CREATE INDEX IF NOT EXISTS idx_connector_runs_retry_of
  ON connector_runs(retry_of_run_id);
