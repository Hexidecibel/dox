-- Migration 0022: Suppliers table and dynamic metadata columns
-- Replaces hardcoded lot_number, po_number, code_date, expiration_date with flexible JSON metadata tiers.
-- Old columns remain in schema (SQLite can't DROP) but are no longer used.

-- Suppliers table
CREATE TABLE IF NOT EXISTS suppliers (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  aliases TEXT,
  active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(tenant_id, slug)
);
CREATE INDEX IF NOT EXISTS idx_suppliers_tenant ON suppliers(tenant_id, active);

-- Add supplier_id and metadata columns to documents
ALTER TABLE documents ADD COLUMN supplier_id TEXT REFERENCES suppliers(id);
ALTER TABLE documents ADD COLUMN primary_metadata TEXT;
ALTER TABLE documents ADD COLUMN extended_metadata TEXT;
