-- Migration 0089: alert links — the gate for the "alerted owner" mode.
--
-- WHO THIS IS FOR
-- ---------------
-- Some of the people who must act on an alert are not portal users and never
-- will be: the plant QA lead who renews a certificate once a year, the person
-- on the distribution list for out-of-spec results. Their whole experience is
-- the email plus one link that lands on the thing needing attention. Today the
-- spec alert links to /documents/<id>, which is behind ProtectedRoute, so that
-- person lands on a login screen and the alert has failed.
--
-- A row here is that link: an unguessable token that opens ONE read-only view
-- of ONE alert event.
--
-- THE TOKEN IS THE ONLY GATE, SO THE SCOPE IS THE SECURITY
-- -------------------------------------------------------
-- Entropy and shape follow the existing precedent (records update requests /
-- workflow approvals): 32 random bytes -> base64url, ~43 chars.
--
-- What differs from those is that this one is READ-only, so replay is not a
-- state-change risk. The real risk is DURATION: an email sits in an inbox for
-- years and gets forwarded. So:
--
--   * expires_at is NOT NULL. Every link dies. A never-expiring token in an
--     email is a permanent unauthenticated read of a compliance record.
--   * NOT single-use. The alerted owner opens it on a phone, again at a desk,
--     and forwards it to whoever actually does the renewal. Burning it on the
--     first GET (or on a mail client's link preview) would break the exact
--     workflow this exists to serve. Duration is handled by expiry; abuse is
--     handled by rate limiting and the audit row.
--   * revoked_at is a kill switch, so a link known to have leaked can be shut
--     off without waiting out its window.
--
-- SCOPED TO AN EVENT, NOT TO A DOCUMENT FOREVER
-- ---------------------------------------------
-- A link's authority is exactly "the thing this one email was about". A spec
-- alert is one document (one email per document, by design), so document_id is
-- set. A renewal alert is a digest of N documents, so subject_ids carries that
-- exact set. Re-alerting mints a NEW link rather than reusing an old one --
-- which means an old forwarded link never widens to cover documents that were
-- not in the email it came from.

CREATE TABLE IF NOT EXISTS alert_links (
  id TEXT PRIMARY KEY,
  -- 32 random bytes, base64url, no padding.
  token TEXT NOT NULL UNIQUE,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('spec_alert', 'renewal_alert')),

  -- Set for spec_alert (one document per alert). NULL for renewal digests.
  document_id TEXT REFERENCES documents(id) ON DELETE CASCADE,
  -- JSON array of document ids for renewal_alert digests. NULL for spec_alert.
  subject_ids TEXT,

  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  revoked_at TEXT,

  -- Cheap "has anyone opened this" signal. The authoritative record of each
  -- view is the audit_log row (action = 'alert_link.view'); these two columns
  -- exist so the question can be answered without scanning the audit table.
  view_count INTEGER NOT NULL DEFAULT 0,
  last_viewed_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_alert_links_token ON alert_links(token);
CREATE INDEX IF NOT EXISTS idx_alert_links_tenant ON alert_links(tenant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_alert_links_document
  ON alert_links(document_id) WHERE document_id IS NOT NULL;
