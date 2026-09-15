/**
 * Exact-duplicate detection at intake (migration 0107).
 *
 * THE RULE, IN ONE PLACE
 * ----------------------
 * Every intake door computes a SHA-256 of the bytes. Before an arrival becomes
 * a review card, it is compared with what this TENANT already holds:
 *
 *   1. identical to an APPROVED file   -> no new card. A ledger row
 *      (`intake_duplicates`, match_kind `already_approved`) links the arrival
 *      to the document it already became, and the document page says
 *      "received again".
 *   2. identical to a file still WAITING in the Review Queue -> no second
 *      card. Ledger row `already_waiting` against that queue item, whose card
 *      says "also received from <source>".
 *   3. identical to a REJECTED file    -> queued normally (a resend after a
 *      rejection is often deliberate), and the card says "this exact file was
 *      rejected on <date> for <reason>". Not a suppression, so no ledger row;
 *      an audit row records that the match was seen.
 *
 * Precedence is 1, then 2, then 3: "a reviewer already approved this" is the
 * strongest thing intake can know about a file.
 *
 * NOTHING HERE DECIDES ANYTHING A PERSON DECIDES
 * ---------------------------------------------
 * A suppression deletes nothing and rejects nothing. The bytes stay where the
 * door put them, the exact enqueue call is stored, and "Review anyway"
 * (POST /api/intake-duplicates/:id/review) replays it. Every suppression writes
 * an audit row. The match is BYTE-IDENTICAL only; a re-scan of the same page
 * is a different file and goes to review like any other, on purpose.
 *
 * WHAT "APPROVED" MEANS HERE
 * --------------------------
 * Two readings, both checked, because neither alone is complete on prod:
 *   - a live document whose version carries the checksum. True for every
 *     single-document approval, manual uploads and the ingest API.
 *   - an approved queue item carrying the checksum. A records-shaped COA is
 *     page-scoped at approval, so its documents carry the checksum of their
 *     OWN pages, not of the file that arrived; the queue item still carries
 *     the arrival's. Its documents are found by `external_ref`
 *     ('queue-<id>' / 'queue-<id>-<suffix>'). An order/shipment approval has
 *     no document at all, and still counts: it was reviewed.
 *
 * KNOWN LIMIT: two identical files arriving in the same instant can both pass
 * the check (there is no unique index to make the second unwritable, because
 * prod already holds pending twins that would fail its creation). The window
 * is one request; the worst case is today's behaviour.
 */

import { generateId, logAudit } from '../db';
import type {
  IntakeDuplicateMatchKind,
  IntakeDuplicateNotice,
  IntakeRejectedMatch,
  QueueIntakeHistory,
  RejectionReason,
} from '../../../shared/types';

/** D1 refuses more than 100 bound parameters per statement. */
const IN_CHUNK = 80;

