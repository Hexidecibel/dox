-- Migration 0044: Records update requests (Phase 2 Slice 2)
--
-- Adds the records_update_requests table — Smartsheet's "Send update
-- request" flow ported into dox. A user opens a row drawer, picks a
-- recipient + a subset of columns to fill, and the server mints a
-- single-use unguessable token. The recipient lands on /u/<token>,
-- sees a Typeform-feel form pre-filled with the row's current values
-- for ONLY the requested fields, fills them in, and submits. The row
-- updates and the original sender sees a "filled out N fields" entry
-- in the row's activity feed.
--
-- This is a separate entity from records_forms (0041): forms are
-- 1-to-many anonymous intake; update requests are 1-to-1 targeted
-- collaboration with row + field scope baked into the link.
--
-- Conventions follow 0040/0041/0043:
--   - TEXT primary keys via lower(hex(randomblob(8))) at the API layer
--     (we use generateId() in the handler — same as records_forms).
--   - tenant_id denormalized for fast scoping.
--   - status is a CHECKed enum so a typo can't put a row in limbo.
--   - ON DELETE CASCADE on sheet_id + row_id so archiving cleanly
--     drops the open requests.

CREATE TABLE IF NOT EXISTS records_update_requests (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  sheet_id TEXT NOT NULL,
  row_id TEXT NOT NULL,
  -- URL-safe random token, generated server-side, 24+ chars. The token
  -- IS the auth gate for the public form; treat it like a session id.
  token TEXT NOT NULL UNIQUE,
  recipient_email TEXT NOT NULL,
  -- Resolved at create time when the recipient happens to be a known
  -- user; otherwise NULL (most external recipients).
  recipient_user_id TEXT NULL,
  -- JSON array of column_keys (NOT column ids) the recipient is asked
  -- to fill. Keys are immutable; column ids could theoretically rotate.
  fields_requested TEXT NOT NULL,
  -- Optional context message from the requester, rendered on the form.
  message TEXT NULL,
  -- Optional ISO date the requester wants the response by. Surfaced on
  -- the form; not enforced server-side (we don't auto-expire on it).
  due_date TEXT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','responded','expired','cancelled')) DEFAULT 'pending',
  responded_at TEXT NULL,
  -- Optional hard expiry. Defaults to ~30 days at the API layer; NULL
  -- means "no expiry". The public GET enforces this.
  expires_at TEXT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by_user_id TEXT NOT NULL,
  FOREIGN KEY (sheet_id) REFERENCES records_sheets(id) ON DELETE CASCADE,
  FOREIGN KEY (row_id) REFERENCES records_rows(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_records_update_requests_tenant_sheet
  ON records_update_requests(tenant_id, sheet_id);
CREATE INDEX IF NOT EXISTS idx_records_update_requests_token
  ON records_update_requests(token);
CREATE INDEX IF NOT EXISTS idx_records_update_requests_recipient
  ON records_update_requests(recipient_email, status);
-- Per-row "pending requests" lookup for the drawer.
CREATE INDEX IF NOT EXISTS idx_records_update_requests_row_status
  ON records_update_requests(row_id, status);
