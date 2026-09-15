/**
 * The requirement derivation rules (shared/requirementDerivation.ts) and the
 * two planners that turn them into writes.
 *
 * The properties that matter, in AJ's terms (2026-09-14): every approved
 * supplier owes the baseline; a category brings its packet; a claim brings its
 * paperwork; a product brings a spec sheet; and a person's row always wins. A
 * supplier that drops off the verified list is flagged, never deleted.
 */

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_SUPPLIER_LIST_RULES,
  countDerivedChanges,
  deriveSupplierRequirements,
  describeBasis,
  planDerivedChanges,
  planPacketApply,
  type DerivationSupplierInput,
  type ExistingApplicability,
  type PacketDefinition,
} from '../../shared/requirementDerivation';

const PACKETS: PacketDefinition[] = [
  {
    slug: 'ingredient-supplier',
    name: 'Ingredient Supplier',
    requirements: ['spec-sheet', 'micro-limits', 'allergen-matrix'],
    recommends: ['shelf-life'],
  },
  {
    slug: 'chemical-sanitation',
    name: 'Chemical / Sanitation Supplier',
    requirements: ['sds-on-file', 'spec-sheet', 'letter-of-guarantee'],
    recommends: ['product-label'],
  },
];

const CLAIM_RULES = [
  { claim_slug: 'kosher', requirement_slug: 'kosher-certificate', is_required: true },
  { claim_slug: 'halal', requirement_slug: 'halal-certificate', is_required: true },
  { claim_slug: 'rbst-free', requirement_slug: 'letter-of-guarantee', is_required: true },
  { claim_slug: 'made-in-usa', requirement_slug: 'country-of-origin', is_required: false },
];

const KNOWN = new Set([
  'certificate-of-insurance',
  'third-party-audit-certificate',
  'spec-sheet',
  'micro-limits',
  'allergen-matrix',
  'shelf-life',
  'sds-on-file',
  'letter-of-guarantee',
  'product-label',
  'kosher-certificate',
  'halal-certificate',
  'country-of-origin',
]);

function supplier(over: Partial<DerivationSupplierInput>): DerivationSupplierInput {
  return {
    key: 'sup_1',
    name: 'Acme',
    approved: true,
    categories: [],
    products: [],
    supplierClaims: [],
    ...over,
  };
}

function derive(suppliers: DerivationSupplierInput[], known = KNOWN) {
  return deriveSupplierRequirements({
    suppliers,
    rules: DEFAULT_SUPPLIER_LIST_RULES,
    packets: PACKETS,
    claimRules: CLAIM_RULES,
    knownRequirementSlugs: known,
  });
}

const slugs = (rows: Array<{ slug: string }>) => rows.map((r) => r.slug).sort();

