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
 *
 * SCOPE (migration 0123): ONCE PER SUPPLIER, PER PRODUCT, PER LOT
 * ---------------------------------------------------------------
 * `requirements.scope` says what a requirement is owed per
 * (`shared/requirementScope.ts`). A `supplier` requirement is judged exactly
 * as before. A `product` requirement attached to S is owed by every ACTIVE
 * product of S (minus `product_requirements` exemptions, plus its `add` rows),
 * and a (requirement, product) pair is closed only by a confirmed document
 * LINKED to that product through `document_products`:
 *
 *   - a confirmed document linked to NO product closes NOTHING. It is listed
 *     as `unattributed`, never read as "covers every product" — that fallback
 *     would be the false-clean this file exists to refuse;
 *   - zero active products is OPEN (`gap_reason: 'no_products'`), never a
 *     vacuous pass;
 *   - a `lot` requirement is stored but not yet evaluated per lot: it is
 *     judged once per supplier (today's rule) and a caveat says so.
 *
 * THE PRODUCT AMBER IS GATED. A supplier with no product-scope requirement
 * (and no product `add` row) keeps today's output byte for byte, apart from
 * the new `products` array, whose entries then say `not_checked`. Otherwise
 * every supplier in every tenant would turn amber the day this shipped — the
 * flat-screen failure. Once product scope is in use for a supplier, a product
 * with nothing applying to it is `not_configured`, and the supplier cannot
 * read `satisfied` while one exists: it reads `products_not_configured`.
 */

import type { SupplierRequirementTier } from './types';
import { expiredOnArrival } from './expiredOnArrival';
import type { ExpiredOnArrival } from './expiredOnArrival';
import { normalizeRequirementScope, type RequirementScope } from './requirementScope';

// ---------------------------------------------------------------------------
// Inputs — the shapes the D1 loader hands in
// ---------------------------------------------------------------------------

/**
 * Where a requirement's applicability came from. `product` = a
 * `product_requirements` add row (0123) made it owed by one product.
 */
export type GapOrigin = 'applicability' | 'claim' | 'product';

/** The vocabulary fields every requirement carries into a gap result. */
export interface RequirementVocab {
  requirement_id: string;
  name: string;
  slug: string;
  checklist: string | null;
  sort_order: number;
  /**
   * `requirements.scope` (0123). Absent / unknown = 'supplier'. Input only:
   * a supplier-scope result does not echo it, so pre-0123 output is unchanged.
   */
  scope?: RequirementScope | string | null;
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
  /**
   * `document_claims.subject_type` / `subject_id` and `claim_types.subject_grain`.
   * Read only for a PRODUCT-scope requirement: a claim about one product opens
   * it for that product only. Absent = today's behaviour (supplier-wide).
   */
  subject_type?: string | null;
  subject_id?: string | null;
  subject_grain?: string | null;
}

/**
 * One ACTIVE product of the supplier — linked through `product_suppliers` or
 * the legacy `products.supplier_id`, `products.active = 1`, and not marked
 * no-longer-supplied. The subject set of a product-scope requirement.
 */
export interface ProductSubject {
  product_id: string;
  name: string;
  /** `product_suppliers.source` (0123); NULL for a pre-0123 or legacy-only link. */
  source: string | null;
  /** True when the product has at least one CONFIRMED `product_identifiers` row. */
  identified: boolean;
  /** A person declared this product owes nothing per product (0123). */
  nothing_owed: { reason: string; at: string | null; by: string | null } | null;
}

/** A product linked to the supplier that is NOT checked, and why. Never dropped silently. */
export interface ExcludedProduct {
  product_id: string;
  name: string;
  reason: 'inactive' | 'discontinued';
}

/** One `product_requirements` row (0123) with the requirement vocabulary joined. */
export interface ProductOverrideRow extends RequirementVocab {
  product_id: string;
  mode: 'add' | 'exempt';
  tier: SupplierRequirementTier;
  reason: string | null;
}

/** One `document_products` row for this supplier's active documents. */
export interface ProductLinkRow {
  document_id: string;
  product_id: string;
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
  /**
   * The document's own printed expiry (`primary_metadata.document_expires_on`)
   * and the day it arrived (`documents.arrived_at`, else `created_at`). Carried
   * so a certificate already expired on arrival does NOT close anything (rules
   * table G4). Optional: a loader that does not pass them gets today's answer.
   */
  expires_on?: string | null;
  arrived_at?: string | null;
  created_at?: string | null;
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
  /** Active products of the supplier (0123). Absent = none known. */
  products?: ProductSubject[];
  /** Linked but not checked (inactive / no longer supplied) — a caveat, never silent. */
  excludedProducts?: ExcludedProduct[];
  /** `product_requirements` rows for this supplier. */
  productOverrides?: ProductOverrideRow[];
  /** `document_products` rows for this supplier's active documents. */
  productLinks?: ProductLinkRow[];
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

/**
 * A confirmed link that was NOT counted as closing the requirement, and why.
 * Only one reason today (G4); a union so a second one cannot be a boolean.
 */
export interface NotCountedDocument extends SatisfiedByDocument {
  reason: 'expired_on_arrival';
  expired_on_arrival: ExpiredOnArrival;
}

/** One applicable requirement, judged. */
export interface GapRequirement extends RequirementVocab {
  tier: SupplierRequirementTier;
  /** 'applicability' (configured), 'claim' (triggered), or both. */
  origins: GapOrigin[];
  opened_by: OpenedByClaim[];
  satisfied: boolean;
  satisfied_by: SatisfiedByDocument[];
  /**
   * Confirmed documents offered for this requirement that do not close it —
   * today, only certificates that were already expired when they arrived (G4).
   * Listed, never dropped: "you sent it, and it was dead on arrival" is the
   * thing to say to the supplier.
   */
  not_counted: NotCountedDocument[];
  /**
   * Why an OPEN requirement is open when something was offered for it. Null
   * when it is satisfied, or when nothing was offered at all.
   *
   *   expired_on_arrival  the only offers were dead on arrival (G4).
   *   no_products         product scope, and the supplier has no active
   *                       product to judge it against (0123) — open, never
   *                       a vacuous pass.
   *   unattributed        product scope, and a confirmed document exists but
   *                       names no product, so it closes nothing (0123).
   */
  gap_reason: GapReason | null;
  /** One plain-language line, ready to render or paste into an email. */
  summary: string;
  // --- Present only when the requirement is NOT supplier-scope (0123). -----
  scope?: RequirementScope;
  /** Product scope: how many products owe it / how many are closed. */
  subjects_total?: number;
  subjects_satisfied?: number;
  /** Product scope: the products still owing it. */
  open_subjects?: GapSubject[];
  /** Product scope: products exempted from it, with the reason recorded. */
  exempt_subjects?: GapExemptSubject[];
  /** Product scope: confirmed documents that name no product and so close nothing. */
  unattributed?: SatisfiedByDocument[];
  /** Lot scope: stored, not yet judged per lot — judged once per supplier. */
  lot_evaluation?: 'supplier_level';
}

export type GapReason = 'expired_on_arrival' | 'no_products' | 'unattributed';

export interface GapSubject {
  product_id: string;
  name: string;
}

export interface GapExemptSubject extends GapSubject {
  reason: string | null;
}

/**
 * Four values. The third and fourth are the point.
 *
 *   not_configured           nothing applies to this supplier, so there is
 *                            nothing to subtract. NOT the same as compliant,
 *                            and never rendered as a pass.
 *   open                     at least one counted requirement is unsatisfied.
 *   products_not_configured  (0123) everything counted is closed, but product
 *                            scope is in use for this supplier and at least
 *                            one active product has nothing applying to it.
 *                            Amber, never green.
 *   satisfied                everything counted is closed by a confirmed link.
 *
 * Precedence: not_configured > open > products_not_configured > satisfied.
 */
export type SupplierGapStatus = 'not_configured' | 'open' | 'products_not_configured' | 'satisfied';

/**
 * One product's own state (0123).
 *
 *   not_checked     product scope is not in use for this supplier (no
 *                   product-scope requirement attached), so nothing is
 *                   judged per product. Neutral — the gating rule.
 *   not_configured  product scope IS in use, and nothing applies to this
 *                   product and nobody declared it owes nothing. Amber.
 *   open            at least one counted per-product requirement is open.
 *   satisfied       everything counted is closed — or a person declared it
 *                   owes nothing, with a reason (`nothing_owed`).
 */
export type ProductGapStatus = 'not_checked' | 'not_configured' | 'open' | 'satisfied';

/** One per-product requirement, judged for one product. */
export interface GapProductRequirement {
  requirement_id: string;
  name: string;
  tier: SupplierRequirementTier;
  /** Why it is owed by this product: the supplier attachment, an add row, or a product claim. */
  origin: 'supplier' | 'product' | 'claim';
  satisfied: boolean;
  satisfied_by: SatisfiedByDocument[];
}

export interface ProductGap {
  product_id: string;
  name: string;
  status: ProductGapStatus;
  source: string | null;
  /**
   * Created from a certificate's product name and never confirmed by an
   * identifier — may be a second name for one of the tenant's own SKUs.
   */
  possible_duplicate: boolean;
  nothing_owed: { reason: string; at: string | null; by: string | null } | null;
  requirements: GapProductRequirement[];
  exempt: GapExemptRequirement[];
  /** Open per-product requirements in the counted tiers. */
  open: number;
}

export interface GapExemptRequirement {
  requirement_id: string;
  name: string;
  reason: string | null;
}

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
  | 'recommended_excluded'
  | 'expired_on_arrival'
  // --- 0123 requirement scope. Emitted only once a supplier uses the scope. ---
  | 'products_not_configured'
  | 'products_excluded'
  | 'possible_duplicate_products'
  | 'no_products'
  | 'unattributed_documents'
  | 'lot_scope_not_evaluated'
  | 'facility_claim_supplier_wide'
  | 'claim_missing_subject';

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
  /**
   * Every ACTIVE product of the supplier and its own state (0123). Entries say
   * `not_checked` while no product-scope requirement applies to the supplier.
   */
  products: ProductGap[];
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
  if (item.scope === 'product') return summarizeProductScope(item);
  const tier = item.tier === 'required' ? 'required' : 'recommended';
  // Lot scope is judged once per supplier until per-lot checking ships, and
  // the sentence says so rather than reading as a per-lot verdict.
  const label = item.scope === 'lot' ? `${tier}, per lot` : tier;
  const lotNote =
    item.scope === 'lot'
      ? ' (per-lot checking has not shipped; judged once for this supplier)'
      : '';
  if (item.satisfied) {
    const n = item.satisfied_by.length;
    return `${item.name} (${label}) — closed by ${n} confirmed document${n === 1 ? '' : 's'}${lotNote}`;
  }
  if (item.gap_reason === 'expired_on_arrival') {
    const f = item.not_counted[0].expired_on_arrival;
    return `${item.name} (${label}) — open; expired on arrival: ${item.not_counted[0].document_title} expired ${f.expires_on}, before it arrived on ${f.arrived_on}${lotNote}`;
  }
  if (item.opened_by.length > 0) {
    const claims = [...new Set(item.opened_by.map((c) => c.claim_type_name))];
    return `${item.name} (${label}) — open; triggered by the ${claims
      .map((c) => `"${c}"`)
      .join(', ')} claim${claims.length === 1 ? '' : 's'} on this supplier's documents${lotNote}`;
  }
  return `${item.name} (${label}) — open; no confirmed document from this supplier closes it${lotNote}`;
}

function nameList(names: string[], max = 3): string {
  if (names.length <= max) return names.join(', ');
  return `${names.slice(0, max).join(', ')} and ${names.length - max} more`;
}

/** "Specification Sheet (required, per product) — 9 of 12 products; open for …" */
function summarizeProductScope(item: GapRequirement): string {
  const tier = item.tier === 'required' ? 'required' : 'recommended';
  const head = `${item.name} (${tier}, per product)`;
  const total = item.subjects_total ?? 0;
  const done = item.subjects_satisfied ?? 0;
  const unattributed = item.unattributed?.length ?? 0;
  const unattributedNote =
    unattributed > 0
      ? `; ${unattributed} confirmed document${unattributed === 1 ? ' names' : 's name'} no product and ${
          unattributed === 1 ? 'closes' : 'close'
        } nothing until someone says which products ${unattributed === 1 ? 'it covers' : 'they cover'}`
      : '';
  if (total === 0) {
    return `${head} — open; this supplier has no active products to check it against${unattributedNote}`;
  }
  if (item.satisfied) {
    return `${head} — ${done} of ${total} product${total === 1 ? '' : 's'}; every product is closed by a confirmed document`;
  }
  const open = (item.open_subjects ?? []).map((s) => s.name);
  const expired =
    item.gap_reason === 'expired_on_arrival'
      ? `; ${item.not_counted[0].document_title} expired before it arrived and does not count`
      : '';
  return `${head} — ${done} of ${total} product${total === 1 ? '' : 's'}; open for ${nameList(open)}${expired}${unattributedNote}`;
}

type SubjectOrigin = GapProductRequirement['origin'];

/** Working state for one product-scope requirement while the engine runs. */
interface ProductScopeWork {
  /** Applies to every active product (attached to the supplier, or a supplier-wide claim). */
  wide: boolean;
  wideTier: SupplierRequirementTier | null;
  /** Explicit per-product subjects: add rows and product-subject claims. */
  explicit: Map<string, { tier: SupplierRequirementTier; origin: SubjectOrigin }>;
  exempt: Map<string, string | null>;
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

  const activeProducts = input.products ?? [];
  const activeById = new Map(activeProducts.map((p) => [p.product_id, p]));

  // --- Left-hand side: merge both origins into one applicable set. ---------
  const byId = new Map<string, GapRequirement>();
  const scopeOf = new Map<string, RequirementScope>();
  const productWork = new Map<string, ProductScopeWork>();
  const workFor = (requirementId: string): ProductScopeWork => {
    let w = productWork.get(requirementId);
    if (!w) {
      w = { wide: false, wideTier: null, explicit: new Map(), exempt: new Map() };
      productWork.set(requirementId, w);
    }
    return w;
  };

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
      not_counted: [],
      gap_reason: null,
      summary: '',
    };
    byId.set(vocab.requirement_id, created);
    scopeOf.set(vocab.requirement_id, normalizeRequirementScope(vocab.scope));
    return created;
  };

  let facilityClaims = 0;
  let claimsMissingSubject = 0;

  for (const row of input.applicability) {
    const item = ensure(row, row.tier);
    if (!item.origins.includes('applicability')) item.origins.push('applicability');
    if (scopeOf.get(row.requirement_id) === 'product') {
      const w = workFor(row.requirement_id);
      w.wide = true;
      w.wideTier = w.wideTier ? strongerTier(w.wideTier, row.tier) : row.tier;
    }
  }

  for (const row of input.claimOpened) {
    const tier = tierFromClaimRow(row);
    const item = ensure(row, tier);
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
    // Claim subject hook (design §5). Only a PRODUCT-scope requirement reads
    // the subject: closure follows the requirement's scope, so an organic
    // certificate (supplier scope) still closes once.
    if (scopeOf.get(row.requirement_id) === 'product') {
      const w = workFor(row.requirement_id);
      if (row.subject_type === 'product' && row.subject_id) {
        const prev = w.explicit.get(row.subject_id);
        w.explicit.set(row.subject_id, {
          tier: prev ? strongerTier(prev.tier, tier) : tier,
          origin: prev?.origin ?? 'claim',
        });
      } else {
        w.wide = true;
        w.wideTier = w.wideTier ? strongerTier(w.wideTier, tier) : tier;
        if (row.subject_type === 'facility') facilityClaims += 1;
        if (row.subject_grain === 'product') claimsMissingSubject += 1;
      }
    }
  }

  // Per-product overrides. Read ONLY for a product-scope requirement: a row
  // left behind after someone changed the requirement's scope is inert rather
  // than silently re-scoping it.
  for (const row of input.productOverrides ?? []) {
    const scope = scopeOf.get(row.requirement_id) ?? normalizeRequirementScope(row.scope);
    if (scope !== 'product') continue;
    if (row.mode === 'add') {
      if (!activeById.has(row.product_id)) continue; // inactive/discontinued: in the caveat
      const item = ensure(row, row.tier);
      if (!item.origins.includes('product')) item.origins.push('product');
      const w = workFor(row.requirement_id);
      const prev = w.explicit.get(row.product_id);
      w.explicit.set(row.product_id, {
        tier: prev ? strongerTier(prev.tier, row.tier) : row.tier,
        origin: 'product',
      });
    } else {
      workFor(row.requirement_id).exempt.set(row.product_id, row.reason ?? null);
    }
  }

  // --- The subject set of every product-scope requirement. -----------------
  // wide: every active product, minus exemptions, minus products a person
  // declared owe nothing per product. Then the explicit adds / product claims.
  const subjectsOf = new Map<
    string,
    Map<string, { tier: SupplierRequirementTier; origin: SubjectOrigin }>
  >();
  for (const [requirementId, w] of productWork) {
    if (!byId.has(requirementId)) continue;
    const subjects = new Map<string, { tier: SupplierRequirementTier; origin: SubjectOrigin }>();
    if (w.wide && w.wideTier) {
      for (const p of activeProducts) {
        if (w.exempt.has(p.product_id) || p.nothing_owed) continue;
        subjects.set(p.product_id, { tier: w.wideTier, origin: 'supplier' });
      }
    }
    for (const [productId, e] of w.explicit) {
      if (!activeById.has(productId) || w.exempt.has(productId)) continue;
      const prev = subjects.get(productId);
      subjects.set(productId, {
        tier: prev ? strongerTier(prev.tier, e.tier) : e.tier,
        origin: prev?.origin ?? e.origin,
      });
    }
    subjectsOf.set(requirementId, subjects);
  }

  // --- Right-hand side: subtract confirmed closures. -----------------------
  // Closures for requirements that do NOT apply are ignored rather than
  // credited: a document closing something nobody asked for is not a gap being
  // filled, and counting it would let satisfied exceed applicable.
  //
  // A certificate already expired when it arrived closes NOTHING (G4). It is
  // kept on the item as `not_counted`, so the gap can say what was sent and
  // why it did not count, rather than looking as if the supplier sent nothing.
  //
  // Product scope: a closure counts for the products its document is LINKED
  // to (document_products), and a document linked to none closes nothing.
  const docProducts = new Map<string, Set<string>>();
  for (const l of input.productLinks ?? []) {
    const set = docProducts.get(l.document_id) ?? new Set<string>();
    set.add(l.product_id);
    docProducts.set(l.document_id, set);
  }
  /** requirement -> product -> documents closing that pair */
  const closedPairs = new Map<string, Map<string, SatisfiedByDocument[]>>();

  for (const closure of input.closures) {
    const item = byId.get(closure.requirement_id);
    if (!item) continue;
    const dup =
      item.satisfied_by.some((d) => d.document_id === closure.document_id) ||
      item.not_counted.some((d) => d.document_id === closure.document_id) ||
      (item.unattributed ?? []).some((d) => d.document_id === closure.document_id);
    if (dup) continue;
    const dead = expiredOnArrival({
      expires_on: closure.expires_on,
      arrived_at: closure.arrived_at,
      created_at: closure.created_at,
    });
    if (dead) {
      item.not_counted.push({
        document_id: closure.document_id,
        document_title: closure.document_title,
        confirmed_at: closure.confirmed_at ?? null,
        reason: 'expired_on_arrival',
        expired_on_arrival: dead,
      });
      continue;
    }
    const doc: SatisfiedByDocument = {
      document_id: closure.document_id,
      document_title: closure.document_title,
      confirmed_at: closure.confirmed_at ?? null,
    };
    if (scopeOf.get(closure.requirement_id) === 'product') {
      const linked = docProducts.get(closure.document_id);
      if (!linked || linked.size === 0) {
        // Never "covers every product": that fallback is the false-clean.
        (item.unattributed ??= []).push(doc);
        continue;
      }
      const subjects = subjectsOf.get(closure.requirement_id);
      let closedAny = false;
      for (const productId of linked) {
        if (!subjects?.has(productId)) continue;
        closedAny = true;
        const perReq = closedPairs.get(closure.requirement_id) ?? new Map<string, SatisfiedByDocument[]>();
        const list = perReq.get(productId) ?? [];
        list.push(doc);
        perReq.set(productId, list);
        closedPairs.set(closure.requirement_id, perReq);
      }
      if (closedAny) item.satisfied_by.push(doc);
      continue;
    }
    item.satisfied = true;
    item.satisfied_by.push(doc);
  }

  const productName = (id: string): string => activeById.get(id)?.name ?? id;

  const applicable = [...byId.values()].sort(compareRequirements);
  for (const item of applicable) {
    const scope = scopeOf.get(item.requirement_id) ?? 'supplier';
    if (scope === 'product') {
      const subjects = subjectsOf.get(item.requirement_id) ?? new Map();
      const closed = closedPairs.get(item.requirement_id) ?? new Map();
      const openSubjects: GapSubject[] = [];
      let done = 0;
      for (const productId of subjects.keys()) {
        if (closed.has(productId)) done += 1;
        else openSubjects.push({ product_id: productId, name: productName(productId) });
      }
      openSubjects.sort((a, b) => a.name.localeCompare(b.name));
      const exemptMap = productWork.get(item.requirement_id)?.exempt ?? new Map<string, string | null>();
      const exempt: GapExemptSubject[] = [...exemptMap.entries()]
        .filter(([productId]) => activeById.has(productId))
        .map(([productId, reason]) => ({ product_id: productId, name: productName(productId), reason }))
        .sort((a, b) => a.name.localeCompare(b.name));
      item.scope = 'product';
      item.subjects_total = subjects.size;
      item.subjects_satisfied = done;
      item.open_subjects = openSubjects;
      item.exempt_subjects = exempt;
      item.unattributed = item.unattributed ?? [];
      item.satisfied = subjects.size > 0 && openSubjects.length === 0;
      item.gap_reason = item.satisfied
        ? null
        : subjects.size === 0
          ? 'no_products'
          : item.not_counted.length > 0
            ? 'expired_on_arrival'
            : item.unattributed.length > 0
              ? 'unattributed'
              : null;
    } else {
      if (scope === 'lot') {
        item.scope = 'lot';
        item.lot_evaluation = 'supplier_level';
      }
      item.gap_reason = !item.satisfied && item.not_counted.length > 0 ? 'expired_on_arrival' : null;
    }
    item.summary = summarize(item);
  }

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

  // --- Per-product view (0123). Gated: only once a product-scope requirement
  //     applies to this supplier does any product get judged. -------------
  const productScopeInUse = subjectsOf.size > 0;
  const products: ProductGap[] = activeProducts.map((p) => {
    const possibleDuplicate = p.source === 'certificate' && !p.identified;
    if (!productScopeInUse) {
      return {
        product_id: p.product_id,
        name: p.name,
        status: 'not_checked',
        source: p.source,
        possible_duplicate: possibleDuplicate,
        nothing_owed: p.nothing_owed,
        requirements: [],
        exempt: [],
        open: 0,
      };
    }
    const requirements: GapProductRequirement[] = [];
    const exempt: GapExemptRequirement[] = [];
    for (const item of applicable) {
      const subjects = subjectsOf.get(item.requirement_id);
      if (!subjects) continue;
      const exemptMap = productWork.get(item.requirement_id)?.exempt;
      if (exemptMap?.has(p.product_id)) {
        exempt.push({
          requirement_id: item.requirement_id,
          name: item.name,
          reason: exemptMap.get(p.product_id) ?? null,
        });
        continue;
      }
      const s = subjects.get(p.product_id);
      if (!s) continue;
      const closedBy = closedPairs.get(item.requirement_id)?.get(p.product_id) ?? [];
      requirements.push({
        requirement_id: item.requirement_id,
        name: item.name,
        tier: s.tier,
        origin: s.origin,
        satisfied: closedBy.length > 0,
        satisfied_by: closedBy,
      });
    }
    const openCount = requirements.filter(
      (r) => !r.satisfied && tiersCounted.includes(r.tier),
    ).length;
    const status: ProductGapStatus =
      requirements.length === 0
        ? p.nothing_owed
          ? 'satisfied'
          : 'not_configured'
        : openCount > 0
          ? 'open'
          : 'satisfied';
    return {
      product_id: p.product_id,
      name: p.name,
      status,
      source: p.source,
      possible_duplicate: possibleDuplicate,
      nothing_owed: p.nothing_owed,
      requirements,
      exempt,
      open: openCount,
    };
  });
  products.sort((a, b) => a.name.localeCompare(b.name));
  const productsNotConfigured = products.filter((p) => p.status === 'not_configured');

  // --- Status. `not_configured` is decided by what APPLIES, not by what is
  //     counted: a supplier whose only applicability is a recommended row has
  //     been configured, and reporting it as unconfigured would be its own
  //     lie. Then the product amber, below `open` and above `satisfied`. ----
  const baseStatus: SupplierGapStatus =
    applicable.length === 0 ? 'not_configured' : open.length > 0 ? 'open' : 'satisfied';
  const status: SupplierGapStatus =
    baseStatus === 'satisfied' && productsNotConfigured.length > 0
      ? 'products_not_configured'
      : baseStatus;

  // A product `add` row is a person configuring this supplier, just as a
  // supplier_requirements row is.
  const configured =
    input.applicability.length > 0 || applicable.some((i) => i.origins.includes('product'));

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

  const deadOnArrival = open.filter((i) => i.gap_reason === 'expired_on_arrival').length;
  if (deadOnArrival > 0) {
    caveats.push({
      code: 'expired_on_arrival',
      count: deadOnArrival,
      message: `${deadOnArrival} open requirement${deadOnArrival === 1 ? ' was' : 's were'} answered with a certificate that had already expired when it arrived. ${
        deadOnArrival === 1 ? 'It does' : 'They do'
      } not count; ask the supplier for a current one.`,
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

  // --- 0123 caveats. Each fires only when the scope it describes is in use,
  //     so a tenant still entirely on supplier scope sees none of them. -----
  if (productScopeInUse) {
    if (productsNotConfigured.length > 0) {
      const n = productsNotConfigured.length;
      caveats.push({
        code: 'products_not_configured',
        count: n,
        message: `${n} active product${n === 1 ? ' has' : 's have'} nothing set up: ${nameList(
          productsNotConfigured.map((p) => p.name),
          5,
        )}. No per-product requirement applies and nobody declared ${
          n === 1 ? 'it owes' : 'they owe'
        } nothing, so ${n === 1 ? 'it is' : 'they are'} not checked. This is not the same as compliant.`,
      });
    }
    const excluded = input.excludedProducts ?? [];
    if (excluded.length > 0) {
      const n = excluded.length;
      caveats.push({
        code: 'products_excluded',
        count: n,
        message: `${n} product${n === 1 ? '' : 's'} linked to ${input.supplier_name} ${
          n === 1 ? 'is' : 'are'
        } not checked: ${nameList(
          excluded.map(
            (p) => `${p.name} (${p.reason === 'inactive' ? 'inactive' : 'no longer supplied'})`,
          ),
          5,
        )}.`,
      });
    }
    const dupes = products.filter((p) => p.possible_duplicate);
    if (dupes.length > 0) {
      const n = dupes.length;
      caveats.push({
        code: 'possible_duplicate_products',
        count: n,
        message: `${n} product${n === 1 ? ' was' : 's were'} created from a certificate's product name and ${
          n === 1 ? 'has' : 'have'
        } no confirmed identifier, so ${
          n === 1 ? 'it' : 'each'
        } may duplicate one of your own SKUs and count as a second obligation: ${nameList(
          dupes.map((p) => p.name),
          5,
        )}.`,
      });
    }
    const noProducts = applicable.filter((i) => i.gap_reason === 'no_products');
    if (noProducts.length > 0) {
      caveats.push({
        code: 'no_products',
        count: noProducts.length,
        message: `${nameList(noProducts.map((i) => i.name))} ${
          noProducts.length === 1 ? 'is' : 'are'
        } owed per product, and this supplier has no active products, so ${
          noProducts.length === 1 ? 'it stays' : 'they stay'
        } open. Link the products this supplier ships.`,
      });
    }
    const unattributedDocs = new Map<string, string>();
    for (const item of applicable) {
      for (const d of item.unattributed ?? []) unattributedDocs.set(d.document_id, d.document_title);
    }
    if (unattributedDocs.size > 0) {
      const n = unattributedDocs.size;
      caveats.push({
        code: 'unattributed_documents',
        count: n,
        message: `${n} confirmed document${n === 1 ? ' closes' : 's close'} a per-product requirement but ${
          n === 1 ? 'is' : 'are'
        } linked to no product, so ${n === 1 ? 'it closes' : 'they close'} nothing: ${nameList(
          [...unattributedDocs.values()],
          5,
        )}. Say which products ${n === 1 ? 'it covers' : 'they cover'}.`,
      });
    }
    if (facilityClaims > 0) {
      caveats.push({
        code: 'facility_claim_supplier_wide',
        count: facilityClaims,
        message:
          'A claim made about a facility opened a per-product requirement. Facilities are not modelled yet, so it is applied to every active product of this supplier.',
      });
    }
    if (claimsMissingSubject > 0) {
      caveats.push({
        code: 'claim_missing_subject',
        count: claimsMissingSubject,
        message: `${claimsMissingSubject} product-level claim${
          claimsMissingSubject === 1 ? ' does' : 's do'
        } not say which product ${
          claimsMissingSubject === 1 ? 'it is' : 'they are'
        } about, so the requirement ${
          claimsMissingSubject === 1 ? 'it opens is' : 'they open is'
        } applied to every active product.`,
      });
    }
  }

  const lotScoped = applicable.filter((i) => i.scope === 'lot');
  if (lotScoped.length > 0) {
    caveats.push({
      code: 'lot_scope_not_evaluated',
      count: lotScoped.length,
      message: `${nameList(lotScoped.map((i) => i.name))} ${
        lotScoped.length === 1 ? 'is' : 'are'
      } set per lot. Per-lot checking has not shipped yet, so ${
        lotScoped.length === 1 ? 'it is' : 'they are'
      } judged once for this supplier: any confirmed document counts, whichever lot it covers.`,
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
    products,
  };
}

/** Roll several supplier gaps up for a list view. */
export interface GapRollup {
  suppliers: number;
  not_configured: number;
  open: number;
  /** 0123: closed at supplier level, but an active product has nothing set up. */
  products_not_configured: number;
  satisfied: number;
  open_requirements: number;
  unclassified_documents: number;
}

export function rollupSupplierGaps(gaps: SupplierGap[]): GapRollup {
  return gaps.reduce<GapRollup>(
    (acc, g) => {
      acc.suppliers += 1;
      switch (g.status) {
        case 'not_configured':
          acc.not_configured += 1;
          break;
        case 'open':
          acc.open += 1;
          break;
        case 'products_not_configured':
          acc.products_not_configured += 1;
          break;
        case 'satisfied':
          acc.satisfied += 1;
          break;
        default: {
          const exhaustive: never = g.status;
          throw new Error(`unknown gap status ${String(exhaustive)}`);
        }
      }
      acc.open_requirements += g.open.length;
      acc.unclassified_documents +=
        g.documents.classification.unclassified + g.documents.classification.needs_review;
      return acc;
    },
    {
      suppliers: 0,
      not_configured: 0,
      open: 0,
      products_not_configured: 0,
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
