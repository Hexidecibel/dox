-- Migration 0138: document orders. The lines of an order that ask for a
-- supplier's documents rather than a lot's certificate.
--
-- WHY
-- ---
-- Decisions C-043 and C-044 (docs/decision-log.md), AJ Conner's finish-line
-- step 1d. Sales builds an order from the approved item list; the portal
-- resolves each item-and-supplier pair to the current approved document of
-- each type asked for; each document then leaves according to its sharing
-- rule (0137): send freely on a 30-day link, held for QA, or never.
--
-- ONE ORDER RECORD. This is not a second kind of order. It is the `orders`
-- row of 0030 / 0134, and the COA lines stay in `order_items`, untouched: a
-- COA line is one lot row and one certificate, and has no supplier, no type
-- and no approval state. A document line is a different shape, so it gets its
-- own table instead of five nullable columns on `order_items`.
--
-- WHAT THIS ADDS
-- --------------
-- order_documents -- ONE ROW PER (order, item, supplier, document type).
--     A product with several approved suppliers is several rows (C-043):
--     nothing picks a supplier.
--
--     product_id, supplier_id, document_type_id -- what was asked for. All
--         NOT NULL so the plain UNIQUE actually constrains (the 0087 rule).
--         `supplier_id` has NO ON DELETE ACTION on purpose: the 0133 rule is
--         that anything with a supplier_id ON DELETE CASCADE must be moved by
--         `mergeSuppliers`, and a cascade here would let a supplier merge
--         delete what somebody asked for. With no action the delete would be
--         refused instead, so `mergeSuppliers` moves these rows explicitly
--         (a line the winner already has is kept once).
--     THERE IS NO FACILITY COLUMN. The plant is display only and is read at
--         the moment of display from `product_suppliers.facility_id`: a
--         stored copy would go stale the day somebody corrects the plant, and
--         would need its own handling in a supplier merge, for a value no
--         decision reads.
--
--     document_id, version_number -- what the resolver found, or NULL.
--     resolution -- 'found' / 'missing' / 'expired', CHECKed: a closed
--         vocabulary this table owns and nothing references.
--     resolution_note -- plain words when the answer needs them (two
--         documents shared a date; an older one is still in date).
--     document_due_date -- the document's own due date as resolved.
--     resolved_at -- when the resolver last ran for this line.
--
--     rule_at_resolve -- the sharing rule as read when the line was resolved.
--         A SNAPSHOT FOR DISPLAY AND NOTHING ELSE. NO CHECK, like 0137's two
--         columns. The live rule is re-read at send, at release and at every
--         read of the link; no decision ever reads this column.
--
--     release_status -- 'none' / 'pending_qa' / 'released' / 'refused',
--         CHECKed. `pending_qa` is the held release C-044 describes.
--     pending_send_id / pending_at / pending_requested_by -- the send that
--         put the line in front of QA. The addresses a release mails are
--         read from THAT send's stored recipients, so a release cannot be
--         redirected by a later edit to the customer.
--     decided_by / decided_at / decision_note -- who released or refused it.
--         A refusal needs a note (enforced by the API).
--
--     qa_notified_at / qa_notified_cause -- QA is told ONCE per line per
--         cause ('pending_qa' / 'missing' / 'expired'). NULL = not told.
--
--     export_link_id -- the link the document last left on (bare pointer).
--     last_send_id / last_sent_at -- the send it last left with. "Did this
--         line go" is read from here when deciding whether an order is
--         delivered.
--     added_by -- who put the line on the order.
--
-- order_sends.kind -- NULL for an ordinary send (every row before this
--     migration); 'qa_request' for a send where nothing could go yet and QA
--     was asked; 'qa_release' for the mail a QA release produced. No CHECK:
--     the table has one already on `status`, and a new kind must not need a
--     rebuild.
--
-- order_send_files.order_document_ids -- JSON list of the order_documents
--     rows a file stands for; NULL for a COA line's file.
-- order_send_files.link_days -- for a `delivery = 'link'` file, how long the
--     link lives. NULL keeps 0134's meaning exactly: a file too large to
--     attach, on a link that does not expire. 30 is a document order's link.
--
-- ADDITIVE ONLY. One new table, three nullable columns with no default. No
-- existing row changes and nothing is rebuilt.

CREATE TABLE IF NOT EXISTS order_documents (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL REFERENCES products(id),
  supplier_id TEXT NOT NULL REFERENCES suppliers(id),
  document_type_id TEXT NOT NULL REFERENCES document_types(id),
  document_id TEXT REFERENCES documents(id),
  version_number INTEGER,
  resolution TEXT NOT NULL CHECK (resolution IN ('found', 'missing', 'expired')),
  resolution_note TEXT,
  document_due_date TEXT,
  resolved_at TEXT NOT NULL DEFAULT (datetime('now')),
  rule_at_resolve TEXT,
  release_status TEXT NOT NULL DEFAULT 'none'
    CHECK (release_status IN ('none', 'pending_qa', 'released', 'refused')),
  pending_send_id TEXT,
  pending_at TEXT,
  pending_requested_by TEXT,
  decided_by TEXT,
  decided_at TEXT,
  decision_note TEXT,
  qa_notified_at TEXT,
  qa_notified_cause TEXT,
  export_link_id TEXT,
  last_send_id TEXT,
  last_sent_at TEXT,
  added_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(order_id, product_id, supplier_id, document_type_id)
);

CREATE INDEX IF NOT EXISTS idx_order_documents_order ON order_documents(order_id);
CREATE INDEX IF NOT EXISTS idx_order_documents_pending ON order_documents(tenant_id, release_status);
CREATE INDEX IF NOT EXISTS idx_order_documents_document ON order_documents(tenant_id, document_id);
CREATE INDEX IF NOT EXISTS idx_order_documents_supplier ON order_documents(tenant_id, supplier_id);

ALTER TABLE order_sends ADD COLUMN kind TEXT;

ALTER TABLE order_send_files ADD COLUMN order_document_ids TEXT;
ALTER TABLE order_send_files ADD COLUMN link_days INTEGER;
