-- WHAT A REQUIREMENT IS OWED PER -- once per supplier, once per product, or
-- once per lot -- and the two product facts that make "per product" honest.
--
-- AJ, 2026-09-28: "an ingredient statement is per product, for every supplier".
-- Until this migration a requirement attached to a supplier was closed by ONE
-- confirmed document from that supplier, whatever it covered. A spec sheet for
-- one of twelve products closed the spec-sheet line for all twelve, which is
-- the false-clean the gap engine exists to refuse.
--
-- (1) requirements.scope ('supplier' / 'product' / 'lot'). NOT NULL DEFAULT
--     'supplier', so every existing row and every existing gap is unchanged the
--     day this lands. The vocabulary is enforced IN CODE (shared/requirementScope.ts),
--     NOT by a CHECK: requirements is the target of several CASCADE foreign
--     keys, so widening a CHECK later (a 'facility' scope is already foreseen)
--     would force exactly the table rebuild CLAUDE.md warns about. An unknown
--     stored value reads as 'supplier'. 'lot' may be stored now; per-lot
--     checking is not built yet and the engine says so rather than guessing.
--     Scope belongs to the REQUIREMENT, not to supplier_requirements: it says
--     what the thing is. supplier_requirements stays the one attach point, and
--     attaching a product-scope requirement to S means "owed for every active
--     product of S".
--
-- (2) product_requirements -- the per-product exception, both directions.
--     'exempt' removes an inherited product-scope item for ONE product (a
--     packaging SKU owes no nutritionals); the API requires a reason. 'add'
--     makes a requirement owed by one product only. supplier_id is part of the
--     key because supplier A's spec sheet does not cover supplier B's version
--     of the same product. All four key columns are NOT NULL, so a plain UNIQUE
--     constrains (the 0087 rule; no COALESCE index needed). source/reason are
--     nullable with no default (the 0102 discipline).
--
-- (3) product_suppliers becomes the authority on "active product of S":
--     source            'certificate' / 'admin' / 'import' / 'connector'.
--                       NULL = linked before anyone recorded how, which is the
--                       literal truth of every existing row. No CHECK (producers
--                       grow), no backfill.
--     discontinued_at/_by  "no longer supplied". NULL = currently supplied.
--     nothing_owed_reason/_at/_by  a person declared this product owes nothing
--                       per product (with a reason), so it reads as settled
--                       rather than as "nothing set up".
--
-- Additive only: ALTER TABLE ADD COLUMN plus one CREATE TABLE. No rebuild.
-- Plain-ASCII header (the 0110 D1 import finding).

ALTER TABLE requirements ADD COLUMN scope TEXT NOT NULL DEFAULT 'supplier';

CREATE TABLE IF NOT EXISTS product_requirements (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  supplier_id TEXT NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  requirement_id TEXT NOT NULL REFERENCES requirements(id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK (mode IN ('add', 'exempt')),
  tier TEXT NOT NULL DEFAULT 'required' CHECK (tier IN ('required', 'recommended')),
  reason TEXT,
  source TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by TEXT,
  UNIQUE (tenant_id, supplier_id, product_id, requirement_id)
);

CREATE INDEX IF NOT EXISTS idx_product_requirements_supplier
  ON product_requirements (tenant_id, supplier_id);
CREATE INDEX IF NOT EXISTS idx_product_requirements_product
  ON product_requirements (product_id);
CREATE INDEX IF NOT EXISTS idx_product_requirements_requirement
  ON product_requirements (requirement_id);

ALTER TABLE product_suppliers ADD COLUMN source TEXT;
ALTER TABLE product_suppliers ADD COLUMN discontinued_at TEXT;
ALTER TABLE product_suppliers ADD COLUMN discontinued_by TEXT;
ALTER TABLE product_suppliers ADD COLUMN nothing_owed_reason TEXT;
ALTER TABLE product_suppliers ADD COLUMN nothing_owed_at TEXT;
ALTER TABLE product_suppliers ADD COLUMN nothing_owed_by TEXT;
