-- Migration 0079: registry fields in documents_fts.
--
-- =====================================================================
--  REQUIRED REINDEX AFTER APPLYING THIS MIGRATION
-- =====================================================================
-- This migration's inline backfill (§ 6) rebuilds every documents_fts row
-- from the new source view, so on the DB where the migration runs the four
-- new columns are populated for all existing docs. As with 0074, any future
-- reindex draining through documents_fts_source stays consistent because the
-- view now carries the new expressions. If you rebuild the index out-of-band,
-- run a full tenant reindex via POST /api/admin/search/reindex.
-- =====================================================================
--
-- GOAL
-- ----
-- Make IDP Document Registry fields searchable in documents_fts:
--   - the doc's FULL set of categories (multi-category via 0076's
--     document_categories junction, not just the single document_type_id),
--   - the NL-retrieval aliases (0077 documents.aliases),
--   - regulatory criteria (0077 documents.criteria),
--   - facility scope applies_to (0077 documents.applies_to).
--
-- FTS5 cannot ALTER TABLE ADD COLUMN, so — exactly as 0074 did for lot_text —
-- we DROP and recreate documents_fts with FOUR new columns appended LAST,
-- recreate the source view, recreate every doc-emitting trigger (they
-- enumerate the full column list), ADD document_categories triggers so a
-- doc's category_text refreshes when its category links change, and backfill.
-- Keeping the new columns LAST preserves existing column indexes (used by
-- snippet() calls in the search handlers), so nothing before lot_text shifts.
--
-- New column order (documents_fts):
--   0: title
--   1: description
--   2: tags_text
--   3: file_name
--   4: extracted_text
--   5: primary_metadata_text
--   6: extended_metadata_text
--   7: supplier_text
--   8: document_type_text
--   9: product_text
--  10: lot_text
--  11: category_text     <-- NEW (all categories via document_categories)
--  12: aliases_text      <-- NEW (documents.aliases, JSON-flattened)
--  13: criteria_text     <-- NEW (documents.criteria, JSON-flattened)
--  14: applies_to_text   <-- NEW (documents.applies_to, JSON-flattened)
--  + UNINDEXED doc_id, tenant_id
--
-- The documents_fts_map table (TEXT id -> INTEGER rowid) is NOT touched — we
-- preserve existing rowids so doc identity is stable across the rebuild.

------------------------------------------------------------
-- 1. Drop the FTS table + source view (preserve the map).
------------------------------------------------------------

DROP TRIGGER IF EXISTS trg_documents_ai_fts;
DROP TRIGGER IF EXISTS trg_documents_au_fts;
DROP TRIGGER IF EXISTS trg_documents_ad_fts;
DROP TRIGGER IF EXISTS trg_document_versions_ai_fts;
DROP TRIGGER IF EXISTS trg_document_versions_au_fts;
DROP TRIGGER IF EXISTS trg_document_products_ai_fts;
DROP TRIGGER IF EXISTS trg_document_products_ad_fts;
DROP TRIGGER IF EXISTS trg_document_lots_ai_fts;
DROP TRIGGER IF EXISTS trg_document_lots_ad_fts;
DROP TRIGGER IF EXISTS trg_lots_au_fts;
DROP TRIGGER IF EXISTS trg_document_categories_ai_fts;
DROP TRIGGER IF EXISTS trg_document_categories_ad_fts;

DROP VIEW IF EXISTS documents_fts_source;
DROP TABLE IF EXISTS documents_fts;

------------------------------------------------------------
-- 2. Recreate documents_fts with the four registry columns.
------------------------------------------------------------

CREATE VIRTUAL TABLE documents_fts USING fts5(
  title,
  description,
  tags_text,
  file_name,
  extracted_text,
  primary_metadata_text,
  extended_metadata_text,
  supplier_text,
  document_type_text,
  product_text,
  lot_text,
  category_text,
  aliases_text,
  criteria_text,
  applies_to_text,
  doc_id     UNINDEXED,
  tenant_id  UNINDEXED,
  tokenize = "unicode61 remove_diacritics 2 tokenchars '-_/.'"
);

