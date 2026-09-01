/**
 * Requirement GAP detection — "what does this supplier still owe us?"
 *
 * WHY THIS FILE EXISTS, AND WHY IT IS PURE
 * ----------------------------------------
 * Migration 0080 gave a tenant a vocabulary of checklist line items
 * (`requirements`), a junction saying which documents CLOSE them
 * (`document_requirements`) and a config saying which claims OPEN them
 * (`claim_type_requirements`). Migration 0087 added the missing half:
 * `supplier_requirements`, which says a line item APPLIES to a supplier.
 *
 * A gap is the set difference between those halves:
 *
 *     ( requirements that APPLY to supplier S )          <- 0087 + claims
 *   MINUS
 *     ( requirements CLOSED by S's confirmed documents ) <- 0080
 *
 * That subtraction is the whole product claim, so it does not belong inline in
 * a route handler where the only way to exercise it is to stand up D1. Same
 * split as `shared/specCheck.ts` (pure engine) and
 * `functions/lib/spec-warnings.ts` (its D1 loader): this module takes rows and
 * returns a verdict, and `functions/lib/requirement-gaps.ts` is the only thing
 * that knows how to fetch those rows.
 *
 * PURE. No D1, no network, no clock.
 *
 * THE DEFAULT IS `required` ONLY — a deliberate client decision
 * ------------------------------------------------------------
 * `supplier_requirements.tier` has two values. Gap reports count `required`
 * and leave `recommended` out unless a caller opts in
 * (`includeRecommended: true`). This is a signal-quality decision, not a
 * shortcut: a report that flags everything gets muted, and a muted report is
 * strictly worse than no report at all, because people still believe it is
 * running. The `recommended` totals are still COMPUTED and returned — they are
 * simply not what `open` and `status` are derived from.
 *
 * THE FALSE-CLEAN FAILURE THIS FILE REFUSES TO COMMIT
 * ---------------------------------------------------
 * A supplier with no applicability configured has nothing to subtract, so the
 * arithmetic answer is "0 open". Rendering that as "satisfied" is exactly the
 * failure that makes a narrow-testing supplier look compliant: the number is
 * clean because nobody ever said what was owed. So `status` has a THIRD value,
 * `not_configured`, and it is never collapsed into `satisfied`. Likewise a
 * document nobody has classified cannot close anything, so it silently shrinks
 * the satisfied side; `documents.classification` (migration 0081) is carried
 * on every result and raises a caveat, so "0 open" and "nothing was ever
 * looked at" cannot read the same.
 */

import type { SupplierRequirementTier } from './types';

// ---------------------------------------------------------------------------
// Inputs — the shapes the D1 loader hands in
// ---------------------------------------------------------------------------

/** Where a requirement's applicability came from. */
export type GapOrigin = 'applicability' | 'claim';

/** The vocabulary fields every requirement carries into a gap result. */
export interface RequirementVocab {
  requirement_id: string;
  name: string;
  slug: string;
  checklist: string | null;
  sort_order: number;
}

/**
 * One `supplier_requirements` row for this supplier, with the requirement
 * vocabulary joined in. The configured left-hand side of the subtraction.
 */
export interface ApplicabilityRow extends RequirementVocab {
  tier: SupplierRequirementTier;
}

/**
 * A requirement made applicable by a CONFIRMED claim on one of this supplier's
 * documents, resolved through `claim_type_requirements`.
 *
 * `is_required` is that table's own advisory flag: 1 makes the requirement
 * mandatory (so it lands in the `required` tier), 0 is advisory (so it lands
 * in `recommended`). One row per (requirement, claim, document) so the report
 * can say WHY something is suddenly owed — "the spec sheet says Organic".
 */
export interface ClaimOpenedRow extends RequirementVocab {
  is_required: number;
  claim_type_id: string;
  claim_type_name: string;
  document_id: string;
  document_title: string;
}

/**
 * A CONFIRMED `document_requirements` link from one of this supplier's active
 * documents. Only `confirmed` closes anything — `suggested` is a machine
 * proposal nobody has ruled on and `rejected` is a human saying no. Counting
 * either as a closure would let the pipeline mark its own homework.
 */
