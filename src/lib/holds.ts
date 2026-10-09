/**
 * The rail's "Holds" number (migration 0139).
 *
 * The same pattern as the Waiting for QA count (src/lib/qaWaiting.ts): the rail
 * asks for ONE cheap count on mount and on a timer, never on navigation, and a
 * screen that places or releases a hold says so here so the number moves at
 * once.
 */

/** How often the rail re-asks how many certificates are on hold. */
export const HOLDS_POLL_MS = 3 * 60 * 1000;

/** Dispatched on `window` when the number of active holds may have changed. */
export const HOLDS_CHANGED = 'dox:holds-changed';

export function announceHoldsChanged(): void {
  try {
    window.dispatchEvent(new Event(HOLDS_CHANGED));
  } catch {
    // No window (a test without one): nothing to tell.
  }
}
