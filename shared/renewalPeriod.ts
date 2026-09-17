/**
 * Renewal PERIODS — how long a document is good for, and which rule said so.
 *
 * ---------------------------------------------------------------------------
 * THESE ARE REGULATORY DEFINITIONS, NOT PREFERENCES
 * ---------------------------------------------------------------------------
 * Confirmed by the client's subject-matter expert (AJ Conner, 2026-09-02).
 * They are not tuning knobs someone picked because a year felt round:
 *
 *   1. ANNUAL IS THE DEFAULT. Roughly 90% of the documents in a supplier file
 *      are re-collected yearly, so a document nobody has configured is assumed
 *      to be good for twelve months rather than assumed to be good forever.
 *
 *   2. SPECIFICATION SHEETS RENEW AT THREE YEARS. Both major food-safety
 *      schemes define a spec sheet the same way: revised within three years,
 *      or carrying history showing someone reviewed or refreshed it inside
 *      that window. Three years is therefore the DEFINITION of a current spec
 *      sheet, not our house style — an auditor applies it whether or not this
 *      system does.
 *
 *   3. EVERYTHING ELSE IS ONE YEAR, *OR* WHATEVER THE DOCUMENT ITSELF STATES.
 *      This is the important half. A certificate of insurance that prints
 *      "expires 09/01/2027" expires on 09/01/2027 — not a year after we filed
 *      it, and not three years later because someone filed it under the wrong
 *      type. A default is a guess about a document that did not say; it must
 *      never overwrite a document that did.
 *
 * ---------------------------------------------------------------------------
 * ONE LADDER, ONE FUNCTION
 * ---------------------------------------------------------------------------
 * `resolveRenewalExpiry` is the ONLY place this precedence is expressed.
 * Everything that needs a next-action date — the dashboard, the alert engine,
 * the register — calls it. Scattering "well, unless it has an expiry" checks
 * across call sites is how two screens end up disagreeing about when a
 * certificate lapses, and the answer that reaches a customer is then a
 * function of which screen they happened to open.
 *
 * The ladder, most specific fact first:
 *
 *   1. `renewal_due_date`                  → the record's own canonical date
 *   2. a `renewal_decision` with no date   → a reviewer answered "it doesn't"
 *   3. a type that DOES NOT RENEW          → categorical, see WHAT RENEWS
 *   4. `primary_metadata.document_expires_on`
 *                                          → the DOCUMENT's own stated expiry
 *   5. `documents.renewal_interval_months` → a period set on THIS document
 *   6. `document_types.renewal_interval_months` → the type's period (rule 2)
 *   7. twelve months                       → the 90% case (rule 1)
 *
 * Tiers 1-4 are STATED FACTS and always win. Tiers 5-7 are PERIODS, and a
 * period is only half an answer: it needs an anchor date to count from. When
 * there is no anchor we return no date and say so, rather than manufacturing
 * one — see ANCHOR below.
 *
 * ---------------------------------------------------------------------------
 * `document_expires_on` IS NOT `expiration_date`. DO NOT REINTRODUCE THAT BUG.
 * ---------------------------------------------------------------------------
 * `primary_metadata.expiration_date` is the PRODUCT's date — the extraction
 * prompt in functions/lib/llm.ts (mirrored twice in bin/process-worker) defines
 * it as "expiration, best-by, use-by, or sell-by date". It is when the cream
 * goes bad. It says NOTHING about when the paperwork needs re-collecting.
 *
 * An earlier draft of this ladder read it as the document's expiry. Measured
 * against production that was not a corner case: 139 of 200 documents carry a
 * printed `expiration_date` and ALL 139 are Certificates of Analysis. Every one
 * of them would have been handed a renewal due date equal to its product's
 * shelf life, landed on the renewal dashboard, and emailed its owner — real
 * mail, to a real customer, about a certificate that does not renew.
 *
 * So the two dates are two fields, named so they cannot be confused:
 *
 *   expiration_date      → the PRODUCT stops being good. Shelf life. Not here.
 *   document_expires_on  → the DOCUMENT stops being valid. A certificate of
 *                          insurance printing "expires 09/01/2027", an organic
 *                          or GFSI certificate, a third-party audit
 *                          certificate. THIS is rule 3's "whatever the document
 *                          itself states".
 *
 * `document_expires_on` is only asked for on types where a document genuinely
 * expires, and the prompt explicitly forbids copying a COA's shelf life into
 * it. If you are about to add `expiration_date` back into this file, read the
 * paragraph above again.
 *
 * AND THE SAME GOES FOR `shelf_life`, WHICH IS THE SAME MISTAKE IN A PERIOD'S
 * CLOTHING. Extraction gained a `shelf_life` field on 2026-09-17 because all
 * four specification sheets in `tests/fixtures/real-corpus` print one ("21
 * days", "22 days", "1 year frozen, 21 days refrigerated") and nothing had
 * anywhere to put it. It is the PRODUCT's life, exactly as `expiration_date` is
 * the PRODUCT's date, and it is deliberately NOT an input to this function —
 * not as a tier, not as a period, and not as an anchor. The temptation is
 * sharper than `expiration_date`'s, because this one already IS a period and
 * tiers 5-7 are periods: "21 days" would slot straight into
 * `resolveRenewalPeriodMonths` and propose re-collecting a specification sheet
 * three weeks after it was issued, when a spec sheet renews at THREE YEARS by
 * type (rule 2). A shelf life is a fact about cream. How long the paperwork is
 * good for is a fact about the paperwork, and the two never meet here.
 * Pinned by tests/unit/shelfLifeNotRenewal.test.ts.
 *
 * ---------------------------------------------------------------------------
 * WHAT RENEWS AT ALL — the third document-type state
 * ---------------------------------------------------------------------------
 * "How often" and "at all" are different questions, and a nullable period
 * column can only answer the first. `document_types.renewal_policy` answers the
 * second in three explicit words (see `TypeRenewalPolicy`). A Certificate of
 * Analysis is `none`: it is a per-lot record superseded by the next lot's
 * certificate, so it has no cadence to be late against — not a very long one.
 *
 * The exclusion is CATEGORICAL, so it is checked BEFORE any date printed on the
 * document. If a COA's stated expiry could still reach tier 4, one bad
 * extraction — the exact bug above, in miniature — would put it back on the
 * dashboard. The two ways out are both a human's own words: a `renewal_due_date`
 * somebody wrote (tier 1), or a `renewal_interval_months` set on that one
 * document (tier 5 is consulted first, inside `resolveRenewalPeriodMonths`).
 *
 * Every result carries the `rule` that produced it and a human `reason`, so a
 * caller can always answer "why does this say 2027?" without re-deriving the
 * ladder. A date whose provenance cannot be explained is a date a QA manager
 * is right not to trust.
 *
 * ---------------------------------------------------------------------------
 * ANCHOR — why only `effective_date`
 * ---------------------------------------------------------------------------
 * A period is applied to the date the document TOOK EFFECT. It is deliberately
 * not applied to an issue/print/test date, and not to the upload timestamp.
 * Most of the corpus is COAs, which are lot records that do not renew at all
 * but do carry printed dates; anchoring a default on any date we happen to
 * have would hand every one of them a manufactured expiry, put them on the
 * renewal dashboard, and mail somebody about them. A missing anchor is an
 * honest "we cannot date this", which is the same posture the spec engine
 * takes with `not_checked`.
 *
 * `keep_current` opts out of periods entirely: that renewal_type means "keep
 * the latest version on file, there is no cadence". Giving it a computed
 * cadence would contradict the record's own declaration.
 *
 * ---------------------------------------------------------------------------
 * PROPOSAL, NOT VERDICT
 * ---------------------------------------------------------------------------
 * At approval a human is holding the document and every input is present, so
 * this function's answer is shown to them PRE-FILLED and EDITABLE, with its
 * `reason` printed beside it, and what they confirm is written to
 * `documents.renewal_due_date` plus a frozen `renewal_snapshot`. That is the
 * same discipline as `limit_snapshot` in migration 0085: once a human has
 * judged something, later configuration changes must not silently re-judge it.
 * A reviewer who CLEARS the field is answering "this does not renew" — a real
 * answer, recorded as `renewal_decision = 'cleared'` (tier 2) and distinct from
 * a document nobody ever looked at, which has no decision at all.
 */