describe('deriveSupplierRequirements', () => {
  it('gives every approved supplier the baseline (COI + third-party food safety certificate), required', () => {
    const { bySupplier } = derive([supplier({ categories: ['distributor'] })]);
    expect(bySupplier.sup_1).toEqual([
      { slug: 'certificate-of-insurance', tier: 'required', basis: [{ rule: 'baseline' }] },
      { slug: 'third-party-audit-certificate', tier: 'required', basis: [{ rule: 'baseline' }] },
    ]);
  });

  it('adds the category packet: requirements required, recommends recommended', () => {
    const { bySupplier } = derive([supplier({ categories: ['ingredient'] })]);
    const byslug = Object.fromEntries(bySupplier.sup_1.map((r) => [r.slug, r.tier]));
    expect(byslug['micro-limits']).toBe('required');
    expect(byslug['allergen-matrix']).toBe('required');
    expect(byslug['shelf-life']).toBe('recommended');
  });

  it('chemical/sanitation gets its own packet, not the ingredient one', () => {
    const { bySupplier } = derive([supplier({ categories: ['chemical-sanitation'] })]);
    expect(slugs(bySupplier.sup_1)).toEqual(
      ['certificate-of-insurance', 'letter-of-guarantee', 'product-label', 'sds-on-file', 'spec-sheet', 'third-party-audit-certificate'].sort(),
    );
    expect(bySupplier.sup_1.map((r) => r.slug)).not.toContain('micro-limits');
  });

  it('reports a category with no packet instead of inventing one', () => {
    const { bySupplier, problems } = derive([supplier({ categories: ['packaging'] })]);
    expect(slugs(bySupplier.sup_1)).toEqual(['certificate-of-insurance', 'third-party-audit-certificate']);
    expect(problems).toContainEqual({ kind: 'category_without_packet', category: 'packaging' });
  });

  it('turns claims on products bought into the claim rules\' requirements, at the rule tier', () => {
    const { bySupplier } = derive([
      supplier({
        categories: ['distributor'],
        products: [
          { label: '810004 Whole Milk', claims: ['kosher', 'halal'] },
          { label: '810010 2% Milk', claims: ['kosher', 'made-in-usa'] },
        ],
      }),
    ]);
    const rows = Object.fromEntries(bySupplier.sup_1.map((r) => [r.slug, r]));
    expect(rows['kosher-certificate'].tier).toBe('required');
    expect(rows['kosher-certificate'].basis).toEqual([
      { rule: 'claim', claim: 'kosher', product: '810004 Whole Milk' },
      { rule: 'claim', claim: 'kosher', product: '810010 2% Milk' },
    ]);
    expect(rows['halal-certificate'].tier).toBe('required');
    expect(rows['country-of-origin'].tier).toBe('recommended');
  });

  it('applies claims written without a product to the supplier', () => {
    const { bySupplier } = derive([supplier({ supplierClaims: ['kosher'] })]);
    const k = bySupplier.sup_1.find((r) => r.slug === 'kosher-certificate')!;
    expect(k.basis).toEqual([{ rule: 'claim', claim: 'kosher', product: null }]);
    expect(describeBasis(k.basis[0])).toBe('"kosher" claim');
  });

  it('requires a spec sheet when products are bought, naming every product, and not otherwise', () => {
    const withProducts = derive([
      supplier({ products: [{ label: '0801 Butter Bag', claims: [] }, { label: '10286 Butter Tote', claims: [] }] }),
    ]);
    const spec = withProducts.bySupplier.sup_1.find((r) => r.slug === 'spec-sheet')!;
    expect(spec.tier).toBe('required');
    expect(spec.basis).toEqual([{ rule: 'product_spec_sheet', products: ['0801 Butter Bag', '10286 Butter Tote'] }]);

    const without = derive([supplier({ categories: ['distributor'] })]);
    expect(without.bySupplier.sup_1.map((r) => r.slug)).not.toContain('spec-sheet');
  });

  it('merges reasons and lets required beat recommended', () => {
    // rbst-free (required letter-of-guarantee) + chemical packet (required) +
    // a recommended claim rule for the same item would still be required.
    const { bySupplier } = derive([
      supplier({ categories: ['chemical-sanitation'], products: [{ label: 'Sanitizer', claims: ['rbst-free'] }] }),
    ]);
    const log = bySupplier.sup_1.find((r) => r.slug === 'letter-of-guarantee')!;
    expect(log.tier).toBe('required');
    expect(log.basis.map((b) => b.rule).sort()).toEqual(['category_packet', 'claim']);
    const spec = bySupplier.sup_1.find((r) => r.slug === 'spec-sheet')!;
    expect(spec.basis.map((b) => b.rule).sort()).toEqual(['category_packet', 'product_spec_sheet']);
  });

  it('derives nothing for a supplier marked not approved', () => {
    const { bySupplier } = derive([supplier({ approved: false, categories: ['ingredient'], products: [{ label: 'x', claims: ['kosher'] }] })]);
    expect(bySupplier.sup_1).toEqual([]);
  });

  it('reports a requirement the tenant does not hold rather than inventing it', () => {
    const known = new Set([...KNOWN].filter((s) => s !== 'third-party-audit-certificate'));
    const { bySupplier, problems } = derive([supplier({})], known);
    expect(slugs(bySupplier.sup_1)).toEqual(['certificate-of-insurance']);
    expect(problems).toEqual([
      { kind: 'unknown_requirement', slug: 'third-party-audit-certificate', because: 'named by the baseline rule' },
    ]);
  });

  it('reports a category packet the pack does not define', () => {
    const res = deriveSupplierRequirements({
      suppliers: [supplier({ categories: ['ingredient'] })],
      rules: DEFAULT_SUPPLIER_LIST_RULES,
      packets: [],
      claimRules: [],
      knownRequirementSlugs: KNOWN,
    });
    expect(res.problems).toContainEqual({ kind: 'unknown_packet', packet: 'ingredient-supplier', category: 'ingredient' });
  });
});

