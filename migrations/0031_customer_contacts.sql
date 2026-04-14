-- Migration 0031: customer_contacts join table
--
-- Each customer can have multiple named contacts with emails. Unblocks the
-- email connector's XLSX path which extracts a customer registry where each
-- customer has 2-5 contact emails (e.g. "(K00166) CHUCKANUT BAY FOODS:
-- alice@chuckanut.com; bob@chuckanut.com; orders@chuckanut.com").
--
-- The existing customers.email column is kept as a convenience "primary
-- contact" backfill, populated from the first contact at insert time.

CREATE TABLE IF NOT EXISTS customer_contacts (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT,
  email TEXT NOT NULL,
  role TEXT,
  is_primary INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_customer_contacts_customer ON customer_contacts(customer_id);
CREATE INDEX IF NOT EXISTS idx_customer_contacts_tenant ON customer_contacts(tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_customer_contacts_unique ON customer_contacts(customer_id, lower(email));
