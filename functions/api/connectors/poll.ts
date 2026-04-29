/**
 * POST /api/connectors/poll
 *
 * Scheduled poll endpoint driven by the companion `dox-connector-poller`
 * Worker (see `workers/connector-poller/`). Walks active file_watch
 * connectors with a configured `r2_prefix`, lists new objects, and
 * dispatches a connector run for each.
 *
 * Auth: bearer token (`Authorization: Bearer <CONNECTOR_POLL_TOKEN>`)
 * checked here. The route is allowlisted in
 * `functions/api/_middleware.ts` so the JWT layer is bypassed — only
 * whoever holds CONNECTOR_POLL_TOKEN can drive the poller. Same value
 * must be set on both the Pages env and the companion Worker.
 *
 * Response: JSON summary of what was checked / dispatched. Used by the
 * Worker only for log-level visibility; the Worker does not retry.
 *
 * Concurrency: a previous tick can still be running when the next one
 * fires (Pages can spin up parallel invocations). We use a short-lived
 * lock row in `app_state` (created lazily) keyed by `'poll_lock'` to
 * single-flight the poll. The lock TTL is 4 minutes — comfortably
 * shorter than the 5-minute cron interval, but long enough to outlast
 * any reasonable burst. A stale lock (older than TTL) is treated as
 * abandoned and reclaimed.
 */

import type { Env } from '../../lib/types';
import { pollAllR2Connectors } from '../../lib/connectors/pollR2';

const LOCK_TTL_MS = 4 * 60 * 1000;
const LOCK_KEY = 'poll_lock';

/**
 * Create the `app_state` table on first use. Idempotent. We do this
 * inline rather than a fresh migration so the lock is purely an
 * implementation detail of the poll endpoint — if we ever migrate to a
 * different lock primitive (DO, KV) the table goes away with no schema
 * cleanup.
 */
async function ensureAppStateTable(db: D1Database): Promise<void> {
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS app_state (
         key TEXT PRIMARY KEY,
         value TEXT NOT NULL,
         updated_at INTEGER NOT NULL
       )`,
    )
    .run();
}

/**
 * Try to acquire the poll lock. Returns true on success.
 *
 * SQLite-style "INSERT OR REPLACE only when stale" — D1 lacks proper
 * transactions across multiple statements, so we use a conditional
 * UPDATE that only succeeds if the existing lock is older than the TTL
 * (or absent). The token is a per-attempt random string so a stale
 * holder can't accidentally release someone else's lock on completion.
 */
async function acquirePollLock(db: D1Database, token: string): Promise<boolean> {
  await ensureAppStateTable(db);
  const now = Date.now();
  const cutoff = now - LOCK_TTL_MS;

  // Insert a fresh lock if no row exists.
  try {
    await db
      .prepare(
        `INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, ?)`,
      )
      .bind(LOCK_KEY, token, now)
      .run();
    return true;
  } catch {
    /* fallthrough: existing row, attempt steal */
  }

  // Existing row — steal it only if it's older than TTL.
  const updated = await db
    .prepare(
      `UPDATE app_state
          SET value = ?, updated_at = ?
        WHERE key = ?
          AND updated_at < ?`,
    )
    .bind(token, now, LOCK_KEY, cutoff)
    .run();

  // D1 reports rows changed via `meta.changes` on the result.
  const changes = (updated as unknown as { meta?: { changes?: number } }).meta?.changes ?? 0;
  return changes > 0;
}

async function releasePollLock(db: D1Database, token: string): Promise<void> {
  try {
    await db
      .prepare(
        `DELETE FROM app_state WHERE key = ? AND value = ?`,
      )
      .bind(LOCK_KEY, token)
      .run();
  } catch {
    /* swallow — lock will expire naturally */
  }
}

function unauthorized(message: string): Response {
  return new Response(
    JSON.stringify({ error: message }),
    { status: 401, headers: { 'Content-Type': 'application/json' } },
  );
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const expected = context.env.CONNECTOR_POLL_TOKEN;
  if (!expected) {
    // Misconfigured — deny everyone. Fail closed.
    return unauthorized('Poll endpoint not configured');
  }

  const authHeader = context.request.headers.get('Authorization') || '';
  if (!authHeader.toLowerCase().startsWith('bearer ')) {
    return unauthorized('Missing bearer token');
  }
  const provided = authHeader.slice('bearer '.length).trim();
  if (provided !== expected) {
    return unauthorized('Invalid bearer token');
  }

  // Try to grab the single-flight lock.
  const lockToken = crypto.randomUUID();
  const acquired = await acquirePollLock(context.env.DB, lockToken);
  if (!acquired) {
    return new Response(
      JSON.stringify({
        error: 'Poll already running',
        code: 'busy',
      }),
      { status: 429, headers: { 'Content-Type': 'application/json' } },
    );
  }

  try {
    const summary = await pollAllR2Connectors(context.env);
    return new Response(JSON.stringify(summary), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('connector poll failed:', err);
    return new Response(
      JSON.stringify({
        error: err instanceof Error ? err.message : 'Internal server error',
      }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  } finally {
    await releasePollLock(context.env.DB, lockToken);
  }
};

// Helpful 405 if someone GETs the endpoint by mistake.
export const onRequestGet: PagesFunction<Env> = async () => {
  return new Response(
    JSON.stringify({ error: 'Use POST' }),
    { status: 405, headers: { 'Content-Type': 'application/json', Allow: 'POST' } },
  );
};
