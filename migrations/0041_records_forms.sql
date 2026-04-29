-- Migration 0041: Records forms — public-link intake forms
--
-- Adds two tables for Phase 2 Slice 1 of the Records module: per-sheet
-- form configurations (`records_forms`) and a submission log
-- (`records_form_submissions`). Forms derive 1:1 from the column
-- schema — no separate field designer — and can be exposed via a
-- random `public_slug` so anyone (no auth) can submit a row through a
-- Typeform-feel public URL at /f/<slug>.
--
-- Conventions follow 0040: TEXT primary keys via lower(hex(randomblob(8))),
-- tenant_id denormalized everywhere, TEXT timestamps via datetime('now'),
-- archived flag, idx_<table>_<cols> index naming, ON DELETE CASCADE on
-- tenant-scoped child rows.

-- The form. One sheet may have several forms (e.g., "Quick intake" vs
-- "Full COA upload"). field_config is an ordered JSON array of
-- {column_id, required, label_override, help_text, position} — columns
-- not present in the array are hidden from the form. settings holds
-- presentation knobs (thank-you message, redirect URL, accent color,
-- logo URL).
CREATE TABLE IF NOT EXISTS records_forms (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  sheet_id TEXT NOT NULL REFERENCES records_sheets(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  public_slug TEXT,
  is_public INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','live','archived')),
  field_config TEXT,
  settings TEXT,
  archived INTEGER DEFAULT 0,
  created_by_user_id TEXT REFERENCES users(id),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_records_forms_tenant_sheet ON records_forms(tenant_id, sheet_id);
-- Unique partial index so multiple internal-only forms can coexist
-- (NULL slug rows aren't constrained), but live public slugs must be
-- globally unique.
CREATE UNIQUE INDEX IF NOT EXISTS idx_records_forms_slug_unique ON records_forms(public_slug) WHERE public_slug IS NOT NULL;

-- Submission log. Each public-form POST creates one row in records_rows
-- (the canonical record) AND one row here (the audit/metadata trail).
-- submitter_metadata captures IP/UA/optional submitter email — kept as
-- JSON so we can extend without another migration.
CREATE TABLE IF NOT EXISTS records_form_submissions (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  form_id TEXT NOT NULL REFERENCES records_forms(id) ON DELETE CASCADE,
  sheet_id TEXT NOT NULL REFERENCES records_sheets(id) ON DELETE CASCADE,
  row_id TEXT NOT NULL REFERENCES records_rows(id) ON DELETE CASCADE,
  submitter_metadata TEXT,
  turnstile_verified INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_records_form_submissions_form ON records_form_submissions(tenant_id, form_id, created_at);
CREATE INDEX IF NOT EXISTS idx_records_form_submissions_sheet ON records_form_submissions(tenant_id, sheet_id, created_at);
