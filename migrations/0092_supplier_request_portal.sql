-- Migration 0092: the supplier's side of the ask.
--
-- WHY
-- ---
-- 0090 built the composer: a buyer can compose a packet, issue it, amend it,
-- and the internal routing row proves who sent what. What it could not do is
-- let the supplier ANSWER. `buildSupplierRequestView` existed as an allow-list
-- projection with no public door in front of it — the module note in
-- functions/api/document-requests/[id]/external.ts says so in as many words:
-- "There is deliberately no token-gated public variant yet — the moment one is
-- wanted it follows the alert_links pattern (0089)."
--
-- This is that moment. Three tables: the door, what came through it, and which
-- items each arrival was claimed against.
--
--
-- THE LINK IS SCOPED TO A ROOT, NOT TO A REQUEST. LOAD-BEARING.
-- -------------------------------------------------------------
-- 0090's amendment model creates a NEW document_requests row and stamps
-- `superseded_at` on the old one; `buildSupplierRequestView` returns null for a
-- superseded version, correctly, because showing a supplier a packet we have
-- replaced is worse than showing them nothing.
--
-- If the token pinned a `request_id`, every amendment would therefore
-- dead-link a URL already sitting in a supplier's inbox. The buyer's ordinary
-- act of fixing a typo would silently break the supplier's only way in, and
-- nobody would find out until a phone call.
--
-- So the token pins `root_request_id` and resolves to whichever version is
-- current at READ time. One link for the life of one ask, however many times
-- we revise it.
--
-- The counterpart constraint: a link must NEVER widen to a DIFFERENT ask. That
-- is the failure alert-links.ts names ("reusing an old row would let a link
-- forwarded last month silently widen to cover a document that was not in the
-- email it came from"). A root is one ask. A renewal is a new ask, gets a new
-- root, and therefore gets a new link — deliberately, not incidentally.
--
-- `supplier_id` is denormalized onto the link as a second fence. Every write
-- that arrives through a token is checked against it, so no sequence of
-- amendments can ever cause a file from supplier A to land against supplier B.
--
--
-- LIFETIME IS DERIVED FROM THE DEADLINE, NOT A FLAT 30 DAYS.
-- ---------------------------------------------------------
-- alert_links uses 30 days because an alert is a moment: read it, act, done.
-- A request is not a moment. It runs for weeks, the deadline slips, the person
-- who owns it is on leave, and the packet is chased twice before it lands. A
-- 30-day link would expire mid-chase and every expiry is a phone call.
--
-- So the TTL is computed (functions/lib/request-links.ts) as
--   max(90 days from mint, due_date + 60 days), capped at 400 days.
-- Floor: a request with no deadline still gets a working quarter. Grace: a
-- deadline that passes does not slam the door on the supplier still trying to
-- comply — being late is the normal case, and locking them out converts a late
-- document into no document. Cap: an unauthenticated read of a compliance
-- record is a disclosure with a clock on it, and 400 days is the longest clock
-- that is still a clock. There is no "no expiry" option, for the reason 0089
-- gives.
--
-- `revoked_at` is the kill switch, same as alert_links: one UPDATE closes a
-- link that was forwarded to the wrong person.
--
--
-- WHY UPLOADS ARE NOT DOCUMENTS YET
-- ---------------------------------
-- `request_uploads.document_id` is nullable and starts NULL. A supplier upload
-- is a file that ARRIVED; it becomes a `documents` row when a human reviews it.
-- That is not caution, it is the standing decision of this codebase — nothing
-- auto-ingests, every document is human-reviewed — and it is also what keeps
-- the progress number honest. See the note on request_upload_lines.

-- ---------------------------------------------------------------------------
-- request_links — the door
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS request_links (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

  -- 32 random bytes -> base64url, same entropy and same shape as alert_links,
  -- records update requests and workflow approvals. UNIQUE so a collision is a
  -- constraint failure rather than a cross-supplier read.
  token TEXT NOT NULL UNIQUE,

  -- The ask, across every amendment of it. See the header.
  root_request_id TEXT NOT NULL,
  -- The second fence. Every write through this token is checked against it.
  supplier_id TEXT NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,

  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  -- NOT NULL. Every link expires.
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  -- Which of our people minted it. Internal — never projected outward.
  created_by TEXT REFERENCES users(id),

  view_count INTEGER NOT NULL DEFAULT 0,
  last_viewed_at TEXT,
  last_upload_at TEXT
);

-- "What links exist for this ask" — the buyer's revoke/reissue view, and the
-- lookup that lets issue reuse a live link instead of minting a second one.
CREATE INDEX IF NOT EXISTS idx_request_links_root
  ON request_links(root_request_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_request_links_tenant
  ON request_links(tenant_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- request_uploads — one file the supplier sent
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS request_uploads (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

  -- Which link it came through, and which VERSION of the ask was current when
  -- it arrived. Both, on purpose: the link answers "who", the request answers
  -- "what were they looking at", and after an amendment those differ.
  link_id TEXT NOT NULL REFERENCES request_links(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL REFERENCES document_requests(id) ON DELETE CASCADE,
  supplier_id TEXT NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,

  r2_key TEXT NOT NULL,
  file_name TEXT NOT NULL,
  file_size INTEGER NOT NULL,
  mime_type TEXT NOT NULL,
  checksum TEXT,

  uploaded_at TEXT NOT NULL DEFAULT (datetime('now')),
  -- Recorded for the audit trail. NEVER projected back to the supplier, and
  -- never shown to them as "we know where you were".
  uploader_ip TEXT,
  -- Optional, typed by the supplier ("Priya, QA"). Their own words, so it is
  -- the one uploader field that may be echoed back to them.
  uploader_label TEXT,

  -- NULL until a human turns this arrival into a registry object. See header.
  document_id TEXT REFERENCES documents(id) ON DELETE SET NULL,

  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- The supplier's own history, newest first — the question the client says
-- generates the most phone calls.
CREATE INDEX IF NOT EXISTS idx_request_uploads_link
  ON request_uploads(link_id, uploaded_at DESC);

-- "Everything this supplier has sent us against this ask."
CREATE INDEX IF NOT EXISTS idx_request_uploads_request
  ON request_uploads(request_id, uploaded_at DESC);

-- The reviewer's inbox: arrivals not yet turned into documents.
CREATE INDEX IF NOT EXISTS idx_request_uploads_pending
  ON request_uploads(tenant_id, uploaded_at DESC) WHERE document_id IS NULL;

-- ---------------------------------------------------------------------------
-- request_upload_lines — which items one arrival was claimed against
-- ---------------------------------------------------------------------------
-- THIS TABLE IS THE PRODUCT THESIS.
--
-- The client's sentence — "this closed 7 of your 14 items" — is only sayable
-- because one upload row can point at seven line rows. A schema with
-- `request_lines.upload_id` on it would force the supplier to send the same
-- allergen statement seven times, which is precisely the incumbent behaviour
-- the whole page exists to invert.
--
-- CLAIMED, not proven. A row here means the supplier said "this file covers
-- that item". It does not mean a reviewer agreed, which is why it moves the
-- line to `received` and never to `accepted`. The progress bar counts
-- `accepted` only, so nothing a supplier does on their own can move the
-- number — a useful property to be able to state out loud.
CREATE TABLE IF NOT EXISTS request_upload_lines (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  upload_id TEXT NOT NULL REFERENCES request_uploads(id) ON DELETE CASCADE,
  line_id TEXT NOT NULL REFERENCES request_lines(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),

  -- One claim per (file, item). Re-sending the same file for the same item is
  -- a new upload row, not a duplicate claim on the old one.
  UNIQUE(upload_id, line_id)
);

-- "What arrived against this item" — per-line history, and the received count
-- the checklist shows next to each row.
CREATE INDEX IF NOT EXISTS idx_request_upload_lines_line
  ON request_upload_lines(line_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- request_lines.attention_reason — the sentence the supplier actually reads
-- ---------------------------------------------------------------------------
-- 0090 gave request_lines a `status_note`. That column is INTERNAL: it is
-- where a reviewer writes "third time they've sent the 2023 cert, escalate to
-- Dan" and it must never leave the portal.
--
-- But the brief for this page is explicit that a rejected item must tell the
-- supplier the specific reason and what the replacement must contain, never
-- the bare word "rejected". Reusing `status_note` for that would mean an
-- internal note reaching a vendor the first time a reviewer forgot which box
-- they were typing in — the exact incident the allow-list exists to prevent,
-- and one an allow-list cannot catch, because the field would be allow-listed.
--
-- So the two audiences get two columns. `status_note` stays internal and is
-- absent from every projection; `attention_reason` is written to be read by
-- the supplier, and is the only one that goes out.
ALTER TABLE request_lines ADD COLUMN attention_reason TEXT;