/** Rule 1: the default period for a document nobody has configured. */
export const ANNUAL_RENEWAL_MONTHS = 12;

/** Rule 2: the scheme-defined review window for a specification sheet. */
export const SPEC_SHEET_RENEWAL_MONTHS = 36;

/** Sanity bound on a stored period. 50 years is already absurd; 0 is a bug. */
export const MAX_RENEWAL_PERIOD_MONTHS = 600;

/**
 * Which rung of the ladder produced the answer. Returned on every result so a
 * caller (and eventually the UI) can explain itself.
 */
export type RenewalRule =
  /** The record's own canonical next-action date. */
  | 'document_due_date'
  /** The expiry printed on the document itself. Beats every default. */
  | 'document_expiry'
  /** A period set on this one document. */
  | 'document_interval'
  /** The document type's configured period (three years for spec sheets). */
  | 'document_type_default'
  /** Nobody configured anything: twelve months. */
  | 'system_default_annual'
  /**
   * This record has no renewal period at all. Three things reach it: a
   * `keep_current` renewal_type, a document type whose policy is `none` (a
   * COA), and a reviewer who cleared the field at approval. They are one rule
   * because they are one answer — "nothing is ever due for this" — and the
   * `reason` says which of the three said so.
   */
  | 'no_renewal_period'
  /** A period applies but there is no anchor date to count it from. */
  | 'unresolvable';

