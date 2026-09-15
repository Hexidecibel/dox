/**
 * API key expiry — the ONE definition of when a key stops working.
 *
 * Every place that decides or shows whether a key is expired reads this file:
 * the auth middleware (`functions/lib/api-key-auth.ts`), the create endpoint
 * (`functions/api/api-keys/index.ts`) and Settings › API Keys. They used to
 * each write `new Date(expires_at) < new Date()`, which is wrong for the value
 * the create form actually stored: a date-only string like `2026-09-15` parses
 * as MIDNIGHT UTC AT THE START of that day, so a key set to expire "today" was
 * dead on creation (hit on prod 2026-09-15).
 *
 * `expires_at` is the LAST INSTANT the key works. A key is expired once `now`
 * is strictly after it. Three stored shapes are read:
 *
 *   - DATE-ONLY (`2026-09-15`) — legacy rows and API callers that send a bare
 *     date. It means "valid THROUGH that day", i.e. through 23:59:59.999 UTC.
 *     UTC because dox has no per-tenant (or per-user) time zone to resolve a
 *     calendar date against; the UI says "(UTC)" whenever it shows one of these.
 *   - ZONED TIMESTAMP (`2026-09-16T06:59:59.999Z`, `...-07:00`) — what the
 *     create endpoint stores today. The Settings form computes the end of the
 *     picked day in the ADMIN'S OWN time zone in the browser, which is the only
 *     place that time zone is known, so "expires Sep 15" means their Sep 15.
 *   - NAIVE TIMESTAMP (`2026-09-15 10:00:00`) — SQLite `datetime('now')` shape;
 *     read as UTC, the same convention as `src/utils/format.ts`.
 *
 * Anything else is `invalid`, and an invalid expiry counts as EXPIRED: this is
 * an authentication check, and the old code's NaN comparison silently meant
 * "never expires" for a value nobody could read.
 *
 * Pure — every function that needs the time takes `now`, so tests pin a clock.
 */

export type ApiKeyExpiry =
  | { kind: 'never' }
  /** Date-only value: works through the end of `date` in UTC. */
  | { kind: 'date'; date: string; lastValidAt: Date }
  /** A specific instant (zoned, or naive read as UTC). */
  | { kind: 'instant'; lastValidAt: Date }
  | { kind: 'invalid'; raw: string };

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAIVE_TIMESTAMP = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/;
const ZONED_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/i;

/** A real calendar date (rejects 2026-02-30), or null. */
function calendarDate(value: string): { y: number; m: number; d: number } | null {
  const match = DATE_ONLY.exec(value);
  if (!match) return null;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) {
    return null;
  }
  return { y, m, d };
}

function validDate(date: Date): Date | null {
  return Number.isNaN(date.getTime()) ? null : date;
}

export function parseApiKeyExpiry(value: string | null | undefined): ApiKeyExpiry {
  if (value === null || value === undefined) return { kind: 'never' };
  const raw = String(value).trim();
  if (raw === '') return { kind: 'never' };

  const cal = calendarDate(raw);
  if (cal) {
    return {
      kind: 'date',
      date: raw,
      lastValidAt: new Date(Date.UTC(cal.y, cal.m - 1, cal.d, 23, 59, 59, 999)),
    };
  }
  if (ZONED_TIMESTAMP.test(raw) && calendarDate(raw.slice(0, 10))) {
    const at = validDate(new Date(raw));
    return at ? { kind: 'instant', lastValidAt: at } : { kind: 'invalid', raw };
  }
  if (NAIVE_TIMESTAMP.test(raw) && calendarDate(raw.slice(0, 10))) {
    const at = validDate(new Date(`${raw.replace(' ', 'T')}Z`));
    return at ? { kind: 'instant', lastValidAt: at } : { kind: 'invalid', raw };
  }
  return { kind: 'invalid', raw };
}

/**
 * True once the key has stopped working: `now` is strictly after the last
 * valid instant. No expiry is never expired; an unreadable one always is.
 */
export function isApiKeyExpired(expiresAt: string | null | undefined, now: Date): boolean {
  const expiry = parseApiKeyExpiry(expiresAt);
  switch (expiry.kind) {
    case 'never':
      return false;
    case 'invalid':
      return true;
    default:
      return now.getTime() > expiry.lastValidAt.getTime();
  }
}

export type NewApiKeyExpiryResult =
  | { ok: true; expiresAt: string | null }
  | { ok: false; error: string };

/**
 * Validate the `expiresAt` a caller sends to POST /api/api-keys and normalise
 * it to the stored form: a full UTC ISO timestamp of the last valid instant,
 * or null for "never expires".
 *
 * Accepted: omitted / null / '' (never), a date-only `YYYY-MM-DD` (through the
 * end of that day UTC), or an ISO 8601 timestamp WITH a zone. A naive
 * timestamp is refused on write — it names no time zone, and guessing one is
 * exactly how a key ends up expiring hours early. A value already in the past
 * is refused too: the key would be dead on creation.
 */
export function validateNewApiKeyExpiry(value: unknown, now: Date): NewApiKeyExpiryResult {
  if (value === undefined || value === null || value === '') return { ok: true, expiresAt: null };
  if (typeof value !== 'string') {
    return { ok: false, error: 'expiresAt must be a string: a date (YYYY-MM-DD) or an ISO 8601 timestamp with a time zone' };
  }
  const raw = value.trim();
  const isDateOnly = DATE_ONLY.test(raw);
  if (!isDateOnly && !ZONED_TIMESTAMP.test(raw)) {
    return {
      ok: false,
      error:
        'expiresAt must be a date (YYYY-MM-DD, valid through the end of that day UTC) or an ISO 8601 timestamp with a time zone (e.g. 2026-09-15T23:59:59-07:00)',
    };
  }
  const expiry = parseApiKeyExpiry(raw);
  if (expiry.kind !== 'date' && expiry.kind !== 'instant') {
    return { ok: false, error: `expiresAt is not a real date: ${raw}` };
  }
  if (now.getTime() > expiry.lastValidAt.getTime()) {
    const when =
      expiry.kind === 'date'
        ? `the end of ${expiry.date} (UTC)`
        : expiry.lastValidAt.toISOString();
    return {
      ok: false,
      error: `expiresAt is in the past: a key that stops working at ${when} would be expired on creation. Choose a later date, or omit expiresAt for a key that does not expire.`,
    };
  }
  return { ok: true, expiresAt: expiry.lastValidAt.toISOString() };
}

/**
 * Browser helper for the create form: the last millisecond of a picked
 * calendar date in the viewer's LOCAL time zone, as a UTC ISO string.
 * Returns null for anything that is not a real `YYYY-MM-DD` date.
 */
export function endOfLocalDayIso(dateOnly: string): string | null {
  const cal = calendarDate(dateOnly);
  if (!cal) return null;
  return new Date(cal.y, cal.m - 1, cal.d, 23, 59, 59, 999).toISOString();
}

/** Today's calendar date in the viewer's LOCAL time zone, as `YYYY-MM-DD`. */
export function localDateString(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
