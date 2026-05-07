-- Migration 0054: Search v2 — FTS5 backbone
--
-- Phase 1 of the Document Search v2 plan
-- (`/home/hexi/.claude/plans/peppy-coalescing-platypus.md`).
--
-- Adds FTS5 virtual tables for documents (denormalized — supplier text,
-- document_type text, and product text concatenated in) plus per-entity
-- FTS tables for suppliers, document_types, products, orders, customers,
-- and bundles. Tenant ID is stored UNINDEXED on every FTS row so isolation
-- runs *inside* the MATCH query rather than as a post-filter.
--
-- Deviation from the plan worth flagging:
-- ----------------------------------------
-- The plan specifies contentless (`content=''`) FTS5 tables for
-- `documents_fts` and `orders_fts`, with content-aware
-- (`content='<table>'`) tables for the per-entity ones. We instead use
-- regular FTS5 tables (no `content=` clause) for ALL of them. Reason:
-- contentless FTS5 has no per-row DELETE — to remove a row you must call
-- `INSERT INTO fts(fts, rowid, col1, col2, ...) VALUES('delete', rowid,
-- oldval1, oldval2, ...)` with the EXACT current indexed values for that
-- rowid. From a trigger this requires either (a) a BEFORE-trigger
-- staging step that captures the old computed text or (b) a deterministic
-- recompute from OLD ids — both fragile. Regular FTS5 supports clean
-- `DELETE FROM fts WHERE rowid = ?` and `INSERT INTO fts(rowid, ...)`
-- semantics, at the cost of duplicating the indexed text on disk. With
-- the 200KB cap on `extracted_text` this is ~600KB worst case per doc
-- (raw + posting list ~3x), well within budget for the v1 50k-doc target.
-- The 10GB-cap risk noted in the plan is unaffected.
--
-- The TEXT-id → INTEGER rowid map tables (`documents_fts_map`,
-- `orders_fts_map`) are kept because FTS5 rowids are integers and our
-- entity IDs are hex strings. The map's rowid uses
-- `INTEGER PRIMARY KEY AUTOINCREMENT` so we get monotonic ints for free
-- without a separate sequence helper.
--
-- Tokenizer: `unicode61 remove_diacritics 2 tokenchars '-_/.'` so SKUs,
-- lot numbers, and slash-delimited identifiers survive as single tokens.
--
-- Trigger boundary: per-entity FTS tables are kept fully in sync with
-- their source tables. Cross-entity renames (supplier / doc_type /
-- product → docs) deliberately DO NOT fan out — Phase 2 adds an async
-- reindex queue for that. So `documents_fts` only re-emits a doc row
-- when `documents`, `document_versions`, or `document_products` change.

------------------------------------------------------------
-- 1. ID-map tables for entities with TEXT primary keys
------------------------------------------------------------

-- Maps document.id (hex TEXT) to an integer rowid for documents_fts.
CREATE TABLE IF NOT EXISTS documents_fts_map (
  rowid   INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_id  TEXT NOT NULL UNIQUE
);

-- Maps order.id (hex TEXT) to an integer rowid for orders_fts.
CREATE TABLE IF NOT EXISTS orders_fts_map (
  rowid     INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id  TEXT NOT NULL UNIQUE
);

------------------------------------------------------------
-- 2. documents_fts — denormalized, the heavy hitter
------------------------------------------------------------
--
-- Indexed columns (in declaration order; matters for snippet() column
-- index references in Phase 4):
--   0: title
--   1: description
--   2: tags_text
--   3: file_name
--   4: extracted_text             (capped at 200KB by the source view)
--   5: primary_metadata_text
--   6: extended_metadata_text
--   7: supplier_text              (name + flattened aliases)
--   8: document_type_text         (name + slug)
--   9: product_text               (concat of linked product names)
--
-- Plus UNINDEXED `doc_id` and `tenant_id` for filtering / projection.

CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
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
  doc_id     UNINDEXED,
  tenant_id  UNINDEXED,
  tokenize = "unicode61 remove_diacritics 2 tokenchars '-_/.'"
);