------------------------------------------------------------
-- 3. Recreate documents_fts_source with the new expressions.
------------------------------------------------------------
--
-- category_text: GROUP_CONCAT of the doc's category doctype NAMES via the
--   document_categories junction (0076) joined to document_types. Mirrors the
--   product_text correlated subquery below. Covers ALL categories, not just
--   the single denormalized document_type_id.
-- aliases_text / criteria_text / applies_to_text: flatten the JSON array
--   columns (0077) by stripping the '[' ']' '"' structural chars, exactly as
--   supplier_text flattens suppliers.aliases. Commas remain and act as token
--   separators (they are not in the tokenizer's tokenchars).
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
  )                                 AS product_text,
  COALESCE(
    (SELECT GROUP_CONCAT(
              COALESCE(l.lot_number, '') || ' ' ||
              REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
                UPPER(COALESCE(l.lot_number, '')),
                '-', ''), ' ', ''), '.', ''), '/', ''), '_', '') || ' ' ||
              COALESCE(l.sub_lot_code, '') || ' ' ||
              COALESCE(l.lot_key, ''),
              ' ')
       FROM document_lots dl
       JOIN lots l ON l.id = dl.lot_id
      WHERE dl.document_id = d.id),
    ''
  )                                 AS lot_text,
  COALESCE(
    (SELECT GROUP_CONCAT(COALESCE(dct.name, ''), ' ')
       FROM document_categories dc
       JOIN document_types dct ON dct.id = dc.document_type_id
      WHERE dc.document_id = d.id),
    ''
  )                                 AS category_text,
  REPLACE(REPLACE(REPLACE(COALESCE(d.aliases, ''), '[', ''), ']', ''), '"', '')
                                    AS aliases_text,
  REPLACE(REPLACE(REPLACE(COALESCE(d.criteria, ''), '[', ''), ']', ''), '"', '')
                                    AS criteria_text,
  REPLACE(REPLACE(REPLACE(COALESCE(d.applies_to, ''), '[', ''), ']', ''), '"', '')
                                    AS applies_to_text
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

------------------------------------------------------------
-- 4. Recreate the doc-emitting triggers with the new columns.
------------------------------------------------------------

CREATE TRIGGER trg_documents_ai_fts
AFTER INSERT ON documents
BEGIN
  INSERT OR IGNORE INTO documents_fts_map (doc_id) VALUES (NEW.id);

  INSERT INTO documents_fts (
    rowid, title, description, tags_text, file_name,
    extracted_text, primary_metadata_text, extended_metadata_text,
    supplier_text, document_type_text, product_text, lot_text,
    category_text, aliases_text, criteria_text, applies_to_text,
    doc_id, tenant_id
  )
  SELECT
    m.rowid,
    src.title, src.description, src.tags_text, src.file_name,
    src.extracted_text, src.primary_metadata_text, src.extended_metadata_text,
    src.supplier_text, src.document_type_text, src.product_text, src.lot_text,
    src.category_text, src.aliases_text, src.criteria_text, src.applies_to_text,
    src.doc_id, src.tenant_id
  FROM documents_fts_source src
  JOIN documents_fts_map m ON m.doc_id = src.doc_id
  WHERE src.doc_id = NEW.id;
END;

CREATE TRIGGER trg_documents_au_fts
AFTER UPDATE ON documents
BEGIN
  DELETE FROM documents_fts
   WHERE rowid = (SELECT rowid FROM documents_fts_map WHERE doc_id = NEW.id);

  INSERT INTO documents_fts (
    rowid, title, description, tags_text, file_name,
    extracted_text, primary_metadata_text, extended_metadata_text,
    supplier_text, document_type_text, product_text, lot_text,
    category_text, aliases_text, criteria_text, applies_to_text,
    doc_id, tenant_id
  )
  SELECT
    m.rowid,
    src.title, src.description, src.tags_text, src.file_name,
    src.extracted_text, src.primary_metadata_text, src.extended_metadata_text,
    src.supplier_text, src.document_type_text, src.product_text, src.lot_text,
    src.category_text, src.aliases_text, src.criteria_text, src.applies_to_text,
    src.doc_id, src.tenant_id
  FROM documents_fts_source src
  JOIN documents_fts_map m ON m.doc_id = src.doc_id
  WHERE src.doc_id = NEW.id;
