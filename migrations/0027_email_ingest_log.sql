-- Email ingest log for tracking inbound emails
CREATE TABLE IF NOT EXISTS email_ingest_log (
  id TEXT PRIMARY KEY,
  tenant_id TEXT REFERENCES tenants(id),
  sender_email TEXT NOT NULL,
  sender_name TEXT,
  subject TEXT,
  attachment_count INTEGER DEFAULT 0,
  results TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_email_ingest_log_tenant ON email_ingest_log(tenant_id, created_at);
