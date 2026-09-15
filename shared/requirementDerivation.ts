/**
 * Requirement DERIVATION — what a supplier owes, worked out from facts the
 * company already holds rather than guessed once for everybody.
 *
 * AJ Conner, 2026-09-14: the live tenant's suppliers all carry the same
 * invented set (21 suppliers x 6 required + 8 recommended). His minimum for
 * EVERY approved supplier is a certificate of insurance and a third-party food
 * safety certificate, plus claim paperwork where a claim is made and a spec
 * sheet for the products bought. Everything beyond that should follow from the
 * verified supplier list: which suppliers are approved, what kind of supplier
 * each is, what we buy from them, and what we claim about it.
 *
 * ONE RULE FUNCTION, WHATEVER THE DOOR. The spreadsheet import is "easy mode";
 * a webhook/API feed comes later. Both reach `deriveSupplierRequirements` with
 * the same input shape, so the answer a supplier gets cannot depend on how its
 * row arrived.
 *
 * PURE. No D1, no network, no clock. `functions/lib/supplier-list-import.ts`
 * loads the tenant's vocabulary and hands it in; the packet planner and the
 * import planner below decide WHAT TO WRITE against the rows that exist, and
 * are pure for the same reason: "a person's row always wins" is the rule most
 * worth testing, and it should not need a database to test it.
 *
 * THE RULES (exact):
 *   1. An approved supplier owes every `rules.baseline` item.            (baseline)
 *   2. It owes its category's packet from the tenant's starter pack --
 *      the packet's `requirements` as required, `recommends` as
 *      recommended. A category with no packet adds nothing.      (category_packet)
 *   3. For every claim made on a product bought from it (or on the
 *      supplier itself), it owes what the tenant's claim rules
 *      (`claim_type_requirements`) say that claim needs, at the
 *      rule's tier.                                                         (claim)
 *   4. For every product bought, it owes `rules.productSpecSheet`. (product_spec_sheet)
 *   5. A supplier marked not approved owes nothing by derivation.
 *   6. When several rules name one requirement, required beats recommended
 *      and every reason is kept.
 *   7. A requirement slug the tenant does not hold (or has deactivated) is
 *      REPORTED, never invented and never silently dropped.
 */

import type { SupplierCategory } from './supplierListTemplate';

export type DerivationTier = 'required' | 'recommended';

const TIER_RANK: Record<DerivationTier, number> = { required: 2, recommended: 1 };

export function strongerTier(a: DerivationTier, b: DerivationTier): DerivationTier {
  return TIER_RANK[a] >= TIER_RANK[b] ? a : b;
}

export interface SupplierListRules {
  /** What every approved supplier owes, whatever it sells us. */
  baseline: ReadonlyArray<{ slug: string; tier: DerivationTier }>;
  /** Category -> packet slug in the tenant's starter pack. null = no packet. */
  categoryPackets: Readonly<Record<SupplierCategory, string | null>>;
  /** Owed once per supplier when at least one product is bought from it. */
  productSpecSheet: { slug: string; tier: DerivationTier } | null;
}

/**
 * The rules as AJ stated them on 2026-09-14, mapped onto the fsqa pack's slugs.
 *
 *   certificate-of-insurance        "certificate of liability insurance"
 *   third-party-audit-certificate   "a third-party food safety certificate"
 *                                   (the pack's "3rd Party Audit CERTIFICATE";
 *                                   confirm with AJ that this is the item he
 *                                   means, not a separate GFSI certificate)
 *
 * Category packets: ingredient and chemical/sanitation map to the pack's own
 * packets. Co-packer uses the ingredient packet (a co-packer makes food we
 * sell, so HACCP, spec, micro and allergen paperwork apply) -- an assumption
 * pending AJ. Packaging and distributor have no packet in the pack, so they
 * get the baseline only; that is reported on the preview, not hidden.
 */
export const DEFAULT_SUPPLIER_LIST_RULES: SupplierListRules = {
  baseline: [
    { slug: 'certificate-of-insurance', tier: 'required' },
    { slug: 'third-party-audit-certificate', tier: 'required' },
  ],
  categoryPackets: {
    ingredient: 'ingredient-supplier',
    'chemical-sanitation': 'chemical-sanitation',
    'co-packer': 'ingredient-supplier',
    packaging: null,
    distributor: null,
  },
  productSpecSheet: { slug: 'spec-sheet', tier: 'required' },
};

