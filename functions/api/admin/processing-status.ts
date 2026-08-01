/**
 * GET /api/admin/processing-status
 *
 * System-health view of the document processing pipeline. Built after the
 * 2026-05-09 outage where docs weren't processing and we burned cycles
 * SSH-ing around to figure out which subsystem was down. With this
 * endpoint, super_admins can refresh a single page and see:
 *
 *   - queue depth + oldest queued row + counts by processing_status
 *   - "worker last did work N minutes ago" (proxied via newest `ready` row)
 *   - Qwen GPU host reachability (llama-swap `/v1/models` + `/running`)
 *   - orphaned `processing` claims (>15min — worker died mid-job)
 *   - recent errors + a by-pattern histogram for quick pattern-spotting
 *
 * Auth: super_admin only — this is system-wide and has no tenant scope.
 *
 * Failure isolation: the Qwen probe runs with a 5s AbortController so a
 * hung Qwen host can't take down the whole status page. If Qwen is
 * unreachable, we still return the rest of the data with
 * `qwen.reachable: false` and a captured error string.
 */

import { requireRole, errorToResponse } from '../../lib/permissions';
import { logAudit, getClientIp } from '../../lib/db';
import { MODEL_CHAINS, chainFor, resolveModel, type ModelTag } from '../../lib/models';
import type { Env, User } from '../../lib/types';
import type {
  ProcessingStatusResponse,
  ProcessingStatusErrorRow,
  ProcessingStatusQwen,
  ProcessingStatusModels,
  ProcessingStatusModelTag,
} from '../../../shared/types';

const QWEN_PROBE_TIMEOUT_MS = 5000;
const STALE_PROCESSING_MIN = 15;
const WORKER_HEALTHY_MIN = 10;
const ERROR_PATTERN_PREFIX_LEN = 80;
const RECENT_ERRORS_LIMIT = 10;

interface QueueCountRow {
  processing_status: string;
  c: number;
}

interface OldestQueuedRow {
  id: string;
  created_at: string;
}

interface LastReadyRow {
  reviewed_at: string | null;
  created_at: string;
}

interface ErrorRow {
  id: string;
  error_message: string | null;
  created_at: string;
}

interface StaleRow {
  c: number;
  oldest: string | null;
}

/**
 * Probe the Qwen GPU host. Always resolves — never throws — so a hung
 * host cannot 500 the status endpoint. Caller treats `reachable: false`
 * as a yellow/red signal and shows the captured error string.
 */
