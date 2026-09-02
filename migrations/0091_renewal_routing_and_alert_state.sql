-- Migration 0091: renewal alert ROUTING and the re-alert LEDGER.
--
-- Two tables, both in service of one sentence from the client: "Alerts route
-- to the record's owner role, not to a general admin pool. An alert everyone
-- receives is an alert nobody acts on."
--
-- ═══════════════════════════════════════════════════════════════════════════
-- 1. owner_routes — making `documents.owner` resolvable
-- ═══════════════════════════════════════════════════════════════════════════
-- `documents.owner` (migration 0077) is FREE TEXT and always has been. It
-- holds things like 'QA', 'Accounting', 'Insurance', 'Purchasing' — a
-- department, not a person, and not a user id. There is no way to turn that
-- string into an email address, which is why the renewal alert has been
-- broadcasting to every org_admin plus every super_admin since it shipped.
--
-- WHY NOT JUST MAKE owner A USER FK
-- ---------------------------------
-- Three reasons, in order of weight:
--
--   1. The owners are ROLES, not people. 'QA' is two people this quarter and a
--      different two next quarter. Pointing a document at a user id means
--      re-editing every certificate when somebody changes desks; pointing it
--      at a label the tenant maps once means changing one row.
--   2. Some owners have no account and never will. Insurance renewals go to a
--      broker; a plant licence goes to a site manager who logs in never. This
--      is the same population `alert_links` (0089) exists for, and the same
--      argument: if the routing table cannot hold a bare email address, the
--      honest owner gets replaced by a fake user account or by nobody.
--   3. The existing free-text values are real data. A FK migration would have
--      to guess a user for every one of them, and a wrong guess routes a
--      compliance alert to the wrong person silently.
--
-- So the label stays as typed and this table maps it to recipients. A route
-- may point at a portal user (user_id) OR at a plain address (email) — never
-- neither. Several rows may share one owner_key: 'QA' can be three people.
--
-- MATCHING IS ON A NORMALIZED KEY
-- ------------------------------
-- owner_key is the lower-cased, whitespace-collapsed label, so 'QA', 'qa' and
-- ' Qa ' are one route. The as-typed owner_label is kept for display only.
-- Normalization happens in `functions/lib/alert-routing.ts` (normalizeOwnerKey)
-- and both sides must use it — there is no SQL-side collation trick here.
--
-- WHAT HAPPENS WHEN NOTHING MATCHES IS THE WHOLE POINT
-- ---------------------------------------------------
-- A document whose owner is NULL, or whose owner label has no route, is
-- UNROUTED. The renewal path does NOT fall back to the admin pool for those —
-- that fallback is the bug being fixed. It reports them as a routing gap
-- instead. See functions/lib/renewal-alerts.ts.

CREATE TABLE IF NOT EXISTS owner_routes (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

  -- Normalized match key (lower-cased, whitespace-collapsed).
  owner_key TEXT NOT NULL,
  -- The label as a human typed it, for display in the admin UI.
  owner_label TEXT NOT NULL,

  -- Exactly one of these is set. A portal user is preferred (their address
  -- follows them when it changes); a bare email covers the broker/site-manager
  -- case where there is no account to point at.
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  email TEXT,

  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by TEXT,

  CHECK ((user_id IS NOT NULL) <> (email IS NOT NULL))
);

-- One row per (tenant, owner label, recipient). COALESCE rather than a plain
-- multi-column UNIQUE because SQLite treats NULLs as distinct, so
-- UNIQUE(tenant_id, owner_key, user_id, email) would happily store the same
-- email twice.
CREATE UNIQUE INDEX IF NOT EXISTS idx_owner_routes_unique
  ON owner_routes(tenant_id, owner_key, COALESCE(user_id, email));

CREATE INDEX IF NOT EXISTS idx_owner_routes_lookup
  ON owner_routes(tenant_id, owner_key) WHERE active = 1;

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. renewal_alert_state — one row per document, so a daily job is not a
--    daily email
-- ═══════════════════════════════════════════════════════════════════════════
-- A certificate sits in the 60-day window for sixty days. A job that runs
-- every morning and mails whatever is in the window mails the same person
-- about the same certificate sixty times, and by the fourth morning the alert
-- has become a filter rule. That is strictly worse than no job at all, and it
-- is the exact failure the client named.
--
-- So the scheduled path consults this ledger and re-alerts a document only
-- when it has something new to say:
--
--   * never alerted before                          → send
--   * status ESCALATED since last alert             → send, ignoring cooldown
--     (expiring → overdue/expired is genuinely new information: the date
--     passed. The reverse — a due date pushed out after renewal — is not an
--     escalation and does not re-alert.)
--   * cooldown elapsed (default 7 days)             → send, as a weekly nudge
--   * otherwise                                     → skip, silently and by
--                                                     design
--
-- Weekly rather than daily because a renewal is a task with a multi-week lead
-- time, not an incident. Weekly keeps an open item from disappearing while
-- leaving the recipient's inbox usable.
--
-- The MANUAL button (POST /api/expirations/notify) deliberately ignores the
-- cooldown — a human asking for the digest right now gets it right now — but
-- it still WRITES here, so clicking the button at 09:00 does not mean the cron
-- repeats it at 13:00.
--
-- Keyed per document, not per (document, recipient): the digest is grouped by
-- owner and a document has one owner, so the two are the same key in practice
-- and this one survives an owner_routes edit without stranding rows.

CREATE TABLE IF NOT EXISTS renewal_alert_state (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,

  -- The status this document had the last time it was actually mailed.
  -- Compared against the current status to detect escalation.
  last_status TEXT NOT NULL,
  -- The due date it had at that moment. Recorded for forensics: "why did this
  -- re-alert" is answerable without reading the mail logs.
  last_due_date TEXT,

  -- TWO stamps, because they answer two different questions and conflating
  -- them makes the cooldown arithmetic wrong.
  --
  --   last_notified_at   real wall-clock time. Forensics: when did this
  --                      actually leave the building.
  --   last_notified_as_of the run's `as_of` DATE, which is what the cooldown
  --                      is measured against.
  --
  -- Normally these agree, because a scheduled run's as_of IS today. They come
  -- apart the moment anyone passes an explicit as_of — an operator re-running
  -- a missed day, a test walking a record through a week — and if the cooldown
  -- measured wall-clock against as_of it would compute a negative elapsed time
  -- and suppress forever. Measuring as_of against as_of keeps the rule
  -- self-consistent whatever clock the run believes in.
  last_notified_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_notified_as_of TEXT,
  -- How many times this document has been mailed about, ever. A row with a
  -- high count and an unchanged status is a renewal nobody is doing.
  notify_count INTEGER NOT NULL DEFAULT 1,

  UNIQUE(tenant_id, document_id)
);

CREATE INDEX IF NOT EXISTS idx_renewal_alert_state_doc
  ON renewal_alert_state(tenant_id, document_id);