export interface PacketDefinition {
  slug: string;
  name: string;
  requirements: readonly string[];
  recommends: readonly string[];
}

export interface ClaimRuleDefinition {
  claim_slug: string;
  requirement_slug: string;
  is_required: boolean;
}

export interface DerivationProductInput {
  /** How the product is named on the preview: "10042 Unsalted Butter 25kg". */
  label: string;
  /** Claim-type slugs, already matched against the tenant's claim types. */
  claims: readonly string[];
}

export interface DerivationSupplierInput {
  /** Supplier id, or a provisional key for a supplier a dry run would create. */
  key: string;
  name: string;
  approved: boolean;
  categories: readonly SupplierCategory[];
  products: readonly DerivationProductInput[];
  /** Claims written on a row with no product: applied to the supplier. */
  supplierClaims: readonly string[];
}

export type DerivationBasis =
  | { rule: 'baseline' }
  | { rule: 'category_packet'; category: SupplierCategory; packet: string }
  | { rule: 'claim'; claim: string; product: string | null }
  | { rule: 'product_spec_sheet'; products: string[] };

export interface DerivedRequirement {
  slug: string;
  tier: DerivationTier;
  basis: DerivationBasis[];
}

export type DerivationProblem =
  | { kind: 'unknown_requirement'; slug: string; because: string }
  | { kind: 'unknown_packet'; packet: string; category: SupplierCategory }
  | { kind: 'category_without_packet'; category: SupplierCategory };

export interface DerivationInput {
  suppliers: readonly DerivationSupplierInput[];
  rules: SupplierListRules;
  packets: readonly PacketDefinition[];
  claimRules: readonly ClaimRuleDefinition[];
  /** Active requirement slugs this tenant holds. */
  knownRequirementSlugs: ReadonlySet<string>;
}

export interface DerivationResult {
  /** supplier key -> what it owes, sorted required first then by slug. */
  bySupplier: Record<string, DerivedRequirement[]>;
  problems: DerivationProblem[];
}

export function describeBasis(b: DerivationBasis): string {
  switch (b.rule) {
    case 'baseline':
      return 'Every approved supplier';
    case 'category_packet':
      return `${b.category} supplier (${b.packet} packet)`;
    case 'claim':
      return b.product ? `"${b.claim}" claim on ${b.product}` : `"${b.claim}" claim`;
    case 'product_spec_sheet':
      return `Spec sheet for ${b.products.join(', ')}`;
  }
}

function problemKey(p: DerivationProblem): string {
  switch (p.kind) {
    case 'unknown_requirement':
      return `req:${p.slug}`;
    case 'unknown_packet':
      return `packet:${p.packet}`;
    case 'category_without_packet':
      return `cat:${p.category}`;
  }
}

