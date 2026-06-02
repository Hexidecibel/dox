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
export function formatDate(dateString: string | null | undefined): string {
  if (!dateString) return 'Never';
  const date = new Date(ensureUtc(dateString));
  if (isNaN(date.getTime())) return 'Invalid date';
  return date.toLocaleDateString();
}

/** Format a date string as date + time in the user's locale. */
export function formatDateTime(dateString: string | null | undefined): string {
  if (!dateString) return 'Never';
  const date = new Date(ensureUtc(dateString));
  if (isNaN(date.getTime())) return 'Invalid date';
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
