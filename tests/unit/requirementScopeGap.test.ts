/**
 * Requirement scope in the pure gap engine (migration 0123).
 *
 * The rules pinned here are the ones whose failure would read CLEAN:
 *   - zero active products is open, never a vacuous pass;
 *   - a confirmed document linked to no product closes nothing;
 *   - exempt / add rows move one product in or out;
 *   - the supplier cannot read `satisfied` while a product has nothing set up;
 *   - and a tenant still entirely on supplier scope gets byte-identical output
 *     (apart from `products`) — pinned against the PRE-0123 engine's own bytes.
 */

import { describe, it, expect } from 'vitest';
import {
  computeSupplierGap,
  rollupSupplierGaps,
  EMPTY_CLASSIFICATION_COUNTS,
  type ApplicabilityRow,
  type ClaimOpenedRow,
  type ClosureRow,
  type ProductOverrideRow,
  type ProductSubject,
  type SupplierGapInput,
} from '../../shared/requirementGap';
import inputs from '../fixtures/requirement-gap/supplier-scope-inputs.json';
import golden from '../fixtures/requirement-gap/supplier-scope-golden.json';

function applies(
  requirement_id: string,
  name: string,
  scope: 'supplier' | 'product' | 'lot' = 'supplier',
  tier: 'required' | 'recommended' = 'required',
): ApplicabilityRow {
  return { requirement_id, name, slug: requirement_id, checklist: null, sort_order: 0, tier, scope };
}

function product(product_id: string, name: string, over: Partial<ProductSubject> = {}): ProductSubject {
  return { product_id, name, source: 'admin', identified: true, nothing_owed: null, ...over };
}

function closes(requirement_id: string, document_id: string): ClosureRow {
  return {
    requirement_id,
    document_id,
    document_title: `Doc ${document_id}`,
    confirmed_at: '2026-09-01T00:00:00Z',
  };
}

function override(
  requirement_id: string,
  product_id: string,
  mode: 'add' | 'exempt',
  over: Partial<ProductOverrideRow> = {},
): ProductOverrideRow {
  return {
    requirement_id,
    name: requirement_id,
    slug: requirement_id,
    checklist: null,
    sort_order: 0,
    scope: 'product',
    product_id,
    mode,
    tier: 'required',
    reason: mode === 'exempt' ? 'packaging SKU' : null,
    ...over,
  };
}

function input(over: Partial<SupplierGapInput> = {}): SupplierGapInput {
  return {
    supplier_id: 'sup-cmf',
    supplier_name: 'Country Morning Farms',
    applicability: [],
    claimOpened: [],
    closures: [],
    documentCount: 3,
    classification: { ...EMPTY_CLASSIFICATION_COUNTS, classified: 3 },
    ...over,
  };
}

const TWO_PRODUCTS = [product('p-milk', 'MS WHOLE'), product('p-cream', 'HEAVY CREAM')];

