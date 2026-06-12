-- Migration 0074: COA sublot split (Option B) — lot search in documents_fts.
--
-- =====================================================================
--  REQUIRED REINDEX AFTER APPLYING THIS MIGRATION
-- =====================================================================
-- This migration's inline backfill (§ 6) rebuilds every documents_fts row
-- from the new source view, so on the DB where the migration runs the
-- lot_text column is populated for all currently-linked docs. BUT the
-- search-v2 reindex drain is manual (memory: "reindex drain still
-- manual") and any future supplier/product/doctype reindex jobs draining
-- through `functions/lib/search-reindex.ts` re-emit from
-- `documents_fts_source` — which now carries lot_text — so they stay
-- consistent. If you ever rebuild the index out-of-band, run a full
-- tenant reindex via `POST /api/admin/search/reindex` (action
-- "enqueue_and_drain", omit tenant_id for all tenants) to backfill
-- lot_text for existing linked docs.
-- =====================================================================
--
-- PROBLEM
-- -------
-- Today `lot_number` is indexed in `orders_fts.items_text` but NOT in
-- `documents_fts`, so a COA cannot be found by its lot. With per-sublot
-- COAs (migration 0073) each COA doc links — via document_lots → lots —
-- to a `lots` row carrying lot_number + sub_lot_code + combined lot_key
-- (norm(lot_number) + sub_lot_code, e.g. "10426110" + "05" = "1042611005").
--
-- We want:
--   - typing the MAIN lot   "10426110"   → ALL its sublot COAs
--   - typing the combined   "1042611005" → the exact sublot COA
--   - separators irrelevant ("10426110-05", "10426110 05", "1042611005")
--
-- APPROACH
-- --------
-- Add a new indexed column `lot_text` to documents_fts that flattens, per
-- document, the linked lots' identifiers. Mirrors orders_fts.items_text
-- (which GROUP_CONCATs per-item product_name/product_code/lot_number).
--
-- For each linked lot we emit FOUR space-separated tokens:
--   1. lot_number          — raw, as stored (caught by tokenchars '-_/.')
--   2. norm(lot_number)    — uppercased, all separators stripped
--   3. sub_lot_code        — the 2-digit sublot ('' for main-lot-only)
--   4. lot_key             — already normalized; embeds the sublot
--
-- The lot_key is the load-bearing anchor:
--   - Every sublot of main lot "10426110" has a lot_key that STARTS WITH
--     "10426110" ("1042611005", "1042611006", ...). The search endpoint
--     normalizes the user's term the same way (uppercase + strip
--     separators) and prefix-matches, so a main-lot term matches every
--     sublot's lot_key → returns ALL sublot COAs.
--   - The full combined term "1042611005" prefix-matches exactly that
--     one sublot's lot_key.
-- Including norm(lot_number) too makes the bare main lot resolvable even
-- for a main-lot-only ('' sublot) doc whose lot_key == norm(lot_number).
--
-- FTS5 cannot ALTER TABLE ADD COLUMN, so we DROP and recreate
-- documents_fts with the new column, recreate the source view, recreate
-- every doc-emitting trigger (they enumerate the full column list), and
-- ADD triggers so a doc's lot_text refreshes when its document_lots links
-- change (links are written at approve time, AFTER the document row) and
-- when the underlying lots row is updated.
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
--  10: lot_text          <-- NEW (kept LAST so existing column indexes,
--                            used in snippet() calls, are unchanged)
--  + UNINDEXED doc_id, tenant_id
--
-- The documents_fts_map table (TEXT id → INTEGER rowid) is NOT touched —
-- we preserve existing rowids so doc identity is stable across the rebuild.

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

DROP VIEW IF EXISTS documents_fts_source;
DROP TABLE IF EXISTS documents_fts;

------------------------------------------------------------
-- 2. Recreate documents_fts with lot_text appended.
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
  doc_id     UNINDEXED,
  tenant_id  UNINDEXED,
  tokenize = "unicode61 remove_diacritics 2 tokenchars '-_/.'"
);