function existing(over: Partial<ExistingApplicability>): ExistingApplicability {
  return { id: 'row', supplier_id: 'sup_1', requirement_slug: 'spec-sheet', tier: 'required', source: null, review_flag: null, ...over };
}

describe('planDerivedChanges', () => {
  const derived = {
    sup_1: [
      { slug: 'certificate-of-insurance', tier: 'required' as const, basis: [{ rule: 'baseline' as const }] },
      { slug: 'spec-sheet', tier: 'required' as const, basis: [{ rule: 'product_spec_sheet' as const, products: ['x'] }] },
      { slug: 'shelf-life', tier: 'recommended' as const, basis: [{ rule: 'baseline' as const }] },
      { slug: 'haccp-plan', tier: 'required' as const, basis: [{ rule: 'baseline' as const }] },
    ],
  };

  it('adds new rows, adopts unconfirmed seed rows, refreshes derived rows, and never touches a person\'s row', () => {
    const changes = planDerivedChanges(derived, [
      existing({ id: 'r_seed', requirement_slug: 'spec-sheet', tier: 'recommended', source: null }),
      existing({ id: 'r_derived', requirement_slug: 'shelf-life', tier: 'required', source: 'derived', review_flag: 'not_on_verified_list' }),
      existing({ id: 'r_human', requirement_slug: 'haccp-plan', tier: 'recommended', source: 'human' }),
    ]);
    expect(changes).toEqual([
      { kind: 'add', supplier_key: 'sup_1', slug: 'certificate-of-insurance', tier: 'required', basis: [{ rule: 'baseline' }] },
      {
        kind: 'adopt_unconfirmed',
        row_id: 'r_seed',
        supplier_key: 'sup_1',
        slug: 'spec-sheet',
        from_tier: 'recommended',
        tier: 'required',
        basis: [{ rule: 'product_spec_sheet', products: ['x'] }],
      },
      {
        kind: 'refresh_derived',
        row_id: 'r_derived',
        supplier_key: 'sup_1',
        slug: 'shelf-life',
        from_tier: 'required',
        tier: 'recommended',
        basis: [{ rule: 'baseline' }],
        was_flagged: true,
      },
      {
        kind: 'keep_person',
        row_id: 'r_human',
        supplier_key: 'sup_1',
        slug: 'haccp-plan',
        source: 'human',
        tier: 'recommended',
        derived_tier: 'required',
      },
    ]);
  });

  it('a packet row is a person\'s row too', () => {
    const changes = planDerivedChanges(
      { sup_1: [{ slug: 'spec-sheet', tier: 'required', basis: [] }] },
      [existing({ id: 'r_packet', source: 'packet', tier: 'recommended', packet_slug: 'ingredient-supplier' })],
    );
    expect(changes).toEqual([
      expect.objectContaining({ kind: 'keep_person', row_id: 'r_packet', tier: 'recommended', derived_tier: 'required' }),
    ]);
  });

  it('re-import flags derived rows the list no longer implies — including suppliers dropped from the list — and deletes nothing', () => {
    const changes = planDerivedChanges(
      { sup_1: [{ slug: 'certificate-of-insurance', tier: 'required', basis: [] }] },
      [
        existing({ id: 'kept', requirement_slug: 'certificate-of-insurance', source: 'derived' }),
        existing({ id: 'gone', requirement_slug: 'kosher-certificate', source: 'derived' }),
        existing({ id: 'dropped_supplier', supplier_id: 'sup_2', requirement_slug: 'spec-sheet', source: 'derived' }),
        existing({ id: 'already', supplier_id: 'sup_2', requirement_slug: 'sds-on-file', source: 'derived', review_flag: 'not_on_verified_list' }),
        existing({ id: 'human_elsewhere', supplier_id: 'sup_2', requirement_slug: 'w9-on-file', source: 'human' }),
        existing({ id: 'seed_elsewhere', supplier_id: 'sup_2', requirement_slug: 'w9-on-file', source: null }),
      ],
    );
    const flags = changes.filter((c) => c.kind === 'flag_unsupported');
    expect(flags.map((f) => [f.row_id, (f as { already_flagged: boolean }).already_flagged])).toEqual([
      ['gone', false],
      ['dropped_supplier', false],
      ['already', true],
    ]);
    // No change kind deletes anything, and person/seed rows the list says
    // nothing about are not mentioned at all.
    expect(changes.map((c) => c.kind)).not.toContain('remove');
    expect(changes.some((c) => 'row_id' in c && (c.row_id === 'human_elsewhere' || c.row_id === 'seed_elsewhere'))).toBe(false);
    expect(countDerivedChanges(changes)).toMatchObject({ refreshed: 1, newly_flagged: 2, still_flagged: 1 });
  });

  it('is idempotent: planning against its own result changes no tier and adds nothing', () => {
    const first = planDerivedChanges(derived, []);
    const afterApply: ExistingApplicability[] = first.map((c, i) => ({
      id: `r${i}`,
      supplier_id: 'sup_1',
      requirement_slug: c.slug,
      tier: (c as { tier: 'required' | 'recommended' }).tier,
      source: 'derived',
      review_flag: null,
    }));
    const second = countDerivedChanges(planDerivedChanges(derived, afterApply));
    expect(second).toEqual({
      added: 0,
      adopted_unconfirmed: 0,
      refreshed: 4,
      tier_changed: 0,
      kept_person_set: 0,
      newly_flagged: 0,
      still_flagged: 0,
    });
  });
});

