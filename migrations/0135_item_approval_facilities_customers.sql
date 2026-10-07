-- Migration 0135: approved items, supplier facilities, customer COA contacts
-- and the customer's COA requirements per item.
--
-- WHY
-- ---
-- Decisions C-001, C-002 and C-004 (docs/decision-log.md, 2026-10-06), AJ
-- Conner's finish-line steps 1b / 1c / 1e:
--
--   C-001  Approval is its own status on the item-and-supplier pair, separate
--          from "currently supplied". Everything on file starts approved.
--   C-002  A facility is a named record under a supplier that a PERSON adds. A
--          printed plant code attaches to it as an identifier. There is no
--          "line" until a real case needs one.
--   C-004  Customer COA requirements: one row per customer and item.
--
-- Until now "approved" existed only as a column of the supplier list
-- spreadsheet, parsed and used to decide whether requirements are derived, and
-- then dropped. `customer_contacts` (0031) was written by the order connector
-- and read by nothing; `customers.coa_requirements` is a free-text blob no
-- code reads.
--
-- NOTHING HERE CHANGES A VERDICT. No gap, renewal alert, search answer or
-- order send reads a column this file adds in order to decide anything. The
-- order review gains information and a warning; nothing is blocked.
--
-- WHAT THIS ADDS
-- --------------
-- supplier_facilities -- a named place under a supplier. `name_norm` is
--     computed in code (lower-cased, whitespace collapsed -- the
--     owner_routes.owner_key discipline; no SQL collation trick), and both
--     key columns are NOT NULL so the plain UNIQUE(supplier_id, name_norm)
--     actually constrains (the 0087 rule). `plant_code` is the identifier a
--     certificate prints; it is recorded, never matched on -- nothing infers a
--     facility from a certificate. `active` = 0 retires a facility without
--     losing which items were made there.
--
-- product_suppliers.approval_status -- 'approved' / 'pending' /
--     'not_approved', CHECKed: a closed vocabulary this table owns, on a table
--     nothing references, so the CHECK costs no future rebuild. DEFAULT
--     'pending': a pair created after this migration starts pending whatever
--     door made it (a certificate naming a product, an admin, an import).
-- product_suppliers.approval_source -- 'initial' / 'person' / 'import'. No
--     CHECK (producers grow -- 0102's rule) and NO DEFAULT: NULL means nobody
--     and nothing has said anything about this pair yet.
-- product_suppliers.approval_decided_at / _by / approval_note -- who settled
--     it and when. `not_approved` needs a note (enforced by the API).
-- product_suppliers.facility_id -- the facility this item comes from, or NULL
--     = "no facility recorded", which counts toward the whole supplier.
--     ON DELETE SET NULL: removing a facility never removes a pair.
--
-- customer_contacts.coa_recipient -- whether this contact receives COAs on an
--     order send. DEFAULT 1: a contact on file is somebody the customer told
--     us about, and the review screen shows and lets the sender edit the list
--     before anything leaves.
--
-- customer_item_requirements -- what ONE customer needs for ONE item:
--     `coa_required` ('yes' / 'no' / 'on_request'), `must_show` (free text:
--     what the certificate has to state), `timing` (free text: with the
--     shipment, before it, monthly), `delivery_contact_id` (a contact of that
--     customer, ON DELETE SET NULL), `source` (nullable, no default, no
--     CHECK), `notes`. All three key columns NOT NULL, plain UNIQUE. Thin on
--     purpose: widened when AJ's column set arrives.
--
-- BACKFILL
-- --------
-- 1. A product linked to a supplier ONLY through the legacy
--    `products.supplier_id` column has no product_suppliers row to carry an
--    approval. One is created, with `source` left NULL -- "linked before
--    anyone recorded how", exactly what PUT /api/suppliers/:id/products/:pid
--    has written for such a link since 0123. Every reader already ORs the two
--    paths and reads NULL facts for a legacy-only link, so the gap engine's
--    input is identical before and after (pinned by
--    tests/api/migration-0135-item-approval.test.ts).
-- 2. EVERY pair then on file becomes 'approved' with approval_source
--    'initial' -- never 'person'. A row must not claim somebody decided it
--    (0102's rule): approval_decided_at / _by stay NULL. Guarded on
--    approval_source IS NULL so a second run changes nothing.
--
-- Additive only. No table is rebuilt.

CREATE TABLE IF NOT EXISTS supplier_facilities (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  supplier_id TEXT NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  name_norm TEXT NOT NULL,
  plant_code TEXT,
  notes TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by TEXT,
  UNIQUE(supplier_id, name_norm)
);

CREATE INDEX IF NOT EXISTS idx_supplier_facilities_supplier
  ON supplier_facilities(tenant_id, supplier_id);

ALTER TABLE product_suppliers ADD COLUMN approval_status TEXT NOT NULL DEFAULT 'pending'
  CHECK (approval_status IN ('approved', 'pending', 'not_approved'));
ALTER TABLE product_suppliers ADD COLUMN approval_source TEXT;
ALTER TABLE product_suppliers ADD COLUMN approval_decided_at TEXT;
ALTER TABLE product_suppliers ADD COLUMN approval_decided_by TEXT;
ALTER TABLE product_suppliers ADD COLUMN approval_note TEXT;
ALTER TABLE product_suppliers ADD COLUMN facility_id TEXT REFERENCES supplier_facilities(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_product_suppliers_approval
  ON product_suppliers(tenant_id, approval_status);

CREATE INDEX IF NOT EXISTS idx_product_suppliers_facility
  ON product_suppliers(facility_id) WHERE facility_id IS NOT NULL;

INSERT INTO product_suppliers (id, tenant_id, product_id, supplier_id)
SELECT lower(hex(randomblob(16))), p.tenant_id, p.id, p.supplier_id
  FROM products p
  JOIN suppliers s ON s.id = p.supplier_id AND s.tenant_id = p.tenant_id
 WHERE NOT EXISTS (SELECT 1 FROM product_suppliers ps
                    WHERE ps.product_id = p.id AND ps.supplier_id = p.supplier_id);

UPDATE product_suppliers
   SET approval_status = 'approved', approval_source = 'initial'
 WHERE approval_source IS NULL;

ALTER TABLE customer_contacts ADD COLUMN coa_recipient INTEGER NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS customer_item_requirements (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  coa_required TEXT NOT NULL DEFAULT 'yes'
    CHECK (coa_required IN ('yes', 'no', 'on_request')),
  must_show TEXT,
  timing TEXT,
  delivery_contact_id TEXT REFERENCES customer_contacts(id) ON DELETE SET NULL,
  source TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by TEXT,
  UNIQUE(tenant_id, customer_id, product_id)
);

CREATE INDEX IF NOT EXISTS idx_customer_item_requirements_customer
  ON customer_item_requirements(tenant_id, customer_id);

CREATE INDEX IF NOT EXISTS idx_customer_item_requirements_product
  ON customer_item_requirements(product_id);