function chunk<T>(items: T[], size = IN_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function ph(n: number): string {
  return Array.from({ length: n }, () => '?').join(', ');
}

/** The queue item id a queue-produced document was approved from, if any. */
export function queueIdFromExternalRef(externalRef: string | null | undefined): string | null {
  if (!externalRef) return null;
  const m = /^queue-([A-Za-z0-9]+)(?:-|$)/.exec(externalRef);
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

export type IntakeMatch =
  | {
      kind: 'already_approved';
      documentId: string | null;
      documentTitle: string | null;
      queueId: string | null;
    }
  | { kind: 'already_waiting'; queueId: string }
  | { kind: 'rejected'; rejected: IntakeRejectedMatch };

/**
 * What this tenant already holds with these exact bytes. NULL when nothing,
 * or when the door had no checksum to compare (a check that cannot run must
 * not suppress).
 */
export async function findIntakeMatch(
  db: D1Database,
  tenantId: string,
  checksum: string | null | undefined,
): Promise<IntakeMatch | null> {
  if (!checksum) return null;

  // 1a. A live document whose version is these bytes. Oldest first: the
  //     original is the one a person approved first.
  const byVersion = await db
    .prepare(
      `SELECT d.id, d.title, d.external_ref
         FROM document_versions dv
         JOIN documents d ON d.id = dv.document_id
        WHERE d.tenant_id = ? AND dv.checksum = ? AND d.status <> 'deleted'
        ORDER BY d.created_at ASC, d.id ASC
        LIMIT 1`,
    )
    .bind(tenantId, checksum)
    .first<{ id: string; title: string; external_ref: string | null }>();
  if (byVersion) {
    return {
      kind: 'already_approved',
      documentId: byVersion.id,
      documentTitle: byVersion.title,
      queueId: queueIdFromExternalRef(byVersion.external_ref),
    };
  }

  // 1b. An approved queue item that is these bytes (page-scoped records COA,
  //     or an order/shipment approval with no document).
  const approvedItem = await db
    .prepare(
      `SELECT pq.id,
              (SELECT d.id FROM documents d
                WHERE d.tenant_id = pq.tenant_id AND d.status <> 'deleted'
                  AND (d.external_ref = 'queue-' || pq.id OR d.external_ref LIKE 'queue-' || pq.id || '-%')
                ORDER BY d.created_at ASC, d.id ASC LIMIT 1) AS document_id,
              (SELECT d.title FROM documents d
                WHERE d.tenant_id = pq.tenant_id AND d.status <> 'deleted'
                  AND (d.external_ref = 'queue-' || pq.id OR d.external_ref LIKE 'queue-' || pq.id || '-%')
                ORDER BY d.created_at ASC, d.id ASC LIMIT 1) AS document_title,
              pq.output_kind
         FROM processing_queue pq
        WHERE pq.tenant_id = ? AND pq.checksum = ? AND pq.status = 'approved'
        ORDER BY COALESCE(pq.reviewed_at, pq.created_at) ASC, pq.id ASC`,
    )
    .bind(tenantId, checksum)
    .all<{ id: string; document_id: string | null; document_title: string | null; output_kind: string | null }>();
  const approvedRows = approvedItem.results ?? [];
  // Prefer an approval that still has a live document; a COA approval whose
  // documents were all deleted since is no longer "already here".
  const withDoc = approvedRows.find((r) => r.document_id);
  if (withDoc) {
    return {
      kind: 'already_approved',
      documentId: withDoc.document_id,
      documentTitle: withDoc.document_title,
      queueId: withDoc.id,
    };
  }
  const recordsApproval = approvedRows.find(
    (r) => r.output_kind === 'order' || r.output_kind === 'shipment',
  );
  if (recordsApproval) {
    return { kind: 'already_approved', documentId: null, documentTitle: null, queueId: recordsApproval.id };
  }

  // 2. Still waiting for a reviewer (any processing state, errors included —
  //    an errored item is still a card someone has to deal with).
  const waiting = await db
    .prepare(
      `SELECT id FROM processing_queue
        WHERE tenant_id = ? AND checksum = ? AND status = 'pending'
        ORDER BY created_at ASC, id ASC
        LIMIT 1`,
    )
    .bind(tenantId, checksum)
    .first<{ id: string }>();
  if (waiting) return { kind: 'already_waiting', queueId: waiting.id };

  // 3. Rejected before. Most recent rejection, because that is the reason a
  //    person gave last.
  const rejected = await db
    .prepare(
      `SELECT id, file_name, reviewed_at, rejection_reason, rejection_note
         FROM processing_queue
        WHERE tenant_id = ? AND checksum = ? AND status = 'rejected'
        ORDER BY COALESCE(reviewed_at, created_at) DESC, id DESC
        LIMIT 1`,
    )
    .bind(tenantId, checksum)
    .first<{
      id: string;
      file_name: string;
      reviewed_at: string | null;
      rejection_reason: string | null;
      rejection_note: string | null;
    }>();
  if (rejected) {
    return {
      kind: 'rejected',
      rejected: {
        queue_id: rejected.id,
        file_name: rejected.file_name,
        rejected_at: rejected.reviewed_at,
        rejection_reason: (rejected.rejection_reason as RejectionReason | null) ?? null,
        rejection_note: rejected.rejection_note,
      },
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Admission — the one decision every door makes
// ---------------------------------------------------------------------------

/**
 * The replayable part of an enqueue call. Mirrors `EnqueueDocumentParams`
 * minus the per-call controls; kept structural so this module does not import
 * enqueue.ts (which imports this one).
 */
export interface IntakeReplayParams {
  tenantId: string;
  documentTypeId: string | null;
  fileR2Key: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  checksum: string;
  createdBy: string | null;
  source: string;
  sourceDetail: string | null;
  outputKind: string | null;
  sourceId: string | null;
  supplierId?: string | null;
  connectorRunId?: string | null;
}

export interface AdmitIntakeArgs extends IntakeReplayParams {
  /** Supplier-portal arrival this file is (ledger pointer only). */
  requestUploadId?: string | null;
  clientIp?: string | null;
}

export type IntakeAdmission =
  | { outcome: 'admit'; previouslyRejected: IntakeRejectedMatch | null }
  | { outcome: 'duplicate'; notice: IntakeDuplicateNotice; matchedDocumentTitle: string | null };

/**
 * Compare, and when the arrival is a suppression, record it: the ledger row,
 * the audit row, and — for a connector door — close the run header the door
 * opened for it, which would otherwise read `running` forever with nothing in
 * it.
 *
 * Returns `admit` when the caller should queue the file (with the previous
 * rejection to warn about, if any). The caller writes the case-3 audit row via
 * `auditRejectedResend` once it has a queue id.
 */
export async function admitIntake(db: D1Database, args: AdmitIntakeArgs): Promise<IntakeAdmission> {
  const match = await findIntakeMatch(db, args.tenantId, args.checksum);
  if (!match) return { outcome: 'admit', previouslyRejected: null };
  if (match.kind === 'rejected') return { outcome: 'admit', previouslyRejected: match.rejected };

  const id = generateId();
  const matchKind: IntakeDuplicateMatchKind = match.kind;
  const matchedDocumentId = match.kind === 'already_approved' ? match.documentId : null;
  const matchedQueueId = match.queueId;
  const replay: IntakeReplayParams = {
    tenantId: args.tenantId,
    documentTypeId: args.documentTypeId ?? null,
    fileR2Key: args.fileR2Key,
    fileName: args.fileName,
    fileSize: args.fileSize,
    mimeType: args.mimeType,
    checksum: args.checksum,
    createdBy: args.createdBy ?? null,
    source: args.source,
    sourceDetail: args.sourceDetail ?? null,
    outputKind: args.outputKind ?? null,
    sourceId: args.sourceId ?? null,
    supplierId: args.supplierId ?? null,
    connectorRunId: args.connectorRunId ?? null,
  };

  await db
    .prepare(
      `INSERT INTO intake_duplicates
         (id, tenant_id, checksum, match_kind, matched_document_id, matched_queue_id,
          source, source_detail, source_id, connector_run_id, request_upload_id,
          file_name, file_size, mime_type, file_r2_key, enqueue_params, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      args.tenantId,
      args.checksum,
      matchKind,
      matchedDocumentId,
      matchedQueueId,
      args.source,
      args.sourceDetail ?? null,
      args.sourceId ?? null,
      args.connectorRunId ?? null,
      args.requestUploadId ?? null,
      args.fileName,
      args.fileSize,
      args.mimeType,
      args.fileR2Key,
      JSON.stringify(replay),
      args.createdBy ?? null,
    )
    .run();

  if (args.connectorRunId) {
    // The door opened a batch header for this file. Nothing will ever be
    // approved into it, so the rollup would never finish it. It did finish:
    // the file was already here. Guarded on the run holding no queue item, so
    // a multi-attachment email whose FIRST attachment was a duplicate does not
    // close the run its other attachments are queued under; `reopenRunClosedByDuplicate`
    // undoes it if a later attachment in the same run is queued.
    try {
      await db
        .prepare(
          `UPDATE connector_runs
              SET status = 'success', completed_at = datetime('now'),
                  details = ?
            WHERE id = ? AND tenant_id = ? AND status = 'running'
              AND NOT EXISTS (SELECT 1 FROM processing_queue WHERE connector_run_id = ?)`,
        )
        .bind(
          JSON.stringify({ intake_duplicate_id: id, match_kind: matchKind, queued: 0 }),
          args.connectorRunId,
          args.tenantId,
          args.connectorRunId,
        )
        .run();
    } catch (err) {
      console.warn('intake duplicate: could not close run header:', err);
    }
  }

  try {
    await logAudit(
      db,
      args.createdBy ?? null,
      args.tenantId,
      'intake.duplicate_suppressed',
      'intake_duplicate',
      id,
      JSON.stringify({
        match_kind: matchKind,
        matched_document_id: matchedDocumentId,
        matched_queue_id: matchedQueueId,
        source: args.source,
        source_detail: args.sourceDetail ?? null,
        file_name: args.fileName,
        checksum: args.checksum,
        ...(args.requestUploadId ? { request_upload_id: args.requestUploadId } : {}),
        ...(args.connectorRunId ? { connector_run_id: args.connectorRunId } : {}),
      }),
      args.clientIp ?? null,
    );
  } catch (err) {
    // The ledger row IS the visible record; the audit row is the second copy.
    console.warn('intake duplicate: audit write failed:', err);
  }

  return {
    outcome: 'duplicate',
    notice: {
      intake_duplicate_id: id,
      match_kind: matchKind,
      matched_document_id: matchedDocumentId,
      matched_queue_id: matchedQueueId,
    },
    matchedDocumentTitle: match.kind === 'already_approved' ? match.documentTitle : null,
  };
}

/**
 * A run header closed because its first file was a duplicate gets a queued
 * file after all (a later attachment of the same email, or "Review anyway"):
 * it is running again, and the approve-time rollup finishes it as usual.
 */
export async function reopenRunClosedByDuplicate(db: D1Database, runId: string): Promise<void> {
  try {
    await db
      .prepare(
        `UPDATE connector_runs SET status = 'running', completed_at = NULL
          WHERE id = ? AND status = 'success' AND details LIKE '{"intake_duplicate_id"%'`,
      )
      .bind(runId)
      .run();
  } catch (err) {
    console.warn('intake duplicate: could not reopen run header:', err);
  }
}

/** Case 3's trail: a file a person rejected came back and was queued anyway. */
export async function auditRejectedResend(
  db: D1Database,
  args: {
    tenantId: string;
    queueId: string;
    actorId: string | null;
    source: string;
    fileName: string;
    rejected: IntakeRejectedMatch;
    clientIp?: string | null;
  },
): Promise<void> {
  try {
    await logAudit(
      db,
      args.actorId,
      args.tenantId,
      'intake.previously_rejected_file',
      'processing_queue',
      args.queueId,
      JSON.stringify({
        source: args.source,
        file_name: args.fileName,
        rejected_queue_id: args.rejected.queue_id,
        rejected_at: args.rejected.rejected_at,
        rejection_reason: args.rejected.rejection_reason,
      }),
      args.clientIp ?? null,
    );
  } catch (err) {
    console.warn('intake duplicate: rejected-resend audit failed:', err);
  }
}

// ---------------------------------------------------------------------------
// Read side — what the Review Queue card shows
// ---------------------------------------------------------------------------

interface HistoryInputItem {
  id: string;
  tenant_id: string;
  checksum: string | null;
  status: string;
}

function emptyHistory(): QueueIntakeHistory {
  return { also_received: [], previously_rejected: null, identical_documents: [], sent_anyway: null };
}

/**
 * Batch-load `intake_history` for a page of queue items. A fixed handful of
 * queries per page regardless of page size; best-effort (a failure returns
 * empty histories rather than failing the queue read, and an environment
 * without 0107 behaves as if nothing was ever suppressed).
 */
export async function loadQueueIntakeHistory(
  db: D1Database,
  items: HistoryInputItem[],
): Promise<Map<string, QueueIntakeHistory>> {
  const out = new Map<string, QueueIntakeHistory>();
  for (const it of items) out.set(it.id, emptyHistory());
  if (items.length === 0) return out;

  try {
    const ids = items.map((i) => i.id);

    // Arrivals recorded against a waiting item, and the "Review anyway" stamp.
    for (const part of chunk(ids)) {
      const rows = await db
        .prepare(
          `SELECT id, matched_queue_id, queue_id, source, source_detail, file_name, received_at,
                  match_kind, matched_document_id,
                  (SELECT title FROM documents WHERE id = intake_duplicates.matched_document_id) AS matched_document_title,
                  (SELECT name FROM users WHERE id = intake_duplicates.overridden_by) AS overridden_by_name,
                  overridden_at
             FROM intake_duplicates
            WHERE matched_queue_id IN (${ph(part.length)}) OR queue_id IN (${ph(part.length)})
            ORDER BY received_at ASC`,
        )
        .bind(...part, ...part)
        .all<{
          id: string;
          matched_queue_id: string | null;
          queue_id: string | null;
          source: string;
          source_detail: string | null;
          file_name: string;
          received_at: string;
          match_kind: IntakeDuplicateMatchKind;
          matched_document_id: string | null;
          matched_document_title: string | null;
          overridden_by_name: string | null;
          overridden_at: string | null;
        }>();
      for (const r of rows.results ?? []) {
        if (r.matched_queue_id && out.has(r.matched_queue_id)) {
          out.get(r.matched_queue_id)!.also_received.push({
            id: r.id,
            source: r.source,
            source_detail: r.source_detail,
            file_name: r.file_name,
            received_at: r.received_at,
            queue_id: r.queue_id,
          });
        }
        if (r.queue_id && out.has(r.queue_id)) {
          out.get(r.queue_id)!.sent_anyway = {
            id: r.id,
            match_kind: r.match_kind,
            matched_document_id: r.matched_document_id,
            matched_document_title: r.matched_document_title,
            overridden_by_name: r.overridden_by_name,
            overridden_at: r.overridden_at,
          };
        }
      }
    }

    // Same-checksum facts, grouped per tenant. Only pending items get the
    // warnings: on an approved or rejected card they would be describing the
    // item's own history back to it.
    const byTenant = new Map<string, HistoryInputItem[]>();
    for (const it of items) {
      if (!it.checksum || it.status !== 'pending') continue;
      const list = byTenant.get(it.tenant_id) ?? [];
      list.push(it);
      byTenant.set(it.tenant_id, list);
    }

    for (const [tenantId, list] of byTenant) {
      const checksums = [...new Set(list.map((i) => i.checksum as string))];
      for (const part of chunk(checksums, 90)) {
        const rejected = await db
          .prepare(
            `SELECT id, checksum, file_name, reviewed_at, created_at, rejection_reason, rejection_note
               FROM processing_queue
              WHERE tenant_id = ? AND status = 'rejected' AND checksum IN (${ph(part.length)})
              ORDER BY COALESCE(reviewed_at, created_at) DESC, id DESC`,
          )
          .bind(tenantId, ...part)
          .all<{
            id: string;
            checksum: string;
            file_name: string;
            reviewed_at: string | null;
            rejection_reason: string | null;
            rejection_note: string | null;
          }>();
        for (const it of list) {
          if (!part.includes(it.checksum as string)) continue;
          const hit = (rejected.results ?? []).find((r) => r.checksum === it.checksum && r.id !== it.id);
          if (hit) {
            out.get(it.id)!.previously_rejected = {
              queue_id: hit.id,
              file_name: hit.file_name,
              rejected_at: hit.reviewed_at,
              rejection_reason: (hit.rejection_reason as RejectionReason | null) ?? null,
              rejection_note: hit.rejection_note,
            };
          }
        }

        const docs = await db
          .prepare(
            `SELECT DISTINCT d.id, d.title, dv.checksum, d.created_at
               FROM document_versions dv
               JOIN documents d ON d.id = dv.document_id
              WHERE d.tenant_id = ? AND d.status <> 'deleted' AND dv.checksum IN (${ph(part.length)})
              ORDER BY d.created_at ASC`,
          )
          .bind(tenantId, ...part)
          .all<{ id: string; title: string; checksum: string }>();
        for (const it of list) {
          const hist = out.get(it.id)!;
          for (const d of docs.results ?? []) {
            if (d.checksum === it.checksum && !hist.identical_documents.some((x) => x.id === d.id)) {
              hist.identical_documents.push({ id: d.id, title: d.title });
            }
          }
        }
      }
    }
  } catch (err) {
    console.warn('intake history: load failed:', err instanceof Error ? err.message : String(err));
  }
  return out;
}
