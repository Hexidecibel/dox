/**
 * EXPIRED ON ARRIVAL — a certificate that was already dead when it reached us
 * (rules table G4, ruled 2026-09-27).
 *
 * "Accepting an expired certificate is the finding an auditor writes first."
 * Three of four certificates in one recent packet were expired on arrival, and
 * nothing said so: the Review Queue showed the printed expiry as a field like
 * any other, approval filed it, and the gap engine counted it as closing the
 * requirement it was sent for. G4's three answers, all of which read this file:
 *
 *   1. the Review Queue card SAYS so, before approval (src/pages/ReviewQueue.tsx);
 *   2. the gap engine does NOT count the document as satisfying its requirement,
 *      and the requirement stays open with this as the reason
 *      (shared/requirementGap.ts);
 *   3. approval notifies the QA lane through the shared routing ladder, with an
 *      audit row (functions/lib/expired-on-arrival.ts).
 *
 * THE TWO DATES, AND WHICH ONES THEY ARE
 *
 *   expires  `document_expires_on` — the date THE DOCUMENT stops being valid,
 *            as printed and approved. NEVER `expiration_date`, which is a
 *            product's shelf life (see shared/renewalPeriod.ts; the same bug
 *            would flag every COA for a lot that has since sold through).
 *   arrived  the day the file reached us: the queue item's creation, carried
 *            onto the document at approval as `documents.arrived_at`
 *            (migration 0121). A document with no recorded arrival falls back
 *            to its own `created_at` — exact for a direct upload, and for one
 *            approved before 0121 the approval day, which can only be LATER
 *            than arrival. That fallback can call a certificate expired on
 *            arrival when it lapsed while waiting in the queue; it is named
 *            `arrival_basis: 'created_at'` so a reader can tell.
 *
 * STRICTLY BEFORE. A certificate that expires ON the day it arrives was valid
 * that day. Dates are compared as calendar days (YYYY-MM-DD), not instants — a
 * printed expiry is a day, and a timezone must not decide the finding.
 *
 * NEVER A GUESS. A value that is not a clean calendar date answers `null`
 * (unknown), never `false`: "we could not read the expiry" is not "it was
 * current". Callers treat null as "say nothing", which is what they did before.
 *
 * PURE. No D1, no clock.
 */

export type ArrivalBasis = 'arrived_at' | 'created_at';

export interface ExpiredOnArrival {
  /** YYYY-MM-DD, the printed expiry. */
  expires_on: string;
  /** YYYY-MM-DD, the day the document reached us. */
  arrived_on: string;
  /** Whole days between the expiry and the arrival (always >= 1). */
  days_expired: number;
  /** Which recorded date `arrived_on` came from. */
  arrival_basis: ArrivalBasis;
}

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * A calendar day out of a date or a timestamp ("2026-09-27",
 * "2026-09-27 14:03:11", "2026-09-27T14:03:11Z"), or null when the value is
 * not one. The day is validated, so "2026-02-31" is null rather than a day that
 * silently rolls into March.
 */
export function calendarDay(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const head = value.trim().slice(0, 10);
  const m = ISO_DAY.exec(head);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) {
    return null;
  }
  return head;
}

function dayNumber(day: string): number {
  const [y, m, d] = day.split('-').map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / 86_400_000);
}

/**
 * Was this document already expired the day it arrived?
 *
 * @returns the finding, or `null` when it was not expired on arrival OR when
 *          either date is missing or unreadable. Both mean "say nothing".
 */
export function expiredOnArrival(input: {
  expires_on: unknown;
  arrived_at?: unknown;
  created_at?: unknown;
}): ExpiredOnArrival | null {
  const expires = calendarDay(input.expires_on);
  if (!expires) return null;
  const recorded = calendarDay(input.arrived_at);
  const arrived = recorded ?? calendarDay(input.created_at);
  if (!arrived) return null;
  const days = dayNumber(arrived) - dayNumber(expires);
  if (days < 1) return null;
  return {
    expires_on: expires,
    arrived_on: arrived,
    days_expired: days,
    arrival_basis: recorded ? 'arrived_at' : 'created_at',
  };
}

/** The one sentence every surface uses, so the card, the gap and the email agree. */
export function expiredOnArrivalSentence(f: ExpiredOnArrival): string {
  return (
    `Expired on arrival: this document's own expiry is ${f.expires_on}, ` +
    `${f.days_expired} day${f.days_expired === 1 ? '' : 's'} before it arrived on ${f.arrived_on}`
  );
}

/**
 * The owner label an expired-on-arrival notice routes to (G4: "routes to the QA
 * lane"). Matched through `owner_routes` like any other label, normalized, so a
 * tenant's "qa" or "QA " route receives it.
 */
export const EXPIRED_ON_ARRIVAL_OWNER_LABEL = 'QA';