END;

CREATE TRIGGER trg_documents_ad_fts
AFTER DELETE ON documents
BEGIN
  DELETE FROM documents_fts
   WHERE rowid = (SELECT rowid FROM documents_fts_map WHERE doc_id = OLD.id);
  DELETE FROM documents_fts_map WHERE doc_id = OLD.id;
END;

CREATE TRIGGER trg_document_versions_ai_fts
AFTER INSERT ON document_versions
BEGIN
  DELETE FROM documents_fts
   WHERE rowid = (SELECT rowid FROM documents_fts_map WHERE doc_id = NEW.document_id);

  INSERT INTO documents_fts (
    rowid, title, description, tags_text, file_name,
    extracted_text, primary_metadata_text, extended_metadata_text,
    supplier_text, document_type_text, product_text, lot_text,
    category_text, aliases_text, criteria_text, applies_to_text,
    doc_id, tenant_id
  )
  SELECT
    m.rowid,
    src.title, src.description, src.tags_text, src.file_name,
    src.extracted_text, src.primary_metadata_text, src.extended_metadata_text,
    src.supplier_text, src.document_type_text, src.product_text, src.lot_text,
    src.category_text, src.aliases_text, src.criteria_text, src.applies_to_text,
    src.doc_id, src.tenant_id
  FROM documents_fts_source src
  JOIN documents_fts_map m ON m.doc_id = src.doc_id
  WHERE src.doc_id = NEW.document_id;
END;

CREATE TRIGGER trg_document_versions_au_fts
AFTER UPDATE OF extracted_text, file_name, version_number ON document_versions
BEGIN
  DELETE FROM documents_fts
   WHERE rowid = (SELECT rowid FROM documents_fts_map WHERE doc_id = NEW.document_id);

  INSERT INTO documents_fts (
    rowid, title, description, tags_text, file_name,
    extracted_text, primary_metadata_text, extended_metadata_text,
    supplier_text, document_type_text, product_text, lot_text,
    category_text, aliases_text, criteria_text, applies_to_text,
    doc_id, tenant_id
  )
  SELECT
    m.rowid,
    src.title, src.description, src.tags_text, src.file_name,
    src.extracted_text, src.primary_metadata_text, src.extended_metadata_text,
    src.supplier_text, src.document_type_text, src.product_text, src.lot_text,
    src.category_text, src.aliases_text, src.criteria_text, src.applies_to_text,
    src.doc_id, src.tenant_id
  FROM documents_fts_source src
  JOIN documents_fts_map m ON m.doc_id = src.doc_id
  WHERE src.doc_id = NEW.document_id;
END;

CREATE TRIGGER trg_document_products_ai_fts
AFTER INSERT ON document_products
BEGIN
  DELETE FROM documents_fts
   WHERE rowid = (SELECT rowid FROM documents_fts_map WHERE doc_id = NEW.document_id);

  INSERT INTO documents_fts (
    rowid, title, description, tags_text, file_name,
    extracted_text, primary_metadata_text, extended_metadata_text,
    supplier_text, document_type_text, product_text, lot_text,
    category_text, aliases_text, criteria_text, applies_to_text,
    doc_id, tenant_id
  )
  SELECT
    m.rowid,
    src.title, src.description, src.tags_text, src.file_name,
    src.extracted_text, src.primary_metadata_text, src.extended_metadata_text,
    src.supplier_text, src.document_type_text, src.product_text, src.lot_text,
    src.category_text, src.aliases_text, src.criteria_text, src.applies_to_text,
    src.doc_id, src.tenant_id
  FROM documents_fts_source src
  JOIN documents_fts_map m ON m.doc_id = src.doc_id
  WHERE src.doc_id = NEW.document_id;
END;

