-- Migration 0057: Search v2 — saved searches (Phase 3)
--
-- Phase 3 of the Document Search v2 plan
-- (`/home/hexi/.claude/plans/peppy-coalescing-platypus.md`).
--
-- Saved searches are per-user named bookmarks of a search state. Recent
-- searches stay client-side (localStorage, key `dox.search.recent`) per
-- the plan; this table only backs the EXPLICITLY named ones the user
-- chooses to keep.
--
-- The `query_json` column is opaque TEXT — the API layer is responsible
-- for parsing/validating it. We deliberately don't enforce a JSON schema
-- at the DB level so the search-state shape can evolve in the frontend
-- without a migration on every change.
--
-- `scope` is a CHECK-constrained enum reserving 'shared' for a future
-- iteration. The current API only accepts 'personal'; the column ships
-- now so the future migration is a no-op rather than a column add.
--
-- ON DELETE CASCADE from `users` keeps the table tidy when an admin
-- deletes a user account. The tenant_id FK has no cascade — tenants are
-- effectively immutable for the lifetime of a saved search; if a tenant
-- is ever hard-deleted, the FK enforces that we drop saved searches
-- first.

CREATE TABLE IF NOT EXISTS saved_searches (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  name TEXT NOT NULL,
  query_json TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'personal' CHECK (scope IN ('personal', 'shared')),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(user_id, name)
);

CREATE INDEX IF NOT EXISTS idx_saved_searches_user ON saved_searches(user_id);
CREATE INDEX IF NOT EXISTS idx_saved_searches_tenant ON saved_searches(tenant_id);
