-- Migration 0049: connector_runs.source
--
-- Universal-doors model (Phase B2) — tag every run with which intake
-- door it came in through so the activity feed and audit surfaces can
-- filter / group by source. The orchestrator populates this column from
-- the `ConnectorInput.type` plus an explicit override for the API-drop
-- door (`'api'`), which otherwise piggybacks on the file_watch executor.
--
-- Values we expect to see in the wild:
--   - 'manual'      : drag-drop on ConnectorDetail (POST /run)
--   - 'api'         : POST /api/connectors/:id/drop (B2)
--   - 'email'       : email-worker -> connector-email-ingest webhook
--   - 'webhook'     : direct webhook ingest
--   - 'r2_poll'     : scheduled R2 prefix poller
--   - 'public_link' : public drop link form (B4)
--   - 'api_poll'    : outbound vendor-API pull (future)
--
-- Phase B5 builds the source-aware activity feed on top of this column.
-- Existing rows stay NULL (backfill is a non-goal — historical runs
-- predate the universal-doors taxonomy).
--
-- Purely additive — nullable text, no defaults, no backfill. Existing
-- code that omits the column continues to work; readers fall back to
-- 'unknown' when the value is NULL.

ALTER TABLE connector_runs ADD COLUMN source TEXT;
CREATE INDEX IF NOT EXISTS idx_connector_runs_source ON connector_runs(source);
