-- Per-tenant file naming templates
CREATE TABLE IF NOT EXISTS naming_templates (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  template TEXT NOT NULL DEFAULT '{title}.{ext}',
  active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(tenant_id)
);
