-- Email domain to tenant mapping for email ingest
CREATE TABLE IF NOT EXISTS email_domain_mappings (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  domain TEXT NOT NULL,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  default_user_id TEXT REFERENCES users(id),
  active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(domain)
);

CREATE INDEX IF NOT EXISTS idx_email_domain_mappings_domain ON email_domain_mappings(domain);
