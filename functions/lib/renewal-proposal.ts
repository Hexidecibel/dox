/**
 * The renewal PROPOSAL — turning the resolver into something a human confirms.
 *
 * ---------------------------------------------------------------------------
 * WHY APPROVAL IS THE MOMENT
 * ---------------------------------------------------------------------------
 * Before this module the approve path wrote ZERO renewal fields: `produceCoa`
 * named fourteen columns and none of them was a renewal one. Every renewal
 * field on `documents` was written by the documents API or the ingest API and
 * by nothing else, so the dashboard RE-DERIVED a date on every read, from
 * whatever configuration happened to be in force that morning.
 *
 * Approval is the right moment to settle it. A human is holding the document,
 * the extraction is in front of them, the supplier and the document type are
 * resolved, and they are already saying yes to everything else on the page.
 * Asking them for one more thing costs nothing; asking them later costs a trip
 * back to a document they have forgotten.
 *
 * So `resolveRenewalExpiry` becomes a PROPOSAL, not the answer. It is shown
 * pre-filled and editable with its own `reason` printed beside it, and what the
 * reviewer confirms is written to the document.
 *
 * ---------------------------------------------------------------------------
 * THE SNAPSHOT IS THE POINT — same discipline as `limit_snapshot` (0085)
 * ---------------------------------------------------------------------------
 * `document_spec_checks.limit_snapshot` freezes the acceptance limit a verdict
 * was judged against, so moving a threshold next quarter cannot rewrite what a
 * reviewer decided last quarter. `documents.renewal_snapshot` does the same job
 * for a renewal: it freezes what we PROPOSED, the rule and period that produced
 * it, the type configuration in force at the time, and what the human did with
 * it. Change the document type's period afterwards and the stored date does not
 * move — and the snapshot can still explain why the old date was what it was.
 *
 * A recomputed date is only as trustworthy as today's configuration. A frozen
 * one is a record of a decision.
 *
 * ---------------------------------------------------------------------------
 * CLEARED IS AN ANSWER
 * ---------------------------------------------------------------------------
 * A reviewer who empties the field is saying "this does not renew". A document
 * nobody ever looked at also has an empty field. They are opposite states and
 * the difference is `renewal_decision`: non-null means a human answered.
 * `resolveRenewalExpiry` honours that directly, so the dashboard cannot
 * overrule the human on the next read.
 */

import type { D1Database } from '@cloudflare/workers-types';
import {
  resolveRenewalExpiry,
  dateOnly,
  type ResolvedRenewal,
  type RenewalDecision,
  type TypeRenewalPolicy,
} from '../../shared/renewalPeriod';

/**
 * The renewal configuration of a document TYPE, as the proposal needs it.
 * Both fields are what `document_types` stores; a missing type (a queue item
 * with no `document_type_id`) is all-null, which the resolver reads as
 * `inherit` and therefore the annual default.
 */
export interface TypeRenewalConfig {
  renewal_policy: TypeRenewalPolicy | string | null;
  renewal_interval_months: number | null;
}

export const UNCONFIGURED_TYPE_RENEWAL: TypeRenewalConfig = {
  renewal_policy: null,
  renewal_interval_months: null,
};

/** Load a document type's renewal configuration. Missing type → unconfigured. */
export async function loadTypeRenewalConfig(
  db: D1Database,
  documentTypeId: string | null | undefined
): Promise<TypeRenewalConfig> {
  if (!documentTypeId) return UNCONFIGURED_TYPE_RENEWAL;
  const row = await db
    .prepare('SELECT renewal_policy, renewal_interval_months FROM document_types WHERE id = ?')
    .bind(documentTypeId)
    .first<{ renewal_policy: string | null; renewal_interval_months: number | null }>();
  if (!row) return UNCONFIGURED_TYPE_RENEWAL;
  return {
    renewal_policy: row.renewal_policy,
    renewal_interval_months: row.renewal_interval_months,
  };
}

