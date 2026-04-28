-- Migration 0040: Records core schema
--
-- Foundational tables for the Records module: the Smartsheet-class
-- collaborative surface where each row is a typed Record with its own
-- drawer, comments, activity feed, and attachments. Columns can be
-- typed `supplier_ref` / `product_ref` / `document_ref` / `contact`
-- to natively reference real dox entities.
--
-- This migration covers Phase 1 primitives only:
--   sheets, columns, rows, row_refs, attachments, comments, activity,
--   and saved views. Forms, form submissions, update requests,
--   workflows, workflow runs, workflow actions, and automations are
--   deferred to a later migration (they are introduced in Phases 2/3
--   per plan.md and are not needed for the Phase 1 dogfooding gate).
--
-- All tables follow the project conventions seen in 0010, 0016, 0017,
-- 0022, 0038: TEXT primary keys generated via lower(hex(randomblob(8))),
-- tenant scoping via FK to tenants(id), TEXT timestamps via
-- datetime('now'), index naming idx_<table>_<columns>, and
-- ON DELETE CASCADE for tenant-scoped child rows.

-- The container. One sheet per logical record collection (Quality
-- Intake, New Item Approval, etc). template_key identifies sheets
-- spawned from a built-in template so we can ship template updates.
CREATE TABLE IF NOT EXISTS records_sheets (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  description TEXT,
  icon TEXT,
  color TEXT,
  template_key TEXT,
  archived INTEGER DEFAULT 0,
  created_by TEXT REFERENCES users(id),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(tenant_id, slug)
);

CREATE INDEX IF NOT EXISTS idx_records_sheets_tenant ON records_sheets(tenant_id, archived);
CREATE INDEX IF NOT EXISTS idx_records_sheets_template ON records_sheets(template_key);

-- The schema for a sheet. `key` is the immutable slug used by formulas
-- and automations; `label` is the user-facing display. `config` holds
-- type-specific settings as JSON (dropdown options, ref entity type,
-- formula expression, number format, etc).
CREATE TABLE IF NOT EXISTS records_columns (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  sheet_id TEXT NOT NULL REFERENCES records_sheets(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  key TEXT NOT NULL,
  label TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN (
    'text','long_text','number','currency','percent','date','datetime',
    'duration','checkbox','dropdown_single','dropdown_multi','contact',
    'email','url','phone','attachment','formula','rollup',
    'supplier_ref','product_ref','document_ref','record_ref'
  )),
  config TEXT,
  required INTEGER DEFAULT 0,
  is_title INTEGER DEFAULT 0,
  display_order INTEGER NOT NULL DEFAULT 0,
  width INTEGER,
  archived INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(sheet_id, key)
);

CREATE INDEX IF NOT EXISTS idx_records_columns_sheet ON records_columns(sheet_id, display_order);
CREATE INDEX IF NOT EXISTS idx_records_columns_tenant ON records_columns(tenant_id);

