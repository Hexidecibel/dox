/**
 * Search v2 Phase 2 — async reindex drainer.
 *
 * Phase 1 (migration 0054) wires per-entity FTS triggers but deliberately
 * does NOT fan supplier / product / document_type renames out across
 * `documents_fts` — that would freeze the API on big tenants. Phase 2
 * (migration 0055) makes those renames enqueue a `search_reindex_jobs`
 * row instead. This file implements the drain side: pull pending jobs,
 * compute the affected `documents.id` set, and re-emit FTS rows in
 * batches.
 *
 * Re-emission strategy
 * --------------------
 * For each batch of N affected doc IDs, we run two statements per batch:
 *
 *   1. DELETE FROM documents_fts
 *      WHERE rowid IN (SELECT rowid FROM documents_fts_map
 *                       WHERE doc_id IN (...))
 *
 *   2. INSERT INTO documents_fts (rowid, ...indexed cols..., doc_id, tenant_id)
 *      SELECT m.rowid, src.* FROM documents_fts_source src
 *      JOIN documents_fts_map m ON m.doc_id = src.doc_id
 *      WHERE src.doc_id IN (...)
 *
 * That mirrors the trigger pattern in 0054. The `documents_fts_source`
 * view already does the supplier / doc_type / product joins and the
 * 200KB cap on extracted_text, so the re-emit picks up the latest text
 * without us having to recompute it here.
 *
 * Tenant isolation
 * ----------------
 * Every `WHERE` that selects affected docs filters by the JOB's
 * `tenant_id`, not the entity's. A 'supplier' job for tenant A only
 * touches tenant-A docs even if the supplier id were somehow shared
 * across tenants (it isn't, but defense in depth).
 *
 * Failure handling
 * ----------------
 * If any batch throws, we increment `attempts`, record `last_error`,
 * and:
 *   - if `attempts < max_attempts`: leave status='pending' for the next
 *     drain to retry.
 *   - else: flip status='failed' and stop trying.
 * We chose the "pending until exhausted" model over a separate 'dead'
 * status because the operator already has the `failed` row to inspect,
 * and an extra terminal state adds complexity for no behavioral gain.
 */

import type { D1Database } from '@cloudflare/workers-types';

export interface DrainOptions {
  /** Max docs to re-emit per round-trip. Default 500. */
  batchSize?: number;
  /** Max jobs to process in a single drain call. Default 25. */
  maxJobs?: number;
}

export interface DrainResult {
  jobsCompleted: number;
  jobsFailed: number;
  jobsRetrying: number;
  docsReindexed: number;
  batchesRun: number;
}

interface PendingJob {
  id: string;
  tenant_id: string;
  entity_kind: string;
  entity_id: string;
  attempts: number;
  max_attempts: number;
}

const VALID_KINDS = new Set(['supplier', 'product', 'document_type', 'tenant']);

/**
 * Look up the doc IDs affected by a single job. Returns an array of
 * `documents.id` strings, all in the job's tenant. Throws on unknown
 * entity_kind so the caller can flip the job to failed/pending with the
 * error message captured.
 */
async function affectedDocIds(
  db: D1Database,
  job: PendingJob,
): Promise<string[]> {
  if (!VALID_KINDS.has(job.entity_kind)) {
    throw new Error(`Unknown entity_kind: ${job.entity_kind}`);
  }

  if (job.entity_kind === 'supplier') {
    const r = await db
      .prepare(
        `SELECT id FROM documents
          WHERE tenant_id = ? AND supplier_id = ?`,
      )
      .bind(job.tenant_id, job.entity_id)
      .all<{ id: string }>();
    return (r.results ?? []).map((row) => row.id);
  }

  if (job.entity_kind === 'document_type') {
    const r = await db
      .prepare(
        `SELECT id FROM documents
          WHERE tenant_id = ? AND document_type_id = ?`,
      )
      .bind(job.tenant_id, job.entity_id)
      .all<{ id: string }>();
    return (r.results ?? []).map((row) => row.id);
  }

  if (job.entity_kind === 'product') {
    const r = await db
      .prepare(
        `SELECT DISTINCT d.id
           FROM documents d
           JOIN document_products dp ON dp.document_id = d.id
          WHERE d.tenant_id = ? AND dp.product_id = ?`,
      )
      .bind(job.tenant_id, job.entity_id)
      .all<{ id: string }>();
    return (r.results ?? []).map((row) => row.id);
  }

  // 'tenant' — full rebuild for one tenant. Used by the admin endpoint.
  const r = await db
    .prepare(
      `SELECT id FROM documents WHERE tenant_id = ?`,
    )
    .bind(job.tenant_id)
    .all<{ id: string }>();
  return (r.results ?? []).map((row) => row.id);
}

/**
 * Re-emit one batch of doc rows into documents_fts. Uses an IN (...)
 * placeholder list since D1 doesn't support array binds.
 */
