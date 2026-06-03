import { generateId } from '../db';
import type { ConnectorRunSource } from '../connectors/types';

/**
 * Create a `connector_runs` ROLLUP HEADER row for an intake batch.
 *
 * In the Connectors → Sources model, intake doors no longer run the
 * synchronous orchestrator. They enqueue each file into `processing_queue`
 * and let the worker → Review Queue path produce records on human approve.
 * But every queued file still wants a batch header so the activity feed +
 * retry path have a `connector_run_id` to anchor on. Counts start at zero
 * and are filled in later by `accumulateRunRollup` (functions/api/queue/[id].ts)
 * as items are approved.
 *
 * The status starts as `'running'` — the same initial state the orchestrator
 * used — and gets recomputed to success/partial/error by the rollup. A run
 * that never has any item approved simply stays `'running'`, which is
 * accurate: the batch is still in the review queue.
 *
 * Mirrors the orchestrator's defensive insert: an env that hasn't applied the
 * `source` column (migration 0049) downgrades to a sourceless insert rather
 * than throwing.
 */
export async function createConnectorRunHeader(
  db: D1Database,
  params: {
    connectorId: string;
    tenantId: string;
    source: ConnectorRunSource;
  },
): Promise<string> {
  const runId = generateId();
  try {
    await db
      .prepare(
        `INSERT INTO connector_runs (id, connector_id, tenant_id, status, source)
         VALUES (?, ?, ?, 'running', ?)`,
      )
      .bind(runId, params.connectorId, params.tenantId, params.source)
      .run();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('no such column')) {
      await db
        .prepare(
          `INSERT INTO connector_runs (id, connector_id, tenant_id, status)
           VALUES (?, ?, ?, 'running')`,
        )
        .bind(runId, params.connectorId, params.tenantId)
        .run();
    } else {
      throw err;
    }
  }
  return runId;
}
