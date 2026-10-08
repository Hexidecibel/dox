/**
 * The rail's "Waiting for QA" number (migration 0138).
 *
 * The rail asks for it on a timer -- one cheap count, the notification bell's
 * cadence -- not on every navigation. A screen that changes the number (a
 * release, a refusal, putting an unfinished release back) says so here and the
 * rail asks again at once.
 */

/** How often the rail re-asks how many documents wait for QA. */
export const QA_WAITING_POLL_MS = 3 * 60 * 1000;

/** Dispatched on `window` when the number of documents waiting for QA may have changed. */
export const QA_WAITING_CHANGED = 'dox:qa-waiting-changed';

export function announceQaWaitingChanged(): void {
  try {
    window.dispatchEvent(new Event(QA_WAITING_CHANGED));
  } catch {
    // No window (a test without one): nothing to tell.
  }
}

/** Documents one release may carry: what one link carries. The server enforces it. */
export const RELEASE_MAX_DOCUMENTS = 50;
