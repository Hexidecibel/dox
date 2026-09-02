-- Migration 0088: entity_notes — timestamped, attributed, append-only notes
-- against any record in the portal.
--
-- WHY
-- ---
-- "In-system notes" is on the DCN parity list and the portal has never had it.
-- What exists today is two things that are NOT notes:
--
--   documents.description (0001)  a single overwritable TEXT field. One value,
--                                 no author, no timestamp, no history. Editing
--                                 it destroys what it said before. It is a
--                                 DESCRIPTION of the document — a property of
--                                 the thing — and it stays exactly that.
--   suppliers                     nothing at all. The only ALTER TABLE
--                                 suppliers in 87 migrations is 0075's
--                                 lot_scheme.
--
-- A note is a different shape: many per record, each one attributed to a person
-- and fixed in time, read newest-first as a thread. That is what a reviewer
-- means by "put a note on this supplier".
--
-- ONE TABLE, NOT ONE PER RECORD TYPE
-- ----------------------------------
-- Suppliers and documents are the two surfaces asked for; requirement lines and
-- document requests are already named as next. A supplier_notes table plus a
-- document_notes table would mean a third and a fourth, four sets of endpoints,
-- and four UI components that drift. The note itself has no per-parent fields —
-- body, author, time — so the parent is data, not schema: (entity_type,
-- entity_id).
--
-- WHY NOT GENERALISE records_comments (0040)
-- ------------------------------------------
-- 0040 shipped a genuine threaded-comment table (parent_comment_id, mentions)
-- and nothing has ever referenced it: `grep -rn records_comments functions/ src/`
-- returns zero. Reusing it looks free and is not:
--
--   * Its identity column is `row_id TEXT NOT NULL REFERENCES records_rows(id)
--     ON DELETE CASCADE`. A note on a supplier has no records_row. Making it
--     nullable means a full SQLite table rebuild (no ALTER for FKs or NOT NULL)
--     of a table that already exists in prod — more migration risk than a fresh
--     CREATE, not less.
--   * It would then carry TWO mutually exclusive identity schemes in one table:
--     row_id for records rows, (entity_type, entity_id) for everything else,
--     each NULL exactly when the other is set, and no constraint able to say
--     which. That is the "second, different question smuggled into the same
--     rows" that 0087 argues against for supplier_requirements — the same
--     mistake, one table over.
--   * The Records module is real and unfinished. When its row drawer is wired
--     up it wants precisely what 0040 built: comments that CASCADE with their
--     row, thread by parent_comment_id, and fan out @mentions. Repurposing that
--     table now spends a fit-for-purpose design on a problem it does not fit and
--     leaves the problem it does fit without one.
--
-- So records_comments stays where it is, for records rows. Neither table is
-- deleted and neither is widened.
--
-- APPEND-ONLY, DELIBERATELY
-- -------------------------
-- There is no UPDATE path for `body`. Once posted, a note's text is fixed. This
-- is a compliance product: a note saying "supplier confirmed the allergen
-- statement is current" that can be quietly rewritten later is worth less than
-- no note, because a reader cannot tell whether they are looking at what was
-- said at the time. audit_log is append-only for the same reason.
--
-- A correction is another note. The thread already IS the amendment mechanism —
-- that is what makes it a thread rather than a field.
--
-- The one mutation allowed is RETRACTION, and it is soft: deleted_at +
-- deleted_by, row retained. A note on the wrong record needs to come off the
-- record; it does not need to vanish from the history of who wrote what and
-- when. Hard-deleting would let the append-only guarantee be laundered
-- (post-delete-repost is an edit with extra steps and no trace).
--
-- ENTITY_TYPE IS CONSTRAINED, TWICE, AT DIFFERENT WIDTHS
-- ------------------------------------------------------
-- The CHECK below is the integrity backstop: it stops free text and typo'd
-- types reaching the table at all. It is seeded with the four types this
-- facility is intended to serve, because widening a CHECK in SQLite is a full
-- table rebuild and the brief already names more parents coming.
--
-- The API is the narrower, precise gate (functions/lib/notes.ts): a type is
-- only accepted if it has a tenant-scoped existence resolver, so a note can
-- never be attached to an id the caller does not own or that does not exist.
-- Enabling a new parent is therefore a resolver entry in code, not a migration.
--
-- TENANT_ID IS DENORMALIZED ON PURPOSE. The parent tables (suppliers,
-- documents, requirements, supplier_requirements) each carry their own
-- tenant_id, but entity_id is polymorphic and cannot be a foreign key, so no
-- join can be relied on to scope a read. Every query filters on this column and
-- the API validates it against the parent before insert — the same arrangement
-- claim_type_requirements and supplier_requirements use.

CREATE TABLE IF NOT EXISTS entity_notes (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

  -- The polymorphic parent. Deliberately NOT a foreign key: entity_id points at
  -- a different table per entity_type, which SQLite cannot express. The API
  -- resolves and tenant-checks the parent on every write.
  entity_type TEXT NOT NULL
    CHECK (entity_type IN ('supplier','document','requirement','supplier_requirement')),
  entity_id TEXT NOT NULL,

  body TEXT NOT NULL,

  -- Attribution is not nullable: an unattributed note is the failure mode this
  -- table exists to fix. ON DELETE is omitted deliberately — a deactivated user
  -- keeps their name on what they wrote (users are deactivated, not deleted).
  author_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),

  -- Retraction, not deletion. NULL = live.
  deleted_at TEXT,
  deleted_by TEXT REFERENCES users(id)
);

-- The one read this table exists to serve: every live note on one record,
-- newest first. tenant_id leads so the index also enforces the scoping the
-- polymorphic entity_id cannot. created_at DESC matches the ORDER BY exactly so
-- the thread renders straight off the index with no sort step.
--
-- The list query orders by (created_at DESC, rowid DESC). created_at is
-- datetime('now') — one-second granularity — so two notes posted in the same
-- second tie, and tie-breaking on the random-hex id would order them
-- arbitrarily and inconsistently between reads. rowid is monotonic with INSERT
-- and SQLite appends it to every index entry anyway, so insertion order is both
-- the right answer and a free one.
CREATE INDEX IF NOT EXISTS idx_entity_notes_entity
  ON entity_notes(tenant_id, entity_type, entity_id, created_at DESC);

-- "What has this person written", for the audit/export path.
CREATE INDEX IF NOT EXISTS idx_entity_notes_author
  ON entity_notes(tenant_id, author_id, created_at DESC);