export function deriveSupplierRequirements(input: DerivationInput): DerivationResult {
  const bySupplier: Record<string, DerivedRequirement[]> = {};
  const problems = new Map<string, DerivationProblem>();
  const report = (p: DerivationProblem) => {
    const k = problemKey(p);
    if (!problems.has(k)) problems.set(k, p);
  };
  const packets = new Map(input.packets.map((p) => [p.slug, p]));
  const claimRules = new Map<string, ClaimRuleDefinition[]>();
  for (const r of input.claimRules) {
    const list = claimRules.get(r.claim_slug) ?? [];
    list.push(r);
    claimRules.set(r.claim_slug, list);
  }

  for (const supplier of input.suppliers) {
    const owed = new Map<string, DerivedRequirement>();
    const owe = (slug: string, tier: DerivationTier, basis: DerivationBasis, because: string) => {
      if (!input.knownRequirementSlugs.has(slug)) {
        report({ kind: 'unknown_requirement', slug, because });
        return;
      }
      const cur = owed.get(slug);
      if (!cur) {
        owed.set(slug, { slug, tier, basis: [basis] });
        return;
      }
      cur.tier = strongerTier(cur.tier, tier);
      if (!cur.basis.some((x) => b2s(x) === b2s(basis))) cur.basis.push(basis);
    };

    if (!supplier.approved) {
      bySupplier[supplier.key] = [];
      continue;
    }

    // 1. baseline
    for (const item of input.rules.baseline) {
      owe(item.slug, item.tier, { rule: 'baseline' }, 'named by the baseline rule');
    }

    // 2. category packets
    for (const category of supplier.categories) {
      const packetSlug = input.rules.categoryPackets[category];
      if (!packetSlug) {
        report({ kind: 'category_without_packet', category });
        continue;
      }
      const packet = packets.get(packetSlug);
      if (!packet) {
        report({ kind: 'unknown_packet', packet: packetSlug, category });
        continue;
      }
      const basis: DerivationBasis = { rule: 'category_packet', category, packet: packet.slug };
      for (const slug of packet.requirements) owe(slug, 'required', basis, `named by the ${packet.slug} packet`);
      for (const slug of packet.recommends) owe(slug, 'recommended', basis, `named by the ${packet.slug} packet`);
    }

    // 3. claims
    const applyClaim = (claim: string, product: string | null) => {
      for (const rule of claimRules.get(claim) ?? []) {
        owe(
          rule.requirement_slug,
          rule.is_required ? 'required' : 'recommended',
          { rule: 'claim', claim, product },
          `named by the ${claim} claim rule`,
        );
      }
    };
    for (const product of supplier.products) {
      for (const claim of product.claims) applyClaim(claim, product.label);
    }
    for (const claim of supplier.supplierClaims) applyClaim(claim, null);

    // 4. spec sheet per product bought
    if (input.rules.productSpecSheet && supplier.products.length > 0) {
      const products = [...new Set(supplier.products.map((p) => p.label))];
      const { slug, tier } = input.rules.productSpecSheet;
      if (!input.knownRequirementSlugs.has(slug)) {
        report({ kind: 'unknown_requirement', slug, because: 'named by the product spec sheet rule' });
      } else {
        const cur = owed.get(slug);
        if (!cur) owed.set(slug, { slug, tier, basis: [{ rule: 'product_spec_sheet', products }] });
        else {
          cur.tier = strongerTier(cur.tier, tier);
          cur.basis.push({ rule: 'product_spec_sheet', products });
        }
      }
    }

    bySupplier[supplier.key] = sortDerived([...owed.values()]);
  }

  return { bySupplier, problems: [...problems.values()] };
}

function b2s(b: DerivationBasis): string {
  return JSON.stringify(b);
}

function sortDerived(rows: DerivedRequirement[]): DerivedRequirement[] {
  return rows.sort((a, b) => TIER_RANK[b.tier] - TIER_RANK[a.tier] || a.slug.localeCompare(b.slug));
}

// ═══════════════════════════════════════════════════════════════════════════
// Planning writes against what already exists
// ═══════════════════════════════════════════════════════════════════════════

/**
 * An existing applicability row, as the planners need it. `source` is 0102's
 * column: NULL = the unconfirmed bulk seed, 'human' / 'packet' = a person's
 * decision, 'derived' = the verified list (0111).
 */
export interface ExistingApplicability {
  id: string;
  supplier_id: string;
  requirement_slug: string;
  tier: DerivationTier;
  source: string | null;
  packet_slug?: string | null;
  review_flag?: string | null;
}

/** A person put it there: never overwritten, downgraded, flagged or removed by a producer. */
export function isPersonSet(source: string | null): boolean {
  return source === 'human' || source === 'packet';
}

export const NOT_ON_VERIFIED_LIST = 'not_on_verified_list';

export type DerivedChange =
  | { kind: 'add'; supplier_key: string; slug: string; tier: DerivationTier; basis: DerivationBasis[] }
  | {
      kind: 'adopt_unconfirmed';
      row_id: string;
      supplier_key: string;
      slug: string;
      from_tier: DerivationTier;
      tier: DerivationTier;
      basis: DerivationBasis[];
    }
  | {
      kind: 'refresh_derived';
      row_id: string;
      supplier_key: string;
      slug: string;
      from_tier: DerivationTier;
      tier: DerivationTier;
      basis: DerivationBasis[];
      was_flagged: boolean;
    }
  | {
      kind: 'hold_unconfirmed';
      row_id: string;
      supplier_key: string;
      slug: string;
      tier: DerivationTier;
      derived_tier: DerivationTier;
      basis: DerivationBasis[];
    }
  | {
      kind: 'keep_person';
      row_id: string;
      supplier_key: string;
      slug: string;
      source: string;
      tier: DerivationTier;
      derived_tier: DerivationTier;
    }
  | {
      kind: 'flag_unsupported';
      row_id: string;
      supplier_key: string;
      slug: string;
      tier: DerivationTier;
      already_flagged: boolean;
    };

