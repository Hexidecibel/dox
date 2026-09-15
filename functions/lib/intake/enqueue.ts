import { generateId } from '../db';
import { admitIntake, auditRejectedResend, reopenRunClosedByDuplicate } from './duplicates';
import type { IntakeDuplicateNotice, IntakeRejectedMatch } from '../../../shared/types';

/**
 * Shared intake helper: inserts a single `processing_queue` row.
 *
 * Every intake door (manual upload, email, API, S3, public link) funnels
 * through this so the queue-row shape stays identical regardless of how the
 * file arrived. Pure D1 — accepts the DB binding as a param, no env/global
 * access.
 *
 * Mirrors the column list + defaults that the manual-upload path
 * (functions/api/documents/process.ts) historically set inline, plus the
 * connector-only columns `supplier_id` and `connector_run_id` (NULL when not
 * provided).
 *
 * EXACT DUPLICATES (migration 0108). Before inserting, the checksum is
 * compared with what the tenant already holds (functions/lib/intake/duplicates.ts).
 * An arrival identical to an approved file, or to one still waiting in the
 * queue, does NOT become a row here: it is recorded in `intake_duplicates` and
 * the result says so (`outcome: 'duplicate'`, `queueId: null`). Every caller
 * must handle that — the type forces it. An arrival identical to a REJECTED
 * file is queued normally and carries `previouslyRejected`.
 */
export interface EnqueueDocumentParams {
  tenantId: string;
  /** NULL allowed — the worker resolves a default doc type downstream. */
  documentTypeId: string | null;
  fileR2Key: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  checksum: string;
  /**
   * Uploading user id. NULL for vendor-driven doors (API drop, public link,
   * S3 poll) that aren't attributed to a user — the column is nullable
   * (`created_by TEXT REFERENCES users(id)`), so a real null avoids an FK
   * blowup that a sentinel string would trigger.
   */
  createdBy: string | null;
  source: string;
  sourceDetail: string | null;
  /** 'coa' | 'order' | 'shipment'; NULL => treated as 'coa' downstream. */
  outputKind: string | null;
  /** Connector (source) id; NULL for ad-hoc manual uploads. */
  sourceId: string | null;
  /** Pre-resolved supplier when the door knows it; NULL otherwise. */
  supplierId?: string | null;
  /** Batch grouping for connector runs; NULL for one-off intakes. */
  connectorRunId?: string | null;
  /**
   * Pre-generated queue id. Doors that build the R2 key from the id (e.g. the
   * manual-upload path uses `pending/<slug>/<queueId>/<file>`) need the id
   * before the insert; they pass it here so the row id matches the R2 path.
   * Omit to have the helper generate one.
   */
  id?: string;
  /**
   * 'skip' ONLY when a person has already seen the match and chosen to review
   * the file anyway (POST /api/intake-duplicates/:id/review). Default 'check'.
   */
  duplicateCheck?: 'check' | 'skip';
  /** The supplier-portal arrival this file is, for the duplicate ledger. */
  requestUploadId?: string | null;
  /** For the audit rows the duplicate check writes. */
  clientIp?: string | null;
}

export type EnqueueDocumentResult =
  | {
      outcome: 'queued';
      queueId: string;
      /** The last rejection of this exact file, when there was one. */
      previouslyRejected: IntakeRejectedMatch | null;
    }
  | {
      outcome: 'duplicate';
      queueId: null;
      duplicate: IntakeDuplicateNotice;
    };

export async function enqueueDocument(
  db: D1Database,
  params: EnqueueDocumentParams,
): Promise<EnqueueDocumentResult> {
  let previouslyRejected: IntakeRejectedMatch | null = null;
  if (params.duplicateCheck !== 'skip') {
    const admission = await admitIntake(db, params);
    if (admission.outcome === 'duplicate') {
      return { outcome: 'duplicate', queueId: null, duplicate: admission.notice };
    }
    previouslyRejected = admission.previouslyRejected;
  }

  const queueId = params.id || generateId();

  await db
    .prepare(
      `INSERT INTO processing_queue (id, tenant_id, document_type_id, file_r2_key, file_name, file_size, mime_type, status, processing_status, checksum, created_by, source, source_detail, output_kind, source_id, supplier_id, connector_run_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 'queued', ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      queueId,
      params.tenantId,
      params.documentTypeId || null,
      params.fileR2Key,
      params.fileName,
      params.fileSize,
      params.mimeType,
      params.checksum,
      params.createdBy ?? null,
      params.source,
      params.sourceDetail,
      params.outputKind,
      params.sourceId,
      params.supplierId ?? null,
      params.connectorRunId ?? null,
    )
    .run();

  if (params.connectorRunId) {
    await reopenRunClosedByDuplicate(db, params.connectorRunId);
  }

  if (previouslyRejected) {
    await auditRejectedResend(db, {
      tenantId: params.tenantId,
      queueId,
      actorId: params.createdBy ?? null,
      source: params.source,
      fileName: params.fileName,
      rejected: previouslyRejected,
      clientIp: params.clientIp ?? null,
    });
  }

  return { outcome: 'queued', queueId, previouslyRejected };
}
