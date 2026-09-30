-- WHEN A DOCUMENT WAS APPROVED, WHICH DOOR IT CAME IN BY, AND WHICH REVIEW
-- QUEUE ITEM IT CAME FROM (search redesign Phase 3: "Approved" and "Came in by"
-- as search filters).
--
-- Nothing linked a document back to the queue item it was approved from. The
-- approval day and the intake door (email, connector, supplier request link,
-- smart upload) lived only on processing_queue (reviewed_at, source), and
-- documents.created_at is the day the row was written - the approval day for a
-- reviewed document, the upload day for one uploaded directly. So "COAs that
-- came in by email and were approved last week" could not be asked.
--
--   approved_at      the moment a person approved the queue item that
--                    produced this document. NULL = not recorded (approved
--                    before this migration with no provable record, or never
--                    reviewed at all: a direct upload or an ingest API call).
--   intake_source    the door: processing_queue.source for a reviewed
--                    document ('import' = smart upload, 'email', 'manual',
--                    's3', 'api', 'public_link', 'request_link', ...), or
--                    'direct_upload' / 'ingest_api' for the two paths that
--                    create a document without a review. NULL = not recorded.
--   origin_queue_id  the processing_queue row. No foreign key: a queue row may
--                    be purged, and derived provenance must never block that.
--
-- Stamped at approval by functions/lib/document-provenance.ts, called from
-- every approve path that produces documents (functions/lib/kinds/coa.ts), and
-- at insert by the direct paths. Never moved once set: approval is a fact
-- about the first time.
--
-- BACKFILL ONLY WHERE PROVABLE. The approve paths have always written a
-- queue_item.approved / .partial_approved / .auto_ingested audit row naming the
-- queue item (resource_id) and the documents it produced (details.document_id
-- or details.document_ids), in the same request, right after the insert. That
-- row's created_at IS the approval, its resource_id IS the queue item, and the
-- queue item's own source IS the door. A document no such row names stays
-- NULL and the search facet shows it as "Not recorded" - inventing a date
-- would assert a fact nobody has. Then, for documents still unrecorded, a
-- 'document_created' audit row (POST /api/documents) proves a direct upload
-- and a 'document.ingested' row with action 'created' the ingest API (one
-- with 'version_added' says nothing about how the document itself began);
-- neither sets approved_at,
-- because nobody reviewed them.
--
-- Plain-ASCII header (the 0110 D1 import finding). Additive and nullable.

ALTER TABLE documents ADD COLUMN approved_at TEXT;
ALTER TABLE documents ADD COLUMN intake_source TEXT;
ALTER TABLE documents ADD COLUMN origin_queue_id TEXT;

CREATE INDEX IF NOT EXISTS idx_documents_tenant_approved
  ON documents (tenant_id, approved_at)
  WHERE approved_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_documents_tenant_intake_source
  ON documents (tenant_id, intake_source)
  WHERE intake_source IS NOT NULL;

-- Backfill 1: reviewed documents, from the approval audit row (the earliest
-- one naming the document, in its own tenant).
WITH approvals AS (
  SELECT a.id AS audit_id, a.created_at AS approved_at, a.resource_id AS queue_id, a.tenant_id,
         COALESCE(json_extract(a.details, '$.document_id'), j.value) AS document_id
    FROM audit_log a
    LEFT JOIN json_each(
      CASE WHEN json_valid(a.details) AND json_type(a.details, '$.document_ids') = 'array'
           THEN json_extract(a.details, '$.document_ids') END) j
   WHERE a.action IN ('queue_item.approved', 'queue_item.partial_approved', 'queue_item.auto_ingested')
     AND a.resource_type = 'processing_queue'
     AND json_valid(a.details)
)
UPDATE documents
   SET approved_at = (SELECT ap.approved_at FROM approvals ap
                       WHERE ap.document_id = documents.id AND ap.tenant_id = documents.tenant_id
                       ORDER BY ap.approved_at, ap.audit_id LIMIT 1),
       origin_queue_id = (SELECT ap.queue_id FROM approvals ap
                           WHERE ap.document_id = documents.id AND ap.tenant_id = documents.tenant_id
                           ORDER BY ap.approved_at, ap.audit_id LIMIT 1)
 WHERE approved_at IS NULL
   AND EXISTS (SELECT 1 FROM approvals ap WHERE ap.document_id = documents.id AND ap.tenant_id = documents.tenant_id);

UPDATE documents
   SET intake_source = (SELECT NULLIF(TRIM(q.source), '') FROM processing_queue q
                         WHERE q.id = documents.origin_queue_id AND q.tenant_id = documents.tenant_id)
 WHERE intake_source IS NULL AND origin_queue_id IS NOT NULL;

-- Backfill 2: the two paths that create a document with no review.
UPDATE documents
   SET intake_source = 'direct_upload'
 WHERE intake_source IS NULL AND origin_queue_id IS NULL
   AND EXISTS (SELECT 1 FROM audit_log a
                WHERE a.action = 'document_created' AND a.resource_type = 'document'
                  AND a.resource_id = documents.id AND a.tenant_id = documents.tenant_id);

UPDATE documents
   SET intake_source = 'ingest_api'
 WHERE intake_source IS NULL AND origin_queue_id IS NULL
   AND EXISTS (SELECT 1 FROM audit_log a
                WHERE a.action = 'document.ingested' AND a.resource_type = 'document'
                  AND a.resource_id = documents.id AND a.tenant_id = documents.tenant_id
                  AND json_valid(a.details) AND json_extract(a.details, '$.action') = 'created');
