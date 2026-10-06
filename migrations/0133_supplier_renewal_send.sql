-- Migration 0133: the supplier renewal send -- a drafted request, ONE human
-- approval, then mail to the supplier (AJ Conner, decision rows D-040..D-051).
--
-- WHY
-- ---
-- Until now the portal never emailed a supplier. Issuing a request minted a
-- link a person copied by hand, a supplier had no contact on record, and the
-- renewal engine (0091) told only the INTERNAL owner that a document was
-- running out. The owner then wrote the supplier an email from their own
-- mailbox, which is the hour a day the portal exists to give back.
--
-- This adds the outbound half, and its one rule is not negotiable:
--
--   THE PORTAL NEVER EMAILS A SUPPLIER ON ITS OWN.
--
-- The scheduled run only DRAFTS. Every message that reaches a supplier has
-- been approved, once, by a named person, and the row records who and when
-- and the exact words that left.
--
-- FOUR CHANGES
-- ------------
-- 1. supplier_contacts        who at the supplier receives document requests.
-- 2. tenants.default_owner_*  the "master user" (D-050): who approves when a
--                             record's owner route names no portal user.
-- 3. renewal_requests         one row per (document, due date) CYCLE.
-- 4. renewal_request_sends    one row per STAGE of a cycle: the draft, its
--                             approver, and what was actually sent.
--
-- supplier_contacts
-- -----------------
-- One row to start with: the document contact. `role` and `priority` are the
-- roster AJ wants later (QA lead, sales rep, an escalation order) and are
-- nullable with no CHECK so the roster can arrive without a rebuild.
--
-- `email_norm` (trimmed, lower-cased, computed in code -- there is no SQL
-- collation trick, same as owner_routes.owner_key in 0091) is the identity,
-- so "QA@Supplier.com" and "qa@supplier.com" are one contact. Both key
-- columns of UNIQUE(supplier_id, email_norm) are NOT NULL, so the plain
-- UNIQUE actually constrains (the 0087 rule; 0086 is what happens otherwise).
--
-- "The document contact" has to be ONE address or the question "who will this
-- go to" has two answers on the approval screen. A partial unique index says
-- so: at most one ACTIVE row per supplier with is_document_contact = 1.
--
-- A supplier with no document contact gets NO draft. It is reported on the
-- Renewals page and in the run result, never silently skipped -- and that is
-- also what makes this migration inert on the day it lands: no tenant has a
-- contact, so no tenant gets a draft or a new email until an admin adds one.
--
-- tenants.default_owner_user_id
-- -----------------------------
-- Bare TEXT, no foreign key, on purpose. It is resolved at read time against
-- an ACTIVE user of this tenant, so a master user who is deactivated simply
-- stops resolving and the approver falls to the org_admins -- nobody has to
-- remember to clear the setting, and a user row can still be removed.
-- `_updated_at` / `_updated_by` are the 0093 stamp pattern.
--
-- renewal_requests -- the cycle
-- -----------------------------
-- UNIQUE(document_id, due_date): the cycle is "this document, running out on
-- this date". That key is what makes the drafting pass idempotent -- the cron
-- and a person pressing "Send renewal alerts" on the same morning cannot open
-- two cycles -- and it is what ends a cycle honestly: when the due date moves,
-- the old cycle is closed and the next date is a NEW row, not an edit.
--
-- `request_id` is NULL until the first approval. Nothing is composed or issued
-- by the scheduled run: the document request (0090) and its supplier link
-- (0092) are created by the APPROVING person through the one issue path, so
-- "a generator drafts, a human issues" holds without an exception. It names
-- the request ROOT (a first version is its own root). ON DELETE SET NULL: a
-- request that is removed must not take the record of what was sent with it.
--
-- status:
--   open       drafting and follow-ups continue
--   satisfied  a replacement was accepted against the request
--   stopped    the due date changed, the document was archived, or it no
--              longer names this supplier (status_reason says which)
--   escalated  the last follow-up window passed with nothing accepted; told
--              to the tenant's admins once, nothing further is drafted
--
-- renewal_request_sends -- the stage
-- ----------------------------------
-- Four stages, fixed: the alert window opening, the day of expiry, 7 days
-- after, 14 days after. UNIQUE(renewal_request_id, stage) therefore caps a
-- cycle at FOUR messages to a supplier structurally (D-051), not by a counter
-- somebody could forget to check. A newer stage SUPERSEDES an older one that
-- nobody approved, so at most one draft is ever waiting.
--
-- status:
--   pending     drafted, waiting for one approval
--   sent        approved and accepted by the mail provider
--   failed      approved, the send was refused; retryable, nothing claims it
--               was sent
--   skipped     a person decided this stage should not go
--   superseded  a later stage replaced it before anyone approved
--   cancelled   the cycle ended (see renewal_requests.status) first
--
-- `draft_subject` / `draft_body` are what the fixed template produced and are
-- never rewritten. `sent_subject` / `sent_body` are the EXACT text that left,
-- after the approver's edits and with the system's link block appended -- the
-- send-sequence record asks for precisely that, and a draft is not it.
-- `approver_user_id` NULL means no single person resolved and any org_admin
-- may approve; `approver_via` says which rung answered.
-- `notified_at` is when the approver was told a draft is waiting, so a draft
-- is announced once, not every morning it is still unapproved.
-- `attempt_count` is the claim: an approve bumps it under a guard so a double
-- click cannot send twice.
--
-- Additive only: three new tables and three nullable columns. No rebuild, no
-- backfill, nothing an existing tenant can observe.

