-- 0107 — the PRODUCT IDENTIFIER GRAPH: every name and number a product goes by,
-- with where each one came from and whether a person has confirmed it.
--
-- NUMBERING: written in parallel with the intake duplicate-detection branch,
-- which may also claim 0107. Whichever lands second renumbers; nothing in this
-- file depends on its number.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- THE PROBLEM (AJ Conner, Any-Field COA Retrieval, 2026-09-08, D5 / R5 / R7)
-- ═══════════════════════════════════════════════════════════════════════════
-- "2235 versus 810004. 'DG BTR BULK U/S 55.115#' versus 'SWEET CREAM BUTTER -
-- Btr NS Gr AA 25kg.' U/S and NS are the same attribute; 55.115# and 25kg are
-- the same pack. Nothing declares these equivalent."
--
-- A person names a product the way THEY know it: our WMS code (2235), the
-- supplier's item number printed on the certificate (810004), the supplier's
-- product name, a pack ("300 gal tote"), or plain words ("bulk unsalted
-- butter"). Search could match none of those to the certificate, because the
-- certificate carries the SUPPLIER's identity and the order carries OURS.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- WHY A NEW TABLE AND NOT THE TWO THAT ALMOST FIT
-- ═══════════════════════════════════════════════════════════════════════════
--   supplier_product_map (0075)  UNIQUE(tenant, supplier, coa_product_name_key):
--       ONE row per supplier product NAME. Country Morning prints the same name,
--       "Cream - Heavy Whipping 40%", on two different items — 30904 (a 300
--       gallon tote, our 10286) and 50903 (a 5 gallon bag, our 0801) — so the
--       key cannot hold both. It is also read by the lot-matching engine;
--       rebuilding its uniqueness would change matching to serve search.
--   product_suppliers.supplier_sku (0064)  UNIQUE(product_id, supplier_id):
--       one SKU per product per supplier, no provenance, empty on prod.
--
-- Both stay as they are. This table answers a different question — "what does
-- this product go by" — and it has to say, per value, who said so.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- SHAPE
-- ═══════════════════════════════════════════════════════════════════════════
-- Anchored on `products` (product_id NOT NULL): the product is OUR product,
-- the one our SKU names. A supplier's generic product record that several of
-- our SKUs share ("Cream - Heavy Whipping 40%") is NOT the anchor — it enters
-- as a `supplier_name` identifier on each of our products instead, and the pack
-- tells them apart.
--
--   kind  our_sku        our (WMS) product code             supplier_id NULL
--         supplier_item  the supplier's item number         supplier_id NOT NULL
--         supplier_name  the supplier's product name        supplier_id NOT NULL
--         alias          a free-text name people use        supplier_id NULL
--         gtin           a GTIN / UPC                       supplier_id NULL
--         pack           the pack, as written ("300 Gallon Tote", "55.115 lb")
--                                                           supplier_id NULL
--   The CHECK pairs kind with supplier_id both ways, so a supplier-independent
--   kind can never carry a supplier and a supplier's number can never float
--   free of the supplier that issued it.
--
--   value       as written. value_norm is the comparison key (upper-case
--               alphanumerics for codes, lower-cased collapsed words for names),
--               computed by functions/lib/product-identifiers.ts — never in SQL.
--   superseded  1 = a FORMER number (a supplier renumbered the item). Still
--               found by search, and said to be former.
--   confirmed   0 = a candidate. It may help a search FIND something, and every
--               result reached through it says "via unconfirmed …" and is
--               "likely — confirm", never covering. 1 = a person (or a seed from
--               evidence named in `note`) stands behind it.
--   source      'seed' | 'reviewer' | 'extracted' | 'import'. CHECKed: this word
--               decides how a result is explained to a customer's QA manager.
--   note        the evidence, in words ("printed as CUSTOMER ITEM # on CMF
--               certificates"; "AJ has not confirmed what 310348 is").
--
-- ═══════════════════════════════════════════════════════════════════════════
-- THE NULL-DISTINCTNESS TRAP (0086 / 0087 / 0091)
-- ═══════════════════════════════════════════════════════════════════════════
-- supplier_id is nullable BY KIND, so one UNIQUE over it would let unlimited
-- duplicate supplier-independent rows exist (SQLite treats NULLs as distinct).
-- Answered with two PARTIAL unique indexes (0090's pattern): one over the rows
-- that have a supplier, one over the rows that do not. Each index's key
-- columns are NOT NULL inside its WHERE, so each actually constrains.
--
-- Uniqueness is per PRODUCT, not per tenant: two products claiming the same
-- our_sku is a data problem search must SHOW ("could mean: …"), not one a
-- constraint should hide by refusing the second write.
--
-- Rows are removed by DELETE with an audit row carrying the whole row
-- (`product_identifier.removed`); there is no soft-delete column because a
-- removed identifier must stop resolving searches immediately.
--
-- No order index is added for the A7 order lookup: orders already carries
-- UNIQUE(tenant_id, order_number), whose autoindex is exactly that seek.

CREATE TABLE IF NOT EXISTS product_identifiers (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('our_sku', 'supplier_item', 'supplier_name', 'alias', 'gtin', 'pack')),
  value TEXT NOT NULL,
  value_norm TEXT NOT NULL,
  supplier_id TEXT REFERENCES suppliers(id),
  superseded INTEGER NOT NULL DEFAULT 0 CHECK (superseded IN (0, 1)),
  confirmed INTEGER NOT NULL DEFAULT 0 CHECK (confirmed IN (0, 1)),
  source TEXT NOT NULL CHECK (source IN ('seed', 'reviewer', 'extracted', 'import')),
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

CREATE UNIQUE INDEX IF NOT EXISTS idx_product_identifiers_unique_supplier
  ON product_identifiers (product_id, kind, supplier_id, value_norm)
  WHERE supplier_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_product_identifiers_unique_plain
  ON product_identifiers (product_id, kind, value_norm)
  WHERE supplier_id IS NULL;

-- The search-time lookup: every identifier a tenant holds, by value.
CREATE INDEX IF NOT EXISTS idx_product_identifiers_lookup
  ON product_identifiers (tenant_id, value_norm);

CREATE INDEX IF NOT EXISTS idx_product_identifiers_product
  ON product_identifiers (product_id);