/**
 * Pull the two dates the ladder reads out of a set of extracted/approved
 * fields.
 *
 * `document_expires_on` ONLY. `expiration_date` is the PRODUCT's shelf life and
 * is deliberately not consulted — reading it here is precisely the defect this
 * whole change exists to remove. See the header of shared/renewalPeriod.ts.
 *
 * `shelf_life` (the same fact as a PERIOD: "21 days", "1 year frozen, 21 days
 * refrigerated") is not consulted either, and must never be added as a third
 * key or quietly turned into a period below. A specification sheet renews at
 * three years because that is what a specification sheet IS; the cream on it
 * keeps for 21 days. Pinned by tests/unit/shelfLifeNotRenewal.test.ts.
 */
export function renewalDatesFromFields(
  fields: Record<string, unknown> | null | undefined
): { document_expires_on: string | null; effective_date: string | null } {
  const read = (k: string): string | null => {
    const v = fields ? fields[k] : null;
    return typeof v === 'string' ? dateOnly(v) : null;
  };
  return {
    document_expires_on: read('document_expires_on'),
    effective_date: read('effective_date'),
  };
}

/**
 * Build the proposal shown on the review screen for a document that does not
 * exist yet. Nothing on the document side is set: no canonical due date, no
 * per-document period, no prior decision. Everything comes from the extraction
 * and the type.
 */
export function buildRenewalProposal(
  fields: Record<string, unknown> | null | undefined,
  type: TypeRenewalConfig
): ResolvedRenewal {
  const dates = renewalDatesFromFields(fields);
  return resolveRenewalExpiry({
    renewal_type: null,
    renewal_due_date: null,
    renewal_interval_months: null,
    renewal_decision: null,
    type_renewal_policy: type.renewal_policy,
    type_renewal_interval_months: type.renewal_interval_months,
    meta_document_expires_on: dates.document_expires_on,
    meta_effective_date: dates.effective_date,
  });
}

/**
 * What the reviewer sent back. PRESENT means a human answered the question;
 * ABSENT means nobody did, and nothing is written.
 *
 * `due_date: null` inside a present object is the "this does not renew" answer
 * — which is exactly why the payload is a nested object rather than a bare
 * nullable field. A bare `renewal_due_date: null` on the request body is
 * indistinguishable from a client that never sent one, and those two mean
 * opposite things.
 *
 * THE CONTRACT IS LOAD-BEARING, NOT DECORATIVE. A client that sends this object
 * unconditionally converts "the reviewer did not answer" into "the reviewer
 * said no date", which is permanent (tier 2). The Review Queue therefore OMITS
 * it when the proposal was `unresolvable` and the reviewer never touched the
 * box — the one case where an empty box on screen is not an answer, because we
 * put nothing in it to accept or reject.
 */
export interface RenewalDecisionInput {
  /** The date the reviewer confirmed, or null for "this does not renew". */
  due_date: string | null;
}

/** The columns an approval writes to `documents` (migration 0097). */
export interface RenewalWrite {
  due_date: string | null;
  decision: RenewalDecision;
  /** JSON for `documents.renewal_snapshot`. */
  snapshot: string;
  decided_at: string;
  decided_by: string;
}

/**
 * Compare what the reviewer confirmed against what we proposed, and produce the
 * frozen record of that decision.
 *
 * The proposal is recomputed HERE, server-side, rather than trusting a copy
 * echoed back by the client: the snapshot is an audit record, and an audit
 * record assembled from values the audited party supplied is not one.
 *
 * Returns null when there is no decision to record — no reviewer answer, so the
 * document is left with no renewal fields at all and the dashboard goes on
 * deriving one. That absence is meaningful and must not be faked into an
 * 'accepted'.
 */
