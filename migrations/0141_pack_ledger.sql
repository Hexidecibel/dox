-- Migration 0141: the starter-pack ledger.
--
-- WHY
-- ---
-- A starter pack could be applied and never updated. Every statement was
-- INSERT OR IGNORE, nothing recorded which pack or which version of it an
-- organisation was seeded from, and nothing recorded what the pack had written
-- into a row -- so a changed default could only ever reach an organisation set
-- up AFTER the change. The client, reviewing v2.7.0-v2.20.0: the first changed
-- default "applies to newly set-up orgs only, so our config keeps the old rule.
-- That is the first product default to drift from our tenant and it will not be
-- the last." Three one-off repair scripts already exist for exactly that
-- (bin/fix-starter-pack-renewal-policy, bin/propose-requirement-scopes,
-- bin/retire-duplicate-requirements).
--
-- A roll-forward needs to tell three things apart for every row: what the pack
-- wrote, what the row holds now, and what the new version says. The first of
-- those was never stored. This migration stores it. Decisions C-154..C-175
-- (docs/decision-log.md).
--
-- WHAT THIS ADDS
-- --------------
-- tenant_packs -- WHICH PACK AND VERSION AN ORGANISATION IS ON. Append-only:
--     one row for the first application and one more for every roll-forward
--     that moved the version. The CURRENT version is the highest `version`
--     for (tenant_id, pack); nothing is ever updated, so the history is the
--     table. An organisation with no row is "not ledgered": the appliers and
--     the screen treat it as never having had this pack recorded, and
--     bin/baseline-pack-ledger is what gives it a row.
--
--     A version only ever goes UP: the planner refuses to roll an
--     organisation to an older pack, and one step is one row (the unique index
--     below).
--     version       -- the pack version rolled TO.
--     from_version  -- the version rolled FROM; NULL for the first row.
--     source        -- 'apply' (the portal), 'cli' (bin/create-tenant),
--                      'baseline' (bin/baseline-pack-ledger), 'roll_forward'.
--                      No CHECK: a new door must not need a migration.
--     applied_by    -- a user id, or NULL for the CLI and the baseline. No
--                      foreign key on purpose: a ledger row must outlive the
--                      account that wrote it.
--     summary       -- JSON counts of what that application did. NULL for the
--                      first application (the audit row carries its counts).
--
-- pack_applied_items -- ONE ROW PER PACK ITEM PER ORGANISATION: what the pack
--     wrote there. The key is (tenant_id, pack, kind, item_key), where
--     item_key is the item's SLUG (or `parent__child` for a link) -- never an
--     id, because ids are per organisation and slugs are the thing that is the
--     same everywhere.
--
--     kind          -- owner_label / document_type / requirement / claim_type /
--                      claim_rule / type_requirement / extraction_instructions /
--                      spec_test / spec_limit / module (shared/packItems.ts,
--                      PACK_ITEM_KINDS). No CHECK, for the same reason as
--                      `source`: a pack that learns to write a new table adds a
--                      kind in code.
--     row_id        -- the row this item IS in that organisation: the id of the
--                      row the pack inserted, or of the row it adopted (a
--                      hand-made row holding the pack's slug). For the two
--                      tables with no id it is the key column (owner_key,
--                      module_key). NULL when there is no row. A bare pointer,
--                      NO FOREIGN KEY: it points into ten different tables, and
--                      the whole purpose of the `deleted` state below is to
--                      keep the entry after the row has gone.
--     pack_version  -- the pack version `written` was taken from.
--     written       -- JSON object, column -> value: EXACTLY what the pack
--                      writes into that row at pack_version. This is the "base"
--                      of the three-way comparison.
--     differing     -- JSON object, column -> 'unknown' | 'edited': the columns
--                      where the row does NOT hold `written`. 'unknown' means it
--                      already differed when the row was first ledgered (an
--                      adopted row, or the baseline of an organisation seeded
--                      before this table existed): nobody knows whether a
--                      person or an older pack wrote it, so it is treated as a
--                      person's and never overwritten on a guess. 'edited'
--                      means the pack wrote it and the organisation changed it.
--                      '{}' = the row is the pack's, column for column.
--     state         -- pack            present, every column the pack's
--                      differs         present, some column is not the pack's
--                      absent          the pack has this item and the
--                                      organisation had no row for it when it
--                                      was ledgered. NOT RESURRECTED.
--                      deleted         it was ledgered with a row and the row
--                                      has since gone: the organisation removed
--                                      it. Stays gone.
--                      inactive        the row is still there, switched off
--                                      (active = 0). Stays off, and is not
--                                      updated while it is off.
--                      removed_from_pack  a later pack version no longer has
--                                      this item. The row is left exactly as it
--                                      is and flagged; nothing is deleted.
--                      No CHECK, so a later state does not need a table rebuild.
--     source        -- which door wrote the entry first (as tenant_packs.source).
--
-- WHAT THIS DOES NOT DO
-- ---------------------
-- It inserts NOTHING. No organisation gets a ledger from this migration: a row
-- here asserts "the pack wrote this", and for an organisation seeded before
-- today that can only be established by comparing its rows with the pack, which
-- is a report a person reads first (bin/baseline-pack-ledger, dry run by
-- default). Until an organisation is baselined it behaves exactly as before.
--
-- Additive: two new tables, no ALTER, no rebuild, no backfill. The only foreign
-- keys are to tenants(id) ON DELETE CASCADE, the same as every per-tenant
-- vocabulary table (requirements, claim_types, tenant_modules); nothing
-- references either table, and neither has a supplier_id, so mergeSuppliers is
-- not involved.

CREATE TABLE IF NOT EXISTS tenant_packs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  pack TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  from_version INTEGER,
  source TEXT NOT NULL,
  applied_at TEXT NOT NULL DEFAULT (datetime('now')),
  applied_by TEXT,
  summary TEXT CHECK (summary IS NULL OR json_valid(summary))
);

CREATE INDEX IF NOT EXISTS idx_tenant_packs_tenant ON tenant_packs (tenant_id, pack, version);

-- ONE ROW PER STEP. The history is append-only, and a step (this organisation,
-- this pack, from this version to that one) happens once: two requests that
-- both reach the stamp write one row, because the second is INSERT OR IGNOREd
-- on this index. COALESCE because the first row of a pack has no from_version
-- and NULLs are distinct in a unique index. (Added by amending this file before
-- it was applied anywhere but local dev; CREATE ... IF NOT EXISTS, so a local
-- database that ran the first cut takes it with --reapply.)
CREATE UNIQUE INDEX IF NOT EXISTS idx_tenant_packs_step
  ON tenant_packs (tenant_id, pack, version, COALESCE(from_version, 0));

CREATE TABLE IF NOT EXISTS pack_applied_items (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  pack TEXT NOT NULL,
  kind TEXT NOT NULL,
  item_key TEXT NOT NULL,
  row_id TEXT,
  pack_version INTEGER NOT NULL CHECK (pack_version >= 1),
  written TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(written)),
  differing TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(differing)),
  state TEXT NOT NULL,
  source TEXT NOT NULL,
  applied_by TEXT,
  applied_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (tenant_id, pack, kind, item_key)
);

CREATE INDEX IF NOT EXISTS idx_pack_applied_items_row ON pack_applied_items (tenant_id, kind, row_id);
