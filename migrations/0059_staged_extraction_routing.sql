-- Migration 0059: Stage low-confidence connector extractions
--
-- Adds the staging machinery for R1.2 of the extraction-repair surface
-- (see plan.md → "Connector extraction repair surface"). Instead of
-- widening the orders.status CHECK enum (which would force a table
-- rebuild and FTS-trigger reattach), we add additive columns:
--
--   orders.staged_at      TEXT   — set to datetime('now') when the LLM's
--                                  _confidence on this order was below
--                                  the threshold. NULL = committed.
--   orders.confidence     REAL   — the raw 0.0–1.0 the LLM emitted,
--                                  preserved for the review UI to surface.
--   order_items.staged_at TEXT   — same semantics. Items move from
--                                  staged → committed when the parent
--                                  order is approved.
--   order_items.confidence REAL  — per-line confidence.
--   customers.confidence  REAL   — visibility only; customers stay
--                                  on the commit path (identity-keyed
--                                  by customer_number — can't stage
--                                  without breaking upsert semantics).
--   connector_runs.records_staged INTEGER — run-level rollup for the
--                                  triage dashboard.
--
-- Indexes are partial on staged_at IS NOT NULL so they stay small —
-- the vast majority of rows are not staged.

ALTER TABLE orders ADD COLUMN staged_at TEXT;
ALTER TABLE orders ADD COLUMN confidence REAL;
CREATE INDEX IF NOT EXISTS idx_orders_staged
  ON orders(tenant_id, staged_at) WHERE staged_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_orders_connector_run_staged
  ON orders(connector_run_id) WHERE staged_at IS NOT NULL;

ALTER TABLE order_items ADD COLUMN staged_at TEXT;
ALTER TABLE order_items ADD COLUMN confidence REAL;

ALTER TABLE customers ADD COLUMN confidence REAL;

ALTER TABLE connector_runs ADD COLUMN records_staged INTEGER DEFAULT 0;
