-- Migration 0043: Public form attachments (Phase 2 Slice 2)
--
-- Wires upload-as-you-go file/photo attachments into the public Records
-- intake form. Attachments stream straight to R2 from the browser as
-- soon as the user picks them, get a "pending" row in
-- records_row_attachments (row_id NULL, pending_token set), and at
-- submit time the row is created and the pending attachments are linked
-- to it (row_id set, pending_token cleared).
--
-- The 0040 schema declared row_id NOT NULL, which is now too tight
-- because we need to create the attachment row before the records_rows
-- row exists. SQLite can't drop NOT NULL on an existing column, so we
-- table-rebuild records_row_attachments (the canonical "alter column"
-- pattern in this project — see 0017 for prior art).
--
-- New columns added during the rebuild:
--   pending_token       TEXT NULL  -- set on creation, cleared on link
--   pending_expires_at  TEXT NULL  -- ISO timestamp; NULL once linked
--   form_id             TEXT NULL  -- which form created it (NULL for
--                                     non-form attachments, e.g. drawer
--                                     uploads added later)
--
-- A partial index on pending_token supports the future GC sweeper
-- (a TODO in this slice — see PublicFormRenderer + the upload handler).
--
-- The 0041 records_forms.settings JSON gains four new optional keys
-- understood by the renderer + upload endpoint:
--   allow_attachments       boolean (default false)
--   max_attachments         integer (default 5)
--   max_file_size_mb        integer (default 10)
--   allowed_mime_types      string[] (default ["image/*","application/pdf"])
-- No SQL change required for those — settings is already TEXT JSON.

-- Disable FK enforcement for the rebuild so children pointing at
-- records_row_attachments (none today, but defensive) don't trip.
PRAGMA foreign_keys = OFF;

-- Stage the new shape. Mirrors 0040's columns + the three new ones, with
-- row_id relaxed to NULL.
CREATE TABLE IF NOT EXISTS records_row_attachments_new (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  row_id TEXT REFERENCES records_rows(id) ON DELETE CASCADE,
  column_key TEXT,
  r2_key TEXT NOT NULL,
  file_name TEXT NOT NULL,
  file_size INTEGER,
  mime_type TEXT,
  checksum TEXT,
  uploaded_by TEXT REFERENCES users(id),
  created_at TEXT DEFAULT (datetime('now')),
  pending_token TEXT,
  pending_expires_at TEXT,
  form_id TEXT REFERENCES records_forms(id) ON DELETE SET NULL
);

-- Copy existing rows. All current rows are linked (row_id IS NOT NULL)
-- and have no pending state.
INSERT INTO records_row_attachments_new
  (id, tenant_id, row_id, column_key, r2_key, file_name, file_size, mime_type, checksum, uploaded_by, created_at)
SELECT id, tenant_id, row_id, column_key, r2_key, file_name, file_size, mime_type, checksum, uploaded_by, created_at
FROM records_row_attachments;

DROP TABLE records_row_attachments;
ALTER TABLE records_row_attachments_new RENAME TO records_row_attachments;

-- Recreate the indexes from 0040 (table rebuild drops them).
CREATE INDEX IF NOT EXISTS idx_records_row_attachments_row ON records_row_attachments(row_id);
CREATE INDEX IF NOT EXISTS idx_records_row_attachments_tenant ON records_row_attachments(tenant_id);

-- Sweeper-friendly partial index: only pending rows are indexed, and the
-- expires_at column lets the GC scan find expired pending uploads with a
-- bounded query.
CREATE INDEX IF NOT EXISTS idx_records_row_attachments_pending
  ON records_row_attachments(pending_expires_at)
  WHERE pending_token IS NOT NULL;

-- Per-form scan support for the submit-time link step (look up all
-- pending attachments for this form in one query when needed).
CREATE INDEX IF NOT EXISTS idx_records_row_attachments_form
  ON records_row_attachments(form_id)
  WHERE form_id IS NOT NULL;

PRAGMA foreign_keys = ON;
