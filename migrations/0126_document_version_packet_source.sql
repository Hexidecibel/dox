-- WHERE A SPLIT DOCUMENT CAME FROM: the packet it was carved out of, and which
-- pages.
--
-- Rules table H1 (AJ, ruled 2026-09-20): packet splitting is human-confirmed,
-- the original packet stays on record as received, and each split part cites
-- the packet it came from and its page range. "A reviewer must be able to walk
-- from any single document back to what the supplier actually sent."
--
-- 0118 recorded the split on the QUEUE (packet_parent_id, packet_pages on the
-- child item) but the approve paths never copied it anywhere: an approved part
-- became a document with a five-page file and no way back to the thirty-six
-- page packet. These two columns are that way back.
--
-- ON THE VERSION, NOT THE DOCUMENT. The citation is a fact about one FILE --
-- pages 13-16 of that packet -- and a later version of the same document
-- (the supplier sends next year's certificate on its own) did not come from a
-- packet at all.
--
--   source_packet_queue_id  the packet's queue item, the source of record.
--                           ON DELETE SET NULL: losing the queue row must
--                           never lose the document.
--   source_packet           JSON, FROZEN at approval: the packet's file name,
--                           the day it was received, its checksum, the page
--                           range, the part number and count, the index's own
--                           label for the part, who split it and when. Frozen
--                           for the renewal_snapshot / limit_snapshot reason:
--                           the citation has to survive the queue row being
--                           pruned, and it must say what was true when a human
--                           approved the part.
--
-- NULL on both means "not from a packet", which is every existing row and
-- every ordinary upload. Nullable, no default, no backfill: nothing recorded
-- which approved documents came from a split before this.
--
-- Plain-ASCII header (the 0110 D1 import finding).

ALTER TABLE document_versions ADD COLUMN source_packet_queue_id TEXT
  REFERENCES processing_queue(id) ON DELETE SET NULL;
ALTER TABLE document_versions ADD COLUMN source_packet TEXT
  CHECK (source_packet IS NULL OR json_valid(source_packet));

CREATE INDEX IF NOT EXISTS idx_document_versions_source_packet
  ON document_versions(source_packet_queue_id)
  WHERE source_packet_queue_id IS NOT NULL;