/**
 * Does a document of this TYPE renew, and on what cadence?
 * `document_types.renewal_policy` (migration 0097).
 *
 * WHY A WORD AND NOT A SENTINEL. Migration 0096 shipped
 * `document_types.renewal_interval_months` as nullable, where NULL means
 * "inherit the annual default". That column can express two states and needs to
 * express three, the third being "documents of this type do not renew at all".
 * The cheap options were both bad:
 *
 *   * `renewal_interval_months = 0` — a magic number. Nothing in the schema
 *     says 0 is special, `usablePeriod` already rejects it as a bug (which is
 *     the RIGHT reading of a stray 0), and the admin screen would have to
 *     render "0 months" as "never" forever.
 *   * A separate `renews` boolean — two columns that can disagree, so every
 *     reader has to decide which one wins when they do.
 *
 * So the policy is one column holding one of three words, and it is the
 * authority. `renewal_interval_months` is only consulted when the policy says
 * `period`, which means the pair can never contradict itself:
 *
 *   'inherit' — nobody has configured this type; the system annual default
 *               applies. The DEFAULT, so a type created by an older client or
 *               by a migration nobody has revisited behaves exactly as it did
 *               before 0097.
 *   'period'  — renews on `renewal_interval_months` (three years for a
 *               specification sheet).
 *   'none'    — does not renew. A per-lot Certificate of Analysis: superseded
 *               by the next lot's certificate, never overdue.
 */
export type TypeRenewalPolicy = 'inherit' | 'period' | 'none';

/** Every value the column may hold, for validation at the API edge. */
export const TYPE_RENEWAL_POLICIES: readonly TypeRenewalPolicy[] = [
  'inherit',
  'period',
  'none',
] as const;

/**
 * Read a stored/​submitted policy. Anything unrecognised — including NULL from
 * a query written before 0097 — is `inherit`, which is the pre-0097 behaviour.
 * Failing open to "no renewal" here would silently empty the dashboard; failing
 * open to "renews annually" is the state the system was already in.
 */
export function parseTypeRenewalPolicy(v: string | null | undefined): TypeRenewalPolicy {
  return v === 'period' || v === 'none' ? v : 'inherit';
}

/**
 * What a reviewer did with the proposal at approval time
 * (`documents.renewal_decision`, migration 0097). NULL — no decision — means
 * nobody has looked, which is NOT the same as `cleared`.
 */
export type RenewalDecision = 'accepted' | 'overridden' | 'cleared';