/**
 * Turn a derivation into writes.
 *
 *   no row                -> add, source 'derived'
 *   NULL-source row       -> adopt: source 'derived', tier as derived (the guess now has a basis)
 *                            -- UNLESS that would LOWER its tier: then it is held, left unconfirmed
 *                            in the worklist with both tiers shown. An automatic producer never
 *                            quietly takes an item out of the gap count; a person decides.
 *   'derived' row         -> refresh basis + tier, clear any review flag
 *   'human'/'packet' row  -> keep, untouched (reported, with the tier the list implied)
 *   'derived' row the list no longer implies -> flag 'not_on_verified_list'; NEVER deleted
 *
 * The flag pass covers the WHOLE tenant: an import is the verified list, so a
 * derived row for a supplier that is no longer on it is exactly the row a
 * person needs to look at. Person-set and NULL rows are never flagged -- the
 * list says nothing about them.
 */
export function planDerivedChanges(
  derived: Readonly<Record<string, readonly DerivedRequirement[]>>,
  existing: readonly ExistingApplicability[],
): DerivedChange[] {
  const byPair = new Map<string, ExistingApplicability>();
  for (const row of existing) byPair.set(`${row.supplier_id} ${row.requirement_slug}`, row);

  const changes: DerivedChange[] = [];
  const supported = new Set<string>();

  for (const [supplierKey, list] of Object.entries(derived)) {
    for (const d of list) {
      const pair = `${supplierKey} ${d.slug}`;
      supported.add(pair);
      const row = byPair.get(pair);
      if (!row) {
        changes.push({ kind: 'add', supplier_key: supplierKey, slug: d.slug, tier: d.tier, basis: d.basis });
      } else if ((row.source === null || row.source === undefined) && TIER_RANK[row.tier] > TIER_RANK[d.tier]) {
        changes.push({
          kind: 'hold_unconfirmed',
          row_id: row.id,
          supplier_key: supplierKey,
          slug: d.slug,
          tier: row.tier,
          derived_tier: d.tier,
          basis: d.basis,
        });
      } else if (row.source === null || row.source === undefined) {
        changes.push({
          kind: 'adopt_unconfirmed',
          row_id: row.id,
          supplier_key: supplierKey,
          slug: d.slug,
          from_tier: row.tier,
          tier: d.tier,
          basis: d.basis,
        });
      } else if (row.source === 'derived') {
        changes.push({
          kind: 'refresh_derived',
          row_id: row.id,
          supplier_key: supplierKey,
          slug: d.slug,
          from_tier: row.tier,
          tier: d.tier,
          basis: d.basis,
          was_flagged: Boolean(row.review_flag),
        });
      } else {
        changes.push({
          kind: 'keep_person',
          row_id: row.id,
          supplier_key: supplierKey,
          slug: d.slug,
          source: row.source,
          tier: row.tier,
          derived_tier: d.tier,
        });
      }
    }
  }

  for (const row of existing) {
    if (row.source !== 'derived') continue;
    if (supported.has(`${row.supplier_id} ${row.requirement_slug}`)) continue;
    changes.push({
      kind: 'flag_unsupported',
      row_id: row.id,
      supplier_key: row.supplier_id,
      slug: row.requirement_slug,
      tier: row.tier,
      already_flagged: row.review_flag === NOT_ON_VERIFIED_LIST,
    });
  }

  return changes;
}

export interface DerivedChangeCounts {
  added: number;
  adopted_unconfirmed: number;
  refreshed: number;
  tier_changed: number;
  kept_person_set: number;
  held_unconfirmed: number;
  newly_flagged: number;
  still_flagged: number;
}

