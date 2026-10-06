-- Migration 0134: an order a PERSON builds, and the record of what left on it.
--
-- WHY
-- ---
-- AJ Conner, 2026-10-05/06 (decisions D-040..D-051): the basic tier of COA
-- fulfillment has no WMS feed, so a person does what the matching engine does
-- on the automatic tier -- names the customer, the customer's PO / order
-- number and the ship date, picks the approved certificate for each product
-- and lot, reviews it and sends it. Until now an order could only be filled by
-- a connector: no endpoint added a line, the only writer of a line's
-- certificate was accepting an engine suggestion, and nothing sent anything
-- from an order.
--
-- ONE ORDER RECORD FOR BOTH TIERS. Nothing here is a second "manual order"
-- object. A hand-built order is an `orders` row whose lines were filled by a
-- person instead of the engine, and it says which through the columns below.
--
-- WHAT THIS ADDS
-- --------------
-- orders.ship_date    -- the day the goods ship (YYYY-MM-DD), typed by the
--                        person or NULL. The connector path keeps whatever it
--                        keeps in primary_metadata; this is the one the
--                        fulfillment screens read and print.
-- orders.created_by   -- the user who created the order by hand. NULL = a
--                        connector made it (connector_id says which) or it
--                        predates this migration. Bare pointer, no FK: an ALTER
--                        cannot add an enforced one usefully and a removed user
--                        must never block reading an order.
--
-- order_items.picked_by / picked_at
--                     -- who put THIS certificate on THIS line by hand, and
--                        when. NULL = the line's certificate came from an
--                        accepted engine suggestion (or there is none). A pick
--                        writes the same columns an accepted suggestion writes
--                        (coa_document_id, lot_id, lot_matched,
--                        coa_match_status = 'matched', coa_matched_at) plus an
--                        'accepted' lot_match_suggestions row whose
--                        match_basis is 'manual_pick' -- match_basis has no
--                        CHECK, so no rebuild -- so every reader that asks "did
--                        a person accept this" gets yes.
--
-- order_sends         -- ONE send of an order's documents to a customer: who
--                        pressed send, to which addresses, the subject and the
--                        covering message exactly as they left, how many
--                        emails it was split into, and how it ended
--                        ('sent' / 'partial' / 'failed'). `parts` is the
--                        per-email outcome (JSON, validated in code).
--                        `order_id` is a BARE POINTER with the order number
--                        and customer name copied beside it: a record of what
--                        left must outlive the order it left on, and an FK
--                        with no ON DELETE action would make an order with a
--                        send undeletable.
--
-- order_send_files    -- ONE FILE that left (or was meant to): the generated
--                        name it travelled under (the uploaded name never
--                        leaves -- rules table H4), its size and checksum, the
--                        email it rode in (`part_number`), HOW it went
--                        (`delivery` 'attachment' / 'link') and WHAT it was
--                        (`source` 'document' = the document's own file,
--                        'original' = the whole certificate a per-lot page was
--                        cut from, with `source_queue_id` naming where that
--                        original is kept). `document_ids` lists every
--                        document the one file stands for: several lines cut
--                        from one multi-lot certificate travel as ONE
--                        attachment. `sent_ok` is 0 until its email is
--                        accepted by the mail provider.
--
--                        Named for documents, not certificates, on purpose: a
--                        later "document orders for sales" feature puts
--                        non-COA documents on the same order.
--
-- document_export_links.never_expires
--                     -- a file too large to attach leaves as a link, and AJ's
--                        ruling is that a customer's certificate link does not
--                        expire. `expires_at` is NOT NULL (0115) and cannot be
--                        relaxed without rebuilding the table, so the flag is
--                        the authority and every gate reads it; such a link
--                        also stores a far-future expires_at so a reader that
--                        predates the flag fails open the same way. It stays
--                        revocable: never_expires is about time, revoked_at is
--                        about a person.
--
-- Additive only, no rebuild, nothing backfilled: every existing order, line
-- and link keeps NULL / 0, which is the literal truth of each. Plain-ASCII
-- header (the 0110 D1 import finding).

ALTER TABLE orders ADD COLUMN ship_date TEXT;
ALTER TABLE orders ADD COLUMN created_by TEXT;

ALTER TABLE order_items ADD COLUMN picked_by TEXT;
ALTER TABLE order_items ADD COLUMN picked_at TEXT;

ALTER TABLE document_export_links ADD COLUMN never_expires INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS order_sends (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  order_id TEXT NOT NULL,
  order_number TEXT NOT NULL,
  customer_id TEXT,
  customer_name TEXT,
  sent_by TEXT NOT NULL REFERENCES users(id),
  recipients TEXT NOT NULL CHECK (json_valid(recipients)),
  subject TEXT NOT NULL,
  message TEXT,
  part_count INTEGER NOT NULL,
  parts TEXT CHECK (parts IS NULL OR json_valid(parts)),
  status TEXT NOT NULL CHECK (status IN ('sent', 'partial', 'failed')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_order_sends_order ON order_sends(order_id, created_at);
CREATE INDEX IF NOT EXISTS idx_order_sends_tenant ON order_sends(tenant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_order_sends_sender ON order_sends(tenant_id, sent_by, created_at);

CREATE TABLE IF NOT EXISTS order_send_files (
  id TEXT PRIMARY KEY,
  send_id TEXT NOT NULL REFERENCES order_sends(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  document_id TEXT NOT NULL,
  version_number INTEGER,
  document_ids TEXT NOT NULL CHECK (json_valid(document_ids)),
  document_title TEXT,
  lot_label TEXT,
  file_name TEXT NOT NULL,
  bytes INTEGER NOT NULL DEFAULT 0,
  checksum TEXT,
  part_number INTEGER NOT NULL,
  delivery TEXT NOT NULL CHECK (delivery IN ('attachment', 'link')),
  source TEXT NOT NULL CHECK (source IN ('document', 'original')),
  source_queue_id TEXT,
  export_link_id TEXT,
  sent_ok INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_order_send_files_send ON order_send_files(send_id, position);
CREATE INDEX IF NOT EXISTS idx_order_send_files_document ON order_send_files(tenant_id, document_id);