export interface RenewalPeriodInput {
  /** documents.renewal_type (migration 0077). */
  renewal_type: string | null;
  /** documents.renewal_due_date — the canonical next-action date. */
  renewal_due_date: string | null;
  /** documents.renewal_interval_months — a period set on this document. */
  renewal_interval_months: number | null;
  /**
   * documents.renewal_decision (0097) — what a human did with the proposal at
   * approval. Only `cleared` changes an answer here; `accepted`/`overridden`
   * both leave a `renewal_due_date` behind, which tier 1 reads.
   */
  renewal_decision: RenewalDecision | string | null;
  /**
   * document_types.renewal_policy — does this type renew at all (0097)?
   *
   * REQUIRED, not optional-with-a-default. The policy gates whether
   * `type_renewal_interval_months` is read at all, so a call site that forgot
   * it would silently drop a configured three-year spec-sheet period back to
   * annual. Making it required moves that mistake from a quiet wrong date to a
   * compile error. Pass `null` explicitly when there is no type.
   */
  type_renewal_policy: TypeRenewalPolicy | string | null;
  /** document_types.renewal_interval_months — the per-type period (0096). */
  type_renewal_interval_months: number | null;
  /**
   * primary_metadata.$.document_expires_on — the date THE DOCUMENT stops being
   * valid, as printed on it.
   *
   * NOT `primary_metadata.$.expiration_date`, which is the PRODUCT's shelf-life
   * DATE, and NOT `primary_metadata.$.shelf_life`, which is the same fact as a
   * PERIOD ("21 days") and would drop straight into the period tiers. Neither
   * is an input to this function. See the header block.
   */
  meta_document_expires_on: string | null;
  /** primary_metadata.$.effective_date — the anchor a period counts from. */
  meta_effective_date: string | null;
}

export interface ResolvedRenewal {
  /** Resolved next-action date (YYYY-MM-DD), or null when none is derivable. */
  due_date: string | null;
  /** Which rung of the ladder answered. */
  rule: RenewalRule;
  /**
   * The period that applied, in months. Populated even when `due_date` is
   * null (rule `unresolvable`) — "annual, but we have no date to count from"
   * is a more useful thing to show a reviewer than a bare blank.
   */
  period_months: number | null;
  /** The date a period was counted from, when one was. */
  anchor_date: string | null;
  /** One sentence a human can read. Never empty. */
  reason: string;
}

/** The subset of rules that come from a period rather than a stated date. */
type PeriodRule = 'document_interval' | 'document_type_default' | 'system_default_annual';

/**
 * What the period tiers concluded. Either a number of months and the rung that
 * supplied it, or the categorical "documents of this type do not renew".
 * Modelled as a union rather than `months: number | null` so a caller cannot
 * read the months without having first looked at the rule.
 */
export type RenewalPeriodResolution =
  | { months: number; rule: PeriodRule }
  | { months: null; rule: 'no_renewal_period' };

// ── date helpers ────────────────────────────────────────────────────────────

/** Strip any time component; empty/blank → null. */
export function dateOnly(v: string | null | undefined): string | null {
  const s = (v ?? '').trim();
  if (!s) return null;
  return s.slice(0, 10);
}

/** Add `months` to a YYYY-MM-DD date, clamping the day to the target month. */
export function addMonths(date: string, months: number): string | null {
  const d = dateOnly(date);
  if (!d) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  const day = Number(m[3]);
  const base = new Date(Date.UTC(y, mo, 1));
  base.setUTCMonth(base.getUTCMonth() + months);
  // Clamp day to last valid day of the resulting month.
  const lastDay = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 0)).getUTCDate();
  base.setUTCDate(Math.min(day, lastDay));
  return base.toISOString().slice(0, 10);
}

// ── period resolution ───────────────────────────────────────────────────────

/** A stored period is only usable if it is a positive whole number of months. */
function usablePeriod(months: number | null | undefined): number | null {
  if (months === null || months === undefined) return null;
  if (!Number.isFinite(months)) return null;
  const n = Math.trunc(months);
  if (n <= 0 || n > MAX_RENEWAL_PERIOD_MONTHS) return null;
  return n;
}

/**
 * Tiers 3-5: which PERIOD applies, ignoring any stated date. Exported because
 * the type-level setting is worth showing on its own ("this type renews every
 * 36 months") without needing a document in hand.
 */