describe('product scope: what closes a (requirement, product) pair', () => {
  it('closes only the products the confirmed document is linked to', () => {
    const gap = computeSupplierGap(
      input({
        applicability: [applies('r-spec', 'Specification Sheet', 'product')],
        products: TWO_PRODUCTS,
        closures: [closes('r-spec', 'd-1')],
        productLinks: [{ document_id: 'd-1', product_id: 'p-milk' }],
      }),
    );
    const item = gap.applicable[0];
    expect(item.scope).toBe('product');
    expect(item.subjects_total).toBe(2);
    expect(item.subjects_satisfied).toBe(1);
    expect(item.satisfied).toBe(false);
    expect(item.open_subjects).toEqual([{ product_id: 'p-cream', name: 'HEAVY CREAM' }]);
    expect(item.summary).toBe(
      'Specification Sheet (required, per product) — 1 of 2 products; open for HEAVY CREAM',
    );
    expect(gap.status).toBe('open');
  });

  it('one document linked to several products closes all of them', () => {
    const gap = computeSupplierGap(
      input({
        applicability: [applies('r-spec', 'Specification Sheet', 'product')],
        products: TWO_PRODUCTS,
        closures: [closes('r-spec', 'd-1')],
        productLinks: [
          { document_id: 'd-1', product_id: 'p-milk' },
          { document_id: 'd-1', product_id: 'p-cream' },
        ],
      }),
    );
    expect(gap.applicable[0].satisfied).toBe(true);
    expect(gap.status).toBe('satisfied');
    expect(gap.products.every((p) => p.status === 'satisfied')).toBe(true);
  });

  it('an UNATTRIBUTED confirmed document closes nothing — never "all products"', () => {
    const gap = computeSupplierGap(
      input({
        applicability: [applies('r-spec', 'Specification Sheet', 'product')],
        products: TWO_PRODUCTS,
        closures: [closes('r-spec', 'd-orphan')],
        productLinks: [],
      }),
    );
    const item = gap.applicable[0];
    expect(item.satisfied).toBe(false);
    expect(item.subjects_satisfied).toBe(0);
    expect(item.satisfied_by).toEqual([]);
    expect(item.unattributed?.map((d) => d.document_id)).toEqual(['d-orphan']);
    expect(item.gap_reason).toBe('unattributed');
    expect(gap.caveats.map((c) => c.code)).toContain('unattributed_documents');
  });

  it('ZERO active products is open with gap_reason no_products, not a vacuous pass', () => {
    const gap = computeSupplierGap(
      input({
        applicability: [applies('r-spec', 'Specification Sheet', 'product')],
        products: [],
      }),
    );
    expect(gap.applicable[0].satisfied).toBe(false);
    expect(gap.applicable[0].gap_reason).toBe('no_products');
    expect(gap.applicable[0].subjects_total).toBe(0);
    expect(gap.status).toBe('open');
    expect(gap.caveats.map((c) => c.code)).toContain('no_products');
  });

  it('a certificate expired on arrival does not close its product', () => {
    const gap = computeSupplierGap(
      input({
        applicability: [applies('r-spec', 'Specification Sheet', 'product')],
        products: [product('p-milk', 'MS WHOLE')],
        closures: [
          {
            ...closes('r-spec', 'd-dead'),
            expires_on: '2026-01-01',
            arrived_at: '2026-02-01T00:00:00Z',
          },
        ],
        productLinks: [{ document_id: 'd-dead', product_id: 'p-milk' }],
      }),
    );
    expect(gap.applicable[0].satisfied).toBe(false);
    expect(gap.applicable[0].gap_reason).toBe('expired_on_arrival');
    expect(gap.applicable[0].not_counted).toHaveLength(1);
  });
});

describe('product scope: exempt and add', () => {
  it('an exempt row removes one product from an inherited requirement, with its reason', () => {
    const gap = computeSupplierGap(
      input({
        applicability: [applies('r-nutri', '100g Nutritionals', 'product')],
        products: TWO_PRODUCTS,
        productOverrides: [override('r-nutri', 'p-cream', 'exempt')],
        closures: [closes('r-nutri', 'd-1')],
        productLinks: [{ document_id: 'd-1', product_id: 'p-milk' }],
      }),
    );
    const item = gap.applicable[0];
    expect(item.subjects_total).toBe(1);
    expect(item.satisfied).toBe(true);
    expect(item.exempt_subjects).toEqual([
      { product_id: 'p-cream', name: 'HEAVY CREAM', reason: 'packaging SKU' },
    ]);
    const cream = gap.products.find((p) => p.product_id === 'p-cream')!;
    expect(cream.exempt).toEqual([
      { requirement_id: 'r-nutri', name: '100g Nutritionals', reason: 'packaging SKU' },
    ]);
    // Exempt from its only per-product requirement, nothing else applies:
    // amber, not green.
    expect(cream.status).toBe('not_configured');
    expect(gap.status).toBe('products_not_configured');
  });

  it('an add row makes a requirement owed by one product only', () => {
    const gap = computeSupplierGap(
      input({
        applicability: [applies('r-coi', 'Certificate of Insurance')],
        products: TWO_PRODUCTS,
        productOverrides: [override('r-label', 'p-milk', 'add', { name: 'Product Label' })],
        closures: [closes('r-coi', 'd-coi')],
      }),
    );
    const label = gap.applicable.find((a) => a.requirement_id === 'r-label')!;
    expect(label.origins).toEqual(['product']);
    expect(label.subjects_total).toBe(1);
    expect(label.open_subjects).toEqual([{ product_id: 'p-milk', name: 'MS WHOLE' }]);
    const milk = gap.products.find((p) => p.product_id === 'p-milk')!;
    expect(milk.requirements.map((r) => [r.requirement_id, r.origin])).toEqual([
      ['r-label', 'product'],
    ]);
    // The OTHER product has nothing applying, and scope is in use: amber.
    const cream = gap.products.find((p) => p.product_id === 'p-cream')!;
    expect(cream.status).toBe('not_configured');
    expect(gap.status).toBe('open'); // open outranks the product amber
  });

  it('add rows count as configuration: no "claims only" caveat', () => {
    const gap = computeSupplierGap(
      input({
        products: [product('p-milk', 'MS WHOLE')],
        productOverrides: [override('r-label', 'p-milk', 'add')],
      }),
    );
    expect(gap.configured).toBe(true);
    expect(gap.caveats.map((c) => c.code)).not.toContain('no_requirements_configured');
  });

  it('a product declared "nothing owed" reads satisfied with its reason, and is not inherited into', () => {
    const gap = computeSupplierGap(
      input({
        applicability: [applies('r-spec', 'Specification Sheet', 'product')],
        products: [
          product('p-milk', 'MS WHOLE'),
          product('p-lid', 'LID 38MM', {
            nothing_owed: { reason: 'packaging', at: '2026-09-28', by: 'u-1' },
          }),
        ],
        closures: [closes('r-spec', 'd-1')],
        productLinks: [{ document_id: 'd-1', product_id: 'p-milk' }],
      }),
    );
    expect(gap.applicable[0].subjects_total).toBe(1);
    const lid = gap.products.find((p) => p.product_id === 'p-lid')!;
    expect(lid.status).toBe('satisfied');
    expect(lid.nothing_owed?.reason).toBe('packaging');
    expect(gap.status).toBe('satisfied');
  });

  it('a stale override on a requirement that is no longer product scope is inert', () => {
    const gap = computeSupplierGap(
      input({
        applicability: [applies('r-spec', 'Specification Sheet', 'supplier')],
        products: TWO_PRODUCTS,
        productOverrides: [override('r-spec', 'p-milk', 'exempt', { scope: 'supplier' })],
        closures: [closes('r-spec', 'd-1')],
      }),
    );
    expect(gap.applicable[0].scope).toBeUndefined();
    expect(gap.applicable[0].satisfied).toBe(true);
    expect(gap.products.every((p) => p.status === 'not_checked')).toBe(true);
  });
});

