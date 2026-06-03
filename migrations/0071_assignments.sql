-- Ownership assignments: who owns the review of a (supplier, document_type)
-- combo within a tenant. Powers a per-owner "Mine" review filter and a
-- notifications feed.
--
-- One owner per (tenant_id, supplier_id, document_type_id) combo. The owner is
-- a single user today (owner_user_id). owner_group_id is a forward-compatible
-- slot for when groups exist — there is NO groups table yet, so it has no FK.
-- SQLite ALTER/CREATE cannot reliably add FKs after the fact; references are
-- conceptual (users(id), suppliers(id), document_types(id)).

CREATE TABLE IF NOT EXISTS assignments (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  supplier_id TEXT NOT NULL,
  document_type_id TEXT NOT NULL,
  owner_user_id TEXT,
  owner_group_id TEXT,
  created_by TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(tenant_id, supplier_id, document_type_id)
);

-- "My assignments" lookups (and the queue ?mine=1 join filter by owner).
CREATE INDEX IF NOT EXISTS idx_assignments_owner
  ON assignments(tenant_id, owner_user_id);

-- Combo lookup / queue join on (supplier_id, document_type_id).
CREATE INDEX IF NOT EXISTS idx_assignments_combo
  ON assignments(tenant_id, supplier_id, document_type_id);
