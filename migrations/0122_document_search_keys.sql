-- WHAT A DOCUMENT STATES, AS ROWS SEARCH CAN SEEK ON (search redesign, Phase 1).
--
-- A PO, an invoice number, a code date or a best-by date lived only inside the
-- metadata JSON: reachable as free text, or by judging every document the
-- tenant holds (the capped 5,000-document coverage scan, re-run per keystroke).
-- One row per identifier or date a document states makes each an index seek.
--
-- DERIVED DATA. Rows are written by one pure function,
-- shared/searchKeys.ts#deriveSearchKeys, from the document's metadata and its
-- linked lot rows (functions/lib/search/keys.ts; bin/backfill-search-keys uses
-- the bin/lib/shared mirror of the same function). The coverage judge re-reads
-- the document's own metadata, so a stale row can only cost a CANDIDATE, never
-- change a verdict. That is also why nothing here is a foreign key: a derived
-- table must never block a delete, and the documents/lots rebuild pattern
-- (0110) forbids ON DELETE actions pointing at a rebuilt table. A delete
-- trigger on documents clears a document's rows instead.
--
-- TWO PO NAMESPACES (prod, 2026-09-29): po_number on a supplier's certificate
-- is OUR purchase order to that supplier ('K134273', 'k134514', 'K 135680');
-- orders.po_number is the CUSTOMER's PO ('PO-90001'). They share no value. The
-- document side is kind 'supplier_po'; the WMS side is read from orders at
-- query time, and gets the index below.
--
-- value_norm: identifiers are upper-case alphanumerics (case and spaces fold,
-- leading zeros stay); dates are the ISO day; lots are lot + sublot normalized.
-- A date that reads two ways stores BOTH readings with provenance 'ambiguous'
-- (the judge then says it cannot be verified). kind has no CHECK: the
-- vocabulary is owned by shared/searchKeys.ts and grows without a rebuild.
--
-- FRESHNESS follows 0055: triggers enqueue a search_reindex_jobs row of kind
-- 'document_keys' (one pending row per document via 0055's partial unique
-- index), and every search that reads keys first drains up to N pending jobs
-- for its tenant and reports keys_pending if any remain -- so a search never
-- quietly answers from stale keys. Every existing document is enqueued below;
-- bin/backfill-search-keys drains the lot at once.
--
-- Plain-ASCII header on purpose (the 0110 D1 import finding).

CREATE TABLE IF NOT EXISTS document_search_keys (
  id           TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  tenant_id    TEXT NOT NULL,
  document_id  TEXT NOT NULL,
  lot_id       TEXT,
  kind         TEXT NOT NULL,
  value_raw    TEXT NOT NULL,
  value_norm   TEXT NOT NULL,
  value_date   TEXT,
  provenance   TEXT NOT NULL DEFAULT 'stated' CHECK (provenance IN ('stated', 'ambiguous')),
  source_field TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_document_search_keys_value
  ON document_search_keys (tenant_id, kind, value_norm);

CREATE INDEX IF NOT EXISTS idx_document_search_keys_date
  ON document_search_keys (tenant_id, kind, value_date)
  WHERE value_date IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_document_search_keys_document
  ON document_search_keys (document_id);

-- Scope filters run as index range scans instead of a tenant-wide scan.
CREATE INDEX IF NOT EXISTS idx_documents_tenant_status_supplier
  ON documents (tenant_id, status, supplier_id);
CREATE INDEX IF NOT EXISTS idx_documents_tenant_status_type
  ON documents (tenant_id, status, document_type_id);
CREATE INDEX IF NOT EXISTS idx_documents_tenant_status_created
  ON documents (tenant_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_documents_tenant_status_renewal
  ON documents (tenant_id, status, renewal_due_date);
CREATE INDEX IF NOT EXISTS idx_documents_tenant_owner
  ON documents (tenant_id, owner);

-- The customer's PO, followed to the order's lines (a PO search).
CREATE INDEX IF NOT EXISTS idx_orders_tenant_po
  ON orders (tenant_id, po_number);

-- Freshness: enqueue, never compute, inside the writing statement.
CREATE TRIGGER IF NOT EXISTS trg_documents_ai_search_keys
AFTER INSERT ON documents
BEGIN
  INSERT OR IGNORE INTO search_reindex_jobs (tenant_id, entity_kind, entity_id)
  VALUES (NEW.tenant_id, 'document_keys', NEW.id);
END;

CREATE TRIGGER IF NOT EXISTS trg_documents_au_search_keys
AFTER UPDATE OF primary_metadata, extended_metadata ON documents
BEGIN
  INSERT OR IGNORE INTO search_reindex_jobs (tenant_id, entity_kind, entity_id)
  VALUES (NEW.tenant_id, 'document_keys', NEW.id);
END;

CREATE TRIGGER IF NOT EXISTS trg_documents_ad_search_keys
AFTER DELETE ON documents
BEGIN
  DELETE FROM document_search_keys WHERE document_id = OLD.id;
  DELETE FROM search_reindex_jobs
   WHERE entity_kind = 'document_keys' AND entity_id = OLD.id AND status = 'pending';
END;

CREATE TRIGGER IF NOT EXISTS trg_document_lots_ai_search_keys
AFTER INSERT ON document_lots
BEGIN
  INSERT OR IGNORE INTO search_reindex_jobs (tenant_id, entity_kind, entity_id)
  SELECT d.tenant_id, 'document_keys', d.id FROM documents d WHERE d.id = NEW.document_id;
END;

CREATE TRIGGER IF NOT EXISTS trg_document_lots_ad_search_keys
AFTER DELETE ON document_lots
BEGIN
  INSERT OR IGNORE INTO search_reindex_jobs (tenant_id, entity_kind, entity_id)
  SELECT d.tenant_id, 'document_keys', d.id FROM documents d WHERE d.id = OLD.document_id;
END;

CREATE TRIGGER IF NOT EXISTS trg_lots_au_search_keys
AFTER UPDATE OF lot_number, sub_lot_code, code_date, expiration_date ON lots
BEGIN
  INSERT OR IGNORE INTO search_reindex_jobs (tenant_id, entity_kind, entity_id)
  SELECT d.tenant_id, 'document_keys', d.id
    FROM document_lots dl JOIN documents d ON d.id = dl.document_id
   WHERE dl.lot_id = NEW.id;
END;

-- Every document that exists today is owed its keys.
INSERT OR IGNORE INTO search_reindex_jobs (tenant_id, entity_kind, entity_id)
SELECT tenant_id, 'document_keys', id FROM documents;
