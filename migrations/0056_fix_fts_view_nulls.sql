-- Migration 0056: Fix NULL-propagation hazards in documents_fts_source.
--
-- Phase 1 (migration 0054) shipped the FTS5 backbone. Two columns in
-- the source view used unwrapped `||` concatenations:
--
--   supplier_text:
--     COALESCE(
--       s.name || ' ' || REPLACE(REPLACE(REPLACE(COALESCE(s.aliases,''),...))),
--       '')
--   document_type_text:
--     COALESCE(dt.name || ' ' || dt.slug, '')
--
-- SQLite's `||` is NULL-propagating: `'foo' || NULL` is NULL. The
-- OUTER COALESCE in each expression does turn that into '' for the
-- LEFT-JOIN-miss case (no supplier / no doc_type), but it is also a
-- silent-data-loss landmine: if `s.name` is NOT NULL but `s.aliases`
-- or any future-added concat-piece is NULL, OR if `dt.name` or
-- `dt.slug` is ever NULL (today both are NOT NULL by schema, but
-- nothing prevents a future `ALTER TABLE` from relaxing that), the
-- entire indexed text for that column collapses to '' and the
-- doctype/supplier name disappears from search. The bug is dormant
-- in current data because of NOT NULL constraints, but the failure
-- mode is silent (no error, no log line — just missing search hits)
-- so we eliminate it now rather than wait for it to bite.
--
-- This migration:
--   1. DROPs and re-CREATEs `documents_fts_source` with COALESCE
--      wrapped around every individual column reference inside every
--      concatenation, so NULL on one piece can't propagate up.
--   2. Re-backfills `documents_fts` from the corrected view to refresh
--      any rows whose computed text was previously '' due to the
--      old NULL-prop behavior.
--
-- Side effects:
--   - Triggers on documents / document_versions / document_products
--     refer to `documents_fts_source` by name and pick up the new
--     definition automatically. No trigger DDL needed.
--   - `documents_fts_map` rowids are preserved (only the FTS rows
--     are rebuilt; the map is not touched).

DROP VIEW IF EXISTS documents_fts_source;

CREATE VIEW documents_fts_source AS
SELECT
  d.id                              AS doc_id,
  d.tenant_id                       AS tenant_id,
  COALESCE(d.title, '')             AS title,
  COALESCE(d.description, '')       AS description,
  COALESCE(d.tags, '[]')            AS tags_text,
  COALESCE(dv.file_name, '')        AS file_name,
  COALESCE(substr(dv.extracted_text, 1, 200000), '')
                                    AS extracted_text,
  COALESCE(d.primary_metadata, '')  AS primary_metadata_text,
  COALESCE(d.extended_metadata, '') AS extended_metadata_text,
  -- Each piece COALESCE'd individually so a NULL on one side cannot
  -- collapse the whole concat. Trailing/leading spaces are harmless
  -- to the tokenizer.
  (
    COALESCE(s.name, '') || ' ' ||
    REPLACE(REPLACE(REPLACE(COALESCE(s.aliases, ''), '[', ''), ']', ''), '"', '')
  )                                 AS supplier_text,
  (COALESCE(dt.name, '') || ' ' || COALESCE(dt.slug, ''))
                                    AS document_type_text,
  COALESCE(
    (SELECT GROUP_CONCAT(COALESCE(p.name, ''), ' ')
       FROM document_products dp
       JOIN products p ON p.id = dp.product_id
      WHERE dp.document_id = d.id),
    ''
  )                                 AS product_text
FROM documents d
LEFT JOIN suppliers s
       ON s.id = d.supplier_id
LEFT JOIN document_types dt
       ON dt.id = d.document_type_id
LEFT JOIN document_versions dv
       ON dv.document_id = d.id
      AND dv.version_number = (
            SELECT MAX(version_number)
              FROM document_versions
             WHERE document_id = d.id);

-- Re-backfill documents_fts so any rows previously written with
-- collapsed-to-'' supplier_text or document_type_text get refreshed.
DELETE FROM documents_fts;

INSERT INTO documents_fts (
  rowid, title, description, tags_text, file_name,
  extracted_text, primary_metadata_text, extended_metadata_text,
  supplier_text, document_type_text, product_text,
  doc_id, tenant_id
)
SELECT
  m.rowid,
  src.title, src.description, src.tags_text, src.file_name,
  src.extracted_text, src.primary_metadata_text, src.extended_metadata_text,
  src.supplier_text, src.document_type_text, src.product_text,
  src.doc_id, src.tenant_id
FROM documents_fts_source src
JOIN documents_fts_map m ON m.doc_id = src.doc_id;
