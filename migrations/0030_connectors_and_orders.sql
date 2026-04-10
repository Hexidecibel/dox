-- Migration 0030: Connectors, connector runs, customers, orders, order items

CREATE TABLE IF NOT EXISTS connectors (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  name TEXT NOT NULL,
  connector_type TEXT NOT NULL CHECK (connector_type IN ('email', 'api_poll', 'webhook', 'file_watch')),
  system_type TEXT NOT NULL DEFAULT 'other' CHECK (system_type IN ('erp', 'wms', 'other')),
  config TEXT NOT NULL DEFAULT '{}',
  field_mappings TEXT NOT NULL DEFAULT '{}',
  credentials_encrypted TEXT,
  credentials_iv TEXT,
  schedule TEXT,
  active INTEGER DEFAULT 1,
  last_run_at TEXT,
  last_error TEXT,
  created_by TEXT REFERENCES users(id),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_connectors_tenant ON connectors(tenant_id, active);

CREATE TABLE IF NOT EXISTS connector_runs (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  connector_id TEXT NOT NULL REFERENCES connectors(id),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'success', 'partial', 'error')),
  started_at TEXT DEFAULT (datetime('now')),
  completed_at TEXT,
  records_found INTEGER DEFAULT 0,
  records_created INTEGER DEFAULT 0,
  records_updated INTEGER DEFAULT 0,
  records_errored INTEGER DEFAULT 0,
  error_message TEXT,
  details TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_connector_runs_connector ON connector_runs(connector_id, started_at);
CREATE INDEX IF NOT EXISTS idx_connector_runs_tenant ON connector_runs(tenant_id, started_at);

CREATE TABLE IF NOT EXISTS customers (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  customer_number TEXT NOT NULL,
  name TEXT NOT NULL,
  email TEXT,
  coa_delivery_method TEXT DEFAULT 'email' CHECK (coa_delivery_method IN ('email', 'portal', 'none')),
  coa_requirements TEXT,
  active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(tenant_id, customer_number)
);
CREATE INDEX IF NOT EXISTS idx_customers_tenant ON customers(tenant_id, active);
CREATE INDEX IF NOT EXISTS idx_customers_number ON customers(tenant_id, customer_number);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  connector_id TEXT REFERENCES connectors(id),
  connector_run_id TEXT REFERENCES connector_runs(id),
  order_number TEXT NOT NULL,
  po_number TEXT,
  customer_id TEXT REFERENCES customers(id),
  customer_number TEXT,
  customer_name TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'enriched', 'matched', 'fulfilled', 'delivered', 'error')),
  source_data TEXT,
  error_message TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(tenant_id, order_number)
);
CREATE INDEX IF NOT EXISTS idx_orders_tenant_status ON orders(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(tenant_id, customer_id);
CREATE INDEX IF NOT EXISTS idx_orders_connector ON orders(connector_id);

CREATE TABLE IF NOT EXISTS order_items (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id TEXT REFERENCES products(id),
  product_name TEXT,
  product_code TEXT,
  quantity REAL,
  lot_number TEXT,
  lot_matched INTEGER DEFAULT 0,
  coa_document_id TEXT REFERENCES documents(id),
  match_confidence REAL,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_order_items_lot ON order_items(lot_number);
