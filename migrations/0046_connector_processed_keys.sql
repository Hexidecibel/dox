-- Migration 0046: connector_processed_keys
--
-- Dedup table for the scheduled R2-prefix poller (Phase 2 of the
-- file_watch connector). One row per (connector, r2_key) records that
-- we've already dispatched a run for that R2 object so subsequent
-- 5-minute ticks don't reprocess the same file forever.
--
-- The poller (`functions/lib/connectors/pollR2.ts`) writes a row only
-- after `executeConnectorRun` returns without throwing. Run-level
-- failures are recorded on `connector_runs` as usual; the absence of a
-- dedup row means the next tick will retry.

CREATE TABLE IF NOT EXISTS connector_processed_keys (
  id TEXT PRIMARY KEY,
  connector_id TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  processed_at INTEGER NOT NULL,
  run_id TEXT,
  FOREIGN KEY (connector_id) REFERENCES connectors(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_processed_keys_connector_key
  ON connector_processed_keys(connector_id, r2_key);

CREATE INDEX IF NOT EXISTS idx_processed_keys_connector_time
  ON connector_processed_keys(connector_id, processed_at DESC);