-- The Record itself. `data` is a JSON blob keyed by column.key — the
-- single source of truth for cell values. `position` is REAL for
-- fractional indexing (drag-reorder without renumbering). `parent_row_id`
-- enables hierarchy. `display_title` is denormalized from the column
-- flagged `is_title` so list rendering doesn't have to parse `data`.
CREATE TABLE IF NOT EXISTS records_rows (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  sheet_id TEXT NOT NULL REFERENCES records_sheets(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  display_title TEXT,
  data TEXT,
  position REAL NOT NULL DEFAULT 0,
  parent_row_id TEXT REFERENCES records_rows(id) ON DELETE SET NULL,
  archived INTEGER DEFAULT 0,
  created_by TEXT REFERENCES users(id),
  updated_by TEXT REFERENCES users(id),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_records_rows_tenant_sheet ON records_rows(tenant_id, sheet_id, archived);
CREATE INDEX IF NOT EXISTS idx_records_rows_sheet_position ON records_rows(sheet_id, position);
CREATE INDEX IF NOT EXISTS idx_records_rows_parent ON records_rows(parent_row_id);
CREATE INDEX IF NOT EXISTS idx_records_rows_updated ON records_rows(sheet_id, updated_at);

-- Parallel index on entity-ref column values so we can answer
-- "show all records that reference supplier X" without scanning JSON.
-- Maintained by the API layer on row write. ref_type matches the
-- column type minus `_ref` (supplier, product, document, record), plus
-- `contact` for user references via the `contact` column type.
CREATE TABLE IF NOT EXISTS records_row_refs (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  sheet_id TEXT NOT NULL REFERENCES records_sheets(id) ON DELETE CASCADE,
  row_id TEXT NOT NULL REFERENCES records_rows(id) ON DELETE CASCADE,
  column_key TEXT NOT NULL,
  ref_type TEXT NOT NULL CHECK (ref_type IN ('supplier','product','document','record','contact')),
  ref_id TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_records_row_refs_row ON records_row_refs(row_id);
CREATE INDEX IF NOT EXISTS idx_records_row_refs_supplier ON records_row_refs(tenant_id, ref_type, ref_id) WHERE ref_type = 'supplier';
CREATE INDEX IF NOT EXISTS idx_records_row_refs_product ON records_row_refs(tenant_id, ref_type, ref_id) WHERE ref_type = 'product';
CREATE INDEX IF NOT EXISTS idx_records_row_refs_document ON records_row_refs(tenant_id, ref_type, ref_id) WHERE ref_type = 'document';
CREATE INDEX IF NOT EXISTS idx_records_row_refs_record ON records_row_refs(tenant_id, ref_type, ref_id) WHERE ref_type = 'record';
CREATE INDEX IF NOT EXISTS idx_records_row_refs_contact ON records_row_refs(tenant_id, ref_type, ref_id) WHERE ref_type = 'contact';
CREATE INDEX IF NOT EXISTS idx_records_row_refs_lookup ON records_row_refs(tenant_id, ref_type, ref_id);

-- Row attachments. column_key NULL = drawer-level attachment;
-- non-null = bound to a specific attachment column on the row.
-- Mirrors the document_versions R2 pattern: r2_key + checksum + size.
CREATE TABLE IF NOT EXISTS records_row_attachments (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  row_id TEXT NOT NULL REFERENCES records_rows(id) ON DELETE CASCADE,
  column_key TEXT,
  r2_key TEXT NOT NULL,
  file_name TEXT NOT NULL,
  file_size INTEGER,
  mime_type TEXT,
  checksum TEXT,
  uploaded_by TEXT REFERENCES users(id),
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_records_row_attachments_row ON records_row_attachments(row_id);
CREATE INDEX IF NOT EXISTS idx_records_row_attachments_tenant ON records_row_attachments(tenant_id);

-- Saved views. Each sheet has many views; switching is a viewport
-- change, not a query change. Filter/sort/group state lives in `config`.
-- shared = 0 -> personal (only creator sees), 1 -> visible to anyone
-- with sheet access.
CREATE TABLE IF NOT EXISTS records_views (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  sheet_id TEXT NOT NULL REFERENCES records_sheets(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  name TEXT NOT NULL,
  view_type TEXT NOT NULL CHECK (view_type IN ('grid','kanban','timeline','gallery','calendar')),
  config TEXT,
  is_default INTEGER DEFAULT 0,
  shared INTEGER DEFAULT 1,
  created_by TEXT REFERENCES users(id),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_records_views_sheet ON records_views(sheet_id);
CREATE INDEX IF NOT EXISTS idx_records_views_tenant ON records_views(tenant_id);
CREATE INDEX IF NOT EXISTS idx_records_views_creator ON records_views(created_by);

-- Per-row threaded comments. mentions is a JSON array of user_ids
-- so the notification job can fan out without re-parsing the body.
CREATE TABLE IF NOT EXISTS records_comments (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  row_id TEXT NOT NULL REFERENCES records_rows(id) ON DELETE CASCADE,
  parent_comment_id TEXT REFERENCES records_comments(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  mentions TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  edited_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_records_comments_row ON records_comments(row_id, created_at);
CREATE INDEX IF NOT EXISTS idx_records_comments_parent ON records_comments(parent_comment_id);
CREATE INDEX IF NOT EXISTS idx_records_comments_tenant ON records_comments(tenant_id);

-- Per-row activity feed for the drawer. Denormalized from audit_log
-- (which stays the compliance record) so the drawer feed is a cheap
-- single-table read. `kind` is open-ended and validated in the API.
-- `details` shape varies per kind, e.g. updated -> {column, from, to}.
CREATE TABLE IF NOT EXISTS records_activity (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  sheet_id TEXT NOT NULL REFERENCES records_sheets(id) ON DELETE CASCADE,
  row_id TEXT NOT NULL REFERENCES records_rows(id) ON DELETE CASCADE,
  actor_id TEXT REFERENCES users(id),
  kind TEXT NOT NULL,
  details TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_records_activity_row ON records_activity(row_id, created_at);
CREATE INDEX IF NOT EXISTS idx_records_activity_sheet ON records_activity(sheet_id, created_at);
CREATE INDEX IF NOT EXISTS idx_records_activity_tenant ON records_activity(tenant_id);
CREATE INDEX IF NOT EXISTS idx_records_activity_actor ON records_activity(actor_id);
