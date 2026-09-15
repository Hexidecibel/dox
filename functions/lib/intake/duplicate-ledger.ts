/**
 * The staff side of exact-duplicate intake (migration 0107): reading the
 * ledger, and "Review anyway".
 *
 * The rule itself lives in ./duplicates.ts. This module never suppresses
 * anything; it only shows what was suppressed and undoes a suppression when a
 * person asks.
 */

import { logAudit } from '../db';
import { ConflictError, NotFoundError } from '../permissions';
import { enqueueDocument } from './enqueue';
import { queueIdFromExternalRef, reopenRunClosedByDuplicate, type IntakeReplayParams } from './duplicates';
import type { IntakeDuplicate } from '../../../shared/types';

const SELECT_COLUMNS = `
  idup.id, idup.tenant_id, idup.checksum, idup.match_kind,
  idup.matched_document_id, md.title AS matched_document_title,
  idup.matched_queue_id, mq.file_name AS matched_queue_file_name, mq.status AS matched_queue_status,
  idup.source, idup.source_detail, idup.source_id, idup.connector_run_id, idup.request_upload_id,
  idup.file_name, idup.file_size, idup.mime_type, idup.received_at,
  idup.created_by, cu.name AS created_by_name,
  idup.queue_id, idup.overridden_by, ou.name AS overridden_by_name, idup.overridden_at`;

const JOINS = `
  FROM intake_duplicates idup
  LEFT JOIN documents md ON md.id = idup.matched_document_id
  LEFT JOIN processing_queue mq ON mq.id = idup.matched_queue_id
  LEFT JOIN users cu ON cu.id = idup.created_by
  LEFT JOIN users ou ON ou.id = idup.overridden_by`;

export interface ListIntakeDuplicatesOptions {
  /** NULL = every tenant (super_admin only; the endpoint enforces that). */
  tenantId: string | null;
  /** Everything received again that is this document (or the item it was approved from). */
  documentId?: string | null;
  /** Arrivals recorded against this waiting queue item. */
  matchedQueueId?: string | null;
  /** 'open' = still suppressed, 'reviewed' = sent for review anyway. Default all. */
  state?: 'open' | 'reviewed' | 'all';
  limit: number;
  offset: number;
}

