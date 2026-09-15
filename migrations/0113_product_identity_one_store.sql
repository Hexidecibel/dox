-- 0113 - ONE store for product identity: supplier_product_map (0075) is copied
-- into product_identifiers (0107) and stops being read.
--
-- NUMBERING: written alongside 0111 (renewal lead time) and 0112 (supplier-list
-- import), both of which merge first. Nothing in this file depends on its
-- number; renumber freely if another migration lands ahead of it.
--
-- HEADER IS PLAIN ASCII ON PURPOSE. D1's import API lost PRAGMA
-- defer_foreign_keys when 0110's comment header held non-ASCII characters.
--
-- ===========================================================================
-- THE PROBLEM
-- ===========================================================================
-- The same fact lived in two tables:
--
--   supplier_product_map (0075)  supplier COA product NAME -> our product.
--       Read by lot matching. Keyed UNIQUE(tenant, supplier, name), so it can
--       hold ONE product per name. Country Morning prints "Cream - Heavy
--       Whipping 40%" on the 300 gal tote (their item 30904, our 10286) AND on
--       the 5 gal bag (their item 50903, our 0801); the map said 0801 for both,
--       which is part of why order 1794420's 0801 line was offered certificates
--       for other products. No provenance, no confirmation, no item number.
--   product_identifiers (0107)   what each of OUR products goes by: our SKU,
--       supplier item numbers, supplier names, pack, each with source and
--       confirmed. Read by search.
--
-- After this migration the lot matcher resolves a certificate's product from
-- product_identifiers (functions/lib/entities/matching.ts via
-- shared/supplierProductBridge.ts): supplier item number / customer item number
-- first, then supplier name + pack, then a supplier name alone only when it
-- names exactly one of our products. The review-time teach and Supplier >
-- Products write identifiers. Nothing reads supplier_product_map any more.
--
-- ===========================================================================
-- 1. product_identifiers REBUILT - `source` gains 'migrated_product_map'
-- ===========================================================================
-- 0107 CHECKs `source` because that word decides how a result is explained to a
-- customer's QA manager. A row copied from the old map was taught by a person
-- at review, but NOT on the identifier screens and NOT with an item number;
-- calling it 'reviewer' or 'import' would be the dishonest version. SQLite
-- cannot alter a CHECK, so the table is rebuilt exactly as 0110 rebuilt lots:
-- copy out (CREATE TABLE AS SELECT), DROP, CREATE widened, copy back column by
-- column, re-create the four indexes verbatim. No table references
-- product_identifiers(id), so the DROP cannot orphan anything; foreign keys are
-- still deferred for the transaction because the new rows reference products,
-- suppliers and users. No ALTER TABLE ... RENAME (see 0110 for why).
--
-- ===========================================================================
-- 2. COPY every supplier_product_map row
-- ===========================================================================
--   kind 'supplier_name', value = the map's coa_product_name_key, supplier_id =
--   the map row's supplier, product_id = order_product_id, confirmed = 1 (a
--   human taught it), source = 'migrated_product_map', note citing the map row
--   id. 0075 stored only the NORMALIZED name (upper-case alphanumerics and
--   single spaces, "CREAM HEAVY WHIPPING 40"); the raw name was never kept, so
--   the value is written as stored. value_norm = lower(value), which is exactly
--   what normalizeName() in shared/productVocabulary.ts yields for such a value.
--
--   distributor_sku, when present and purely alphanumeric, is copied as an
--   `our_sku` identifier on the same product (it was the order-line code the
--   person taught with the name, and the matcher used it as a code fallback).
--   A value with punctuation is skipped rather than normalized in SQL:
--   value_norm is computed in code everywhere else.
--
--   EXACT DUPLICATES ARE SKIPPED: a supplier_name already on that product for
--   that supplier whose value_norm equals the key once '%' is read as a space
--   (normalizeName keeps '%', the 0075 key dropped it), or an our_sku with the
--   same value_norm. IDEMPOTENT: both INSERTs are guarded by NOT EXISTS (and are
--   INSERT OR IGNORE against 0107's unique indexes), so a re-run of the copy
--   writes nothing.
--
--   Prod expectation (read-only dry run, 2026-09-15): 3 map rows, all Country
--   Morning Farms. "CREAM HEAVY WHIPPING 40" -> 0801 and "MILK WHOLE" -> MS
--   WHOLE 5 GL BAG are already seeded identifiers ("Cream - Heavy Whipping 40%",
--   "Milk - Whole") and are skipped; "HALF AND HALF" -> H&H 5 GL DISP is
--   inserted. distributor_sku: 0801 exists (skipped); 30417 on MS WHOLE 5 GL
--   BAG (order 1794650's line code) and 0708 on H&H 5 GL DISP are inserted.
--
-- ===========================================================================
-- 3. supplier_product_map IS LEFT IN PLACE, UNREAD, FOR ONE RELEASE
-- ===========================================================================
-- It is not dropped here. Once prod shows every row accounted for in
-- product_identifiers, a later migration drops it. Until then no code reads or
-- writes it (pinned by tests/unit/productMapRetired.test.ts).
--
-- ===========================================================================
-- 4. lot_match_suggestions.match_note
-- ===========================================================================
-- A suggestion now says WHY, in words, when the product bridge could not be
-- sure: "Country Morning Farms calls 2 of our products 'Cream - Heavy Whipping
-- 40%' ... no product is assumed", or "via unconfirmed identifier ...".
-- Nullable; NULL means there was nothing to add to the basis. Written by the
-- matcher only, never by a person.

PRAGMA defer_foreign_keys = true;

CREATE TABLE product_identifiers_pre0113 AS SELECT * FROM product_identifiers;

DROP TABLE product_identifiers;

CREATE TABLE product_identifiers (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('our_sku', 'supplier_item', 'supplier_name', 'alias', 'gtin', 'pack')),
  value TEXT NOT NULL,
  value_norm TEXT NOT NULL,
  supplier_id TEXT REFERENCES suppliers(id),
  superseded INTEGER NOT NULL DEFAULT 0 CHECK (superseded IN (0, 1)),
  confirmed INTEGER NOT NULL DEFAULT 0 CHECK (confirmed IN (0, 1)),
  source TEXT NOT NULL CHECK (source IN ('seed', 'reviewer', 'extracted', 'import', 'migrated_product_map')),
  note TEXT,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  confirmed_by TEXT REFERENCES users(id),
  confirmed_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (
    (kind IN ('supplier_item', 'supplier_name') AND supplier_id IS NOT NULL)
    OR (kind IN ('our_sku', 'alias', 'gtin', 'pack') AND supplier_id IS NULL)
  )
);

INSERT INTO product_identifiers (
  id, tenant_id, product_id, kind, value, value_norm, supplier_id, superseded, confirmed, source, note,
  created_by, created_at, confirmed_by, confirmed_at, updated_at
)
SELECT
  id, tenant_id, product_id, kind, value, value_norm, supplier_id, superseded, confirmed, source, note,
  created_by, created_at, confirmed_by, confirmed_at, updated_at
FROM product_identifiers_pre0113;

DROP TABLE product_identifiers_pre0113;

CREATE UNIQUE INDEX IF NOT EXISTS idx_product_identifiers_unique_supplier
  ON product_identifiers (product_id, kind, supplier_id, value_norm)
  WHERE supplier_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_product_identifiers_unique_plain
  ON product_identifiers (product_id, kind, value_norm)
  WHERE supplier_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_product_identifiers_lookup
  ON product_identifiers (tenant_id, value_norm);

CREATE INDEX IF NOT EXISTS idx_product_identifiers_product
  ON product_identifiers (product_id);

INSERT OR IGNORE INTO product_identifiers (
  id, tenant_id, product_id, kind, value, value_norm, supplier_id, superseded, confirmed, source, note,
  created_by, created_at, confirmed_by, confirmed_at, updated_at
)
SELECT
  lower(hex(randomblob(16))),
  m.tenant_id,
  m.order_product_id,
  'supplier_name',
  m.coa_product_name_key,
  lower(m.coa_product_name_key),
  m.supplier_id,
  0,
  1,
  'migrated_product_map',
  'Migrated from supplier_product_map row ' || m.id || ' (0075): taught at review as this supplier''s certificate product name for this product. 0075 kept only the normalized name, so it is shown as stored.',
  (SELECT u.id FROM users u WHERE u.id = m.created_by),
  COALESCE(m.created_at, datetime('now')),
  (SELECT u.id FROM users u WHERE u.id = m.created_by),
  COALESCE(m.updated_at, m.created_at, datetime('now')),
  datetime('now')
FROM supplier_product_map m
JOIN products p ON p.id = m.order_product_id
WHERE trim(m.coa_product_name_key) <> ''
  AND NOT EXISTS (
    SELECT 1 FROM product_identifiers pi
     WHERE pi.product_id = m.order_product_id
       AND pi.kind = 'supplier_name'
       AND pi.supplier_id = m.supplier_id
       AND trim(replace(replace(replace(pi.value_norm, '%', ' '), '  ', ' '), '  ', ' ')) = lower(m.coa_product_name_key)
  );

INSERT OR IGNORE INTO product_identifiers (
  id, tenant_id, product_id, kind, value, value_norm, supplier_id, superseded, confirmed, source, note,
  created_by, created_at, confirmed_by, confirmed_at, updated_at
)
SELECT
  lower(hex(randomblob(16))),
  m.tenant_id,
  m.order_product_id,
  'our_sku',
  trim(m.distributor_sku),
  upper(trim(m.distributor_sku)),
  NULL,
  0,
  1,
  'migrated_product_map',
  'Migrated from supplier_product_map row ' || m.id || ' (0075): the order-line product code taught together with the certificate product name ' || m.coa_product_name_key || '.',
  (SELECT u.id FROM users u WHERE u.id = m.created_by),
  COALESCE(m.created_at, datetime('now')),
  (SELECT u.id FROM users u WHERE u.id = m.created_by),
  COALESCE(m.updated_at, m.created_at, datetime('now')),
  datetime('now')
FROM supplier_product_map m
JOIN products p ON p.id = m.order_product_id
WHERE m.distributor_sku IS NOT NULL
  AND trim(m.distributor_sku) <> ''
  AND NOT (trim(m.distributor_sku) GLOB '*[^A-Za-z0-9]*')
  AND NOT EXISTS (
    SELECT 1 FROM product_identifiers pi
     WHERE pi.product_id = m.order_product_id
       AND pi.kind = 'our_sku'
       AND pi.supplier_id IS NULL
       AND pi.value_norm = upper(trim(m.distributor_sku))
  );

ALTER TABLE lot_match_suggestions ADD COLUMN match_note TEXT;