describe('the product amber and its gate', () => {
  it('precedence: not_configured > open > products_not_configured > satisfied', () => {
    const base = {
      products: TWO_PRODUCTS,
      productOverrides: [override('r-label', 'p-milk', 'add')],
      productLinks: [{ document_id: 'd-l', product_id: 'p-milk' }],
    };
    const amber = computeSupplierGap(input({ ...base, closures: [closes('r-label', 'd-l')] }));
    expect(amber.status).toBe('products_not_configured');
    expect(amber.caveats.find((c) => c.code === 'products_not_configured')?.message).toContain(
      'HEAVY CREAM',
    );
    const open = computeSupplierGap(input(base));
    expect(open.status).toBe('open');
    expect(computeSupplierGap(input()).status).toBe('not_configured');
    expect(
      rollupSupplierGaps([amber, open]).products_not_configured,
    ).toBe(1);
  });

  it('a supplier with no product-scope requirement never judges its products', () => {
    const gap = computeSupplierGap(
      input({
        applicability: [applies('r-coi', 'Certificate of Insurance')],
        products: TWO_PRODUCTS,
        excludedProducts: [{ product_id: 'p-old', name: 'Half-and-Half', reason: 'inactive' }],
        closures: [closes('r-coi', 'd-coi')],
      }),
    );
    expect(gap.status).toBe('satisfied');
    expect(gap.products.map((p) => p.status)).toEqual(['not_checked', 'not_checked']);
    expect(gap.caveats).toEqual([]);
  });

  it('inactive / discontinued and certificate-created products become caveats once gated', () => {
    const gap = computeSupplierGap(
      input({
        applicability: [applies('r-spec', 'Specification Sheet', 'product')],
        products: [
          product('p-milk', 'MS WHOLE'),
          product('p-cert', 'Milk - Whole', { source: 'certificate', identified: false }),
        ],
        excludedProducts: [
          { product_id: 'p-old', name: 'Half-and-Half', reason: 'inactive' },
          { product_id: 'p-gone', name: 'Skim', reason: 'discontinued' },
        ],
      }),
    );
    const byCode = new Map(gap.caveats.map((c) => [c.code, c]));
    expect(byCode.get('products_excluded')?.message).toBe(
      '2 products linked to Country Morning Farms are not checked: Half-and-Half (inactive), Skim (no longer supplied).',
    );
    expect(byCode.get('possible_duplicate_products')?.message).toContain('Milk - Whole');
    expect(gap.products.find((p) => p.product_id === 'p-cert')?.possible_duplicate).toBe(true);
  });
});

