/**
 * Date formatting utilities.
 *
 * SQLite's datetime('now') produces strings like "2026-03-25 02:21:05" without
 * a timezone suffix.  JavaScript's Date constructor treats those as *local* time,
 * but they are actually UTC.  The helper below normalises the input so every
 * date string is parsed as UTC before being formatted for display.
 */

export function ensureUtc(dateString: string): string {
  // Already has timezone info (Z, +HH:MM, -HH:MM) — leave it alone
  if (/[Z]$/i.test(dateString) || /[+-]\d{2}:?\d{2}$/.test(dateString)) {
    return dateString;
  }
  // ONLY an ISO-shaped value may be stamped as UTC. Appending 'Z' to anything
  // else turns a merely-unusual string into a guaranteed Invalid Date: a
  // supplier's printed code date of `7/4/26` became `7/4/26Z`, which no engine
  // parses, so every lot on the product screen rendered "Invalid date" while
  // the real value sat in the column. These fields are TEXT and hold whatever
  // the certificate printed — the parser must not assume the extractor won.
  if (!/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?)?$/.test(dateString)) {
    return dateString;
  }
  // Treat as UTC
  return dateString + 'Z';
}

/**
 * Parse a backend timestamp (UTC, usually without a `Z`) into a Date.
 * Returns `null` for empty/invalid input. Use this anywhere a raw
 * `new Date(serverString)` would otherwise be off by the local tz offset.
 */
export function parseUtc(dateString: string | null | undefined): Date | null {
  if (!dateString) return null;
  const date = new Date(ensureUtc(dateString));
  return isNaN(date.getTime()) ? null : date;
}

/** Format a date string as a short date (e.g. "3/25/2026") in the user's locale. */
// A date-only value ("2026-05-03") is a CALENDAR DATE, not an instant. It has
// no time zone and must never acquire one: stamping it UTC and rendering it
// locally showed every expiration a day early for anyone west of Greenwich.
const ISO_DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?/;

function isTimestamp(s: string): boolean {
  return ISO_DATETIME.test(s) || /[Z]$/i.test(s) || /[+-]\d{2}:?\d{2}$/.test(s);
}

export function formatDate(dateString: string | null | undefined): string {
  if (!dateString) return 'Never';
  const s = String(dateString).trim();

  const cal = ISO_DATE_ONLY.exec(s);
  if (cal) {
    const d = new Date(Number(cal[1]), Number(cal[2]) - 1, Number(cal[3]));
    if (!isNaN(d.getTime())) return d.toLocaleDateString();
  }

  if (isTimestamp(s)) {
    const d = new Date(ensureUtc(s));
    if (!isNaN(d.getTime())) return d.toLocaleDateString();
  }

  // Anything else is returned VERBATIM and never handed to Date(), which
  // guesses: it read the lot code "129" as the year 129, and turned the
  // supplier's printed "7/4/26" into Invalid Date once ensureUtc appended Z.
  // These columns are TEXT holding whatever the certificate printed, so the
  // honest rendering of an unrecognised value is the value itself.
  return s;
}

export function formatDateTime(dateString: string | null | undefined): string {
  if (!dateString) return 'Never';
  const s = String(dateString).trim();
  if (!isTimestamp(s)) return formatDate(s);
  const date = new Date(ensureUtc(s));
  if (isNaN(date.getTime())) return s;
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    // Append a short tz label (e.g. "EDT", "GMT+2") so users know the
    // value is rendered in their own local timezone, not the server's UTC.
    timeZoneName: 'short',
  });
}
