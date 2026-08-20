-- Migration 0084: spec limits — OUR acceptance criteria for COA test results.
--
-- BACKGROUND
-- ----------
-- The portal reads a COA. It has never judged one. Every micro result — coliform,
-- SPC/APC, yeast & mold — lands in the review queue looking exactly like a clean
-- one, and a 40 CFU/g coliform against a 10 CFU/g limit passes a human gate that
-- was never given the limit to check against.
--
-- Phase 0 (already shipped, no schema) checks a result against the limit the COA
-- ITSELF prints. This migration adds the more valuable half: the limit WE hold.
-- A supplier's COA passes against the supplier's spec; the customer spec is
-- routinely tighter, and that gap is the thing nobody catches today.
--
-- TWO TABLES, AND WHY THE FIRST ONE EXISTS
-- ----------------------------------------
-- `spec_limits` alone would look sufficient — a test name, an operator, a number.
-- It isn't, because the test name is not stable across suppliers. One prints
-- "Coliform", another "Coliforms (MPN)", another "Total Coliform"; SPC / APC /
-- TPC / Standard Plate Count / Aerobic Plate Count are all one test. The
-- thresholds are the easy part; the SYNONYM MAP is the actual work, and it is
-- per-tenant knowledge that must outlive any single limit row.
--
-- So `spec_tests` owns the analyte and its aliases, and `spec_limits` hangs
-- thresholds off it. Editing a limit never disturbs the mapping, and one mapping
-- serves every limit for that analyte.
--
-- SCOPE RESOLUTION — most specific wins
-- -------------------------------------
-- A limit may be pinned to a product, a supplier, a document type, any
-- combination, or none of them. All three columns are NULLABLE and NULL means
-- "any". Specificity is scored at read time (see resolveSpecLimits in
-- shared/specCheck.ts):
--
--     product + supplier + doctype   most specific
--     product
--     supplier + doctype
--     supplier
--     doctype
--     (all NULL)                     tenant-wide default
--
-- This ordering is deliberate. A tenant-wide "coliform ≤ 10 CFU/g" row works on
-- day one, before a single supplier is configured, which is what keeps this
-- feature standalone. Product scoping is available but never REQUIRED — product
-- identity is the known-weak spot in this system (the two-catalog gap that
-- supplier_product_map exists to bridge), and making limits depend on it would
-- inherit that problem wholesale.
--
-- NOTHING HERE BLOCKS ANYTHING. These rows feed advisory warnings on the review
-- queue. No trigger, no constraint, and no code path built on this table can
-- refuse an approval.

CREATE TABLE IF NOT EXISTS spec_tests (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- Canonical analyte name, as the tenant thinks of it: 'Coliform'.
  name TEXT NOT NULL,
  -- JSON array of the names suppliers actually print:
  -- ["Coliforms (MPN)", "Total Coliform", "COLIFORM CT"].
  aliases TEXT NOT NULL DEFAULT '[]',
  -- Unit a limit on this analyte is assumed to be stated in when it omits one.
  default_unit TEXT,
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  updated_by TEXT REFERENCES users(id),
  UNIQUE (tenant_id, name)
);

CREATE INDEX IF NOT EXISTS idx_spec_tests_tenant ON spec_tests(tenant_id);

CREATE TABLE IF NOT EXISTS spec_limits (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  spec_test_id TEXT NOT NULL REFERENCES spec_tests(id) ON DELETE CASCADE,

  -- All three NULLABLE; NULL means "any". See the scope note above.
  supplier_id TEXT REFERENCES suppliers(id) ON DELETE CASCADE,
  document_type_id TEXT REFERENCES document_types(id) ON DELETE CASCADE,
  product_id TEXT REFERENCES products(id) ON DELETE CASCADE,

  -- '<' / '<=' / '>' / '>=' use one bound; 'between' uses both; 'absent' uses
  -- neither and is satisfied by Absent / Negative / ND / None detected.
  operator TEXT NOT NULL CHECK (operator IN ('<', '<=', '>', '>=', 'between', '==', 'absent')),
  value_min REAL,
  value_max REAL,
  unit TEXT,

  -- 'alert' notifies the combo owner; 'warn' shows in the queue only. Both are
  -- advisory — neither blocks an approval.
  severity TEXT NOT NULL DEFAULT 'alert' CHECK (severity IN ('warn', 'alert')),

  notes TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  -- Bumped on every edit. A verdict records the limit it was judged against by
  -- value (see document_spec_checks.limit_snapshot), so history stays readable
  -- after a threshold moves; this counter is for the UI and the audit trail.
  version INTEGER NOT NULL DEFAULT 1,

  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  updated_by TEXT REFERENCES users(id)
);

-- The read path resolves every candidate limit for a (tenant, supplier,
-- doctype, product) tuple and scores them, so the useful index is on the
-- tenant + analyte, with the scope columns along for the ride.
CREATE INDEX IF NOT EXISTS idx_spec_limits_tenant_test ON spec_limits(tenant_id, spec_test_id, active);
CREATE INDEX IF NOT EXISTS idx_spec_limits_supplier ON spec_limits(supplier_id);
CREATE INDEX IF NOT EXISTS idx_spec_limits_product ON spec_limits(product_id);
