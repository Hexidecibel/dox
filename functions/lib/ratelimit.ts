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
  const windowStart = new Date(now.getTime() - windowSeconds * 1000).toISOString();

  const record = await db
    .prepare('SELECT attempts, window_start FROM rate_limits WHERE key = ?')
    .bind(key)
    .first<{ attempts: number; window_start: string }>();

  if (!record) {
    return { allowed: true, remaining: maxAttempts, resetAt: '' };
  }

  // If the window has expired, treat as fresh
  if (record.window_start < windowStart) {
    await db.prepare('DELETE FROM rate_limits WHERE key = ?').bind(key).run();
    return { allowed: true, remaining: maxAttempts, resetAt: '' };
  }

  const remaining = Math.max(0, maxAttempts - record.attempts);
  const resetAt = new Date(
    new Date(record.window_start).getTime() + windowSeconds * 1000
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
  const windowStart = new Date(now.getTime() - windowSeconds * 1000).toISOString();

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