export function resolveRenewalPeriodMonths(
  input: Pick<
    RenewalPeriodInput,
    'renewal_interval_months' | 'type_renewal_policy' | 'type_renewal_interval_months'
  >,
): RenewalPeriodResolution {
  // A period written on THIS document is the most specific statement anyone
  // has made, so it is read before the type's policy. That is also the escape
  // hatch: it is how a human opts one document of a non-renewing type back
  // into a cadence, without weakening the exclusion for the other 138.
  const own = usablePeriod(input.renewal_interval_months);
  if (own !== null) return { months: own, rule: 'document_interval' };

  const policy = parseTypeRenewalPolicy(input.type_renewal_policy);
  if (policy === 'none') return { months: null, rule: 'no_renewal_period' };

  // `period` is the only policy under which the months column means anything.
  // An unusable value there (0, negative, absurd) is a bug in the stored row,
  // not an instruction, so it falls through to annual rather than being obeyed.
  if (policy === 'period') {
    const byType = usablePeriod(input.type_renewal_interval_months);
    if (byType !== null) return { months: byType, rule: 'document_type_default' };
  }

  return { months: ANNUAL_RENEWAL_MONTHS, rule: 'system_default_annual' };
}

function describePeriod(months: number): string {
  if (months % 12 === 0) {
    const years = months / 12;
    return years === 1 ? 'one year' : `${years} years`;
  }
  return months === 1 ? 'one month' : `${months} months`;
}

function periodReason(rule: PeriodRule, months: number): string {
  switch (rule) {
    case 'document_interval':
      return `${describePeriod(months)}, the renewal period set on this document`;
    case 'document_type_default':
      return `${describePeriod(months)}, this document type's renewal period`;
    case 'system_default_annual':
      return `${describePeriod(months)}, the default when nothing else is set`;
  }
}

/** The shape every `no_renewal_period` answer takes; only the reason differs. */
function noRenewal(reason: string): ResolvedRenewal {
  return { due_date: null, rule: 'no_renewal_period', period_months: null, anchor_date: null, reason };
}

/**
 * THE precedence function. A human's own answer beats everything; a type that
 * does not renew is excluded outright; a stated document expiry beats every
 * default; after that the most specific configured period wins; annual is the
 * floor.
 */
export function resolveRenewalExpiry(input: RenewalPeriodInput): ResolvedRenewal {
  // Tier 1 — the record's own canonical date. Somebody (a human, or an
  // extractor a human approved) already answered this question.
  const canonical = dateOnly(input.renewal_due_date);
  if (canonical) {
    return {
      due_date: canonical,
      rule: 'document_due_date',
      period_months: null,
      anchor_date: null,
      reason: 'The renewal date recorded on this document.',
    };
  }

  // Tier 2 — a reviewer settled this at approval and the answer was "no date".
  //
  // KEYED ON THE DECISION EXISTING, NOT ON ITS VALUE. Any non-null decision
  // that gets this far has already failed tier 1, which means the human left
  // the field empty — whether they CLEARED a date we proposed, or ACCEPTED a
  // proposal that was itself "does not renew". Both are the same answer and
  // must produce the same result; branching on `=== 'cleared'` would let an
  // accepted no-renewal COA fall through to the annual default below, which is
  // the original bug wearing a hat. The stored value still distinguishes the
  // two for audit — see `renewal_snapshot`.
  //
  // This outranks every default below because it IS an answer, not an absence.
  // A document nobody has reviewed has no decision at all and falls through.
  if (input.renewal_decision) {
    return noRenewal(
      input.renewal_decision === 'cleared'
        ? 'A reviewer cleared the renewal date at approval: this document does not renew.'
        : 'A reviewer confirmed at approval that this document has no renewal date.',
    );
  }

  // The period tiers are resolved EARLY because their first job is not "how
  // long" but "at all": a document type with policy `none` — a COA — is
  // excluded categorically, before anything printed on the page is read. See
  // WHAT RENEWS AT ALL in the header for why that ordering is deliberate.
  const period = resolveRenewalPeriodMonths(input);

  // Tier 3 — the type does not renew.
  if (period.rule === 'no_renewal_period') {
    return noRenewal(
      'Documents of this type do not renew — each one is superseded by the next rather than re-collected on a cadence.',
    );
  }

  // Tier 4 — the expiry printed on the DOCUMENT (not the product's shelf life;
  // see the header). This is rule 3's override: a certificate that states its
  // own expiry expires then, whatever period its type carries. Above every
  // period tier on purpose, including a period set on this same document — a
  // period is a policy about documents of this shape, the printed date is a
  // fact about this one.
  const printed = dateOnly(input.meta_document_expires_on);
  if (printed) {
    return {
      due_date: printed,
      rule: 'document_expiry',
      period_months: null,
      anchor_date: null,
      reason: 'The expiry date stated on the document itself, which overrides any default period.',
    };
  }

  // `keep_current` declares that there IS no period. Honour it rather than
  // inventing a cadence for a record that says it has none. Below the printed
  // expiry, deliberately: "keep the latest version on file" is a statement
  // about our filing, and a document that prints a hard date still has one.
  if (input.renewal_type === 'keep_current') {
    return noRenewal('This document is kept current on file and has no renewal period.');
  }

  // Tiers 5-7 — a period, which needs something to count from.
  const anchor = dateOnly(input.meta_effective_date);
  if (!anchor) {
    return {
      due_date: null,
      rule: 'unresolvable',
      period_months: period.months,
      anchor_date: null,
      reason: `Would renew after ${periodReason(period.rule, period.months)}, but the document has no stated expiry and no effective date to count from.`,
    };
  }

  const due = addMonths(anchor, period.months);
  if (!due) {
    return {
      due_date: null,
      rule: 'unresolvable',
      period_months: period.months,
      anchor_date: null,
      reason: `Would renew after ${periodReason(period.rule, period.months)}, but the effective date could not be read.`,
    };
  }

  return {
    due_date: due,
    rule: period.rule,
    period_months: period.months,
    anchor_date: anchor,
    reason: `Effective ${anchor} plus ${periodReason(period.rule, period.months)}.`,
  };
}