describe('planPacketApply', () => {
  const packet = PACKETS[0];

  it('adds missing rows, adopts unconfirmed ones at the packet tier, and leaves every other row alone', () => {
    const { changes, unknownRequirements } = planPacketApply({
      supplierIds: ['sup_1'],
      packet,
      knownRequirementSlugs: KNOWN,
      existing: [
        existing({ id: 'seed', requirement_slug: 'micro-limits', tier: 'recommended', source: null }),
        existing({ id: 'human', requirement_slug: 'allergen-matrix', tier: 'recommended', source: 'human' }),
        existing({ id: 'derived', requirement_slug: 'shelf-life', tier: 'required', source: 'derived' }),
        existing({ id: 'other_seed', requirement_slug: 'w9-on-file', tier: 'required', source: null }),
      ],
    });
    expect(unknownRequirements).toEqual([]);
    expect(changes).toEqual([
      { kind: 'add', supplier_id: 'sup_1', slug: 'spec-sheet', tier: 'required' },
      { kind: 'adopt_unconfirmed', row_id: 'seed', supplier_id: 'sup_1', slug: 'micro-limits', from_tier: 'recommended', tier: 'required' },
      {
        kind: 'already_present',
        row_id: 'human',
        supplier_id: 'sup_1',
        slug: 'allergen-matrix',
        source: 'human',
        tier: 'recommended',
        packet_tier: 'required',
      },
      {
        kind: 'already_present',
        row_id: 'derived',
        supplier_id: 'sup_1',
        slug: 'shelf-life',
        source: 'derived',
        tier: 'required',
        packet_tier: 'recommended',
      },
    ]);
  });

  it('replace_unconfirmed removes only the supplier\'s unconfirmed rows the packet does not name', () => {
    const { changes } = planPacketApply({
      supplierIds: ['sup_1'],
      packet,
      knownRequirementSlugs: KNOWN,
      replaceUnconfirmed: true,
      existing: [
        existing({ id: 'other_seed', requirement_slug: 'w9-on-file', source: null }),
        existing({ id: 'other_human', requirement_slug: 'recall-program', source: 'human' }),
        existing({ id: 'someone_else', supplier_id: 'sup_2', requirement_slug: 'w9-on-file', source: null }),
      ],
    });
    const removals = changes.filter((c) => c.kind === 'remove_unconfirmed');
    expect(removals).toEqual([
      { kind: 'remove_unconfirmed', row_id: 'other_seed', supplier_id: 'sup_1', slug: 'w9-on-file', tier: 'required' },
    ]);
  });

  it('reports packet slugs the tenant does not hold', () => {
    const { changes, unknownRequirements } = planPacketApply({
      supplierIds: ['sup_1', 'sup_2'],
      packet,
      knownRequirementSlugs: new Set(['spec-sheet']),
      existing: [],
    });
    expect(unknownRequirements.sort()).toEqual(['allergen-matrix', 'micro-limits', 'shelf-life']);
    expect(changes).toEqual([
      { kind: 'add', supplier_id: 'sup_1', slug: 'spec-sheet', tier: 'required' },
      { kind: 'add', supplier_id: 'sup_2', slug: 'spec-sheet', tier: 'required' },
    ]);
  });
});