describe('claims carry a subject (design §5)', () => {
  const claim = (over: Partial<ClaimOpenedRow>): ClaimOpenedRow => ({
    requirement_id: 'r-subst',
    name: 'Claim Substantiation',
    slug: 'r-subst',
    checklist: null,
    sort_order: 0,
    scope: 'product',
    is_required: 1,
    claim_type_id: 'ct-fruit',
    claim_type_name: '90% real fruit',
    document_id: 'd-spec',
    document_title: 'Spec',
    ...over,
  });

  it('a product-subject claim opens a product-scope requirement for that product only', () => {
    const gap = computeSupplierGap(
      input({
        products: TWO_PRODUCTS,
        claimOpened: [claim({ subject_type: 'product', subject_id: 'p-cream' })],
      }),
    );
    expect(gap.applicable[0].subjects_total).toBe(1);
    expect(gap.applicable[0].open_subjects?.[0].product_id).toBe('p-cream');
    expect(gap.products.find((p) => p.product_id === 'p-cream')?.requirements[0].origin).toBe(
      'claim',
    );
  });

  it('a facility claim applies supplier-wide and says facilities are not modelled', () => {
    const gap = computeSupplierGap(
      input({ products: TWO_PRODUCTS, claimOpened: [claim({ subject_type: 'facility' })] }),
    );
    expect(gap.applicable[0].subjects_total).toBe(2);
    expect(gap.caveats.map((c) => c.code)).toContain('facility_claim_supplier_wide');
  });

  it('a product-grain claim with no product subject is flagged', () => {
    const gap = computeSupplierGap(
      input({
        products: TWO_PRODUCTS,
        claimOpened: [claim({ subject_type: 'tenant', subject_grain: 'product' })],
      }),
    );
    expect(gap.caveats.map((c) => c.code)).toContain('claim_missing_subject');
  });

  it('a claim on a SUPPLIER-scope requirement ignores the subject (closes once)', () => {
    const gap = computeSupplierGap(
      input({
        products: TWO_PRODUCTS,
        claimOpened: [claim({ scope: 'supplier', subject_type: 'product', subject_id: 'p-cream' })],
        closures: [closes('r-subst', 'd-any')],
      }),
    );
    expect(gap.applicable[0].satisfied).toBe(true);
    expect(gap.applicable[0].subjects_total).toBeUndefined();
  });
});

describe('lot scope is stored, not yet evaluated per lot', () => {
  it('is judged once per supplier and says so', () => {
    const gap = computeSupplierGap(
      input({
        applicability: [applies('r-coa', 'Certificate of Analysis', 'lot')],
        closures: [closes('r-coa', 'd-coa')],
      }),
    );
    const item = gap.applicable[0];
    expect(item.scope).toBe('lot');
    expect(item.lot_evaluation).toBe('supplier_level');
    expect(item.satisfied).toBe(true);
    expect(item.summary).toContain('per lot');
    expect(gap.caveats.map((c) => c.code)).toContain('lot_scope_not_evaluated');
    // Lot scope alone does not gate the product amber.
    expect(gap.status).toBe('satisfied');
  });
});

describe('BYTE-IDENTICAL for a tenant entirely on supplier scope', () => {
  type Case = { name: string; input: SupplierGapInput };
  const cases = (inputs as unknown as { cases: Case[] }).cases;
  const productSide = (inputs as unknown as { product_side: Partial<SupplierGapInput> })
    .product_side;
  const expected = golden as unknown as Record<
    string,
    { default: unknown; include_recommended: unknown }
  >;

  for (const c of cases) {
    it(`${c.name}: same bytes as the pre-0123 engine, apart from products`, () => {
      for (const [key, opts] of [
        ['default', {}],
        ['include_recommended', { includeRecommended: true }],
      ] as const) {
        const gap = computeSupplierGap({ ...c.input, ...productSide }, opts);
        const { products, ...rest } = gap;
        expect(JSON.stringify(rest)).toBe(JSON.stringify(expected[c.name][key]));
        // The products are listed, and none is judged.
        expect(products.map((p) => p.status)).toEqual(['not_checked', 'not_checked']);
      }
    });
  }
});