-- Source view that produces one row per document, joining suppliers,
-- document_types, document_products+products, and the latest version's
-- file_name + extracted_text. The 200KB cap on extracted_text lives
-- here so every code path that re-emits a doc honors it.
--
-- supplier aliases: `suppliers.aliases` is stored as a JSON array. We
-- flatten by stripping JSON punctuation (`[`, `]`, `"`) — the tokenizer
-- handles whitespace and commas. The result is a space-separated list
-- of alias tokens that interleaves with the supplier name.
--
-- product_text: GROUP_CONCAT of the linked product names. NULL when
-- there are no links.
CREATE VIEW IF NOT EXISTS documents_fts_source AS
SELECT
  d.id                              AS doc_id,
  d.tenant_id                       AS tenant_id,
  d.title                           AS title,
  COALESCE(d.description, '')       AS description,
  COALESCE(d.tags, '[]')            AS tags_text,
  COALESCE(dv.file_name, '')        AS file_name,
  COALESCE(substr(dv.extracted_text, 1, 200000), '')
                                    AS extracted_text,
  COALESCE(d.primary_metadata, '')  AS primary_metadata_text,
  COALESCE(d.extended_metadata, '') AS extended_metadata_text,
  -- Supplier name + flattened aliases (or empty string when unlinked).
  COALESCE(
    s.name || ' ' ||
    REPLACE(REPLACE(REPLACE(COALESCE(s.aliases, ''), '[', ''), ']', ''), '"', ''),
    ''
  )                                 AS supplier_text,
  COALESCE(dt.name || ' ' || dt.slug, '')
                                    AS document_type_text,
  COALESCE(
    (SELECT GROUP_CONCAT(p.name, ' ')
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

------------------------------------------------------------
-- 3. Per-entity FTS tables
------------------------------------------------------------

CREATE VIRTUAL TABLE IF NOT EXISTS suppliers_fts USING fts5(
  name,
  aliases_text,
  supplier_id  UNINDEXED,
  tenant_id    UNINDEXED,
  tokenize = "unicode61 remove_diacritics 2 tokenchars '-_/.'"
);

CREATE VIRTUAL TABLE IF NOT EXISTS document_types_fts USING fts5(
  name,
  slug,
  description,
  doc_type_id  UNINDEXED,
  tenant_id    UNINDEXED,
  tokenize = "unicode61 remove_diacritics 2 tokenchars '-_/.'"
);

CREATE VIRTUAL TABLE IF NOT EXISTS products_fts USING fts5(
  name,
  description,
  product_id  UNINDEXED,
  tenant_id   UNINDEXED,
  tokenize = "unicode61 remove_diacritics 2 tokenchars '-_/.'"
);

CREATE VIRTUAL TABLE IF NOT EXISTS customers_fts USING fts5(
  name,
  customer_number,
  email,
  customer_id  UNINDEXED,
  tenant_id    UNINDEXED,
  tokenize = "unicode61 remove_diacritics 2 tokenchars '-_/.'"
);

CREATE VIRTUAL TABLE IF NOT EXISTS bundles_fts USING fts5(
  name,
  description,
  bundle_id  UNINDEXED,
  tenant_id  UNINDEXED,
  tokenize = "unicode61 remove_diacritics 2 tokenchars '-_/.'"
);

CREATE VIRTUAL TABLE IF NOT EXISTS orders_fts USING fts5(
  order_number,
  po_number,
  customer_text,
  items_text,
  order_id   UNINDEXED,
  tenant_id  UNINDEXED,
  tokenize = "unicode61 remove_diacritics 2 tokenchars '-_/.'"
);

-- Source view for orders_fts: joins customer + flattens order_items into
-- a single space-separated text column (product_name + product_code +
-- lot_number per item).
CREATE VIEW IF NOT EXISTS orders_fts_source AS
SELECT
  o.id                            AS order_id,
  o.tenant_id                     AS tenant_id,
  COALESCE(o.order_number, '')    AS order_number,
  COALESCE(o.po_number, '')       AS po_number,
  COALESCE(c.name || ' ' || COALESCE(c.customer_number, ''),
           o.customer_name,
           '')                    AS customer_text,
  COALESCE(
    (SELECT GROUP_CONCAT(
              COALESCE(oi.product_name, '') || ' ' ||
              COALESCE(oi.product_code, '') || ' ' ||
              COALESCE(oi.lot_number,   ''),
              ' ')
       FROM order_items oi
      WHERE oi.order_id = o.id),
    ''
  )                               AS items_text
FROM orders o
LEFT JOIN customers c ON c.id = o.customer_id;

------------------------------------------------------------
-- 4. Triggers — documents
------------------------------------------------------------

-- AFTER INSERT documents → ensure map row, insert FTS row.
CREATE TRIGGER IF NOT EXISTS trg_documents_ai_fts
AFTER INSERT ON documents
BEGIN
  INSERT OR IGNORE INTO documents_fts_map (doc_id) VALUES (NEW.id);

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
  JOIN documents_fts_map m ON m.doc_id = src.doc_id
  WHERE src.doc_id = NEW.id;
END;

-- AFTER UPDATE documents → re-emit the FTS row.
CREATE TRIGGER IF NOT EXISTS trg_documents_au_fts
AFTER UPDATE ON documents
BEGIN
  DELETE FROM documents_fts
   WHERE rowid = (SELECT rowid FROM documents_fts_map WHERE doc_id = NEW.id);

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
  JOIN documents_fts_map m ON m.doc_id = src.doc_id
  WHERE src.doc_id = NEW.id;
END;

-- AFTER DELETE documents → drop the FTS row (and the map row to keep
-- the autoincrement counter from drifting forever; the rowid value
-- itself is never reused on AUTOINCREMENT, which is intentional).
CREATE TRIGGER IF NOT EXISTS trg_documents_ad_fts
AFTER DELETE ON documents
BEGIN
  DELETE FROM documents_fts
   WHERE rowid = (SELECT rowid FROM documents_fts_map WHERE doc_id = OLD.id);
  DELETE FROM documents_fts_map WHERE doc_id = OLD.id;
END;

------------------------------------------------------------
-- 5. Triggers — document_versions (re-emit parent doc)
------------------------------------------------------------

CREATE TRIGGER IF NOT EXISTS trg_document_versions_ai_fts
AFTER INSERT ON document_versions
BEGIN
  DELETE FROM documents_fts
   WHERE rowid = (SELECT rowid FROM documents_fts_map WHERE doc_id = NEW.document_id);

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
  JOIN documents_fts_map m ON m.doc_id = src.doc_id
  WHERE src.doc_id = NEW.document_id;
END;

CREATE TRIGGER IF NOT EXISTS trg_document_versions_au_fts
AFTER UPDATE OF extracted_text, file_name, version_number ON document_versions
BEGIN
  DELETE FROM documents_fts
   WHERE rowid = (SELECT rowid FROM documents_fts_map WHERE doc_id = NEW.document_id);

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
  JOIN documents_fts_map m ON m.doc_id = src.doc_id
  WHERE src.doc_id = NEW.document_id;
END;

------------------------------------------------------------
-- 6. Triggers — document_products (re-emit parent doc)
------------------------------------------------------------

CREATE TRIGGER IF NOT EXISTS trg_document_products_ai_fts
AFTER INSERT ON document_products
BEGIN
  DELETE FROM documents_fts
   WHERE rowid = (SELECT rowid FROM documents_fts_map WHERE doc_id = NEW.document_id);

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
  JOIN documents_fts_map m ON m.doc_id = src.doc_id
  WHERE src.doc_id = NEW.document_id;
END;

CREATE TRIGGER IF NOT EXISTS trg_document_products_ad_fts
AFTER DELETE ON document_products
BEGIN
  DELETE FROM documents_fts
   WHERE rowid = (SELECT rowid FROM documents_fts_map WHERE doc_id = OLD.document_id);

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
  JOIN documents_fts_map m ON m.doc_id = src.doc_id
  WHERE src.doc_id = OLD.document_id;
END;

------------------------------------------------------------
-- 7. Triggers — suppliers (own FTS only; NO doc fan-out)
------------------------------------------------------------

CREATE TRIGGER IF NOT EXISTS trg_suppliers_ai_fts
AFTER INSERT ON suppliers
BEGIN
  INSERT INTO suppliers_fts (name, aliases_text, supplier_id, tenant_id)
  VALUES (
    NEW.name,
    REPLACE(REPLACE(REPLACE(COALESCE(NEW.aliases, ''), '[', ''), ']', ''), '"', ''),
    NEW.id,
    NEW.tenant_id
  );
END;

CREATE TRIGGER IF NOT EXISTS trg_suppliers_au_fts
AFTER UPDATE OF name, aliases ON suppliers
BEGIN
  DELETE FROM suppliers_fts WHERE supplier_id = NEW.id;
  INSERT INTO suppliers_fts (name, aliases_text, supplier_id, tenant_id)
  VALUES (
    NEW.name,
    REPLACE(REPLACE(REPLACE(COALESCE(NEW.aliases, ''), '[', ''), ']', ''), '"', ''),
    NEW.id,
    NEW.tenant_id
  );
END;

CREATE TRIGGER IF NOT EXISTS trg_suppliers_ad_fts
AFTER DELETE ON suppliers
BEGIN
  DELETE FROM suppliers_fts WHERE supplier_id = OLD.id;
END;

------------------------------------------------------------
-- 8. Triggers — document_types (own FTS only; NO doc fan-out)
------------------------------------------------------------

CREATE TRIGGER IF NOT EXISTS trg_document_types_ai_fts
AFTER INSERT ON document_types
BEGIN
  INSERT INTO document_types_fts (name, slug, description, doc_type_id, tenant_id)
  VALUES (NEW.name, NEW.slug, COALESCE(NEW.description, ''), NEW.id, NEW.tenant_id);
END;

CREATE TRIGGER IF NOT EXISTS trg_document_types_au_fts
AFTER UPDATE OF name, slug, description ON document_types
BEGIN
  DELETE FROM document_types_fts WHERE doc_type_id = NEW.id;
  INSERT INTO document_types_fts (name, slug, description, doc_type_id, tenant_id)
  VALUES (NEW.name, NEW.slug, COALESCE(NEW.description, ''), NEW.id, NEW.tenant_id);
END;

CREATE TRIGGER IF NOT EXISTS trg_document_types_ad_fts
AFTER DELETE ON document_types
BEGIN
  DELETE FROM document_types_fts WHERE doc_type_id = OLD.id;
END;

------------------------------------------------------------
-- 9. Triggers — products (own FTS only; NO doc fan-out)
------------------------------------------------------------

CREATE TRIGGER IF NOT EXISTS trg_products_ai_fts
AFTER INSERT ON products
BEGIN
  INSERT INTO products_fts (name, description, product_id, tenant_id)
  VALUES (NEW.name, COALESCE(NEW.description, ''), NEW.id, NEW.tenant_id);
END;

CREATE TRIGGER IF NOT EXISTS trg_products_au_fts
AFTER UPDATE OF name, description ON products
BEGIN
  DELETE FROM products_fts WHERE product_id = NEW.id;
  INSERT INTO products_fts (name, description, product_id, tenant_id)
  VALUES (NEW.name, COALESCE(NEW.description, ''), NEW.id, NEW.tenant_id);
END;

CREATE TRIGGER IF NOT EXISTS trg_products_ad_fts
AFTER DELETE ON products
BEGIN
  DELETE FROM products_fts WHERE product_id = OLD.id;
END;

------------------------------------------------------------
-- 10. Triggers — customers
------------------------------------------------------------

CREATE TRIGGER IF NOT EXISTS trg_customers_ai_fts
AFTER INSERT ON customers
BEGIN
  INSERT INTO customers_fts (name, customer_number, email, customer_id, tenant_id)
  VALUES (NEW.name, COALESCE(NEW.customer_number, ''), COALESCE(NEW.email, ''),
          NEW.id, NEW.tenant_id);
END;

CREATE TRIGGER IF NOT EXISTS trg_customers_au_fts
AFTER UPDATE OF name, customer_number, email ON customers
BEGIN
  DELETE FROM customers_fts WHERE customer_id = NEW.id;
  INSERT INTO customers_fts (name, customer_number, email, customer_id, tenant_id)
  VALUES (NEW.name, COALESCE(NEW.customer_number, ''), COALESCE(NEW.email, ''),
          NEW.id, NEW.tenant_id);
END;

CREATE TRIGGER IF NOT EXISTS trg_customers_ad_fts
AFTER DELETE ON customers
BEGIN
  DELETE FROM customers_fts WHERE customer_id = OLD.id;
END;

------------------------------------------------------------
-- 11. Triggers — bundles (document_bundles)
------------------------------------------------------------

CREATE TRIGGER IF NOT EXISTS trg_bundles_ai_fts
AFTER INSERT ON document_bundles
BEGIN
  INSERT INTO bundles_fts (name, description, bundle_id, tenant_id)
  VALUES (NEW.name, COALESCE(NEW.description, ''), NEW.id, NEW.tenant_id);
END;

CREATE TRIGGER IF NOT EXISTS trg_bundles_au_fts
AFTER UPDATE OF name, description ON document_bundles
BEGIN
  DELETE FROM bundles_fts WHERE bundle_id = NEW.id;
  INSERT INTO bundles_fts (name, description, bundle_id, tenant_id)
  VALUES (NEW.name, COALESCE(NEW.description, ''), NEW.id, NEW.tenant_id);
END;

CREATE TRIGGER IF NOT EXISTS trg_bundles_ad_fts
AFTER DELETE ON document_bundles
BEGIN
  DELETE FROM bundles_fts WHERE bundle_id = OLD.id;
END;

------------------------------------------------------------
-- 12. Triggers — orders + order_items
------------------------------------------------------------

CREATE TRIGGER IF NOT EXISTS trg_orders_ai_fts
AFTER INSERT ON orders
BEGIN
  INSERT OR IGNORE INTO orders_fts_map (order_id) VALUES (NEW.id);

  INSERT INTO orders_fts (
    rowid, order_number, po_number, customer_text, items_text,
    order_id, tenant_id
  )
  SELECT m.rowid, src.order_number, src.po_number,
         src.customer_text, src.items_text,
         src.order_id, src.tenant_id
  FROM orders_fts_source src
  JOIN orders_fts_map m ON m.order_id = src.order_id
  WHERE src.order_id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_orders_au_fts
AFTER UPDATE ON orders
BEGIN
  DELETE FROM orders_fts
   WHERE rowid = (SELECT rowid FROM orders_fts_map WHERE order_id = NEW.id);

  INSERT INTO orders_fts (
    rowid, order_number, po_number, customer_text, items_text,
    order_id, tenant_id
  )
  SELECT m.rowid, src.order_number, src.po_number,
         src.customer_text, src.items_text,
         src.order_id, src.tenant_id
  FROM orders_fts_source src
  JOIN orders_fts_map m ON m.order_id = src.order_id
  WHERE src.order_id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_orders_ad_fts
AFTER DELETE ON orders
BEGIN
  DELETE FROM orders_fts
   WHERE rowid = (SELECT rowid FROM orders_fts_map WHERE order_id = OLD.id);
  DELETE FROM orders_fts_map WHERE order_id = OLD.id;
END;

-- order_items changes re-emit the parent order.
CREATE TRIGGER IF NOT EXISTS trg_order_items_ai_fts
AFTER INSERT ON order_items
BEGIN
  DELETE FROM orders_fts
   WHERE rowid = (SELECT rowid FROM orders_fts_map WHERE order_id = NEW.order_id);
  INSERT INTO orders_fts (
    rowid, order_number, po_number, customer_text, items_text,
    order_id, tenant_id
  )
  SELECT m.rowid, src.order_number, src.po_number,
         src.customer_text, src.items_text,
         src.order_id, src.tenant_id
  FROM orders_fts_source src
  JOIN orders_fts_map m ON m.order_id = src.order_id
  WHERE src.order_id = NEW.order_id;
END;

CREATE TRIGGER IF NOT EXISTS trg_order_items_au_fts
AFTER UPDATE ON order_items
BEGIN
  DELETE FROM orders_fts
   WHERE rowid = (SELECT rowid FROM orders_fts_map WHERE order_id = NEW.order_id);
  INSERT INTO orders_fts (
    rowid, order_number, po_number, customer_text, items_text,
    order_id, tenant_id
  )
  SELECT m.rowid, src.order_number, src.po_number,
         src.customer_text, src.items_text,
         src.order_id, src.tenant_id
  FROM orders_fts_source src
  JOIN orders_fts_map m ON m.order_id = src.order_id
  WHERE src.order_id = NEW.order_id;
END;

CREATE TRIGGER IF NOT EXISTS trg_order_items_ad_fts
AFTER DELETE ON order_items
BEGIN
  DELETE FROM orders_fts
   WHERE rowid = (SELECT rowid FROM orders_fts_map WHERE order_id = OLD.order_id);
  INSERT INTO orders_fts (
    rowid, order_number, po_number, customer_text, items_text,
    order_id, tenant_id
  )
  SELECT m.rowid, src.order_number, src.po_number,
         src.customer_text, src.items_text,
         src.order_id, src.tenant_id
  FROM orders_fts_source src
  JOIN orders_fts_map m ON m.order_id = src.order_id
  WHERE src.order_id = OLD.order_id;
END;

------------------------------------------------------------
-- 13. Initial backfill
------------------------------------------------------------
--
-- Plan calls for chunked-per-tenant backfill in big tenants. For the
-- migration runner we do a single-shot backfill — `bin/migrate` runs
-- statements via `wrangler d1 execute --file`, which can carry the
-- backfill inserts for the v1 corpus (low thousands of docs/tenant per
-- staging seed). If the prod corpus exceeds the wrangler exec budget
-- on rollout, defer the backfill to a one-shot `bin/backfill-fts`
-- script (called out as a follow-up in the rollout section of the
-- plan). Existing rows in `documents`, `orders`, `suppliers`, etc. on
-- a fresh local DB are zero, so this is a no-op in development.

-- 13a. Map tables — assign rowids in (created_at, id) order so
--      monotonic doc creation produces monotonic rowids.
INSERT OR IGNORE INTO documents_fts_map (doc_id)
SELECT id FROM documents ORDER BY created_at, id;

INSERT OR IGNORE INTO orders_fts_map (order_id)
SELECT id FROM orders ORDER BY created_at, id;

-- 13b. documents_fts from the source view.
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

-- 13c. orders_fts from the source view.
INSERT INTO orders_fts (
  rowid, order_number, po_number, customer_text, items_text,
  order_id, tenant_id
)
SELECT m.rowid, src.order_number, src.po_number,
       src.customer_text, src.items_text,
       src.order_id, src.tenant_id
FROM orders_fts_source src
JOIN orders_fts_map m ON m.order_id = src.order_id;

-- 13d. Per-entity tables.
INSERT INTO suppliers_fts (name, aliases_text, supplier_id, tenant_id)
SELECT
  s.name,
  REPLACE(REPLACE(REPLACE(COALESCE(s.aliases, ''), '[', ''), ']', ''), '"', ''),
  s.id,
  s.tenant_id
FROM suppliers s;

INSERT INTO document_types_fts (name, slug, description, doc_type_id, tenant_id)
SELECT name, slug, COALESCE(description, ''), id, tenant_id FROM document_types;

INSERT INTO products_fts (name, description, product_id, tenant_id)
SELECT name, COALESCE(description, ''), id, tenant_id FROM products;

INSERT INTO customers_fts (name, customer_number, email, customer_id, tenant_id)
SELECT name, COALESCE(customer_number, ''), COALESCE(email, ''), id, tenant_id FROM customers;

INSERT INTO bundles_fts (name, description, bundle_id, tenant_id)
SELECT name, COALESCE(description, ''), id, tenant_id FROM document_bundles;
