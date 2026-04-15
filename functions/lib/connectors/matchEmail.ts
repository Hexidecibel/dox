/**
 * Pure helpers for matching an inbound email to a connector by subject and
 * sender regex. Extracted from functions/api/connectors/match-email.ts so the
 * logic is unit-testable without a D1 stub.
 *
 * All pattern matches are case-insensitive by default — email subjects are
 * notoriously inconsistent in casing (e.g. "Daily COA Report" vs "DAILY COA
 * REPORT" vs "daily coa report"), and forcing the user to think about regex
 * flags for that is bad UX.
 */

/**
 * Returns true when `subject` matches any of the supplied regex patterns.
 * An empty or missing pattern list matches everything.
 * Invalid regex entries are silently skipped.
 */
export function subjectMatches(
  subject: string | null | undefined,
  patterns: readonly string[] | null | undefined,
): boolean {
  if (!patterns || patterns.length === 0) return true;
  if (!subject) return false;
  for (const pattern of patterns) {
    if (typeof pattern !== 'string' || !pattern) continue;
    try {
      // Case-insensitive by default — email subjects are often inconsistent in casing
      const re = new RegExp(pattern, 'i');
      if (re.test(subject)) return true;
    } catch {
      // Invalid regex — skip
    }
  }
  return false;
}

/**
 * Returns true when `sender` matches the supplied sender filter regex.
 * An empty or missing filter matches everything. Case-insensitive.
 */
export function senderMatches(
  sender: string | null | undefined,
  filter: string | null | undefined,
): boolean {
  if (!filter) return true;
  if (!sender) return false;
  try {
    const re = new RegExp(filter, 'i');
    return re.test(sender);
  } catch {
    // Invalid regex — treat as no filter (fail-open matches historical behavior)
    return true;
  }
}
