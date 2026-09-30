-- THE DEFERRED "P3 FTS REBUILD": documents_fts reads REQUIREMENTS, not the
-- retired document_categories, and a product's IDENTIFIERS, not only its name
-- (search redesign Phase 3).
--
-- Two things free text could not find:
--
--   category_text  read document_categories (0076), which 0080 retired in
--                  favour of document_requirements. Nothing has written a
--                  meaningful category row since, so "insurance certificate"
--                  typed as words found only documents whose TYPE says so,
--                  never what a document SATISFIES. It now reads the names of
--                  the requirements a document is linked to by any link a
--                  person has not REJECTED (a rejected link is a person saying
--                  no; a suggested one is a rule's default nobody overruled).
--   product_text   read products.name through document_products only, so a
--                  split COA linked to its product only through a lot row was
--                  invisible to "butter", and a supplier's item number or our
--                  SKU typed as text found nothing. It now reads every product
--                  linked either way, plus each one's CONFIRMED identifiers
--                  (our SKU, the supplier's item numbers - a former one too -
--                  supplier product names, aliases, GTIN, pack). An unconfirmed
--                  identifier is left out: free text must not find a document
--                  through a claim nobody has checked.
--
-- The view keeps its column list and order exactly, so every existing FTS
-- trigger (they INSERT ... SELECT FROM documents_fts_source by column name)
-- keeps working unchanged. DROP VIEW + CREATE VIEW; no table is rebuilt and
-- no ALTER TABLE RENAME is used (0110's finding).
--
-- Freshness:
--   - document_requirements INSERT / UPDATE OF status, requirement_id /
--     DELETE re-emits the one document inline (the 0079 document_categories
--     pattern, which is retired here with its two triggers);
--   - a requirement RENAME, and any product_identifiers change, enqueue a
--     search_reindex_jobs row ('requirement' / 'product') for the drainer
--     (functions/lib/search-reindex.ts), which is now also drained
--     automatically after the rename endpoints and by every search - a
--     product can sit on hundreds of documents, and fanning that out inside a
--     trigger would freeze the request (0055's reasoning).
--   - The 'product' job now finds lot-linked documents as well.
--
-- Full re-emit: one 'tenant' job per organization, drained in the background
-- (or at once with POST /api/admin/search/reindex). Until it drains, a
-- document's FTS row still carries the old category/product text - search
-- keeps working, it only cannot yet find a document by a requirement name.
--
-- document_categories is NOT dropped here, deliberately: it still has writers
-- and readers in the public API (PUT /api/documents/:id `categories`, the
-- ingest API's `category_ids`, GET /api/documents/:id's categories and the
-- legacy /api/documents/search `category_id` filter). Dropping it is an API
-- contract change and ships on its own, once those callers are retired - the
-- supplier_product_map (0075 -> 0113) pattern. From here on its rows feed
-- nothing in search.
--
-- APPLY WITH bin/migrate-prod-one (it strips full-line comments before the D1
-- import). Rehearsed on a populated database in
-- tests/api/migration-0131-fts-registry.test.ts. Plain-ASCII header.

DROP TRIGGER IF EXISTS trg_document_categories_ai_fts;
DROP TRIGGER IF EXISTS trg_document_categories_ad_fts;

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
    (SELECT GROUP_CONCAT(txt, ' ') FROM (
       SELECT COALESCE(p.name, '') AS txt
         FROM products p
        WHERE p.id IN (SELECT dp.product_id FROM document_products dp WHERE dp.document_id = d.id
                       UNION
                       SELECT l.product_id FROM document_lots dl JOIN lots l ON l.id = dl.lot_id
                        WHERE dl.document_id = d.id AND l.product_id IS NOT NULL)
       UNION ALL
       SELECT pi.value AS txt
         FROM product_identifiers pi
        WHERE pi.confirmed = 1
          AND pi.product_id IN (SELECT dp.product_id FROM document_products dp WHERE dp.document_id = d.id
                                UNION
                                SELECT l.product_id FROM document_lots dl JOIN lots l ON l.id = dl.lot_id
                                 WHERE dl.document_id = d.id AND l.product_id IS NOT NULL)
    )),
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
    (SELECT GROUP_CONCAT(COALESCE(r.name, ''), ' ')
       FROM document_requirements dr
       JOIN requirements r ON r.id = dr.requirement_id
      WHERE dr.document_id = d.id AND dr.status != 'rejected'),
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

CREATE TRIGGER trg_document_requirements_ai_fts
AFTER INSERT ON document_requirements
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

CREATE TRIGGER trg_document_requirements_au_fts
AFTER UPDATE OF status, requirement_id ON document_requirements
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

CREATE TRIGGER trg_document_requirements_ad_fts
AFTER DELETE ON document_requirements
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

CREATE TRIGGER IF NOT EXISTS trg_requirements_au_reindex
AFTER UPDATE OF name ON requirements
BEGIN
  INSERT OR IGNORE INTO search_reindex_jobs (tenant_id, entity_kind, entity_id)
  VALUES (NEW.tenant_id, 'requirement', NEW.id);
END;

CREATE TRIGGER IF NOT EXISTS trg_product_identifiers_ai_reindex
AFTER INSERT ON product_identifiers
BEGIN
  INSERT OR IGNORE INTO search_reindex_jobs (tenant_id, entity_kind, entity_id)
  VALUES (NEW.tenant_id, 'product', NEW.product_id);
END;

CREATE TRIGGER IF NOT EXISTS trg_product_identifiers_au_reindex
AFTER UPDATE OF value, confirmed, product_id ON product_identifiers
BEGIN
  INSERT OR IGNORE INTO search_reindex_jobs (tenant_id, entity_kind, entity_id)
  VALUES (NEW.tenant_id, 'product', NEW.product_id);
  INSERT OR IGNORE INTO search_reindex_jobs (tenant_id, entity_kind, entity_id)
  SELECT OLD.tenant_id, 'product', OLD.product_id WHERE OLD.product_id != NEW.product_id;
END;

CREATE TRIGGER IF NOT EXISTS trg_product_identifiers_ad_reindex
AFTER DELETE ON product_identifiers
BEGIN
  INSERT OR IGNORE INTO search_reindex_jobs (tenant_id, entity_kind, entity_id)
  VALUES (OLD.tenant_id, 'product', OLD.product_id);
END;

-- Re-emit every organization's rows through the new view, in the background
-- (an organization with no documents has nothing to re-emit).
INSERT OR IGNORE INTO search_reindex_jobs (tenant_id, entity_kind, entity_id)
SELECT t.id, 'tenant', t.id FROM tenants t
 WHERE EXISTS (SELECT 1 FROM documents d WHERE d.tenant_id = t.id);
