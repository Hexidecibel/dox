-- Migration 0042: Records customer_ref column type + customer ref index
--
-- Brings Records into parity with the existing Customer entity model.
-- Customers are a first-class entity (created in 0030, populated by the
-- ERP/WMS connector). Records did not yet recognize them, so the seeded
-- Quality Intake "Customer" column had to fall back to free-text input.
--
-- Two CHECK constraints widen here:
--   records_columns.type   -> add 'customer_ref'
--   records_row_refs.ref_type -> add 'customer'
--
-- SQLite doesn't allow ALTER TABLE ... CHECK, so we follow the
-- create-new + copy + drop + rename + reindex pattern. All other
-- columns, defaults, foreign keys, and indexes are preserved verbatim
-- against migrations/0040_records_core.sql.

-- D1 (remote) rejects explicit BEGIN/COMMIT — wrangler wraps each
-- multi-statement upload in a single transaction internally. The
-- create-new + copy + drop + rename pattern below is therefore
-- atomic at the wrangler level even without an explicit transaction.
PRAGMA foreign_keys = OFF;

-- =====================================================================
-- records_columns: widen type CHECK to include 'customer_ref'
-- =====================================================================
CREATE TABLE records_columns_new (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  sheet_id TEXT NOT NULL REFERENCES records_sheets(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  key TEXT NOT NULL,
  label TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN (
    'text','long_text','number','currency','percent','date','datetime',
    'duration','checkbox','dropdown_single','dropdown_multi','contact',
    'email','url','phone','attachment','formula','rollup',
    'supplier_ref','product_ref','document_ref','record_ref','customer_ref'
  )),
  config TEXT,
  required INTEGER DEFAULT 0,
  is_title INTEGER DEFAULT 0,
  display_order INTEGER NOT NULL DEFAULT 0,
  width INTEGER,
  archived INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(sheet_id, key)
);

INSERT INTO records_columns_new (
  id, sheet_id, tenant_id, key, label, type, config, required, is_title,
  display_order, width, archived, created_at, updated_at
)
SELECT
  id, sheet_id, tenant_id, key, label, type, config, required, is_title,
  display_order, width, archived, created_at, updated_at
FROM records_columns;

DROP TABLE records_columns;
ALTER TABLE records_columns_new RENAME TO records_columns;

CREATE INDEX IF NOT EXISTS idx_records_columns_sheet ON records_columns(sheet_id, display_order);
CREATE INDEX IF NOT EXISTS idx_records_columns_tenant ON records_columns(tenant_id);

-- =====================================================================
-- records_row_refs: widen ref_type CHECK to include 'customer'
-- =====================================================================
CREATE TABLE records_row_refs_new (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  sheet_id TEXT NOT NULL REFERENCES records_sheets(id) ON DELETE CASCADE,
  row_id TEXT NOT NULL REFERENCES records_rows(id) ON DELETE CASCADE,
  column_key TEXT NOT NULL,
  ref_type TEXT NOT NULL CHECK (ref_type IN ('supplier','product','document','record','contact','customer')),
  ref_id TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

INSERT INTO records_row_refs_new (
  id, tenant_id, sheet_id, row_id, column_key, ref_type, ref_id, created_at
)
SELECT
  id, tenant_id, sheet_id, row_id, column_key, ref_type, ref_id, created_at
FROM records_row_refs;

DROP TABLE records_row_refs;
ALTER TABLE records_row_refs_new RENAME TO records_row_refs;

CREATE INDEX IF NOT EXISTS idx_records_row_refs_row ON records_row_refs(row_id);
CREATE INDEX IF NOT EXISTS idx_records_row_refs_supplier ON records_row_refs(tenant_id, ref_type, ref_id) WHERE ref_type = 'supplier';
CREATE INDEX IF NOT EXISTS idx_records_row_refs_product ON records_row_refs(tenant_id, ref_type, ref_id) WHERE ref_type = 'product';
CREATE INDEX IF NOT EXISTS idx_records_row_refs_document ON records_row_refs(tenant_id, ref_type, ref_id) WHERE ref_type = 'document';
CREATE INDEX IF NOT EXISTS idx_records_row_refs_record ON records_row_refs(tenant_id, ref_type, ref_id) WHERE ref_type = 'record';
CREATE INDEX IF NOT EXISTS idx_records_row_refs_contact ON records_row_refs(tenant_id, ref_type, ref_id) WHERE ref_type = 'contact';
CREATE INDEX IF NOT EXISTS idx_records_row_refs_customer ON records_row_refs(tenant_id, ref_type, ref_id) WHERE ref_type = 'customer';
CREATE INDEX IF NOT EXISTS idx_records_row_refs_lookup ON records_row_refs(tenant_id, ref_type, ref_id);

PRAGMA foreign_keys = ON;