CREATE TABLE IF NOT EXISTS supplier_contacts (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  supplier_id TEXT NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  name TEXT,
  email TEXT NOT NULL,
  email_norm TEXT NOT NULL,
  role TEXT,
  priority INTEGER,
  is_document_contact INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1,
  source TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by TEXT,
  UNIQUE(supplier_id, email_norm)
);

CREATE INDEX IF NOT EXISTS idx_supplier_contacts_supplier
  ON supplier_contacts(tenant_id, supplier_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_supplier_contacts_document_contact
  ON supplier_contacts(supplier_id) WHERE is_document_contact = 1 AND active = 1;

ALTER TABLE tenants ADD COLUMN default_owner_user_id TEXT;
ALTER TABLE tenants ADD COLUMN default_owner_updated_at TEXT;
ALTER TABLE tenants ADD COLUMN default_owner_updated_by TEXT;

CREATE TABLE IF NOT EXISTS renewal_requests (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  supplier_id TEXT NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  due_date TEXT NOT NULL,
  request_id TEXT REFERENCES document_requests(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'satisfied', 'stopped', 'escalated')),
  status_reason TEXT,
  escalated_at TEXT,
  closed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(document_id, due_date)
);

CREATE INDEX IF NOT EXISTS idx_renewal_requests_tenant_status
  ON renewal_requests(tenant_id, status);

CREATE INDEX IF NOT EXISTS idx_renewal_requests_supplier
  ON renewal_requests(tenant_id, supplier_id);

CREATE INDEX IF NOT EXISTS idx_renewal_requests_request
  ON renewal_requests(request_id) WHERE request_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS renewal_request_sends (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  renewal_request_id TEXT NOT NULL REFERENCES renewal_requests(id) ON DELETE CASCADE,
  stage TEXT NOT NULL
    CHECK (stage IN ('window_open', 'day_of', 'plus_7', 'plus_14')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sent', 'failed', 'skipped', 'superseded', 'cancelled')),
  draft_subject TEXT NOT NULL,
  draft_body TEXT NOT NULL,
  approver_user_id TEXT,
  approver_via TEXT,
  drafted_as_of TEXT NOT NULL,
  drafted_at TEXT NOT NULL DEFAULT (datetime('now')),
  notified_at TEXT,
  approved_by TEXT,
  approved_at TEXT,
  sent_at TEXT,
  sent_to TEXT,
  sent_subject TEXT,
  sent_body TEXT,
  skipped_by TEXT,
  skipped_at TEXT,
  failure TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(renewal_request_id, stage)
);

CREATE INDEX IF NOT EXISTS idx_renewal_request_sends_tenant_status
  ON renewal_request_sends(tenant_id, status);

CREATE INDEX IF NOT EXISTS idx_renewal_request_sends_approver
  ON renewal_request_sends(tenant_id, approver_user_id) WHERE status = 'pending';