export function resolveRenewalDecision(
  input: RenewalDecisionInput | null | undefined,
  fields: Record<string, unknown> | null | undefined,
  type: TypeRenewalConfig,
  userId: string,
  now: string = new Date().toISOString()
): RenewalWrite | null {
  if (!input) return null;

  const proposal = buildRenewalProposal(fields, type);
  const confirmed = dateOnly(input.due_date);

  // 'accepted' covers accepting a date AND accepting a proposal of "does not
  // renew" (both sides null). 'cleared' is reserved for a reviewer deleting a
  // date we did propose — the case worth being able to find later.
  //
  // EXCEPT UNDER 'unresolvable', WHERE THERE WAS NOTHING TO ACCEPT. That rule
  // does not mean "this does not renew"; it means "a period applies and we
  // could not find a date to count it from". Both sides being null therefore
  // is not agreement — the naive `confirmed === proposal.due_date` read it as
  // agreement and stored 'accepted', which tier 2 of `resolveRenewalExpiry`
  // (keyed on the decision EXISTING, correctly) then honours forever as "a
  // reviewer confirmed this has no renewal date". A certificate whose expiry we
  // simply failed to extract went silent for good.
  //
  // An empty answer here is still a real answer — the reviewer looked at a box
  // we told them we could not fill and left it empty on purpose — so it is
  // recorded as 'cleared', the word that already means "a human said no date".
  // What must NEVER reach this function in that state is an UNTOUCHED box: the
  // caller omits the `renewal` key entirely then, and nothing is written. See
  // `RenewalDecisionInput` above — present means answered, absent means nobody
  // did, and the Review Queue honours that distinction for this rule.
  let decision: RenewalDecision;
  if (confirmed === null && proposal.rule === 'unresolvable') decision = 'cleared';
  else if (confirmed === proposal.due_date) decision = 'accepted';
  else if (confirmed === null) decision = 'cleared';
  else decision = 'overridden';

  return {
    due_date: confirmed,
    decision,
    decided_at: now,
    decided_by: userId,
    snapshot: JSON.stringify({
      proposed_due_date: proposal.due_date,
      confirmed_due_date: confirmed,
      decision,
      rule: proposal.rule,
      period_months: proposal.period_months,
      anchor_date: proposal.anchor_date,
      reason: proposal.reason,
      // The type configuration in force at the moment of the decision. Frozen
      // for the same reason limit_snapshot freezes a threshold: an admin who
      // changes this type's period next month must not be able to change what
      // this date meant when a human agreed to it.
      type_renewal_policy: type.renewal_policy,
      type_renewal_interval_months: type.renewal_interval_months,
    }),
  };
}

/**
 * The row shape `withRenewalProposal` needs off a `processing_queue` join.
 * Everything is `unknown` and coerced below, matching `WarnableRow` in
 * queue-warnings.ts: callers pass whole `SELECT pq.*, dt....` rows straight out
 * of D1, where every column is untyped.
 */
export interface RenewalProposableRow {
  ai_fields?: unknown;
  /** document_types.renewal_policy, joined as type_renewal_policy. */
  type_renewal_policy?: unknown;
  /** document_types.renewal_interval_months, joined alias. */
  type_renewal_interval_months?: unknown;
  [key: string]: unknown;
}

function parseFields(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const v: unknown = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Attach a `renewal_proposal` to a queue row for the review screen, in the same
 * shape as `withInvariantWarnings` / `withSpecConfig`: advisory, computed from
 * the row's own data, never blocking.
 *
 * The extraction the reviewer sees may still be edited before they approve, so
 * this is a starting value; the decision that gets frozen is recomputed at
 * approve time from the fields actually submitted.
 */
export function withRenewalProposal<T extends RenewalProposableRow>(
  row: T
): T & { renewal_proposal: ResolvedRenewal } {
  return {
    ...row,
    renewal_proposal: buildRenewalProposal(parseFields(row.ai_fields), {
      renewal_policy: typeof row.type_renewal_policy === 'string' ? row.type_renewal_policy : null,
      renewal_interval_months:
        typeof row.type_renewal_interval_months === 'number'
          ? row.type_renewal_interval_months
          : null,
    }),
  };
}