------------------------------------------------------------
-- 3. Recreate documents_fts_source with the lot_text subquery.
------------------------------------------------------------
--
-- lot_text: GROUP_CONCAT over the doc's linked lots. Each lot contributes
-- raw lot_number, a separator-stripped uppercased lot_number, the
-- sub_lot_code, and the (already-normalized) lot_key. The separator strip
-- mirrors functions/lib/entities/lots.ts#normalizeLotNumber: uppercase,
-- then drop '-', ' ', '.', '/', '_'. (The tokenizer's tokenchars keep the
-- raw form too, so both punctuated and stripped queries resolve.)
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
  )                                 AS lot_text
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
-- 4. Recreate the doc-emitting triggers (documents,
--    document_versions, document_products) with lot_text.
------------------------------------------------------------

CREATE TRIGGER trg_documents_ai_fts
AFTER INSERT ON documents
BEGIN
  INSERT OR IGNORE INTO documents_fts_map (doc_id) VALUES (NEW.id);

  INSERT INTO documents_fts (
    rowid, title, description, tags_text, file_name,
    extracted_text, primary_metadata_text, extended_metadata_text,
    supplier_text, document_type_text, product_text, lot_text,
    doc_id, tenant_id
  )
  SELECT
    m.rowid,
    src.title, src.description, src.tags_text, src.file_name,
    src.extracted_text, src.primary_metadata_text, src.extended_metadata_text,
    src.supplier_text, src.document_type_text, src.product_text, src.lot_text,
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
    doc_id, tenant_id
  )
  SELECT
    m.rowid,
    src.title, src.description, src.tags_text, src.file_name,
    src.extracted_text, src.primary_metadata_text, src.extended_metadata_text,
    src.supplier_text, src.document_type_text, src.product_text, src.lot_text,
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
    doc_id, tenant_id
  )
  SELECT
    m.rowid,
    src.title, src.description, src.tags_text, src.file_name,
    src.extracted_text, src.primary_metadata_text, src.extended_metadata_text,
    src.supplier_text, src.document_type_text, src.product_text, src.lot_text,
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
    doc_id, tenant_id
  )
  SELECT
    m.rowid,
    src.title, src.description, src.tags_text, src.file_name,
    src.extracted_text, src.primary_metadata_text, src.extended_metadata_text,
    src.supplier_text, src.document_type_text, src.product_text, src.lot_text,
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
    doc_id, tenant_id
  )
  SELECT
    m.rowid,
    src.title, src.description, src.tags_text, src.file_name,
    src.extracted_text, src.primary_metadata_text, src.extended_metadata_text,
    src.supplier_text, src.document_type_text, src.product_text, src.lot_text,
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
    doc_id, tenant_id
  )
  SELECT
    m.rowid,
    src.title, src.description, src.tags_text, src.file_name,
    src.extracted_text, src.primary_metadata_text, src.extended_metadata_text,
    src.supplier_text, src.document_type_text, src.product_text, src.lot_text,
    src.doc_id, src.tenant_id
  FROM documents_fts_source src
  JOIN documents_fts_map m ON m.doc_id = src.doc_id
  WHERE src.doc_id = OLD.document_id;
END;

------------------------------------------------------------
-- 5. NEW triggers — document_lots + lots refresh lot_text.
------------------------------------------------------------
--
-- doc↔lot links live in document_lots, written at approve time AFTER the
-- document row already exists. The documents/versions/products triggers
-- above would never re-fire for a fresh link, so lot_text would stay
-- empty until some unrelated doc UPDATE. These triggers close that gap:
-- any INSERT/DELETE on document_lots re-emits the affected doc, and any
-- UPDATE of a lot's searchable identifiers re-emits every doc linked to
-- it.
--
-- All four re-emit via the same DELETE-then-INSERT-from-source pattern as
-- the doc triggers. The map row already exists (the document was inserted
-- first), so we re-use its rowid.

