-- Migration 0085: the out-of-spec register.
--
-- WHY A TABLE AND NOT JUST A WARNING
-- ----------------------------------
-- Phase 0 and Phase 1 put a verdict in front of a reviewer at the moment they
-- are looking at the COA. That is where a result gets CAUGHT. It is not where a
-- QA buyer gets what they are paying for, which is the ability to ask, months
-- later and in front of an auditor:
--
--   * what has ever come in out of spec, and who was told?
--   * WHICH LIMIT was this judged against — the one we hold today, or the looser
--     one we held in March?
--   * a human approved this anyway. Who, when, and what did they say about it?
--
-- None of those survive in a warning computed on the fly. So every judged result
-- is written down at approve time.
--
-- limit_snapshot IS THE VERSIONING ANSWER
-- ---------------------------------------
-- A row stores a frozen copy of the numbers it was judged against, not just a
-- pointer to the limit. Thresholds move — that is the entire point of letting a
-- tenant edit them — and a foreign key alone would silently rewrite history the
-- moment somebody tightened a number. The pointer is kept too, for "show me
-- everything this limit ever caught", but the snapshot is what the record means.
--
-- THREE-STATE, PERSISTED
-- ----------------------
-- `not_checked` rows are stored, not discarded. A register that only records
-- passes and failures would quietly imply that everything absent from it was
-- fine, which is the false negative this whole feature exists to avoid. "We had
-- a limit, we could not honestly apply it, here is why" is a first-class result.
--
-- ADVISORY, ALWAYS. Nothing here blocks or reverses an approval. A row in this
-- table is a record of a judgement, never a gate.

CREATE TABLE IF NOT EXISTS document_spec_checks (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  -- Which version of the document produced this result. NULL for rows written
  -- before a version existed.
  version_number INTEGER,
  -- The queue item this came from, so a result can be traced back to the
  -- extraction and the reviewer who approved it.
  queue_item_id TEXT,

  -- NULL when the check came from the COA's own printed spec rather than one of
  -- our configured analytes.
  spec_test_id TEXT,
  -- The analyte name EXACTLY as the supplier printed it. Kept verbatim: it is
  -- the evidence, and it is also how an alias gap is discovered later.
  test_name_raw TEXT NOT NULL,

  value_raw TEXT,
  -- Normalized onto the limit's unit, when that conversion was legitimate.
  value_num REAL,
  unit_raw TEXT,

  verdict TEXT NOT NULL CHECK (verdict IN ('in_spec', 'out_of_spec', 'not_checked')),
  -- Why. Load-bearing for not_checked, which is meaningless without it.
  reason TEXT,
  -- 'printed' = the COA's own limit; 'limit' = ours.
  source TEXT NOT NULL CHECK (source IN ('printed', 'limit')),

  limit_id TEXT,
  -- JSON copy of the limit as it stood: {operator, value_min, value_max, unit,
  -- version}. See the note above — this, not limit_id, is the record.
  limit_snapshot TEXT,

  -- A human seeing an out-of-spec result and approving anyway is a legitimate
  -- QA decision. It must be traceable, not preventable.
  acknowledged_by TEXT REFERENCES users(id),
  acknowledged_at TEXT,
  acknowledgement_note TEXT,

  -- Set once an alert for this result has gone out, so a re-check or a
  -- re-approval cannot spam the same finding twice.
  notified_at TEXT,

  created_at TEXT DEFAULT (datetime('now'))
);

-- The register's own view: everything currently out of spec and unacknowledged,
-- newest first.
CREATE INDEX IF NOT EXISTS idx_dsc_tenant_verdict
  ON document_spec_checks(tenant_id, verdict, acknowledged_at, created_at DESC);

-- "What did this document's results look like?" on the document detail page.
CREATE INDEX IF NOT EXISTS idx_dsc_document ON document_spec_checks(document_id);

-- "Show me everything this limit ever caught", for tuning a threshold.
CREATE INDEX IF NOT EXISTS idx_dsc_limit ON document_spec_checks(limit_id);
