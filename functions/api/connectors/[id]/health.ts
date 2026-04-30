/**
 * GET /api/connectors/:id/health
 *
 * Phase B5 — observability snapshot for the connector detail page.
 * Aggregates counts straight off `connector_runs` so the UI can render
 * a small "Health" card showing 24h volume, success rate, last error,
 * and per-source pills without an N+1 of follow-on requests.
 *
 * Response shape:
 *   {
 *     last_24h: { dispatched, success, partial, error, success_rate },
 *     last_error: { run_id, started_at, error_message } | null,
 *     by_source: { manual, api, email, s3, public_link, webhook,
 *                  api_poll, r2_poll, unknown },  // 24h counts
 *     window_hours: 24,
 *   }
 *
 * `last_error` looks back 7 days regardless of the activity window —
 * the UI uses it to surface "the latest thing that broke" so a
 * connector idle for 6 days but with a 5-day-old error can still warn.
 */

import {
  requireTenantAccess,
  NotFoundError,
  errorToResponse,
} from '../../../lib/permissions';
import type { Env, User } from '../../../lib/types';
import { resolveConnectorHandle } from '../../../lib/connectors/resolveHandle';

const WINDOW_HOURS = 24;
const LAST_ERROR_LOOKBACK_HOURS = 24 * 7;

interface StatusCounts {
  dispatched: number;
  success: number;
  partial: number;
  error: number;
  running: number;
}

interface SourceCounts {
  manual: number;
  api: number;
  email: number;
  s3: number;
  public_link: number;
  webhook: number;
  api_poll: number;
  r2_poll: number;
  unknown: number;
}

function emptyStatusCounts(): StatusCounts {
  return { dispatched: 0, success: 0, partial: 0, error: 0, running: 0 };
}

function emptySourceCounts(): SourceCounts {
  return {
    manual: 0,
    api: 0,
    email: 0,
    s3: 0,
    public_link: 0,
    webhook: 0,
    api_poll: 0,
    r2_poll: 0,
    unknown: 0,
  };
}

function bumpSource(counts: SourceCounts, raw: string | null): void {
  const key = (raw || 'unknown') as keyof SourceCounts;
  if (key in counts) {
    counts[key]++;
  } else {
    counts.unknown++;
  }
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const connectorHandle = context.params.id as string;

    const connector = await resolveConnectorHandle(
      context.env.DB,
      connectorHandle,
      { columns: 'id, tenant_id' },
    );
    if (!connector) {
      throw new NotFoundError('Connector not found');
    }
    requireTenantAccess(user, connector.tenant_id as string);

    // Window cutoff in SQLite-friendly text. `datetime('now', '-24 hours')`
    // would be cleaner but we'd have to thread it as a literal — easier
    // to compute in JS once and bind.
    const windowCutoff = new Date(Date.now() - WINDOW_HOURS * 3600 * 1000)
      .toISOString()
      .replace('T', ' ')
      .replace(/\..*Z$/, '');

    // -------- Last-24h aggregation --------
    // Single SELECT pulls every row in the window. We tally in JS
    // because (a) the volume per connector is bounded by the
    // throughput cap and (b) SQLite's CASE-WHEN-COUNT idiom for both
    // status AND source breakdown would be a wall of text.
    let runs: { status: string; source: string | null }[];
    try {
      const res = await context.env.DB
        .prepare(
          `SELECT status, source FROM connector_runs
            WHERE connector_id = ?
              AND started_at >= ?`,
        )
        .bind(connector.id as string, windowCutoff)
        .all<{ status: string; source: string | null }>();
      runs = res.results ?? [];
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Pre-0049 envs lack the source column; fall back to a sourceless
      // SELECT so the endpoint stays usable on a half-migrated DB.
      if (!msg.includes('no such column')) throw err;
      const res = await context.env.DB
        .prepare(
          `SELECT status FROM connector_runs
            WHERE connector_id = ?
              AND started_at >= ?`,
        )
        .bind(connector.id as string, windowCutoff)
        .all<{ status: string }>();
      runs = (res.results ?? []).map((r) => ({ ...r, source: null }));
    }

    const status = emptyStatusCounts();
    const bySource = emptySourceCounts();
    for (const r of runs) {
      status.dispatched++;
      switch (r.status) {
        case 'success': status.success++; break;
        case 'partial': status.partial++; break;
        case 'error':   status.error++; break;
        case 'running': status.running++; break;
      }
      bumpSource(bySource, r.source);
    }

    // Success rate: success / (success + partial + error). Running
    // rows are excluded so an in-flight run doesn't drag the % down.
    const completed = status.success + status.partial + status.error;
    const successRate = completed === 0
      ? null
      : Math.round((status.success / completed) * 100);

    // -------- Last error (7-day lookback) --------
    const errorCutoff = new Date(
      Date.now() - LAST_ERROR_LOOKBACK_HOURS * 3600 * 1000,
    )
      .toISOString()
      .replace('T', ' ')
      .replace(/\..*Z$/, '');

    const lastError = await context.env.DB
      .prepare(
        `SELECT id, started_at, error_message
           FROM connector_runs
          WHERE connector_id = ?
            AND status = 'error'
            AND started_at >= ?
          ORDER BY started_at DESC
          LIMIT 1`,
      )
      .bind(connector.id as string, errorCutoff)
      .first<{ id: string; started_at: string; error_message: string | null }>();

    return new Response(
      JSON.stringify({
        last_24h: {
          dispatched: status.dispatched,
          success: status.success,
          partial: status.partial,
          error: status.error,
          running: status.running,
          success_rate: successRate,
        },
        last_error: lastError
          ? {
              run_id: lastError.id,
              started_at: lastError.started_at,
              error_message: lastError.error_message,
            }
          : null,
        by_source: bySource,
        window_hours: WINDOW_HOURS,
      }),
      { headers: { 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Connector health error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }
};
