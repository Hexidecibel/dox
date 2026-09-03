-- Migration 0101: where a tenant got to in the first-run setup wizard.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- THIS TABLE STORES A POSITION, NOT A CONFIGURATION
-- ═══════════════════════════════════════════════════════════════════════════
-- The wizard is WRITE-THROUGH. Every screen writes real configuration to the
-- real tables the moment the person acts — the starter pack seeds
-- `document_types` / `requirements` / `claim_types` / `spec_tests` /
-- `owner_labels` / `tenant_modules`, screen 3 writes `owner_routes`, and so on
-- through existing endpoints that already audit and already validate.
--
-- The alternative — stage every answer in a JSON blob and COMMIT it on the
-- last screen — was rejected, and the reason is worth writing down because it
-- is not obvious:
--
--   Screen 1's seeding is what gives screens 2-6 anything to show. A staged
--   step 1 makes every later screen render from the blob instead of from the
--   tenant, so the wizard reads correctly while the tenant is still empty.
--   That divergence is exactly how you ship a wizard that "works" and a tenant
--   that does not, and it is invisible until somebody logs in the next day.
--
-- Abandonment therefore leaves a PARTIALLY CONFIGURED TENANT. That is the
-- correct outcome, not a leak: it is precisely what half an hour of manual
-- admin work produces, every pack write is `INSERT OR IGNORE` on a
-- deterministic `packRowId()`, and nothing the wizard writes overwrites an
-- edit somebody made afterwards.
--
-- So this table answers one question — "where was I, and had I finished?" —
-- and a row of it can be deleted without losing a single setting.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- ONE DRAFT, MANY COMPLETIONS: A PARTIAL UNIQUE INDEX
-- ═══════════════════════════════════════════════════════════════════════════
-- Two things must both be true:
--
--   * a tenant has at most ONE run in flight, so returning to /setup resumes
--     rather than forking a second half-finished walk-through; and
--   * finished runs ACCUMULATE, because "who set this tenant up, when, from
--     which pack" is provenance worth keeping, and a re-run after a vertical
--     change is a legitimate second row.
--
-- A plain `UNIQUE(tenant_id)` would deliver the first and destroy the second.
-- The partial index — the same idiom as 0091's `WHERE active = 1` — delivers
-- both: it constrains only the rows whose `status = 'draft'` and ignores every
-- completed or abandoned row entirely.
--
-- `status` carries a CHECK because it is a closed three-value vocabulary owned
-- by this table, unlike `document_type_requirements.source` (0100) or
-- `document_requirements.source`, where the set of producers grows and SQLite
-- cannot alter a CHECK without a table rebuild. Nothing new will ever be a
-- fourth kind of "where you are".
--
-- ═══════════════════════════════════════════════════════════════════════════
-- WHY `state` AND `applied` ARE BOTH JSON, AND WHAT EACH IS FOR
-- ═══════════════════════════════════════════════════════════════════════════
--   state    the wizard's own scratch: which pack card is selected before it
--            is applied, which labels a person has already dealt with, which
--            explanatory blocks they dismissed. Nothing here is configuration
--            and nothing reads it outside the wizard, which is why it is a
--            blob rather than columns — a column per screen would need a
--            migration every time a screen gains a control.
--   applied  a LEDGER of what the run actually wrote, stamped as it happens:
--            `{"pack":{"name":"fsqa","at":"…","counts":{…}}}`. It is the
--            answer to "did screen 1 already run", which decides whether that
--            screen renders as a chooser or as a read-only summary, and it
--            survives somebody editing the seeded rows afterwards in a way
--            counting the rows back out of the tenant would not.
--
-- Neither is authoritative over the tenant. If the two ever disagree, the
-- tables win — they are what the rest of the product reads.
--
-- `started_by` / `completed_by` are bare TEXT with no FK to `users`, matching
-- `owner_routes.created_by` (0091), `tenant_modules.updated_by` (0099) and
-- `document_type_requirements.created_by` (0100): provenance for a
-- configuration decision must outlive the account that made it.

CREATE TABLE IF NOT EXISTS tenant_setup_runs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'completed', 'abandoned')),

  -- 1-6, the screen the person was last on. Plain INTEGER with no CHECK: the
  -- number of screens is a property of the front end, and a run stamped with a
  -- step this build no longer has must clamp on read, never fail to load.
  current_step INTEGER NOT NULL DEFAULT 1,

  -- The starter pack this run is walking. Nullable until screen 1 is answered,
  -- and NOT a foreign key to anything: packs are JSON files compiled into the
  -- bundle (`functions/lib/starterPacks.generated.ts`), so the database cannot
  -- and should not police the name. An unknown name renders as "pack no longer
  -- available" rather than breaking the run.
  pack TEXT,

  -- See the block above. Both default to an empty object so a reader never has
  -- to distinguish NULL from '{}'.
  state TEXT NOT NULL DEFAULT '{}',
  applied TEXT NOT NULL DEFAULT '{}',

  started_by TEXT,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  completed_by TEXT
);

-- ONE draft per tenant; completed and abandoned runs are unconstrained history.
CREATE UNIQUE INDEX IF NOT EXISTS idx_tenant_setup_runs_one_draft
  ON tenant_setup_runs(tenant_id) WHERE status = 'draft';

-- "Has this tenant ever finished a setup?" — the read behind `needed`, and the
-- history list on the same screen. Ordered by start so the newest is first.
CREATE INDEX IF NOT EXISTS idx_tenant_setup_runs_tenant
  ON tenant_setup_runs(tenant_id, status, started_at DESC);