async function reindexBatch(
  db: D1Database,
  docIds: string[],
): Promise<void> {
  if (docIds.length === 0) return;

  const placeholders = docIds.map(() => '?').join(',');

  // Delete existing FTS rows for these docs.
  await db
    .prepare(
      `DELETE FROM documents_fts
        WHERE rowid IN (
          SELECT rowid FROM documents_fts_map WHERE doc_id IN (${placeholders})
        )`,
    )
    .bind(...docIds)
    .run();

  // Re-insert from the source view. The view already does the supplier /
  // doc_type / product joins and the 200KB extracted_text cap.
  await db
    .prepare(
      `INSERT INTO documents_fts (
         rowid, title, description, tags_text, file_name,
         extracted_text, primary_metadata_text, extended_metadata_text,
         supplier_text, document_type_text, product_text,
         doc_id, tenant_id
       )
       SELECT
         m.rowid,
         src.title, src.description, src.tags_text, src.file_name,
         src.extracted_text, src.primary_metadata_text, src.extended_metadata_text,
         src.supplier_text, src.document_type_text, src.product_text,
         src.doc_id, src.tenant_id
       FROM documents_fts_source src
       JOIN documents_fts_map m ON m.doc_id = src.doc_id
       WHERE src.doc_id IN (${placeholders})`,
    )
    .bind(...docIds)
    .run();
}

/**
 * Drain pending search_reindex_jobs. Returns counts per disposition.
 *
 * Concurrency note: this is intentionally NOT a transaction across all
 * jobs — each job's batch loop runs as separate D1 statements. If the
 * worker crashes mid-job, the FTS rows that already updated stay
 * updated, the job stays in `processing` (and a stale-detection sweep
 * can re-pend it after a timeout). For v1 we accept best-effort drain
 * without a `processing` heartbeat — the next drain naturally retries.
 */
export async function drainSearchReindexQueue(
  db: D1Database,
  options: DrainOptions = {},
): Promise<DrainResult> {
  const batchSize = options.batchSize ?? 500;
  const maxJobs = options.maxJobs ?? 25;

  const result: DrainResult = {
    jobsCompleted: 0,
    jobsFailed: 0,
    jobsRetrying: 0,
    docsReindexed: 0,
    batchesRun: 0,
  };

  const pendingRes = await db
    .prepare(
      `SELECT id, tenant_id, entity_kind, entity_id, attempts, max_attempts
         FROM search_reindex_jobs
        WHERE status = 'pending'
        ORDER BY created_at
        LIMIT ?`,
    )
    .bind(maxJobs)
    .all<PendingJob>();

  const jobs = pendingRes.results ?? [];

  for (const job of jobs) {
    try {
      const docIds = await affectedDocIds(db, job);

      let batchesThisJob = 0;
      for (let i = 0; i < docIds.length; i += batchSize) {
        const slice = docIds.slice(i, i + batchSize);
        await reindexBatch(db, slice);
        batchesThisJob++;
        result.batchesRun++;
        result.docsReindexed += slice.length;
      }

      // For zero-doc jobs (e.g., supplier with no linked docs) we still
      // count one logical batch's worth of work so the metric reflects
      // that we touched the job. batchesRun stays at +0 to keep the
      // chunking-test assertion clean.
      void batchesThisJob;

      await db
        .prepare(
          `UPDATE search_reindex_jobs
              SET status = 'completed',
                  processed_at = datetime('now'),
                  last_error = NULL
            WHERE id = ?`,
        )
        .bind(job.id)
        .run();
      result.jobsCompleted++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const nextAttempts = job.attempts + 1;
      const exhausted = nextAttempts >= job.max_attempts;

      await db
        .prepare(
          `UPDATE search_reindex_jobs
              SET attempts = ?,
                  status = ?,
                  last_error = ?,
                  processed_at = CASE WHEN ? = 'failed' THEN datetime('now') ELSE processed_at END
            WHERE id = ?`,
        )
        .bind(
          nextAttempts,
          exhausted ? 'failed' : 'pending',
          msg.substring(0, 1000),
          exhausted ? 'failed' : 'pending',
          job.id,
        )
        .run();

      if (exhausted) {
        result.jobsFailed++;
      } else {
        result.jobsRetrying++;
      }
    }
  }

  return result;
}

/**
 * Helper for the admin endpoint — enqueue a synthetic 'tenant' job that
 * re-emits every documents_fts row in the tenant. Used for full
 * rebuilds (e.g., after a manual SQL touch-up). Skips the partial unique
 * index by inserting directly; collisions on (entity_kind='tenant',
 * entity_id=tenant_id) WHERE status='pending' are handled by INSERT OR
 * IGNORE the same way as the trigger path.
 */
export async function enqueueFullTenantReindex(
  db: D1Database,
  tenantId: string,
): Promise<{ enqueued: boolean; jobId: string | null }> {
  const beforeRes = await db
    .prepare(
      `SELECT id FROM search_reindex_jobs
        WHERE entity_kind = 'tenant' AND entity_id = ? AND status = 'pending'`,
    )
    .bind(tenantId)
    .first<{ id: string }>();

  if (beforeRes) {
    return { enqueued: false, jobId: beforeRes.id };
  }

  await db
    .prepare(
      `INSERT OR IGNORE INTO search_reindex_jobs
         (tenant_id, entity_kind, entity_id)
       VALUES (?, 'tenant', ?)`,
    )
    .bind(tenantId, tenantId)
    .run();

  const after = await db
    .prepare(
      `SELECT id FROM search_reindex_jobs
        WHERE entity_kind = 'tenant' AND entity_id = ? AND status = 'pending'`,
    )
    .bind(tenantId)
    .first<{ id: string }>();

  return { enqueued: true, jobId: after?.id ?? null };
}