async function probeQwen(env: Env): Promise<ProcessingStatusQwen> {
  if (!env.QWEN_URL) {
    return {
      reachable: false,
      responseTimeMs: null,
      advertisedModels: null,
      loadedModels: null,
      error: 'QWEN_URL env var not set',
    };
  }
  const baseUrl = env.QWEN_URL.replace(/\/+$/, '');
  const headers: Record<string, string> = {
    Accept: 'application/json',
  };
  if (env.QWEN_SECRET) headers.Authorization = `Bearer ${env.QWEN_SECRET}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), QWEN_PROBE_TIMEOUT_MS);
  const start = Date.now();
  try {
    const res = await fetch(`${baseUrl}/v1/models`, {
      headers,
      signal: controller.signal,
    });
    const responseTimeMs = Date.now() - start;
    if (!res.ok) {
      return {
        reachable: false,
        responseTimeMs,
        advertisedModels: null,
        loadedModels: null,
        error: `HTTP ${res.status} from /v1/models`,
      };
    }
    const body = (await res.json()) as { data?: Array<{ id: string }> };
    const advertisedModels = (body.data ?? [])
      .map((m) => m.id)
      .filter((id): id is string => typeof id === 'string');

    // /running is a llama-swap-only endpoint. Best-effort — if it 404s
    // (e.g. host is bare llama.cpp without llama-swap), return null and
    // let the UI hide the "loaded" line.
    let loadedModels: string[] | null = null;
    try {
      const runCtl = new AbortController();
      const runTimer = setTimeout(() => runCtl.abort(), QWEN_PROBE_TIMEOUT_MS);
      const runRes = await fetch(`${baseUrl}/running`, {
        headers,
        signal: runCtl.signal,
      });
      clearTimeout(runTimer);
      if (runRes.ok) {
        const runBody = (await runRes.json()) as {
          running?: Array<{ model?: string } | string>;
        };
        const running = runBody.running ?? [];
        loadedModels = running
          .map((entry) =>
            typeof entry === 'string' ? entry : entry?.model ?? null
          )
          .filter((id): id is string => typeof id === 'string');
      }
    } catch {
      // /running not available — leave loadedModels=null
    }

    return {
      reachable: true,
      responseTimeMs,
      advertisedModels,
      loadedModels,
      error: null,
    };
  } catch (err) {
    const responseTimeMs = Date.now() - start;
    const message =
      err instanceof Error
        ? err.name === 'AbortError'
          ? `Timeout after ${QWEN_PROBE_TIMEOUT_MS}ms`
          : err.message
        : String(err);
    return {
      reachable: false,
      responseTimeMs,
      advertisedModels: null,
      loadedModels: null,
      error: message,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve every semantic model tag to what it would actually use right now.
 *
 * Why this is on the status page: `advertisedModels` tells you the router is
 * up, not that we are running on the model we WANTED. Each tag is an ordered
 * preference chain; dropping to a lower entry is a real quality event (the
 * quantization difference between chain entries changes extraction
 * correctness) and until now it was visible only in worker logs.
 *
 * Cost: this reuses the resolver's own ~60s health cache, so all three tags
 * share ONE `/v1/models` lookup at most — this endpoint must not become a
 * health-check storm. `force` is deliberately NOT passed.
 *
 * Never throws: a chain with nothing available is reported as
 * source='unavailable' with the resolver's message, so a dead vision backend
 * cannot 500 the whole status page.
 */
async function resolveModelTags(env: Env): Promise<ProcessingStatusModels> {
  const tags = Object.keys(MODEL_CHAINS) as ModelTag[];
  const out: ProcessingStatusModelTag[] = [];

  for (const tag of tags) {
    const chain = chainFor(tag, env);
    try {
      const res = await resolveModel(tag, env);
      out.push({
        tag,
        model: res.model,
        preferred: res.preferred,
        chain: res.chain,
        degraded: res.degraded,
        source: res.source,
        error: null,
      });
    } catch (err) {
      out.push({
        tag,
        model: null,
        preferred: chain[0],
        chain,
        degraded: true,
        source: 'unavailable',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { tags: out, degraded: out.some((t) => t.degraded) };
}

/**
 * Group recent error rows by the first N chars of error_message. Folds
 * "47 rows of the same Qwen 503" into a single bucket so the operator
 * can spot patterns without scrolling. Null/empty error_message goes
 * into a `(no message)` bucket.
 */
function groupErrorPatterns(rows: ErrorRow[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) {
    const key = r.error_message
      ? r.error_message.slice(0, ERROR_PATTERN_PREFIX_LEN)
      : '(no message)';
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireRole(user, 'super_admin');

    const db = context.env.DB;
    const nowIso = new Date().toISOString();
    const nowMs = Date.now();

    // ---- Queue counts ----
    // Group by processing_status. The four known states (queued,
    // processing, ready, error) are always present in the response
    // even when zero so the UI's chip layout is stable.
    const countsRes = await db
      .prepare(
        `SELECT processing_status, COUNT(*) AS c
         FROM processing_queue
         GROUP BY processing_status`
      )
      .all<QueueCountRow>();

    const counts = { queued: 0, processing: 0, ready: 0, error: 0 };
    let totalRows = 0;
    for (const row of countsRes.results ?? []) {
      const c = Number(row.c) || 0;
      totalRows += c;
      if (row.processing_status === 'queued') counts.queued = c;
      else if (row.processing_status === 'processing') counts.processing = c;
      else if (row.processing_status === 'ready') counts.ready = c;
      else if (row.processing_status === 'error') counts.error = c;
    }

    // ---- Oldest queued row ----
    const oldestQueuedRow = await db
      .prepare(
        `SELECT id, created_at
         FROM processing_queue
         WHERE processing_status = 'queued'
         ORDER BY created_at ASC
         LIMIT 1`
      )
      .first<OldestQueuedRow>();

    const oldestQueued = oldestQueuedRow
      ? {
          id: oldestQueuedRow.id,
          createdAt: oldestQueuedRow.created_at,
          ageMinutes: Math.max(
            0,
            Math.round(
              (nowMs - new Date(oldestQueuedRow.created_at).getTime()) / 60000
            )
          ),
        }
      : null;

    // ---- Worker last activity ----
    // Most-recent row that reached `ready` is our proxy for "worker
    // did work". Prefer reviewed_at when set (the worker stamps it on
    // completion); otherwise fall back to created_at.
    const lastReadyRow = await db
      .prepare(
        `SELECT reviewed_at, created_at
         FROM processing_queue
         WHERE processing_status = 'ready'
         ORDER BY COALESCE(reviewed_at, created_at) DESC
         LIMIT 1`
      )
      .first<LastReadyRow>();

    let lastJobCompletedAt: string | null = null;
    let minutesSinceLastJob: number | null = null;
    let workerHealthy = false;
    if (lastReadyRow) {
      lastJobCompletedAt =
        lastReadyRow.reviewed_at ?? lastReadyRow.created_at;
      const lastMs = new Date(lastJobCompletedAt).getTime();
      if (Number.isFinite(lastMs)) {
        minutesSinceLastJob = Math.max(
          0,
          Math.round((nowMs - lastMs) / 60000)
        );
        workerHealthy = minutesSinceLastJob < WORKER_HEALTHY_MIN;
      }
    }

    // ---- Stale 'processing' claims (orphaned) ----
    // Anything stuck in `processing` for >15min is almost certainly an
    // orphaned claim — the worker died mid-job and there's no reaper.
    const staleCutoffIso = new Date(
      nowMs - STALE_PROCESSING_MIN * 60000
    ).toISOString();
    const staleRow = await db
      .prepare(
        `SELECT COUNT(*) AS c, MIN(created_at) AS oldest
         FROM processing_queue
         WHERE processing_status = 'processing'
           AND created_at <= ?`
      )
      .bind(staleCutoffIso)
      .first<StaleRow>();

    const orphanedClaims = Number(staleRow?.c) || 0;
    const oldestOrphanAgeMinutes =
      orphanedClaims > 0 && staleRow?.oldest
        ? Math.max(
            0,
            Math.round((nowMs - new Date(staleRow.oldest).getTime()) / 60000)
          )
        : null;

    // ---- Recent errors + by-pattern histogram ----
    const recentErrorsRes = await db
      .prepare(
        `SELECT id, error_message, created_at
         FROM processing_queue
         WHERE processing_status = 'error'
         ORDER BY created_at DESC
         LIMIT ?`
      )
      .bind(RECENT_ERRORS_LIMIT)
      .all<ErrorRow>();

    const recentErrors: ProcessingStatusErrorRow[] = (
      recentErrorsRes.results ?? []
    ).map((r) => ({
      id: r.id,
      errorMessage: r.error_message,
      createdAt: r.created_at,
    }));

    // For pattern bucketing pull a wider window — recent 200 errors —
    // so the histogram surfaces real ratios, not just the latest 10.
    const allErrorsRes = await db
      .prepare(
        `SELECT id, error_message, created_at
         FROM processing_queue
         WHERE processing_status = 'error'
         ORDER BY created_at DESC
         LIMIT 200`
      )
      .all<ErrorRow>();

    const byPattern = groupErrorPatterns(allErrorsRes.results ?? []);

    // ---- Qwen probe (failure-isolated) ----
    const qwen = await probeQwen(context.env);

    // ---- Resolved tag -> model mapping (failure-isolated, cached) ----
    const models = await resolveModelTags(context.env);

    const body: ProcessingStatusResponse = {
      queue: { counts, oldestQueued, totalRows },
      worker: {
        lastJobCompletedAt,
        minutesSinceLastJob,
        healthy: workerHealthy,
      },
      qwen,
      models,
      stale: { orphanedClaims, oldestOrphanAgeMinutes },
      errors: { recent: recentErrors, byPattern },
      checkedAt: nowIso,
    };

    // Audit the access — same pattern as other admin reads. Failures
    // here must not block the response, so wrap and swallow.
    try {
      await logAudit(
        db,
        user.id,
        null,
        'admin.processing_status.viewed',
        'system',
        null,
        null,
        getClientIp(context.request)
      );
    } catch (err) {
      console.warn(
        'processing-status: audit log failed:',
        err instanceof Error ? err.message : String(err)
      );
    }

    return new Response(JSON.stringify(body), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('processing-status error:', err);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
