-- Migration 0037: separate "inactive draft" from "deleted" on connectors
--
-- Prior to this migration, DELETE /api/connectors/:id set active = 0 to
-- soft-delete a connector. That collided with the draft workflow — a user
-- who clicked "Save as Draft" in the wizard also ended up with active = 0,
-- making their draft indistinguishable from a tombstoned record in the
-- list endpoint. This migration adds a dedicated `deleted_at` column so
-- the two states can be tracked independently:
--
--   active = 0 + deleted_at IS NULL     -> Draft (shows in list with a chip)
--   active = 1 + deleted_at IS NULL     -> Active (shows in list normally)
--   deleted_at IS NOT NULL              -> Deleted (hidden from list)
--
-- Nullable ISO-8601 timestamp. Existing rows all default to NULL so the
-- historical soft-deleted (active = 0) rows will appear as drafts in the
-- new list UI. Users can clean those up by hitting Delete again, which the
-- updated handler will now stamp deleted_at on.

ALTER TABLE connectors ADD COLUMN deleted_at TEXT;

CREATE INDEX IF NOT EXISTS idx_connectors_deleted_at ON connectors(deleted_at);