export async function listIntakeDuplicates(
  db: D1Database,
  opts: ListIntakeDuplicatesOptions,
): Promise<{ duplicates: IntakeDuplicate[]; total: number; open_count: number }> {
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (opts.tenantId) {
    conditions.push('idup.tenant_id = ?');
    params.push(opts.tenantId);
  }

  if (opts.documentId) {
    // A document is "received again" both when the arrival matched it
    // directly and when it matched the queue item it was approved from (a
    // file that arrived again while the original was still waiting, before
    // that original was approved into this document).
    const doc = await db
      .prepare('SELECT id, external_ref FROM documents WHERE id = ?' + (opts.tenantId ? ' AND tenant_id = ?' : ''))
      .bind(...(opts.tenantId ? [opts.documentId, opts.tenantId] : [opts.documentId]))
      .first<{ id: string; external_ref: string | null }>();
    if (!doc) throw new NotFoundError('Document not found');
    const originQueueId = queueIdFromExternalRef(doc.external_ref);
    if (originQueueId) {
      conditions.push('(idup.matched_document_id = ? OR idup.matched_queue_id = ?)');
      params.push(doc.id, originQueueId);
    } else {
      conditions.push('idup.matched_document_id = ?');
      params.push(doc.id);
    }
  }

  if (opts.matchedQueueId) {
    conditions.push('idup.matched_queue_id = ?');
    params.push(opts.matchedQueueId);
  }

  const baseWhere = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const stateCondition =
    opts.state === 'open' ? 'idup.queue_id IS NULL' : opts.state === 'reviewed' ? 'idup.queue_id IS NOT NULL' : null;
  const where = stateCondition
    ? baseWhere ? `${baseWhere} AND ${stateCondition}` : `WHERE ${stateCondition}`
    : baseWhere;

  const total = await db
    .prepare(`SELECT COUNT(*) AS n FROM intake_duplicates idup ${where}`)
    .bind(...params)
    .first<{ n: number }>();
  const open = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM intake_duplicates idup ${baseWhere ? `${baseWhere} AND` : 'WHERE'} idup.queue_id IS NULL`,
    )
    .bind(...params)
    .first<{ n: number }>();
  const rows = await db
    .prepare(`SELECT ${SELECT_COLUMNS} ${JOINS} ${where} ORDER BY idup.received_at DESC, idup.id DESC LIMIT ? OFFSET ?`)
    .bind(...params, opts.limit, opts.offset)
    .all<IntakeDuplicate>();

  return {
    duplicates: rows.results ?? [],
    total: Number(total?.n ?? 0),
    open_count: Number(open?.n ?? 0),
  };
}

export async function loadIntakeDuplicate(
  db: D1Database,
  id: string,
  tenantId: string | null,
): Promise<IntakeDuplicate | null> {
  return db
    .prepare(`SELECT ${SELECT_COLUMNS} ${JOINS} WHERE idup.id = ?${tenantId ? ' AND idup.tenant_id = ?' : ''}`)
    .bind(...(tenantId ? [id, tenantId] : [id]))
    .first<IntakeDuplicate>();
}

/**
 * "Review anyway": put a suppressed arrival in front of a reviewer after all.
 *
 * Replays the exact enqueue call the door made, with the duplicate check
 * skipped (a person has seen the match — that is the whole point), then:
 *   - claims the ledger row (`overridden_by`/`overridden_at`, guarded) BEFORE
 *     enqueueing, so a double click cannot queue it twice, then stamps `queue_id`;
 *   - for a supplier-portal arrival, points `request_uploads.queue_id` at the
 *     new item. If the arrival had been linked to the existing document by the
 *     duplicate check and nobody has decided any of its claims yet, that link
 *     is removed so the arrival follows the new review. If a person HAS
 *     decided a claim on it, the link stays: that decision was made on that
 *     document, and undoing it is not this button's job;
 *   - reopens a connector run header the suppression had closed;
 *   - audits `intake_duplicate.review_anyway`.
 *
 * 409 when already sent; 410 when the stored bytes are gone.
 */
export async function reviewIntakeDuplicateAnyway(
  db: D1Database,
  files: R2Bucket,
  args: { id: string; tenantId: string | null; userId: string; ip: string | null },
): Promise<{ duplicate: IntakeDuplicate; queueId: string }> {
  const row = await db
    .prepare(
      `SELECT id, tenant_id, match_kind, matched_document_id, matched_queue_id, request_upload_id,
              connector_run_id, file_r2_key, enqueue_params, queue_id
         FROM intake_duplicates WHERE id = ?${args.tenantId ? ' AND tenant_id = ?' : ''}`,
    )
    .bind(...(args.tenantId ? [args.id, args.tenantId] : [args.id]))
    .first<{
      id: string;
      tenant_id: string;
      match_kind: string;
      matched_document_id: string | null;
      matched_queue_id: string | null;
      request_upload_id: string | null;
      connector_run_id: string | null;
      file_r2_key: string;
      enqueue_params: string;
      queue_id: string | null;
    }>();
  if (!row) throw new NotFoundError('Not found');
  if (row.queue_id) {
    throw new ConflictError('This file has already been sent for review.');
  }

  const head = await files.head(row.file_r2_key);
  if (!head) {
    throw new GoneError('The stored copy of this file is no longer available, so it cannot be reviewed.');
  }

  let replay: IntakeReplayParams;
  try {
    replay = JSON.parse(row.enqueue_params) as IntakeReplayParams;
  } catch {
    throw new ConflictError('This record cannot be replayed.');
  }

  // Claim first, so a double click cannot queue the file twice and nothing
  // this call creates ever has to be taken back.
  const claim = await db
    .prepare(
      `UPDATE intake_duplicates
          SET overridden_by = ?, overridden_at = datetime('now')
        WHERE id = ? AND queue_id IS NULL AND overridden_at IS NULL`,
    )
    .bind(args.userId, row.id)
    .run();
  if (!claim.meta?.changes) {
    throw new ConflictError('This file has already been sent for review.');
  }

  let queueId: string;
  try {
    const enqueued = await enqueueDocument(db, {
      ...replay,
      // Never trust a tenant or key out of a stored blob over the row's own columns.
      tenantId: row.tenant_id,
      fileR2Key: row.file_r2_key,
      duplicateCheck: 'skip',
      clientIp: args.ip,
    });
    if (enqueued.outcome !== 'queued') throw new Error('not queued');
    queueId = enqueued.queueId;
  } catch (err) {
    await db
      .prepare('UPDATE intake_duplicates SET overridden_by = NULL, overridden_at = NULL WHERE id = ? AND queue_id IS NULL')
      .bind(row.id)
      .run();
    throw err;
  }

  await db.prepare('UPDATE intake_duplicates SET queue_id = ? WHERE id = ?').bind(queueId, row.id).run();

  let arrivalLinkRemoved = false;
  if (row.request_upload_id) {
    const upload = await db
      .prepare(
        `SELECT ru.id, ru.document_id,
                (SELECT COUNT(*) FROM request_upload_lines rul
                  WHERE rul.upload_id = ru.id AND rul.decision IS NOT NULL) AS decided
           FROM request_uploads ru WHERE ru.id = ? AND ru.tenant_id = ?`,
      )
      .bind(row.request_upload_id, row.tenant_id)
      .first<{ id: string; document_id: string | null; decided: number }>();
    if (upload) {
      const removeLink =
        row.match_kind === 'already_approved' &&
        upload.document_id !== null &&
        upload.document_id === row.matched_document_id &&
        Number(upload.decided) === 0;
      arrivalLinkRemoved = removeLink;
      await db
        .prepare(
          `UPDATE request_uploads SET queue_id = ?${removeLink ? ', document_id = NULL' : ''}
            WHERE id = ? AND tenant_id = ?`,
        )
        .bind(queueId, upload.id, row.tenant_id)
        .run();
    }
  }

  if (row.connector_run_id) await reopenRunClosedByDuplicate(db, row.connector_run_id);

  await logAudit(
    db,
    args.userId,
    row.tenant_id,
    'intake_duplicate.review_anyway',
    'intake_duplicate',
    row.id,
    JSON.stringify({
      queue_id: queueId,
      match_kind: row.match_kind,
      matched_document_id: row.matched_document_id,
      matched_queue_id: row.matched_queue_id,
      ...(row.request_upload_id
        ? { request_upload_id: row.request_upload_id, arrival_document_link_removed: arrivalLinkRemoved }
        : {}),
    }),
    args.ip,
  );

  const duplicate = await loadIntakeDuplicate(db, row.id, row.tenant_id);
  return { duplicate: duplicate!, queueId };
}

/** 410 — the thing exists in the ledger but its bytes do not. */
export class GoneError extends Error {
  readonly status = 410;
}
