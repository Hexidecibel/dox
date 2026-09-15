-- 0109_supplier_spec_watch.sql
--
-- A SUPPLIER ON WATCH, AND WHAT A CERTIFICATE DID NOT SAY.
--
-- SME rulings, AJ Conner, 2026-09-14 walkthrough (decisions, not preferences):
--
--   * COA completeness: whatever the supplier's COA reports counts as complete
--     BY DEFAULT. The customer can configure ADDITIONAL REQUIRED ANALYTES per
--     supplier; only that configuration can make a COA incomplete.
--   * Supplier-specific limits layered over company limits (most specific wins,
--     0084) ARE the "supplier on watch" mechanism: tighter thresholds and extra
--     required analytes for a watch period, then back to company defaults — with
--     a review-by date, because nobody remembers to loosen by hand.
--   * A printed analyte with NO configured limit is not judged, but must render
--     a visible "No limit configured" state so the portal never implies an
--     assurance it did not give.
--
-- Three changes.
--
-- 1. supplier_required_analytes — which analytes THIS supplier's certificates of
--    THIS document type must report.
--
--    EVERY KEY COLUMN IS NOT NULL, including document_type_id, and that is a
--    decision rather than an oversight. spec_limits (0084) scopes by document
--    type with NULL meaning "any"; mirroring that here would be dishonest,
--    because "any document type" is meaningless for completeness — it would
--    report "Coliform not reported" on the same supplier's insurance
--    certificate. And a nullable key column would reintroduce the NULL-
--    distinctness trap 0086 had to fix and 0087 wrote down: SQLite treats NULLs
--    as distinct in a UNIQUE index, so duplicate "any type" rows could disagree
--    silently. With all four NOT NULL a plain UNIQUE constrains.
--
--    effective_from (nullable): before this day the requirement does not apply.
--    review_by (nullable): see 2 — the same semantics as on a limit.
--    No `active` flag: a watch ends by an admin removing the row (audited), not
--    by a switch that leaves a row looking configured while doing nothing.
--
-- 2. spec_limits.review_by — when a supplier-scoped limit's watch period is due
--    for review, YYYY-MM-DD. NOT AN EXPIRY. After it passes the limit STILL
--    APPLIES and every surface flags "watch period ended <date> — review"; an
--    admin extends or removes it. The unsafe failure is a watch that lapses on
--    its own and puts a supplier back on looser limits nobody chose. The API
--    accepts it only on a supplier-scoped limit. Frozen into
--    document_spec_checks.limit_snapshot like criticality (0095).
--
-- 3. document_spec_gaps — what was NOT judged on an approved document, and why.
--    Two kinds:
--      'missing_required'  a required analyte (1) the certificate did not report
--      'unjudged'          a printed result with no limit in scope and no
--                          printed specification ("No limit configured")
--
--    WHY A SEPARATE TABLE AND NOT A NEW document_spec_checks VERDICT. 0085's
--    verdict column carries CHECK (verdict IN ('in_spec','out_of_spec',
--    'not_checked')), and SQLite cannot alter a CHECK: adding 'not_reported'
--    means rebuilding the register — its rows, its three indexes and 0105's
--    partial UNIQUE index — on a prod table applied surgically. And the fit is
--    wrong anyway: every register row is a JUDGEMENT of a printed result
--    (value, limit_id, limit_snapshot, acknowledgement), while a missing analyte
--    has no value and no limit, and an unjudged result has no limit by
--    definition. Every existing consumer that counts verdict = 'all' would also
--    start counting non-judgements. So the register stays "what we judged" and
--    this table is "what we did not judge".
--
--    Identity: a missing analyte is identified by its analyte, an unjudged
--    result by its place on the page (0105's result_key). The paired CHECKs make
--    exactly one of those present per kind, so COALESCE(result_key, spec_test_id)
--    is never NULL and the expression UNIQUE index below genuinely constrains —
--    the COALESCE answer 0086 gave, applied to a key that is structurally
--    non-NULL rather than to NULLs we want treated as equal.
--
--    required_analyte_id is NOT a foreign key: the requirement may be removed
--    when the watch ends, and requirement_snapshot (frozen, like limit_snapshot)
--    is the record of what was required at the time.
--
-- NUMBERING: written as 0107 in its worktree and renumbered to 0109 at merge
-- (0107 product_identifiers and 0108 intake_duplicates landed first); nothing
-- inside depends on the number.

CREATE TABLE IF NOT EXISTS supplier_required_analytes (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  supplier_id TEXT NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  document_type_id TEXT NOT NULL REFERENCES document_types(id) ON DELETE CASCADE,
  spec_test_id TEXT NOT NULL REFERENCES spec_tests(id) ON DELETE CASCADE,
  effective_from TEXT,
  review_by TEXT,
  reason TEXT,
  created_by TEXT REFERENCES users(id),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  updated_by TEXT REFERENCES users(id),
  UNIQUE (tenant_id, supplier_id, document_type_id, spec_test_id)
);

CREATE INDEX IF NOT EXISTS idx_sra_tenant_supplier
  ON supplier_required_analytes(tenant_id, supplier_id);

ALTER TABLE spec_limits ADD COLUMN review_by TEXT;

CREATE TABLE IF NOT EXISTS document_spec_gaps (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  version_number INTEGER,
  queue_item_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('missing_required', 'unjudged')),
  -- missing_required: the analyte. unjudged: the matched analyte, when the
  -- printed name matched one that had no limit in scope; NULL otherwise.
  spec_test_id TEXT,
  required_analyte_id TEXT,
  -- missing_required: the analyte's name. unjudged: the name as printed.
  test_name_raw TEXT NOT NULL,
  value_raw TEXT,
  unit_raw TEXT,
  result_key TEXT,
  result_location TEXT,
  -- The rule that left it unjudged / incomplete, in words. Never NULL.
  reason TEXT NOT NULL,
  -- missing_required: {analyte, supplier_id, document_type_id, effective_from,
  -- review_by, review_overdue, reason}. unjudged: {why, lab_verdict?}.
  snapshot TEXT,
  -- Same meaning as on document_spec_checks (0103). No default, on purpose.
  judgement_origin TEXT,
  notified_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  CHECK (kind <> 'missing_required' OR (spec_test_id IS NOT NULL AND result_key IS NULL)),
  CHECK (kind <> 'unjudged' OR result_key IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_dsg_document ON document_spec_gaps(document_id);
CREATE INDEX IF NOT EXISTS idx_dsg_tenant_kind
  ON document_spec_gaps(tenant_id, kind, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_dsg_identity
  ON document_spec_gaps(document_id, COALESCE(version_number, -1), kind, COALESCE(result_key, spec_test_id));
