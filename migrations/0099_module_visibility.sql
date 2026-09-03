-- Migration 0099: module visibility — what a tenant bought, and which of that
-- a given person is expected to work in.
--
-- Three tables, all of them joins with composite primary keys and no surrogate
-- ids. The vocabulary of module keys lives in `shared/modules.ts` and NOWHERE
-- ELSE, including here.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- WHY THIS SHAPE
-- ═══════════════════════════════════════════════════════════════════════════
-- Per-tenant configuration today is a growing set of columns on `tenants`
-- (auto_approve_threshold, extraction_context, spec_volume_mass_equivalent),
-- each of which needed its own migration, its own endpoint and its own control.
-- That does not survive fifteen modules. A row per (tenant, module) does, and
-- it is queryable — "which tenants have fulfillment off" is a SELECT rather
-- than a scan of a JSON blob.
--
-- NO JSON COLUMN, for the same reason: a JSON list of enabled modules cannot be
-- indexed, cannot be joined against, and cannot record WHO turned something off
-- and when without inventing a second encoding inside the string.
--
-- EVERY KEY COLUMN IS `NOT NULL` AND PART OF A COMPOSITE PK, so the
-- NULL-distinctness trap that 0086 answered with a COALESCE expression index,
-- 0087 answered with a plain UNIQUE and 0091 answered with a third variant
-- CANNOT APPLY HERE. SQLite treats NULLs as distinct in a UNIQUE index, which
-- is what made those three migrations think about it; a PRIMARY KEY forbids the
-- NULL in the first place. There is deliberately no scope column that could be
-- "unset" — a tenant-wide default is expressed by the ABSENCE of a row, not by
-- a row full of NULLs.
--
-- NO ENUMERATED CHECK ON `module_key`. The structural guarantee is stronger
-- than a constraint: a row naming a module that does not exist in
-- `shared/modules.ts` cannot produce a surface, because surfaces come from
-- code, and the resolver ignores keys it does not recognise. A CHECK would buy
-- nothing except a migration every single time a module ships — and SQLite
-- cannot alter a CHECK in place, so each one would be a full table rebuild.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- THIS MIGRATION INSERTS ZERO ROWS INTO tenant_modules AND module_visibility
-- ═══════════════════════════════════════════════════════════════════════════
-- Absence resolves to the code default, and every module ships
-- `defaultEnabled: true`. So every existing user's visible set the day after
-- this lands is byte-identical to the day before, and a surface narrows only
-- when a named admin clicks a toggle and leaves a row behind.
--
-- The corollary is a rule, not a preference: ONCE A MODULE SHIPS, ITS
-- `defaultEnabled` IS FROZEN. Flipping it later would silently move every
-- tenant that never opened the screen, with nothing anywhere recording that it
-- happened. Changing what existing tenants see is done by INSERTing rows in a
-- LATER migration — explicitly, reviewably, and visible in the table
-- afterwards.
--
-- (`owner_labels` IS backfilled below. That is not a behaviour change: it
-- promotes labels that already exist in `owner_routes` into a table where they
-- can be named, and it changes nobody's visible set.)

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. tenant_modules — the ceiling
-- ═══════════════════════════════════════════════════════════════════════════
-- What this tenant uses. A missing row means "the code default", which is
-- enabled; a row with enabled = 0 is somebody's decision, stamped with who and
-- when so "who turned Orders off" is answerable without reading the audit log.
--
-- `updated_by` is a bare TEXT with no FK to users: it is provenance, and the
-- record of who made a configuration decision must survive that person's
-- account being deleted. Same reasoning as `owner_routes.created_by` (0091).

CREATE TABLE IF NOT EXISTS tenant_modules (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  module_key TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by TEXT,
  PRIMARY KEY (tenant_id, module_key)
);

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. owner_labels — promoting the departmental label to a first-class row
-- ═══════════════════════════════════════════════════════════════════════════
-- `owner_routes` (0091) already carries the departmental concept — QA,
-- Insurance, Accounting, Purchasing — mapped to real recipients. That is what
-- makes it the right membership table for login visibility too: a QA person is
-- ALREADY a route for `qa`, so no second role table is needed. One concept,
-- two effects.
--
-- But a label only exists in `owner_routes` once somebody has been routed
-- there. You cannot configure what Sales sees until Sales receives an alert,
-- and Sales owns no renewals — so Sales would never appear. Promoting the
-- label gives a tenant something to name and configure BEFORE any routing
-- exists, and gives `module_visibility` a parent to hang a foreign key on.
--
-- The key is the SAME normalized `owner_key` as 0091: lower-cased,
-- whitespace-collapsed, normalized in `functions/lib/alert-routing.ts`
-- (normalizeOwnerKey). There is no SQL-side collation trick on either table and
-- both sides must keep using that one function.
--
-- BACKFILLED from the routes that already exist, so a tenant that has been
-- routing alerts for months opens the screen and finds its own departments
-- listed rather than an empty page. MIN(owner_label) picks a display label
-- deterministically where several rows spelled the same key differently
-- ('QA' and 'Q.A.' normalize apart, but 'QA' and 'qa' do not) — display only,
-- and editable afterwards.

CREATE TABLE IF NOT EXISTS owner_labels (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  owner_key TEXT NOT NULL,
  owner_label TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by TEXT,
  PRIMARY KEY (tenant_id, owner_key)
);

INSERT OR IGNORE INTO owner_labels (tenant_id, owner_key, owner_label)
  SELECT tenant_id, owner_key, MIN(owner_label)
    FROM owner_routes
   GROUP BY tenant_id, owner_key;

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. module_visibility — the narrowing, and only the narrowing
-- ═══════════════════════════════════════════════════════════════════════════
-- One row per (tenant, function, module) the function is allowed to see.
--
-- A FUNCTION WITH NO ROWS HERE IS UNCONSTRAINED, not blind. Absence means
-- unconstrained — deliberately the inverse of `owner_routes`, where absence
-- means "unrouted, and reported as a gap". The two rules disagree about silence
-- because they fail in opposite directions: an unrouted alert that quietly went
-- to the admin pool is an alert nobody acts on, while an unconfigured user who
-- quietly saw less is a person who cannot find their own work and cannot tell
-- why. Both are chosen so the un-configured case points toward the person
-- seeing MORE. Narrowing always requires a row somebody wrote.
--
-- The composite FK to owner_labels(tenant_id, owner_key) is why owner_labels
-- had to exist: it makes a visibility row for a department that was never
-- declared impossible, and ON DELETE CASCADE means removing a department takes
-- its scoping with it rather than leaving orphan rows that narrow nobody.
--
-- The resolver (`resolveVisibleModules` in shared/modules.ts) applies these
-- UNDER the tenant ceiling — this table can only narrow within what the tenant
-- has, never grant a module the tenant switched off.

CREATE TABLE IF NOT EXISTS module_visibility (
  tenant_id TEXT NOT NULL,
  owner_key TEXT NOT NULL,
  module_key TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by TEXT,
  PRIMARY KEY (tenant_id, owner_key, module_key),
  FOREIGN KEY (tenant_id, owner_key)
    REFERENCES owner_labels(tenant_id, owner_key) ON DELETE CASCADE
);

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. The index the resolver needs
-- ═══════════════════════════════════════════════════════════════════════════
-- Login asks a question `owner_routes` has never been asked before: "which
-- functions does THIS USER hold?". Its existing index
-- (`idx_owner_routes_lookup`, keyed (tenant_id, owner_key)) answers the
-- alerting question — "who is on this route" — and cannot answer this one; the
-- lookup runs on every page load, so it does not get to be a table scan.
--
-- Partial on the non-NULL side because a route pointing at a bare email
-- (a broker, a site manager — 0091's CHECK allows exactly one of user_id /
-- email) is not a portal user and can never match a login.

CREATE INDEX IF NOT EXISTS idx_owner_routes_by_user
  ON owner_routes(tenant_id, user_id)
  WHERE active = 1 AND user_id IS NOT NULL;