-- A doc gains a lot link → refresh that doc.
CREATE TRIGGER trg_document_lots_ai_fts
AFTER INSERT ON document_lots
BEGIN
  DELETE FROM documents_fts
   WHERE rowid = (SELECT rowid FROM documents_fts_map WHERE doc_id = NEW.document_id);

  INSERT INTO documents_fts (
    rowid, title, description, tags_text, file_name,
    extracted_text, primary_metadata_text, extended_metadata_text,
    supplier_text, document_type_text, product_text, lot_text,
    doc_id, tenant_id
  )
  SELECT
    m.rowid,
    src.title, src.description, src.tags_text, src.file_name,
    src.extracted_text, src.primary_metadata_text, src.extended_metadata_text,
    src.supplier_text, src.document_type_text, src.product_text, src.lot_text,
    src.doc_id, src.tenant_id
  FROM documents_fts_source src
  JOIN documents_fts_map m ON m.doc_id = src.doc_id
  WHERE src.doc_id = NEW.document_id;
END;

-- A doc loses a lot link → refresh that doc.
CREATE TRIGGER trg_document_lots_ad_fts
AFTER DELETE ON document_lots
BEGIN
  DELETE FROM documents_fts
   WHERE rowid = (SELECT rowid FROM documents_fts_map WHERE doc_id = OLD.document_id);

  INSERT INTO documents_fts (
    rowid, title, description, tags_text, file_name,
    extracted_text, primary_metadata_text, extended_metadata_text,
    supplier_text, document_type_text, product_text, lot_text,
    doc_id, tenant_id
  )
  SELECT
    m.rowid,
    src.title, src.description, src.tags_text, src.file_name,
    src.extracted_text, src.primary_metadata_text, src.extended_metadata_text,
    src.supplier_text, src.document_type_text, src.product_text, src.lot_text,
    src.doc_id, src.tenant_id
  FROM documents_fts_source src
  JOIN documents_fts_map m ON m.doc_id = src.doc_id
  WHERE src.doc_id = OLD.document_id;
END;

-- A lot's searchable identifiers change → refresh ALL docs linked to it.
-- findOrCreateLot backfills NULL columns on existing lots (e.g. a sublot
-- created skeletal then enriched), so lot_number/sub_lot_code/lot_key can
-- legitimately change after links exist.
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
    doc_id, tenant_id
  )
  SELECT
    m.rowid,
    src.title, src.description, src.tags_text, src.file_name,
    src.extracted_text, src.primary_metadata_text, src.extended_metadata_text,
    src.supplier_text, src.document_type_text, src.product_text, src.lot_text,
    src.doc_id, src.tenant_id
  FROM documents_fts_source src
  JOIN documents_fts_map m ON m.doc_id = src.doc_id
  WHERE src.doc_id IN (
    SELECT dl.document_id FROM document_lots dl WHERE dl.lot_id = NEW.id
  );
END;

------------------------------------------------------------
-- 6. Backfill documents_fts from the rebuilt source view.
------------------------------------------------------------
--
-- The DROP TABLE in § 1 cleared all rows; rebuild every row (lot_text
-- included) from the new view. Map rowids are unchanged, so doc identity
-- is preserved.

INSERT OR IGNORE INTO documents_fts_map (doc_id)
SELECT id FROM documents ORDER BY created_at, id;

INSERT INTO documents_fts (
  rowid, title, description, tags_text, file_name,
  extracted_text, primary_metadata_text, extended_metadata_text,
  supplier_text, document_type_text, product_text, lot_text,
  doc_id, tenant_id
)
SELECT
  m.rowid,
  src.title, src.description, src.tags_text, src.file_name,
  src.extracted_text, src.primary_metadata_text, src.extended_metadata_text,
  src.supplier_text, src.document_type_text, src.product_text, src.lot_text,
  src.doc_id, src.tenant_id
FROM documents_fts_source src
JOIN documents_fts_map m ON m.doc_id = src.doc_id;