export function countDerivedChanges(changes: readonly DerivedChange[]): DerivedChangeCounts {
  const c: DerivedChangeCounts = {
    added: 0,
    adopted_unconfirmed: 0,
    refreshed: 0,
    tier_changed: 0,
    kept_person_set: 0,
    held_unconfirmed: 0,
    newly_flagged: 0,
    still_flagged: 0,
  };
  for (const ch of changes) {
    switch (ch.kind) {
      case 'add':
        c.added++;
        break;
      case 'adopt_unconfirmed':
        c.adopted_unconfirmed++;
        if (ch.from_tier !== ch.tier) c.tier_changed++;
        break;
      case 'refresh_derived':
        c.refreshed++;
        if (ch.from_tier !== ch.tier) c.tier_changed++;
        break;
      case 'keep_person':
        c.kept_person_set++;
        break;
      case 'hold_unconfirmed':
        c.held_unconfirmed++;
        break;
      case 'flag_unsupported':
        if (ch.already_flagged) c.still_flagged++;
        else c.newly_flagged++;
        break;
    }
  }
  return c;
}

// ─── Packets ────────────────────────────────────────────────────────────────

export type PacketChange =
  | { kind: 'add'; supplier_id: string; slug: string; tier: DerivationTier }
  | {
      kind: 'adopt_unconfirmed';
      row_id: string;
      supplier_id: string;
      slug: string;
      from_tier: DerivationTier;
      tier: DerivationTier;
    }
  | {
      kind: 'already_present';
      row_id: string;
      supplier_id: string;
      slug: string;
      source: string | null;
      tier: DerivationTier;
      packet_tier: DerivationTier;
    }
  | { kind: 'remove_unconfirmed'; row_id: string; supplier_id: string; slug: string; tier: DerivationTier };

/**
 * Applying a packet to named suppliers.
 *
 *   no row                 -> add, source 'packet'
 *   NULL-source row        -> adopt at the packet's tier (the unconfirmed seed
 *                             was nobody's decision; this is one)
 *   any other row          -> already present, untouched -- including a
 *                             'recommended' a person chose where the packet
 *                             says 'required'. Reported with both tiers.
 *   replaceUnconfirmed     -> also remove the supplier's NULL-source rows the
 *                             packet does not name (the worklist's "replace")
 *
 * Nothing a person set and nothing the verified list derived is ever changed.
 */
export function planPacketApply(input: {
  supplierIds: readonly string[];
  packet: PacketDefinition;
  existing: readonly ExistingApplicability[];
  knownRequirementSlugs: ReadonlySet<string>;
  replaceUnconfirmed?: boolean;
}): { changes: PacketChange[]; unknownRequirements: string[] } {
  const unknown: string[] = [];
  const wanted: Array<{ slug: string; tier: DerivationTier }> = [];
  for (const slug of input.packet.requirements) wanted.push({ slug, tier: 'required' });
  for (const slug of input.packet.recommends) {
    if (!input.packet.requirements.includes(slug)) wanted.push({ slug, tier: 'recommended' });
  }
  const known = wanted.filter((w) => {
    if (input.knownRequirementSlugs.has(w.slug)) return true;
    if (!unknown.includes(w.slug)) unknown.push(w.slug);
    return false;
  });

  const changes: PacketChange[] = [];
  for (const supplierId of input.supplierIds) {
    const rows = input.existing.filter((r) => r.supplier_id === supplierId);
    const bySlug = new Map(rows.map((r) => [r.requirement_slug, r]));
    const named = new Set(known.map((k) => k.slug));
    for (const w of known) {
      const row = bySlug.get(w.slug);
      if (!row) changes.push({ kind: 'add', supplier_id: supplierId, slug: w.slug, tier: w.tier });
      else if (row.source === null || row.source === undefined) {
        changes.push({
          kind: 'adopt_unconfirmed',
          row_id: row.id,
          supplier_id: supplierId,
          slug: w.slug,
          from_tier: row.tier,
          tier: w.tier,
        });
      } else {
        changes.push({
          kind: 'already_present',
          row_id: row.id,
          supplier_id: supplierId,
          slug: w.slug,
          source: row.source,
          tier: row.tier,
          packet_tier: w.tier,
        });
      }
    }
    if (input.replaceUnconfirmed) {
      for (const row of rows) {
        if ((row.source === null || row.source === undefined) && !named.has(row.requirement_slug)) {
          changes.push({
            kind: 'remove_unconfirmed',
            row_id: row.id,
            supplier_id: supplierId,
            slug: row.requirement_slug,
            tier: row.tier,
          });
        }
      }
    }
  }
  return { changes, unknownRequirements: unknown };
}