// ── spec-sheet detection ────────────────────────────────────────────────────

/**
 * Does this document type look like a specification sheet (rule 2)?
 *
 * A NAME MATCH, DELIBERATELY AND REGRETTABLY. There is no better signal:
 * `document_types` rows are free text created per tenant by admins, the slug
 * is generated from the name, and nothing in the schema marks a type as "the
 * spec sheet one". So the match lives HERE, in one exported function, used in
 * exactly two places — the 0096 backfill (mirrored in SQL) and the moment a
 * new type is created — and never at read time. What a type renews at is the
 * STORED column: this heuristic only ever proposes a starting value that an
 * admin can see on the Document Types screen and change. A guess that writes
 * itself into a visible, editable setting is recoverable; a guess re-applied
 * silently on every read is not.
 */
export function looksLikeSpecSheetType(name: string): boolean {
  const n = name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  if (!n) return false;
  return (
    /\bspecification\b/.test(n) ||
    /\bspecs?\s+sheets?\b/.test(n) ||
    /\bproduct\s+specs?\b/.test(n)
  );
}

/**
 * Does this document type look like a Certificate of Analysis — a type whose
 * documents do not renew at all?
 *
 * THE SAME NAME MATCH, FOR THE SAME REASON. `document_types` carries no column
 * that says what KIND of document a type is: the row is `name`, `slug`,
 * `description`, some extraction toggles and a supplier. (`output_kind` does
 * exist and does distinguish coa/order/shipment — but it lives on
 * `processing_queue`, is set per ARRIVAL by the source that dispatched it, and
 * is not on the type at all, so it cannot answer this question.) The name is
 * genuinely the only signal, so the match lives here, in one exported function,
 * used in exactly two places — the 0097 backfill (mirrored in SQL) and the
 * moment a new type is created — and never at read time.
 *
 * NARROW ON PURPOSE. It matches the two things a COA type is ever called and
 * nothing near them. 'Certificate of Insurance' and 'Certification' must NOT
 * match: those renew, and a false positive here does not produce a wrong date,
 * it produces SILENCE — a certificate that lapses and never appears on the
 * dashboard. A missed alert is the expensive direction of this error, so the
 * pattern requires the analysis word, not merely the certificate word.
 */
export function looksLikeCoaType(name: string): boolean {
  const n = name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  if (!n) return false;
  return (
    /\bcoas?\b/.test(n) ||
    /\bc\s*of\s*a\b/.test(n) ||
    /\bcertificates?\s+of\s+analysis\b/.test(n) ||
    /\banalysis\s+certificates?\b/.test(n)
  );
}

