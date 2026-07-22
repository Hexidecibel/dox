-- Migration 0076: multi-category junction (document_categories).
--
-- Today a document carries a SINGLE category via documents.document_type_id
-- (migration 0012). The IDP Document Registry needs "one doc, many
-- mappings" so a single record can be filed under several document types
-- (e.g. a combined COA + Spec Sheet, or a permit that satisfies multiple
-- regulatory buckets).
--
-- This adds a junction table with an is_primary flag. documents.document_type_id
-- is RETAINED as the denormalized "primary category" pointer (not dropped) so
-- existing readers keep working; the junction is the new source of truth for
-- the full set of categories.

CREATE TABLE IF NOT EXISTS document_categories (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  document_type_id TEXT NOT NULL REFERENCES document_types(id),
  is_primary INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(document_id, document_type_id)
);

CREATE INDEX IF NOT EXISTS idx_document_categories_document ON document_categories(document_id);
CREATE INDEX IF NOT EXISTS idx_document_categories_type ON document_categories(document_type_id);

-- Backfill: every existing document with a primary category becomes one
-- document_categories row flagged is_primary. The UNIQUE(document_id,
-- document_type_id) guard makes this idempotent.
INSERT OR IGNORE INTO document_categories (document_id, document_type_id, is_primary)
SELECT id, document_type_id, 1
  FROM documents
 WHERE document_type_id IS NOT NULL;
