-- Migration 0139: holds. A hold on a lot's certificate stops it leaving.
--
-- WHY
-- ---
-- Decision C-005 (docs/decision-log.md; C-071..C-082 fill in what it left
-- open). The client's rules table assumes holds exist: B1 "Critical: this
-- result stops the shipment. It can't ship until QA resolves it", and E2 "a
-- zero-tolerance analyte holds until a person resolves it". Until now nothing
-- in the portal held anything; a Critical out-of-spec result warned and mailed
-- and the certificate still left on the next order.
--
-- A hold is PORTAL-ONLY. Nothing is pushed to a warehouse system.
--
-- WHAT THIS ADDS
-- --------------
-- document_holds -- ONE ROW PER HOLD, APPEND-ONLY. A hold is placed, and later
--     released; it is never edited and never deleted. Releasing stamps the
--     three release columns on the same row. "Is this certificate on hold" is
--     "does it have a row with released_at IS NULL".
--
--     tenant_id -- CASCADE with the tenant, like every tenant-owned table.
--     document_id -- the certificate. NO ON DELETE ACTION: documents are never
--         hard-deleted by the application (status = 'deleted'), and a delete
--         that would take a hold with it should be refused, not obeyed.
--     lot_id -- the lot row of the certificate the hold is on, or NULL for the
--         whole certificate (a document with no lot rows, or a person choosing
--         the whole thing). NO ON DELETE ACTION for the same reason. The one
--         tool that deletes a lot (bin/report-lot-key-scheme --apply, merging
--         a mis-keyed lot into the right one) moves these pointers first and
--         will not delete a lot a hold still names.
--     THERE IS NO SUPPLIER COLUMN, on purpose. Anything carrying a
--         supplier_id has to be moved by `mergeSuppliers` (the 0133 rule), and
--         a hold's supplier is its document's: read through the join, it is
--         always right after a merge with nothing to move.
--
--     reason -- why, in words. Required (CHECK), whoever or whatever placed it.
--     source -- 'person' / 'spec_critical' / 'zero_tolerance', CHECKed: a
--         closed vocabulary this table owns.
--           person          somebody pressed "Place hold".
--           spec_critical   a result judged out of spec against a limit whose
--                           criticality is Critical (rules table B1).
--           zero_tolerance  a presence test on a zero-tolerance analyte run on
--                           a smaller sample than the limit requires (E2).
--     source_key -- for an automatic hold, the identity of the JUDGED RESULT
--         that placed it: "v<document version>:<source>:<result key>" where
--         the result key is the register's own location identity (0105).
--         NULL on a person's hold (CHECKed both ways).
--         WHY NOT THE document_spec_checks ROW ID: re-approving a document
--         deletes and rewrites its register rows with new ids, so an id is not
--         the same result twice. The location on a given version is.
--     spec_check_id -- the register row as it was when the hold was placed. A
--         BARE POINTER with no foreign key, for exactly that reason: the row it
--         names may since have been rewritten. `detail` carries what a reader
--         needs without it.
--     document_version -- the version that was current when the hold was
--         placed. Display only. A hold is on the DOCUMENT, not on a version:
--         replacing the file does not lift it (C-076).
--     detail -- JSON frozen at placement for an automatic hold: the test as
--         printed, the value, the limit it was judged against, where on the
--         page. NULL on a person's hold.
--
--     placed_by / placed_at -- who and when. placed_by is NULL for an
--         automatic hold (no person placed it) and required for a person's.
--     qa_notified_at -- when the QA route was told. NULL = not told (the
--         placer was QA, mail is not configured, or nobody is on the route).
--     released_by / released_at / release_reason -- all three or none
--         (CHECK). A release needs a person and a written reason.
--
-- TWO UNIQUE INDEXES, each a rule:
--   idx_document_holds_one_active -- at most one ACTIVE hold per (document,
--       lot, source, result). A second person's hold on a lot already held by
--       a person is refused, not stacked.
--   idx_document_holds_auto_once -- an automatic hold is placed ONCE per
--       judged result, EVER, released or not. Re-approving the same version
--       must not put back a hold QA released with a reason; a NEW version is a
--       new result key and is held again if it still fails.
--
-- trg_document_holds_immutable -- the append-only rule, in the database: an
--     UPDATE may stamp the release columns of an active hold, record that QA
--     was notified, or follow a lot that was merged into another. Anything
--     else aborts. There is deliberately no DELETE trigger: a tenant delete
--     cascades, and the application has no delete path to guard.
--
-- ADDITIVE ONLY. One new table. No existing row changes, nothing is rebuilt,
-- and no existing document is put on hold by this migration:
-- bin/propose-spec-holds lists the documents whose stored approval-time checks
-- would have placed one, and places them only when told to.

CREATE TABLE IF NOT EXISTS document_holds (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  document_id TEXT NOT NULL REFERENCES documents(id),
  lot_id TEXT REFERENCES lots(id),
  reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  source TEXT NOT NULL CHECK (source IN ('person', 'spec_critical', 'zero_tolerance')),
  source_key TEXT,
  spec_check_id TEXT,
  document_version INTEGER,
  detail TEXT,
  placed_by TEXT REFERENCES users(id),
  placed_at TEXT NOT NULL DEFAULT (datetime('now')),
  qa_notified_at TEXT,
  released_by TEXT REFERENCES users(id),
  released_at TEXT,
  release_reason TEXT,
  CHECK ((source = 'person') = (source_key IS NULL)),
  CHECK (source != 'person' OR placed_by IS NOT NULL),
  CHECK (
    (released_at IS NULL AND released_by IS NULL AND release_reason IS NULL)
    OR (released_at IS NOT NULL AND released_by IS NOT NULL AND length(trim(release_reason)) > 0)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_document_holds_one_active
  ON document_holds(document_id, COALESCE(lot_id, ''), source, COALESCE(source_key, ''))
  WHERE released_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_document_holds_auto_once
  ON document_holds(document_id, source, source_key)
  WHERE source_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_document_holds_document ON document_holds(document_id, released_at);
CREATE INDEX IF NOT EXISTS idx_document_holds_tenant_active ON document_holds(tenant_id, released_at, placed_at);
CREATE INDEX IF NOT EXISTS idx_document_holds_lot ON document_holds(lot_id);

CREATE TRIGGER IF NOT EXISTS trg_document_holds_immutable
BEFORE UPDATE ON document_holds
FOR EACH ROW
WHEN NEW.id IS NOT OLD.id
  OR NEW.tenant_id IS NOT OLD.tenant_id
  OR NEW.document_id IS NOT OLD.document_id
  OR NEW.reason IS NOT OLD.reason
  OR NEW.source IS NOT OLD.source
  OR NEW.source_key IS NOT OLD.source_key
  OR NEW.spec_check_id IS NOT OLD.spec_check_id
  OR NEW.document_version IS NOT OLD.document_version
  OR NEW.detail IS NOT OLD.detail
  OR NEW.placed_by IS NOT OLD.placed_by
  OR NEW.placed_at IS NOT OLD.placed_at
  OR (
    OLD.released_at IS NOT NULL
    AND (
      NEW.released_at IS NOT OLD.released_at
      OR NEW.released_by IS NOT OLD.released_by
      OR NEW.release_reason IS NOT OLD.release_reason
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'document_holds is append-only: a hold is released, never edited');
END;
