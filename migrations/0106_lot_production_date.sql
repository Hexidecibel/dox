-- 0106 — a lot row's PRODUCTION DATE, with where it came from; and the text a
-- split certificate is SEARCHED on, as distinct from the text it displays.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- THE PROBLEM (AJ Conner, Any-Field COA Retrieval, 2026-09-08, D1 / R1 / R3)
-- ═══════════════════════════════════════════════════════════════════════════
-- "The manufacture date is the single most requested search key and it lives
-- in exactly one place: the COA PDF." The portal reads it — the worker emits
-- `production_date` ISO for every record — and then files it where retrieval
-- cannot reach it:
--
--   - `lots.mfg_date` is NULL on 100% of production lots (397 rows measured
--     2026-09-15). Nothing writes it except a `mfg_date` key no extraction emits.
--   - The approve paths passed `code_date || production_date` into
--     `lots.code_date`, so a production date became a code date the moment it
--     reached a lot row, in whatever shape the page printed it ("2/20/2026",
--     "04-05-2026", "18-03-2026"). A code date is not a production date (the
--     West Point case), and "04-05-2026" is two different days.
--   - Older Darigold documents carry their production date under `code_date`
--     in primary_metadata, because production_date used to be an alias of it.
--
-- So production date is searched today by a capped scan of document metadata
-- (functions/lib/search-coverage.ts), at document grain, with no index.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- WHY NEW COLUMNS AND NOT `mfg_date`
-- ═══════════════════════════════════════════════════════════════════════════
-- Reusing `mfg_date` would have been one column fewer and exactly the wrong
-- trade. It has no provenance, `findOrCreateLot` fills it from any caller that
-- passes one (orders, shipments, the ingest API), and "mfg" already names a
-- metadata key the extraction layer folds into production_date. A value whose
-- origin cannot be stated is the one thing R8 says the portal must not show a
-- customer's QA manager. It stays, untouched and unread by retrieval.
--
--   production_date          ISO YYYY-MM-DD, or NULL when the value could not be
--                            read as exactly one day. NEVER a guess.
--   production_date_raw      the value as extracted, verbatim. Kept even when
--                            resolved, so "22-Jul-2026" stays defensible.
--   production_date_source   'extracted'                  — the record's own
--                                                           production date field
--                            'extracted_code_date_legacy' — an older extraction
--                                                           filed it as code_date,
--                                                           and the page prints that
--                                                           value under a production
--                                                           label (bin/backfill-lot-
--                                                           production-dates)
--                            'reviewer'                   — a person typed it
--   production_date_status   'resolved'    one day, production_date set
--                            'ambiguous'   reads two ways (04-05-2026), NULL ISO
--                            'unparseable' not a date, NULL ISO
--                            'conflict'    two certificates (or one field) state
--                                          different days; NULL ISO, raw names both.
--                                          Never resolved in code (R3: flag, don't pick).
--   production_date_document_id   the document the value was read from.
--
-- CHECKs on the two vocabularies: unlike 0099's module keys these words drive
-- whether a search calls a certificate covering, so an unknown one must fail
-- the write rather than become a silent non-match. NULL on every column means
-- nobody has read a production date for this lot, which is distinct from
-- 'unparseable'.
--
-- WEIGHT AND QUANTITY ARE NOT HERE. A `lots` row is shared by every certificate
-- and order that names the lot; the 50 EA / 2755.75 lb a row prints is a fact
-- about that row ON THAT CERTIFICATE, and the split document for the row
-- already carries it in its own metadata. Retrieval reads it from there.
--
-- The PARTIAL index is what the production-date lookup uses (tenant, day range).
-- Unresolved rows have no day to range over, so they stay out of it.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- `document_versions.search_text` — SIBLING TEXT (D3)
-- ═══════════════════════════════════════════════════════════════════════════
-- A multi-lot certificate is approved as one document per lot row, and every
-- one of them stored the WHOLE certificate's text. On AJ's fixture all four
-- rows are one table on one page, so page-scoping the PDF cannot separate them:
-- the 23-Jul row's document said "22-Jul-2026" three times, and a query for
-- lot 10426204 with "22-Jul" covered it.
--
-- `extracted_text` stays the text of the file (the preview shows the page, all
-- four rows on it). `search_text`, when set, is what the FTS index reads
-- instead: the same text with the OTHER rows' lot numbers and dates blanked
-- (shared/rowScopedText.ts). Everything the rows share — supplier, PO, product
-- words, test names — stays searchable. NULL for every ordinary document, so
-- the index is byte-identical for them.
--
-- The view is re-created with one expression changed (COALESCE(search_text,
-- extracted_text)); triggers reference it by name and pick it up (the 0056
-- precedent). One trigger IS re-created: the document_versions update trigger
-- listed its columns, and without `search_text` in that list a backfilled
-- search_text would never reach the index. No inline FTS rebuild: no existing
-- row has search_text, so every indexed row is already correct, and each
-- backfilled document reindexes itself through that trigger.

ALTER TABLE lots ADD COLUMN production_date TEXT;
ALTER TABLE lots ADD COLUMN production_date_raw TEXT;
ALTER TABLE lots ADD COLUMN production_date_source TEXT
  CHECK (production_date_source IS NULL OR production_date_source IN ('extracted', 'extracted_code_date_legacy', 'reviewer'));
ALTER TABLE lots ADD COLUMN production_date_status TEXT
  CHECK (production_date_status IS NULL OR production_date_status IN ('resolved', 'ambiguous', 'unparseable', 'conflict'));
ALTER TABLE lots ADD COLUMN production_date_document_id TEXT;

CREATE INDEX IF NOT EXISTS idx_lots_production_date
  ON lots (tenant_id, production_date)
  WHERE production_date IS NOT NULL;

ALTER TABLE document_versions ADD COLUMN search_text TEXT;

DROP VIEW IF EXISTS documents_fts_source;

CREATE VIEW documents_fts_source AS
SELECT
  d.id                              AS doc_id,
  d.tenant_id                       AS tenant_id,
  COALESCE(d.title, '')             AS title,
  COALESCE(d.description, '')       AS description,
  COALESCE(d.tags, '[]')            AS tags_text,
  COALESCE(dv.file_name, '')        AS file_name,
  COALESCE(substr(COALESCE(dv.search_text, dv.extracted_text), 1, 200000), '')
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

DROP TRIGGER IF EXISTS trg_document_versions_au_fts;

CREATE TRIGGER trg_document_versions_au_fts
AFTER UPDATE OF extracted_text, search_text, file_name, version_number ON document_versions
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