/**
 * The renewal period a NEWLY CREATED document type starts life with.
 * Returns null for the annual case: a null column means "the system default
 * applies", which keeps the stored value meaningful (it is there because it
 * DIFFERS from annual) and lets the annual default move later without a
 * migration that rewrites every row.
 */
export function defaultRenewalMonthsForTypeName(name: string): number | null {
  return looksLikeSpecSheetType(name) ? SPEC_SHEET_RENEWAL_MONTHS : null;
}

/**
 * The renewal POLICY a newly created document type starts life with. Same
 * contract as the period above: a visible, editable starting value, proposed
 * once from the name and never re-derived on read.
 */
export function defaultRenewalPolicyForTypeName(name: string): TypeRenewalPolicy {
  if (looksLikeCoaType(name)) return 'none';
  if (looksLikeSpecSheetType(name)) return 'period';
  return 'inherit';
}

/**
 * The renewal POLICY and PERIOD a newly created document type starts life with,
 * as one pair.
 *
 * THIS IS THE ONE HELPER EVERY CREATE PATH CALLS. The two functions above are
 * the halves; calling them separately is how the halves drift apart, and they
 * cannot be allowed to: `parseTypeRenewalSetting` (functions/lib/registry.ts)
 * enforces the invariant that a non-NULL `renewal_interval_months` exists only
 * under a `period` policy, and a caller that reached for the months function
 * alone would write 36 months under `inherit`, where nothing reads it.
 *
 * It exists because the create paths had already drifted. `POST
 * /api/document-types` applied both defaults; the starter pack — which is how a
 * real tenant actually gets its 27 types — named neither column, so every row
 * it wrote took the migration defaults (`inherit` / NULL). The 0096 and 0097
 * backfills ran once, at migration time, against the rows that existed then, so
 * a tenant created afterwards got a Certificate of Analysis that renews
 * annually: the exact "mail every COA owner about a certificate that does not
 * renew" failure the renewal design exists to prevent.
 *
 * Still a PROPOSAL, not a verdict: it writes a starting value into a column an
 * admin can see and change on the Document Types screen, and it is never
 * re-derived at read time.
 */
export interface TypeRenewalDefault {
  policy: TypeRenewalPolicy;
  /** Only ever non-null under `policy === 'period'`. */
  interval_months: number | null;
}

export function defaultRenewalSettingForTypeName(name: string): TypeRenewalDefault {
  const policy = defaultRenewalPolicyForTypeName(name);
  return {
    policy,
    // The months column is read ONLY under 'period' (see resolveRenewalPeriodMonths),
    // so anything stored beside another policy would be a number nothing reads
    // and the screen would contradict itself.
    interval_months: policy === 'period' ? defaultRenewalMonthsForTypeName(name) : null,
  };
}

/**
 * Human label for a type's renewal setting. Takes the policy as well as the
 * months because the months alone cannot say "never" — which is the whole
 * reason `renewal_policy` exists.
 */
export function renewalPeriodLabel(
  months: number | null | undefined,
  policy?: TypeRenewalPolicy | string | null,
): string {
  if (parseTypeRenewalPolicy(policy) === 'none') return 'Does not renew';
  const usable = usablePeriod(months ?? null);
  if (usable === null) return 'Annual (default)';
  const d = describePeriod(usable);
  return d.charAt(0).toUpperCase() + d.slice(1);
}

/**
 * One short sentence naming the rule that produced a resolved renewal, for the
 * reviewer panel — "three years — spec sheet default", "does not renew".
 * Deliberately shorter than `ResolvedRenewal.reason`, which is the full
 * explanation; this is the chip beside the date field.
 */
export function renewalRuleLabel(resolved: ResolvedRenewal): string {
  switch (resolved.rule) {
    case 'document_due_date':
      return 'already recorded on this document';
    case 'document_expiry':
      return 'printed on the document';
    case 'document_interval':
      return `${describePeriod(resolved.period_months ?? ANNUAL_RENEWAL_MONTHS)} — set on this document`;
    case 'document_type_default':
      return `${describePeriod(resolved.period_months ?? ANNUAL_RENEWAL_MONTHS)} — this document type's default`;
    case 'system_default_annual':
      return 'one year — the default when nothing else is set';
    case 'no_renewal_period':
      return 'does not renew';
    case 'unresolvable':
      return 'no date to count from';
  }
}