CREATE TRIGGER trg_document_products_ad_fts
AFTER DELETE ON document_products
BEGIN
  DELETE FROM documents_fts
   WHERE rowid = (SELECT rowid FROM documents_fts_map WHERE doc_id = OLD.document_id);

  INSERT INTO documents_fts (
    rowid, title, description, tags_text, file_name,
    extracted_text, primary_metadata_text, extended_metadata_text,
    supplier_text, document_type_text, product_text, lot_text,
    category_text, aliases_text, criteria_text, applies_to_text,
    doc_id, tenant_id
  )
  SELECT
    m.rowid,
    src.title, src.description, src.tags_text, src.file_name,
    src.extracted_text, src.primary_metadata_text, src.extended_metadata_text,
    src.supplier_text, src.document_type_text, src.product_text, src.lot_text,
    src.category_text, src.aliases_text, src.criteria_text, src.applies_to_text,
    src.doc_id, src.tenant_id
  FROM documents_fts_source src
  JOIN documents_fts_map m ON m.doc_id = src.doc_id
  WHERE src.doc_id = OLD.document_id;
END;

------------------------------------------------------------
-- 5a. Recreate the lot-refresh triggers (from 0074).
------------------------------------------------------------

CREATE TRIGGER trg_document_lots_ai_fts
AFTER INSERT ON document_lots
BEGIN
  DELETE FROM documents_fts
   WHERE rowid = (SELECT rowid FROM documents_fts_map WHERE doc_id = NEW.document_id);

  INSERT INTO documents_fts (
    rowid, title, description, tags_text, file_name,
    extracted_text, primary_metadata_text, extended_metadata_text,
    supplier_text, document_type_text, product_text, lot_text,
    category_text, aliases_text, criteria_text, applies_to_text,
    doc_id, tenant_id
  )
  SELECT
    m.rowid,
    src.title, src.description, src.tags_text, src.file_name,
    src.extracted_text, src.primary_metadata_text, src.extended_metadata_text,
    src.supplier_text, src.document_type_text, src.product_text, src.lot_text,
    src.category_text, src.aliases_text, src.criteria_text, src.applies_to_text,
    src.doc_id, src.tenant_id
  FROM documents_fts_source src
  JOIN documents_fts_map m ON m.doc_id = src.doc_id
  WHERE src.doc_id = NEW.document_id;
END;

CREATE TRIGGER trg_document_lots_ad_fts
AFTER DELETE ON document_lots
BEGIN
  DELETE FROM documents_fts
   WHERE rowid = (SELECT rowid FROM documents_fts_map WHERE doc_id = OLD.document_id);

  INSERT INTO documents_fts (
    rowid, title, description, tags_text, file_name,
    extracted_text, primary_metadata_text, extended_metadata_text,
    supplier_text, document_type_text, product_text, lot_text,
    category_text, aliases_text, criteria_text, applies_to_text,
    doc_id, tenant_id
  )
  SELECT
    m.rowid,
    src.title, src.description, src.tags_text, src.file_name,
    src.extracted_text, src.primary_metadata_text, src.extended_metadata_text,
    src.supplier_text, src.document_type_text, src.product_text, src.lot_text,
    src.category_text, src.aliases_text, src.criteria_text, src.applies_to_text,
    src.doc_id, src.tenant_id
  FROM documents_fts_source src
  JOIN documents_fts_map m ON m.doc_id = src.doc_id
  WHERE src.doc_id = OLD.document_id;
END;

CREATE TRIGGER trg_lots_au_fts
AFTER UPDATE OF lot_number, sub_lot_code, lot_key ON lots
BEGIN
  DELETE FROM documents_fts
   WHERE rowid IN (
     SELECT m.rowid
       FROM documents_fts_map m
       JOIN document_lots dl ON dl.document_id = m.doc_id
      WHERE dl.lot_id = NEW.id
   );

  INSERT INTO documents_fts (
    rowid, title, description, tags_text, file_name,
    extracted_text, primary_metadata_text, extended_metadata_text,
    supplier_text, document_type_text, product_text, lot_text,
    category_text, aliases_text, criteria_text, applies_to_text,
    doc_id, tenant_id
  )
  SELECT
    m.rowid,
    src.title, src.description, src.tags_text, src.file_name,
    src.extracted_text, src.primary_metadata_text, src.extended_metadata_text,
    src.supplier_text, src.document_type_text, src.product_text, src.lot_text,
    src.category_text, src.aliases_text, src.criteria_text, src.applies_to_text,
    src.doc_id, src.tenant_id
  FROM documents_fts_source src
  JOIN documents_fts_map m ON m.doc_id = src.doc_id
  WHERE src.doc_id IN (
    SELECT dl.document_id FROM document_lots dl WHERE dl.lot_id = NEW.id
  );
