/**
 * Date formatting utilities.
 *
 * SQLite's datetime('now') produces strings like "2026-03-25 02:21:05" without
 * a timezone suffix.  JavaScript's Date constructor treats those as *local* time,
 * but they are actually UTC.  The helper below normalises the input so every
 * date string is parsed as UTC before being formatted for display.
 */

function ensureUtc(dateString: string): string {
  // Already has timezone info (Z, +HH:MM, -HH:MM) — leave it alone
  if (/[Z]$/i.test(dateString) || /[+-]\d{2}:\d{2}$/.test(dateString)) {
    return dateString;
  }
  // Treat as UTC
  return dateString + 'Z';
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
  });
}
