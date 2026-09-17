-- ONE UPLOADED FILE IS NOT ALWAYS ONE DOCUMENT -- AND A SPLIT IS A DECISION.
--
-- The client's supplier sends a 36-page PDF holding 25 separate documents with
-- an index page listing every one of them. dox treats an upload as one
-- document, so that file classified as "Letter of Guarantee" (page 3 answering
-- for all 25) and produced document_expires_on = 2027-01-02, a date printed
-- NOWHERE in the file: page 3's "valid one year from the date hereof" clause,
-- read correctly and then applied to a packet containing an SQF certificate
-- that lapses 2026-04-23 and a kosher letter that lapses 2026-06-30. A packet
-- like that is normal practice, not a one-off.
--
-- NOTHING HERE SPLITS ANYTHING. A wrong split turns one wrong document into
-- twenty-five, each with its own type, renewal date and place in a compliance
-- file. So detection (shared/packetDetect.ts) PROPOSES, the proposal is stored,
-- and the columns below record what a PERSON then decided. Three outcomes, and
-- the schema can tell all three apart:
--
--   nobody has looked      packet_proposal set, both decision stamps NULL
--   "not a packet"         packet_dismissed_at set -- the card never asks again
--   "split into N"         packet_split_at set on the parent, N child rows
--
-- THE PARENT BECOMES A CONTAINER. It is deliberately NOT approved into a
-- document -- approving it would recreate exactly the defect this exists for --
-- and `functions/api/queue/[id].ts` refuses an approve on any row with
-- packet_split_at. It stays 'pending' rather than gaining a fourth status,
-- because status is a CHECK constraint on a table SQLite cannot alter in place
-- and a container is not a new lifecycle: it is a pending item that one
-- specific action is closed to. Rejecting it is still allowed and leaves its
-- children alone -- that is how a reviewer clears the container once the parts
-- are handled.
--
-- THE ORIGINAL FILE STAYS THE SOURCE OF RECORD. file_r2_key on the parent is
-- never touched. Each child gets its own carved PDF (the SAME splitter the COA
-- records path runs, functions/lib/kinds/coaPageScope.ts#extractRecordPdf --
-- it carved all 26 parts of this packet with no fallback) and records the page
-- range it came from, so "which pages of what did this document come from" is
-- answerable forever without re-deriving it.
--
-- packet_parent_id IS NULLABLE AND SELF-REFERENTIAL, with ON DELETE SET NULL:
-- an orphaned child is a queue item with a file, and losing its parent must
-- never lose the work. A partial index on the non-NULL side is the whole
-- worklist ("every part of every split"), which is how the review card finds
-- its siblings.
--
-- Additive and nullable throughout. Every existing row reads exactly as it did
-- the day before: NULL packet_proposal means nothing was detected, which is
-- also what every row extracted before this migration says.

-- The proposal, as shared/packetDetect.ts produced it. A TEXT column holding
-- JSON, like ai_fields / learned_field_hints / text_page_sources before it --
-- nothing queries inside it, the review UI renders it.
ALTER TABLE processing_queue ADD COLUMN packet_proposal TEXT;

-- "Not a packet." Remembered on the item so the card stops asking.
ALTER TABLE processing_queue ADD COLUMN packet_dismissed_at TEXT;
ALTER TABLE processing_queue ADD COLUMN packet_dismissed_by TEXT REFERENCES users(id);

-- The split, once a person confirmed it. packet_split_method records whether
-- the ranges came from the file's own index or from the page layout, and
-- whether the reviewer edited them ('index', 'letterhead', 'heuristic',
-- 'adjusted') -- a split nobody checked and a split somebody corrected are
-- different evidence about the detector.
ALTER TABLE processing_queue ADD COLUMN packet_split_at TEXT;
ALTER TABLE processing_queue ADD COLUMN packet_split_by TEXT REFERENCES users(id);
ALTER TABLE processing_queue ADD COLUMN packet_split_method TEXT;
ALTER TABLE processing_queue ADD COLUMN packet_part_count INTEGER;

-- The child half: which container it came out of, which pages of it, and where
-- it sat in the proposal. packet_part_label is the index's own words for the
-- part, kept as a HINT for the reviewer and never fed to classification -- this
-- packet's index calls page 6 a "Global Standard for Food Safety Certificate"
-- and the page is an SQF certificate from NSF.
ALTER TABLE processing_queue ADD COLUMN packet_parent_id TEXT REFERENCES processing_queue(id) ON DELETE SET NULL;
ALTER TABLE processing_queue ADD COLUMN packet_pages TEXT;
ALTER TABLE processing_queue ADD COLUMN packet_part_index INTEGER;
ALTER TABLE processing_queue ADD COLUMN packet_part_label TEXT;

CREATE INDEX IF NOT EXISTS idx_pq_packet_parent
  ON processing_queue(packet_parent_id, packet_part_index)
  WHERE packet_parent_id IS NOT NULL;
