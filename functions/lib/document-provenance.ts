/**
 * Stamp a document's provenance at approval (migration 0130): when it was
 * approved, which Review Queue item it came from, and which door that item
 * came in by (processing_queue.source). Search filters on all three
 * ("Approved last week", "Came in by email").
 *
 * Called by every approve path that produces documents
 * (functions/lib/kinds/coa.ts), once the rows exist. Never moves a value
 * already set: approval is a fact about the FIRST time, and a document that
 * later gains a version through another path keeps its origin.
 *
 * Best-effort, like the arrival stamp beside it: the approval has happened and
 * must stand, so a failure here is logged and swallowed.
 */
export async function stampApprovalProvenance(
  db: D1Database,
  tenantId: string,
  queueItemId: string,
  documentIds: string[],
): Promise<void> {
  if (documentIds.length === 0) return;
  try {
    await db.batch(
      documentIds.map((id) =>
        db
          .prepare(
            `UPDATE documents
                SET approved_at = COALESCE(approved_at, datetime('now')),
                    origin_queue_id = COALESCE(origin_queue_id, ?),
                    intake_source = COALESCE(intake_source,
                      (SELECT NULLIF(TRIM(q.source), '') FROM processing_queue q WHERE q.id = ? AND q.tenant_id = ?))
              WHERE id = ? AND tenant_id = ? AND approved_at IS NULL`,
          )
          .bind(queueItemId, queueItemId, tenantId, id, tenantId),
      ),
    );
  } catch (err) {
    console.error('stampApprovalProvenance failed (approval stands):', err);
  }
}

/** The door a document created WITHOUT a review came in by (0130). */
export type DirectIntake = 'direct_upload' | 'ingest_api';