export interface ClosureRow {
  requirement_id: string;
  document_id: string;
  document_title: string;
  confirmed_at: string | null;
}

/** Migration 0081 states, counted over this supplier's active documents. */
export interface ClassificationCounts {
  unclassified: number;
  needs_review: number;
  classified: number;
  unclassifiable: number;
}

export const EMPTY_CLASSIFICATION_COUNTS: ClassificationCounts = {
  unclassified: 0,
  needs_review: 0,
  classified: 0,
  unclassifiable: 0,
};

/** Everything the engine needs about ONE supplier. */
export interface SupplierGapInput {
  supplier_id: string;
  supplier_name: string;
  applicability: ApplicabilityRow[];
  claimOpened: ClaimOpenedRow[];
  closures: ClosureRow[];
  documentCount: number;
  classification: ClassificationCounts;
}

export interface GapOptions {
  /**
   * Include `recommended`-tier items in `open` and let them drive `status`.
   * OFF by default — see the header note on signal quality.
   */
  includeRecommended?: boolean;
}

/** The shipped default, named so callers and tests can assert on it. */
export const DEFAULT_GAP_OPTIONS: Required<GapOptions> = {
  includeRecommended: false,
};

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

/** Which claim, on which document, made a requirement newly applicable. */
export interface OpenedByClaim {
  claim_type_id: string;
  claim_type_name: string;
  document_id: string;
  document_title: string;
}

/** What closed a requirement, if anything did. */
export interface SatisfiedByDocument {
  document_id: string;
  document_title: string;
  confirmed_at: string | null;
}

/** One applicable requirement, judged. */
export interface GapRequirement extends RequirementVocab {
  tier: SupplierRequirementTier;
  /** 'applicability' (configured), 'claim' (triggered), or both. */
  origins: GapOrigin[];
  opened_by: OpenedByClaim[];
  satisfied: boolean;
  satisfied_by: SatisfiedByDocument[];
  /** One plain-language line, ready to render or paste into an email. */
  summary: string;
}

/**
 * Three values, and the third is the point.
 *
 *   not_configured  nothing applies to this supplier, so there is nothing to
 *                   subtract. NOT the same as compliant, and never rendered as
 *                   a pass.
 *   open            at least one counted requirement is unsatisfied.
 *   satisfied       everything counted is closed by a confirmed link.
 */
export type SupplierGapStatus = 'not_configured' | 'open' | 'satisfied';

export interface TierCounts {
  applicable: number;
  satisfied: number;
  open: number;
}

export interface SupplierGapCounts {
  required: TierCounts;
  recommended: TierCounts;
}

export type GapCaveatCode =
  | 'no_requirements_configured'
  | 'no_documents'
  | 'unclassified_documents'
  | 'recommended_excluded';

/**
 * A reason the numbers above might not mean what they appear to mean. Emitted
 * as data rather than prose so the UI can style it and a test can assert it.
 */
export interface GapCaveat {
  code: GapCaveatCode;
  message: string;
  count?: number;
}

