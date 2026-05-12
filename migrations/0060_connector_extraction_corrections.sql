-- Migration 0060: Capture extraction corrections for R2 learning
--
-- When a human approves a staged connector order with edits, the diff
-- between the LLM's original values and the human-final values is the
-- signal R2 (per-supplier extraction instructions) needs to learn from.
-- Each row records a single approve-with-edits event.
--
-- Columns:
--   tenant_id        — scoped per tenant.
--   connector_id     — which connector generated the bad extraction.
--   connector_run_id — which run; lets a future "what improved between
--                      run N and N+1" view group corrections.
--   order_id         — the order that was edited (kept even after the
--                      order is deleted; FK is REFERENCES not CASCADE).
--   customer_id      — when known. Joins to R2's supplier-instructions
--                      table once R2 lands.
--   customer_number  — denormalized so R2 can group by K-number even if
--                      customer_id is null at correction time.
--   diffs (JSON)     — array of { entity, entity_id, field, original,
--                      corrected, op } where:
--                        entity = 'order' | 'order_item'
--                        op     = 'update' | 'insert' | 'delete'
--                        For inserts: corrected is the full new item,
--                                     original is null.
--                        For deletes: original is the deleted row,
--                                     corrected is null.
--   reviewer_id      — user that hit Approve.
--   reviewed_at      — when.

CREATE TABLE IF NOT EXISTS connector_extraction_corrections (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  connector_id TEXT REFERENCES connectors(id),
  connector_run_id TEXT REFERENCES connector_runs(id),
  order_id TEXT REFERENCES orders(id),
  customer_id TEXT REFERENCES customers(id),
  customer_number TEXT,
  diffs TEXT NOT NULL DEFAULT '[]',
  reviewer_id TEXT REFERENCES users(id),
  reviewed_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_corrections_customer_number
  ON connector_extraction_corrections(tenant_id, customer_number)
  WHERE customer_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_corrections_connector
  ON connector_extraction_corrections(connector_id);
CREATE INDEX IF NOT EXISTS idx_corrections_run
  ON connector_extraction_corrections(connector_run_id);
CREATE INDEX IF NOT EXISTS idx_corrections_customer_id
  ON connector_extraction_corrections(customer_id)
  WHERE customer_id IS NOT NULL;
