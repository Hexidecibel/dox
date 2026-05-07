-- Migration 0055: Search v2 — async reindex queue (Phase 2)
--
-- Phase 2 of the Document Search v2 plan
-- (`/home/hexi/.claude/plans/peppy-coalescing-platypus.md`).
--
-- Phase 1 (migration 0054) deliberately stopped supplier / product /
-- document_type renames from fanning out across `documents_fts`. That
-- protects API latency on big tenants — a supplier with 10k docs would
-- otherwise rebuild 10k FTS rows inside the UPDATE statement.
--
-- This migration adds the async drain path. Three pieces:
--
--   1. `search_reindex_jobs` table — one row per pending fan-out.
--   2. A partial unique index on (entity_kind, entity_id) WHERE
--      status='pending' so renaming the same supplier ten times produces
--      ONE pending job, not ten.
--   3. AFTER UPDATE triggers on suppliers / products / document_types
--      that INSERT a job row using `INSERT OR IGNORE` against the
--      partial unique index for idempotency.
--
-- The drainer itself lives in `functions/lib/search-reindex.ts` —
-- triggered by `POST /api/admin/search/reindex` (super_admin only) and,
-- as a follow-up, by the local process-worker's main poll loop.
--
-- Schema deviation from the plan worth flagging:
-- ------------------------------------------------
-- The plan offered "reuse processing_queue with a kind discriminator vs
-- new search_reindex_jobs table — pick the cleaner answer." We pick the
-- new table. Reasons:
--   * `processing_queue` is wide (file_r2_key, mime_type, ai_fields,
--     vlm_*, learned_field_hints, …) and tightly coupled to the AI
--     extraction lifecycle. Forcing reindex jobs through it would mean
--     either NOT NULL violations or making half the schema nullable.
--   * The AI queue has a separate worker contract (`/api/queue/:id/results`)
--     that posts extraction outputs. Reindex jobs have no extraction
--     output to post; they are pure SQL fan-outs.
--   * The two queues have different drain rules (AI: 1 at a time,
--     human-in-the-loop; reindex: many at a time, fully automated) and
--     different retry semantics.
-- A separate table keeps both queues honest.

------------------------------------------------------------
-- 1. search_reindex_jobs table
------------------------------------------------------------

CREATE TABLE IF NOT EXISTS search_reindex_jobs (
  id            TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  tenant_id     TEXT NOT NULL REFERENCES tenants(id),
  -- Which kind of source-table change triggered this job. The drainer
  -- branches on this to look up the affected docs.
  --   'supplier'      → docs WHERE supplier_id = entity_id
  --   'product'       → docs joined via document_products
  --   'document_type' → docs WHERE document_type_id = entity_id
  --   'tenant'        → all docs in the tenant (full rebuild)
  entity_kind   TEXT NOT NULL,
  entity_id     TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  attempts      INTEGER NOT NULL DEFAULT 0,
  max_attempts  INTEGER NOT NULL DEFAULT 3,
  last_error    TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  processed_at  TEXT
);

CREATE INDEX IF NOT EXISTS idx_search_reindex_jobs_pending
  ON search_reindex_jobs (status, created_at)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_search_reindex_jobs_tenant
  ON search_reindex_jobs (tenant_id, status);

-- Idempotent enqueue: at most one row per (entity_kind, entity_id) in
-- status='pending'. Same kind/id with status='completed' or 'failed' is
-- allowed — those are historical. Re-renaming after a completed drain
-- correctly produces a fresh pending job because the prior row is no
-- longer pending.
CREATE UNIQUE INDEX IF NOT EXISTS uq_search_reindex_jobs_pending
  ON search_reindex_jobs (entity_kind, entity_id)
  WHERE status = 'pending';

------------------------------------------------------------
-- 2. Triggers — suppliers / products / document_types
------------------------------------------------------------
--
-- We use `INSERT OR IGNORE` against the partial unique index so a second
-- rename while a prior job is still pending becomes a no-op. After the
-- drainer flips that job to 'completed' or 'failed', the next rename
-- naturally inserts a new row.
--
-- These triggers are SEPARATE from the FTS-update triggers on the same
-- tables in 0054. Both fire on AFTER UPDATE; SQLite runs them in the
-- order they appear in sqlite_master. Order doesn't matter here — the
-- FTS update for the entity's own row (suppliers_fts etc) doesn't read
-- or write search_reindex_jobs.

CREATE TRIGGER IF NOT EXISTS trg_suppliers_au_reindex
AFTER UPDATE OF name, aliases ON suppliers
BEGIN
  INSERT OR IGNORE INTO search_reindex_jobs
    (tenant_id, entity_kind, entity_id)
  VALUES
    (NEW.tenant_id, 'supplier', NEW.id);
END;

CREATE TRIGGER IF NOT EXISTS trg_products_au_reindex
AFTER UPDATE OF name ON products
BEGIN
  INSERT OR IGNORE INTO search_reindex_jobs
    (tenant_id, entity_kind, entity_id)
  VALUES
    (NEW.tenant_id, 'product', NEW.id);
END;

CREATE TRIGGER IF NOT EXISTS trg_document_types_au_reindex
AFTER UPDATE OF name, slug ON document_types
BEGIN
  INSERT OR IGNORE INTO search_reindex_jobs
    (tenant_id, entity_kind, entity_id)
  VALUES
    (NEW.tenant_id, 'document_type', NEW.id);
END;
