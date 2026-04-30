/**
 * Simple rate limiting using D1.
 * Tracks attempts by a key (e.g. "login:ip:email") within a sliding window.
 */

export async function checkRateLimit(
  db: D1Database,
  key: string,
  maxAttempts: number,
  windowSeconds: number
): Promise<{ allowed: boolean; remaining: number; resetAt: string }> {
  const now = new Date();
  // SQLite stores `datetime('now')` as `YYYY-MM-DD HH:MM:SS` (no T, no Z).
  // JS's `.toISOString()` returns `YYYY-MM-DDTHH:MM:SS.sssZ` and the
  // string compare against the SQLite format always lexically deems the
  // SQLite value "less than" the JS one (' ' < 'T'), which would cause
  // every call to spuriously declare the window expired. Match the
  // SQLite shape so the comparison is meaningful.
  const windowStart = new Date(now.getTime() - windowSeconds * 1000)
    .toISOString()
    .replace('T', ' ')
    .replace(/\..*Z$/, '');

  const record = await db
    .prepare('SELECT attempts, window_start FROM rate_limits WHERE key = ?')
    .bind(key)
    .first<{ attempts: number; window_start: string }>();

  if (!record) {
    return { allowed: true, remaining: maxAttempts, resetAt: '' };
  }

  // If the window has expired, treat as fresh. We compare the parsed
  // numeric millis on both sides instead of doing a lexical compare —
  // historical rows can carry either the SQLite ('YYYY-MM-DD HH:MM:SS')
  // or JS ISO ('YYYY-MM-DDTHH:MM:SS.sssZ') format depending on which
  // call site wrote them, and a string compare across the two formats
  // is unreliable (' ' < 'T').
  const recordRaw = record.window_start;
  const recordMs = recordRaw.includes('T')
    ? Date.parse(recordRaw)
    : Date.parse(recordRaw.replace(' ', 'T') + 'Z');
  const cutoffMs = now.getTime() - windowSeconds * 1000;
  if (Number.isFinite(recordMs) && recordMs < cutoffMs) {
    await db.prepare('DELETE FROM rate_limits WHERE key = ?').bind(key).run();
    return { allowed: true, remaining: maxAttempts, resetAt: '' };
  }

  const remaining = Math.max(0, maxAttempts - record.attempts);
  // Parse the SQLite-format window_start back into a Date. Historical
  // rows + tests sometimes carry the JS ISO shape (`YYYY-MM-DDTHH:MM:SS.sssZ`);
  // SQLite's `datetime('now')` writes the bare `YYYY-MM-DD HH:MM:SS`
  // form. Detect by the presence of `T` to handle both.
  const raw = record.window_start;
  const startedAt = raw.includes('T')
    ? new Date(raw)
    : new Date(raw.replace(' ', 'T') + 'Z');
  const resetAt = new Date(
    startedAt.getTime() + windowSeconds * 1000,
  ).toISOString();

  if (record.attempts >= maxAttempts) {
    return { allowed: false, remaining: 0, resetAt };
  }

  return { allowed: true, remaining, resetAt };
}

export async function recordAttempt(
  db: D1Database,
  key: string,
  windowSeconds: number
): Promise<void> {
  const now = new Date();
  // Match SQLite's `datetime('now')` format (`YYYY-MM-DD HH:MM:SS`) so
  // the lexical compare against `window_start` is meaningful — see
  // checkRateLimit() for the full background.
  const windowStart = new Date(now.getTime() - windowSeconds * 1000)
    .toISOString()
    .replace('T', ' ')
    .replace(/\..*Z$/, '');

  // Clean up expired record first
  await db
    .prepare('DELETE FROM rate_limits WHERE key = ? AND window_start < ?')
    .bind(key, windowStart)
    .run();

  // Upsert: insert or increment
  await db
    .prepare(
      `INSERT INTO rate_limits (key, attempts, window_start)
       VALUES (?, 1, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET attempts = attempts + 1`
    )
    .bind(key)
    .run();
}

export async function clearRateLimit(
  db: D1Database,
  key: string
): Promise<void> {
  await db.prepare('DELETE FROM rate_limits WHERE key = ?').bind(key).run();
}