END;

------------------------------------------------------------
-- 5b. NEW triggers — document_categories refresh category_text.
------------------------------------------------------------
--
-- Category links live in document_categories, written after the document row
-- exists. The documents/versions/products/lots triggers never re-fire for a
-- fresh category link, so category_text would stay stale. These close that
-- gap: any INSERT/DELETE on document_categories re-emits the affected doc.
-- Same DELETE-then-INSERT-from-source pattern as trg_document_products_*.
-- (On document delete the FK cascade removes these rows; the re-emit then
-- finds no source row and is a harmless no-op, matching document_products.)

CREATE TRIGGER trg_document_categories_ai_fts
AFTER INSERT ON document_categories
BEGIN
  DELETE FROM documents_fts
   WHERE rowid = (SELECT rowid FROM documents_fts_map WHERE doc_id = NEW.document_id);

  INSERT INTO documents_fts (
    rowid, title, description, tags_text, file_name,
    extracted_text, primary_metadata_text, extended_metadata_text,
    supplier_text, document_type_text, product_text, lot_text,
    category_text, aliases_text, criteria_text, applies_to_text,
    doc_id, tenant_id
  )
  SELECT
    m.rowid,
    src.title, src.description, src.tags_text, src.file_name,
    src.extracted_text, src.primary_metadata_text, src.extended_metadata_text,
    src.supplier_text, src.document_type_text, src.product_text, src.lot_text,
    src.category_text, src.aliases_text, src.criteria_text, src.applies_to_text,
    src.doc_id, src.tenant_id
  FROM documents_fts_source src
  JOIN documents_fts_map m ON m.doc_id = src.doc_id
  WHERE src.doc_id = NEW.document_id;
END;

CREATE TRIGGER trg_document_categories_ad_fts
AFTER DELETE ON document_categories
BEGIN
  DELETE FROM documents_fts
   WHERE rowid = (SELECT rowid FROM documents_fts_map WHERE doc_id = OLD.document_id);

  INSERT INTO documents_fts (
    rowid, title, description, tags_text, file_name,
    extracted_text, primary_metadata_text, extended_metadata_text,
    supplier_text, document_type_text, product_text, lot_text,
    category_text, aliases_text, criteria_text, applies_to_text,
    doc_id, tenant_id
  )
  SELECT
    m.rowid,
    src.title, src.description, src.tags_text, src.file_name,
    src.extracted_text, src.primary_metadata_text, src.extended_metadata_text,
    src.supplier_text, src.document_type_text, src.product_text, src.lot_text,
    src.category_text, src.aliases_text, src.criteria_text, src.applies_to_text,
    src.doc_id, src.tenant_id
  FROM documents_fts_source src
  JOIN documents_fts_map m ON m.doc_id = src.doc_id
  WHERE src.doc_id = OLD.document_id;
END;

------------------------------------------------------------
-- 6. Backfill documents_fts from the rebuilt source view.
------------------------------------------------------------
--
-- The DROP TABLE in § 1 cleared all rows; rebuild every row (new columns
-- included) from the new view. Map rowids are unchanged, so doc identity is
-- preserved.

INSERT OR IGNORE INTO documents_fts_map (doc_id)
SELECT id FROM documents ORDER BY created_at, id;

INSERT INTO documents_fts (
  rowid, title, description, tags_text, file_name,
  extracted_text, primary_metadata_text, extended_metadata_text,
  supplier_text, document_type_text, product_text, lot_text,
  category_text, aliases_text, criteria_text, applies_to_text,
  doc_id, tenant_id
)
SELECT
  m.rowid,
  src.title, src.description, src.tags_text, src.file_name,
  src.extracted_text, src.primary_metadata_text, src.extended_metadata_text,
  src.supplier_text, src.document_type_text, src.product_text, src.lot_text,
  src.category_text, src.aliases_text, src.criteria_text, src.applies_to_text,
  src.doc_id, src.tenant_id
FROM documents_fts_source src
JOIN documents_fts_map m ON m.doc_id = src.doc_id;
