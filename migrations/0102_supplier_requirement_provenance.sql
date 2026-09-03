-- Migration 0102: where a supplier's checklist row CAME FROM.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- WHY THIS EXISTS
-- ═══════════════════════════════════════════════════════════════════════════
-- `supplier_requirements` (0087) says WHICH checklist items apply to WHICH
-- supplier. It is the left side of every gap report, so a wrong row there does
-- not merely sit in a table — it invents an obligation and then reports the
-- supplier as failing to meet it.
--
-- The live tenant's checklist is uniform-and-wrong for exactly that reason: six
-- items were bulk-written across 21 existing suppliers in one retroactive pass,
-- and nothing on any row records that this is what happened. Every one of them
-- is indistinguishable from a row somebody chose deliberately. The setup
-- wizard's last screen applies a starter pack's PACKET to ONE named supplier,
-- so it is about to become a second producer — and a second producer with no
-- provenance would make the first one's damage permanent by dilution.
--
-- Two columns, both about discovery rather than behaviour: nothing reads them
-- to decide anything, and gap detection is byte-identical before and after.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- `source` IS NULLABLE, AND THE NULLS ARE THE POINT
-- ═══════════════════════════════════════════════════════════════════════════
-- The obvious shape — `source TEXT NOT NULL DEFAULT 'human'`, matching 0100 —
-- is wrong HERE, and the difference is worth writing down. 0100 created an
-- empty table, so its default described every row truthfully. This table
-- already holds rows, including the bulk-written ones, and a NOT NULL DEFAULT
-- would stamp 'human' onto them: the audit trail would then assert that
-- somebody chose each of those items for each of those suppliers, which is the
-- precise falsehood this column exists to prevent.
--
-- So NULL means "written before anybody recorded why", it is the honest state
-- for every row that exists today, and it is queryable — `WHERE source IS
-- NULL` is the worklist for auditing the retroactive write.
--
-- No CHECK on the values, for the reason already recorded for
-- `document_requirements.source` in functions/lib/registry.ts and repeated by
-- 0100: the set of producers grows, and SQLite cannot alter a CHECK in place —
-- each new one would cost a table rebuild. The vocabulary is 'packet' |
-- 'human' today and is enforced where it is written, not by the column.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- `packet_slug` IS A LABEL, NOT A FOREIGN KEY
-- ═══════════════════════════════════════════════════════════════════════════
-- There is no packets table and this migration does not create one. Packets are
-- DEFINED IN THE PACK JSON (`requirement_packets`, compiled into
-- functions/lib/starterPacks.generated.ts) and applied one supplier at a time;
-- a table would imply they are tenant state that can drift from the pack, and
-- would need a migration every time a vertical adds one. So the slug is stored
-- as text with no referent the database can police, exactly as
-- `tenant_setup_runs.pack` (0101) stores a pack name that is a JSON file.
--
-- A packet the pack later renames leaves rows naming something that no longer
-- ships. That is correct: the row records what was applied at the time, and a
-- provenance stamp that silently follows a rename is not provenance.
--
-- NULL on every row that did not come from a packet, including 'human' ones.

ALTER TABLE supplier_requirements ADD COLUMN source TEXT;
ALTER TABLE supplier_requirements ADD COLUMN packet_slug TEXT;

-- "Which suppliers got the Ingredient Supplier packet, and when did that
-- change?" — the one question these columns were added to answer. Partial, on
-- the non-NULL side, because every pre-existing row has a NULL slug and an
-- index over those is an index over noise (the same shape as 0094's partial
-- index on `request_uploads.queue_id`).
CREATE INDEX IF NOT EXISTS idx_supplier_requirements_packet
  ON supplier_requirements(tenant_id, packet_slug)
  WHERE packet_slug IS NOT NULL;
