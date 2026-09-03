-- Migration 0097: does a document renew AT ALL, and what did the human say?
--
-- Two halves of one gap. Migration 0096 shipped a renewal PERIOD per document
-- type and a precedence ladder in code, and both assumed the answer to "when is
-- this due?" is always a date. For most of the corpus it is not.
--
--
-- HALF ONE — `document_types.renewal_policy`: the third state
-- ----------------------------------------------------------
-- 0096's `renewal_interval_months` is nullable, where NULL means "inherit the
-- annual default" and a number means "this many months". Two states. A
-- Certificate of Analysis needs a third: it does not renew at all. It is a
-- per-lot record superseded by the next lot's certificate, so it has no cadence
-- to be late against -- not a very long one, and not an unconfigured one.
--
-- That is not a hypothetical. On prod, 139 of 200 documents carry a printed
-- expiration_date and ALL 139 are COAs. With only two states expressible, every
-- one of them resolves to a manufactured annual date, lands on the renewal
-- dashboard, and mails its owner.
--
-- WHY A WORD AND NOT A SENTINEL. `renewal_interval_months = 0` was the cheap
-- option and is a trap: nothing in the schema says 0 is special, the resolver
-- already (correctly) rejects 0 as a corrupt period, and the admin screen would
-- render "0 months" for "never" forever. A separate `renews` boolean was the
-- other cheap option: two columns that can disagree, so every reader has to
-- decide which wins. One column, three words, and it is the authority --
-- `renewal_interval_months` is read only when the policy is 'period', so the
-- pair cannot contradict itself.
--
-- DEFAULT 'inherit' — the pre-0097 behaviour exactly. A type nobody has
-- configured, and a type written by a client that has never heard of this
-- column, both keep renewing annually. Defaulting to 'none' would empty the
-- dashboard silently, which is the failure mode this whole feature exists to
-- prevent.
--
-- THE BACKFILL IS A NAME MATCH, WHICH IS UGLY AND IS THE ONLY OPTION. Same
-- position as 0096. `document_types` carries no column saying what KIND of
-- document a type is -- name, slug, description, some extraction toggles, a
-- supplier. (`output_kind` does distinguish coa/order/shipment, but it lives on
-- `processing_queue`, is set per ARRIVAL by the dispatching source, and is not
-- on the type at all.) So the match is on the name, mirrored from
-- `looksLikeCoaType` in shared/renewalPeriod.ts, and it runs exactly twice:
-- here, once, and when a NEW type is created. Never at read time. What a type
-- renews at is this stored column, visible and editable on the Document Types
-- screen; a guess written into a visible setting is one a human can correct.
--
-- THE MATCH IS NARROW ON PURPOSE. It requires the ANALYSIS word, not merely the
-- certificate word, so 'Certificate of Insurance' and 'Certification' cannot
-- match. A false positive here does not produce a wrong date -- it produces
-- SILENCE, a certificate that lapses and never appears anywhere. A missed alert
-- is the expensive direction of this error.
--
--
-- HALF TWO — the approval-time renewal decision on `documents`
-- -----------------------------------------------------------
-- Before this, the approve path wrote ZERO renewal fields: `produceCoa` named
-- fourteen columns and none of them was a renewal one, so every dashboard read
-- RE-DERIVED a date from whatever configuration happened to be in force that
-- morning. Approval is the right moment to settle it -- a human is holding the
-- document and every input is present -- so the resolver becomes a PROPOSAL,
-- shown pre-filled and editable with the rule that produced it in plain words,
-- and what the reviewer confirms is stored.
--
-- `renewal_snapshot` FREEZES THE PROPOSAL, in the same shape and for the same
-- reason as `document_spec_checks.limit_snapshot` in migration 0085: once a
-- human has judged something, moving a threshold (or a type's period) later
-- must not silently rewrite what they judged. It holds the proposed date, the
-- rule, the period, the anchor and the reason as JSON -- enough to re-explain
-- the decision years later even after the type has been reconfigured.
--
-- `renewal_decision` MAKES "NO RENEWAL" SAYABLE. A cleared field and an
-- untouched field are both a NULL `renewal_due_date`, and they mean opposite
-- things: 'cleared' is a reviewer answering "this one does not renew", NULL is
-- nobody having looked. Without the distinction the resolver would fall through
-- to the annual default and overrule the human on the very next read. 'cleared'
-- is therefore consulted by `resolveRenewalExpiry` directly, immediately below
-- the canonical date.
--
-- NO CHECK COUPLING `renewal_decision` TO `renewal_due_date`. 'accepted' and
-- 'overridden' do imply a date today, but a later human edit that clears the
-- date through the documents API is a legitimate state, and a CHECK that
-- rejected it would turn an ordinary edit into a 500.
--
-- NO INDEX. `idx_documents_renewal_due_date` (0077) already serves the
-- dashboard query; these four columns are read per row once a document is
-- already selected.

-- ── document_types: does this type renew at all? ───────────────────────────
ALTER TABLE document_types ADD COLUMN renewal_policy TEXT NOT NULL DEFAULT 'inherit'
  CHECK (renewal_policy IN ('inherit', 'period', 'none'));

-- COA types first: they do not renew, and any period sitting on them is now
-- unreadable, so it is cleared rather than left to mislead whoever reads the
-- row. Safe to touch updated_at -- both document_types UPDATE triggers are
-- column-scoped (AFTER UPDATE OF name, slug[, description]), so this churns
-- neither the FTS index nor the reindex queue.
UPDATE document_types
SET renewal_policy = 'none',
    renewal_interval_months = NULL,
    updated_at = datetime('now')
-- LIKE has no word boundary, so the abbreviation is matched with an explicit
-- start/middle/end set rather than '%coa%', which would also catch 'cocoas'.
WHERE (
    lower(name) LIKE '%certificate of analysis%'
    OR lower(name) LIKE '%certificates of analysis%'
    OR lower(name) LIKE '%analysis certificate%'
    OR lower(name) LIKE '%c of a%'
    OR lower(name) IN ('coa', 'coas')
    OR lower(name) LIKE 'coa %'  OR lower(name) LIKE 'coas %'
    OR lower(name) LIKE '% coa'  OR lower(name) LIKE '% coas'
    OR lower(name) LIKE '% coa %' OR lower(name) LIKE '% coas %'
    OR slug IN ('coa', 'coas')
    OR slug LIKE 'coa-%'  OR slug LIKE 'coas-%'
    OR slug LIKE '%-coa'  OR slug LIKE '%-coas'
    OR slug LIKE '%-coa-%' OR slug LIKE '%-coas-%'
    OR slug LIKE '%certificate-of-analysis%'
  );

-- Everything 0096 gave an explicit period to is 'period'. This is what keeps
-- the two columns coherent: after this statement, a non-NULL
-- renewal_interval_months exists only under a 'period' policy.
UPDATE document_types
SET renewal_policy = 'period',
    updated_at = datetime('now')
WHERE renewal_policy = 'inherit'
  AND renewal_interval_months IS NOT NULL;

-- ── documents: the approval-time renewal decision ──────────────────────────
ALTER TABLE documents ADD COLUMN renewal_decision TEXT
  CHECK (renewal_decision IN ('accepted', 'overridden', 'cleared'));
ALTER TABLE documents ADD COLUMN renewal_snapshot TEXT;
ALTER TABLE documents ADD COLUMN renewal_decided_at TEXT;
ALTER TABLE documents ADD COLUMN renewal_decided_by TEXT;
