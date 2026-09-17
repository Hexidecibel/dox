/**
 * Did the reviewer ANSWER the renewal question — and therefore, does the
 * approve request carry a renewal decision at all?
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS ITS OWN MODULE
 * ---------------------------------------------------------------------------
 * The server contract (functions/lib/renewal-proposal.ts) is that the `renewal`
 * key PRESENT means a human answered and ABSENT means nobody did, and the
 * difference is permanent: a recorded decision with no date is read by
 * `resolveRenewalExpiry` tier 2, forever and ahead of every default, as "a
 * reviewer confirmed this document does not renew".
 *
 * The Review Queue used to send the key unconditionally, which was right for
 * every proposal that puts something on screen to agree with — a date, or "does
 * not renew" for a type that does not renew. It was wrong for exactly one rule.
 *
 * ---------------------------------------------------------------------------
 * `unresolvable` IS NOT AN ANSWER, IT IS OUR FAILURE
 * ---------------------------------------------------------------------------
 * That rule means "a period applies, but the document states no expiry and
 * carries no effective date to count from". The box is empty because WE could
 * not fill it. A reviewer who approves without touching it has agreed to
 * nothing, and recording that as a decision turns a certificate whose expiry we
 * merely failed to extract into one that never comes due again — on one
 * careless Approve, with no way for a later reviewer or the dashboard to tell
 * it from a real ruling.
 *
 * So on that rule alone an untouched box sends nothing. Touching it at all —
 * typing a date, or typing one and deleting it again — makes it an answer,
 * because now the reviewer has looked at the field and decided what belongs in
 * it. `undefined` (never edited) and `''` (edited to empty) are therefore
 * deliberately different inputs here, which is also why the caller's edit map
 * is keyed on presence rather than initialised from the proposal.
 */

import type { ResolvedRenewal } from '../../shared/renewalPeriod';

/** The approve payload's renewal half. Present = answered; absent = not asked. */
export interface RenewalAnswerPayload {
  renewal?: { due_date: string | null };
}

/**
 * Has the reviewer answered?
 *
 * @param proposal what the server proposed for this item (null when the item
 *   carries no proposal at all — an older queue row, say — in which case the
 *   box behaves as any other pre-filled field and its value is an answer).
 * @param edited the reviewer's edit, or `undefined` when they never touched the
 *   box.
 */
export function renewalAnswered(
  proposal: ResolvedRenewal | null | undefined,
  edited: string | undefined,
): boolean {
  if (proposal?.rule === 'unresolvable') return edited !== undefined;
  return true;
}

/** The date currently in the box: the reviewer's edit, else the proposal. */
export function renewalBoxValue(
  proposal: ResolvedRenewal | null | undefined,
  edited: string | undefined,
): string {
  return edited ?? proposal?.due_date ?? '';
}

/**
 * The renewal half of an approve request. `{}` when the reviewer has not
 * answered, which leaves the document's renewal columns all-NULL: still to be
 * decided, and distinguishable from a decision.
 */
export function renewalAnswerPayload(
  proposal: ResolvedRenewal | null | undefined,
  edited: string | undefined,
): RenewalAnswerPayload {
  if (!renewalAnswered(proposal, edited)) return {};
  return { renewal: { due_date: renewalBoxValue(proposal, edited) || null } };
}