export interface SupplierGap {
  supplier_id: string;
  supplier_name: string;
  status: SupplierGapStatus;
  /** True only when at least one `supplier_requirements` row exists. */
  configured: boolean;
  /** Which tiers `open` and `status` were derived from. Always explicit. */
  tiers_counted: SupplierRequirementTier[];
  counts: SupplierGapCounts;
  /** Every applicable requirement, BOTH tiers, satisfied flagged. */
  applicable: GapRequirement[];
  /** The actionable list: unsatisfied, narrowed to `tiers_counted`. */
  open: GapRequirement[];
  documents: {
    total: number;
    classification: ClassificationCounts;
  };
  caveats: GapCaveat[];
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

const EMPTY_TIER_COUNTS = (): TierCounts => ({ applicable: 0, satisfied: 0, open: 0 });

/** `required` outranks `recommended` when a requirement applies twice over. */
function strongerTier(
  a: SupplierRequirementTier,
  b: SupplierRequirementTier,
): SupplierRequirementTier {
  return a === 'required' || b === 'required' ? 'required' : 'recommended';
}

function tierFromClaimRow(row: ClaimOpenedRow): SupplierRequirementTier {
  return Number(row.is_required) === 0 ? 'recommended' : 'required';
}

/** Checklist grouping first, then the tenant's configured order, then name. */
function compareRequirements(a: GapRequirement, b: GapRequirement): number {
  const ca = a.checklist ?? '';
  const cb = b.checklist ?? '';
  if (ca !== cb) return ca < cb ? -1 : 1;
  if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order;
  return a.name.localeCompare(b.name);
}

/**
 * The one sentence a reviewer reads. Deliberately says WHY a requirement
 * applies when a claim opened it: "we need an Organic Certificate" is not
 * actionable, "the spec sheet claims Organic, so an Organic Certificate is
 * now owed" is.
 */
function summarize(item: GapRequirement): string {
  const tier = item.tier === 'required' ? 'required' : 'recommended';
  if (item.satisfied) {
    const n = item.satisfied_by.length;
    return `${item.name} (${tier}) — closed by ${n} confirmed document${n === 1 ? '' : 's'}`;
  }
  if (item.opened_by.length > 0) {
    const claims = [...new Set(item.opened_by.map((c) => c.claim_type_name))];
    return `${item.name} (${tier}) — open; triggered by the ${claims
      .map((c) => `"${c}"`)
      .join(', ')} claim${claims.length === 1 ? '' : 's'} on this supplier's documents`;
  }
  return `${item.name} (${tier}) — open; no confirmed document from this supplier closes it`;
}

/**
 * Compute the gap for ONE supplier.
 *
 * Total function: every branch returns a `SupplierGap`, and an input with no
 * rows at all yields `status: 'not_configured'` rather than a clean bill.
 */
export function computeSupplierGap(
  input: SupplierGapInput,
  options: GapOptions = {},
): SupplierGap {
  const includeRecommended =
    options.includeRecommended ?? DEFAULT_GAP_OPTIONS.includeRecommended;

  // --- Left-hand side: merge both origins into one applicable set. ---------
  const byId = new Map<string, GapRequirement>();

  const ensure = (vocab: RequirementVocab, tier: SupplierRequirementTier): GapRequirement => {
    const hit = byId.get(vocab.requirement_id);
    if (hit) {
      hit.tier = strongerTier(hit.tier, tier);
      return hit;
    }
    const created: GapRequirement = {
      requirement_id: vocab.requirement_id,
      name: vocab.name,
      slug: vocab.slug,
      checklist: vocab.checklist ?? null,
      sort_order: Number(vocab.sort_order ?? 0),
      tier,
      origins: [],
      opened_by: [],
      satisfied: false,
      satisfied_by: [],
      summary: '',
    };
    byId.set(vocab.requirement_id, created);
    return created;
  };

  for (const row of input.applicability) {
    const item = ensure(row, row.tier);
    if (!item.origins.includes('applicability')) item.origins.push('applicability');
  }

  for (const row of input.claimOpened) {
    const item = ensure(row, tierFromClaimRow(row));
    if (!item.origins.includes('claim')) item.origins.push('claim');
    const dup = item.opened_by.some(
      (c) => c.claim_type_id === row.claim_type_id && c.document_id === row.document_id,
    );
    if (!dup) {
      item.opened_by.push({
        claim_type_id: row.claim_type_id,
        claim_type_name: row.claim_type_name,
        document_id: row.document_id,
        document_title: row.document_title,
      });
    }
  }

  // --- Right-hand side: subtract confirmed closures. -----------------------
  // Closures for requirements that do NOT apply are ignored rather than
  // credited: a document closing something nobody asked for is not a gap being
  // filled, and counting it would let satisfied exceed applicable.
  for (const closure of input.closures) {
    const item = byId.get(closure.requirement_id);
    if (!item) continue;
    const dup = item.satisfied_by.some((d) => d.document_id === closure.document_id);
    if (dup) continue;
    item.satisfied = true;
    item.satisfied_by.push({
      document_id: closure.document_id,
      document_title: closure.document_title,
      confirmed_at: closure.confirmed_at ?? null,
    });
  }

  const applicable = [...byId.values()].sort(compareRequirements);
  for (const item of applicable) item.summary = summarize(item);

  // --- Counts. Both tiers are always counted; only the counted tiers drive
  //     `open` and `status`. ------------------------------------------------
  const counts: SupplierGapCounts = {
    required: EMPTY_TIER_COUNTS(),
    recommended: EMPTY_TIER_COUNTS(),
  };
  for (const item of applicable) {
    const bucket = counts[item.tier];
    bucket.applicable += 1;
    if (item.satisfied) bucket.satisfied += 1;
    else bucket.open += 1;
  }

  const tiersCounted: SupplierRequirementTier[] = includeRecommended
    ? ['required', 'recommended']
    : ['required'];

  const open = applicable.filter((i) => !i.satisfied && tiersCounted.includes(i.tier));

  // --- Status. `not_configured` is decided by what APPLIES, not by what is
  //     counted: a supplier whose only applicability is a recommended row has
  //     been configured, and reporting it as unconfigured would be its own
  //     lie. ------------------------------------------------------------------
  const status: SupplierGapStatus =
    applicable.length === 0 ? 'not_configured' : open.length > 0 ? 'open' : 'satisfied';

  const configured = input.applicability.length > 0;

  // --- Caveats: every reason a clean number might not be a clean supplier. --
  const caveats: GapCaveat[] = [];

  if (!configured) {
    caveats.push({
      code: 'no_requirements_configured',
      message:
        applicable.length === 0
          ? 'No requirements have been attached to this supplier, so nothing is being checked. This is not the same as compliant.'
          : 'No requirements are attached to this supplier; everything listed became applicable only because a confirmed claim triggered it.',
    });
  }

  if (input.documentCount === 0) {
    caveats.push({
      code: 'no_documents',
      message: 'This supplier has no active documents, so nothing can close a requirement.',
    });
  }

  const unreviewed = input.classification.unclassified + input.classification.needs_review;
  if (unreviewed > 0) {
    caveats.push({
      code: 'unclassified_documents',
      count: unreviewed,
      message: `${unreviewed} of this supplier's documents ${
        unreviewed === 1 ? 'has' : 'have'
      } not been classified, so ${
        unreviewed === 1 ? 'it' : 'they'
      } cannot close anything yet. Open counts may be overstated.`,
    });
  }

  if (!includeRecommended && counts.recommended.open > 0) {
    caveats.push({
      code: 'recommended_excluded',
      count: counts.recommended.open,
      message: `${counts.recommended.open} recommended item${
        counts.recommended.open === 1 ? ' is' : 's are'
      } also open but excluded from the counts by default.`,
    });
  }

  return {
    supplier_id: input.supplier_id,
    supplier_name: input.supplier_name,
    status,
    configured,
    tiers_counted: tiersCounted,
    counts,
    applicable,
    open,
    documents: {
      total: input.documentCount,
      classification: { ...input.classification },
    },
    caveats,
  };
}

/** Roll several supplier gaps up for a list view. */
export interface GapRollup {
  suppliers: number;
  not_configured: number;
  open: number;
  satisfied: number;
  open_requirements: number;
  unclassified_documents: number;
}

export function rollupSupplierGaps(gaps: SupplierGap[]): GapRollup {
  return gaps.reduce<GapRollup>(
    (acc, g) => {
      acc.suppliers += 1;
      if (g.status === 'not_configured') acc.not_configured += 1;
      else if (g.status === 'open') acc.open += 1;
      else acc.satisfied += 1;
      acc.open_requirements += g.open.length;
      acc.unclassified_documents +=
        g.documents.classification.unclassified + g.documents.classification.needs_review;
      return acc;
    },
    {
      suppliers: 0,
      not_configured: 0,
      open: 0,
      satisfied: 0,
      open_requirements: 0,
      unclassified_documents: 0,
    },
  );
}

// ---------------------------------------------------------------------------
// API response shapes
// ---------------------------------------------------------------------------

export interface SupplierGapListResponse {
  gaps: SupplierGap[];
  rollup: GapRollup;
  /** Echoed back so a client can never misread which tiers the numbers cover. */
  tiers_counted: SupplierRequirementTier[];
  include_recommended: boolean;
  total: number;
  limit: number;
  offset: number;
}

export interface SupplierGapGetResponse {
  gap: SupplierGap;
  tiers_counted: SupplierRequirementTier[];
  include_recommended: boolean;
}
