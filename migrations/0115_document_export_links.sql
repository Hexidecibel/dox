-- Migration 0115: document export links -- handing a search result to someone
-- who will never log in.
--
-- WHO THIS IS FOR
-- ---------------
-- AJ Conner, 2026-09-14: he spends one to three hours a day answering document
-- requests, and the person doing the searching is usually forwarding what they
-- find to a salesperson, who forwards it to a customer. Until now the only way
-- out of search was opening each result and pressing download, one at a time,
-- then attaching the files to a mail client by hand -- at which point the
-- portal knows nothing about what left the building.
--
-- A row here is the record of one send: exactly which documents, to exactly
-- which addresses, by exactly which user, on whose behalf, and until when.
--
-- WHY A LINK AND NOT ATTACHMENTS
-- ------------------------------
-- Attachments would blow every mail size limit the moment somebody selects a
-- dozen certificates, and -- the real reason -- an attachment leaves no trail.
-- Once it is in an inbox nobody can say whether it was opened, and it can
-- never be withdrawn. A link is revocable (revoked_at), expiring
-- (expires_at NOT NULL) and every open writes an audit row.
--
-- THE SCOPE IS THE SECURITY, EXACTLY AS IN 0089
-- --------------------------------------------
-- Token shape follows the existing precedent: 32 random bytes -> base64url.
-- document_ids is the frozen list the email named; the landing page reads that
-- list and nothing else, so a link forwarded on can never widen to a document
-- that was not in the email it came from. Items are addressed by their
-- POSITION in that list, never by a document id, so a recipient holds no
-- internal identifier they could aim at another endpoint.
--
-- HOW THIS DIFFERS FROM alert_links (0089)
-- ----------------------------------------
-- An alert link is read-only on purpose: it tells a vendor that something
-- needs attention and deliberately offers no file. This one EXISTS to hand
-- files over, so the landing page does download. Everything else is tightened
-- to pay for that: the sender is a portal user (created_by NOT NULL, so every
-- send has a person behind it), the recipients are recorded, and sends are
-- rate limited per user.
--
-- NOT SINGLE-USE, for the same reason as 0089: the recipient opens it on a
-- phone, again at a desk, and forwards it to whoever actually needs the
-- certificate. Duration is handled by expiry, abuse by rate limiting plus the
-- view/download audit rows.

-- Plain-ASCII header on purpose (the 0110 D1 import finding). Renumbered from
-- 0114 to 0115 on merge: 0114 was taken by spec_unmatched_ignores.

CREATE TABLE IF NOT EXISTS document_export_links (
  id TEXT PRIMARY KEY,
  -- 32 random bytes, base64url, no padding.
  token TEXT NOT NULL UNIQUE,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

  -- JSON array of document ids: the EXACT set the email named, in the order
  -- the sender selected them. NOT NULL and never rewritten -- an amendment is
  -- a new send, which is a new link.
  document_ids TEXT NOT NULL,

  -- The portal user who sent it. NOT NULL: an anonymous export is not
  -- provable, and provability is the point.
  created_by TEXT NOT NULL REFERENCES users(id),
  -- Free text, e.g. "Dana Reid <dana@example.com>". The person typing chooses
  -- who it is for; this is printed in the email as context, never used as a
  -- from address. Nothing in the portal impersonates anybody.
  on_behalf_of TEXT,
  -- JSON array of the addresses the email was sent to, so the audit answer
  -- survives even if the audit row is filtered away.
  recipients TEXT NOT NULL,
  message TEXT,

  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  revoked_at TEXT,

  -- Cheap "has anyone opened this" signals. The authoritative record of each
  -- view and each download is the audit_log row; these exist so the question
  -- can be answered without scanning the audit table.
  view_count INTEGER NOT NULL DEFAULT 0,
  last_viewed_at TEXT,
  download_count INTEGER NOT NULL DEFAULT 0,
  last_downloaded_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_document_export_links_token
  ON document_export_links(token);
CREATE INDEX IF NOT EXISTS idx_document_export_links_tenant
  ON document_export_links(tenant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_document_export_links_sender
  ON document_export_links(created_by, created_at);
