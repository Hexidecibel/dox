/**
 * Unit tests for the pure gap engine (`shared/requirementGap.ts`).
 *
 * The subtraction "what applies MINUS what is closed" is the whole product
 * claim, so it is tested here without a database — the same reason
 * `shared/specCheck.ts` has its own unit suite separate from the D1-backed
 * spec tests. The D1 wiring is covered in tests/api/supplier-gaps.test.ts.
 */

import { describe, it, expect } from 'vitest';
import {
  computeSupplierGap,
  rollupSupplierGaps,
  DEFAULT_GAP_OPTIONS,
  EMPTY_CLASSIFICATION_COUNTS,
  type ApplicabilityRow,
  type ClaimOpenedRow,
  type ClassificationCounts,
  type ClosureRow,
  type SupplierGapInput,
} from '../../shared/requirementGap';

function applies(
  requirement_id: string,
  name: string,
  tier: 'required' | 'recommended' = 'required',
  sort_order = 0,
  checklist: string | null = null,
): ApplicabilityRow {
  return { requirement_id, name, slug: requirement_id, checklist, sort_order, tier };
}

function opened(
  requirement_id: string,
  name: string,
  claim_type_name: string,
  is_required = 1,
): ClaimOpenedRow {
  return {
    requirement_id,
    name,
    slug: requirement_id,
    checklist: null,
    sort_order: 0,
    is_required,
    claim_type_id: `ct-${claim_type_name}`,
    claim_type_name,
    document_id: 'doc-spec',
    document_title: 'Spec Sheet',
  };
}

function closes(requirement_id: string, document_id = 'doc-1'): ClosureRow {
  return {
    requirement_id,
    document_id,
    document_title: `Document ${document_id}`,
    confirmed_at: '2026-08-01T00:00:00Z',
  };
}

function input(over: Partial<SupplierGapInput> = {}): SupplierGapInput {
  return {
    supplier_id: 'sup-1',
    supplier_name: 'Alpha Dairy',
    applicability: [],
    claimOpened: [],
    closures: [],
    documentCount: 0,
    classification: { ...EMPTY_CLASSIFICATION_COUNTS },
    ...over,
  };
}

function counts(over: Partial<ClassificationCounts> = {}): ClassificationCounts {
  return { ...EMPTY_CLASSIFICATION_COUNTS, ...over };
}

describe('the subtraction itself', () => {
  it('reports what applies minus what a confirmed document closed', () => {
    const gap = computeSupplierGap(
      input({
        applicability: [
          applies('r-allergen', 'Allergen Matrix'),
          applies('r-nutrition', '100g Nutritionals'),
        ],
        closures: [closes('r-allergen')],
        documentCount: 1,
        classification: counts({ classified: 1 }),
      }),
    );

    expect(gap.status).toBe('open');
    expect(gap.counts.required).toEqual({ applicable: 2, satisfied: 1, open: 1 });
    expect(gap.open.map((o) => o.requirement_id)).toEqual(['r-nutrition']);
    expect(gap.applicable.find((a) => a.requirement_id === 'r-allergen')?.satisfied).toBe(true);
  });

  it('names every open item in plain language, with its id and tier', () => {
    const gap = computeSupplierGap(
      input({ applicability: [applies('r-allergen', 'Allergen Matrix')] }),
    );
    const [item] = gap.open;
    expect(item.requirement_id).toBe('r-allergen');
    expect(item.tier).toBe('required');
    expect(item.summary).toBe(
      'Allergen Matrix (required) — open; no confirmed document from this supplier closes it',
    );
  });

  it('goes to "satisfied" only when every counted item is closed', () => {
    const gap = computeSupplierGap(
      input({
        applicability: [applies('r-allergen', 'Allergen Matrix')],
        closures: [closes('r-allergen')],
        documentCount: 1,
        classification: counts({ classified: 1 }),
      }),
    );
    expect(gap.status).toBe('satisfied');
    expect(gap.open).toHaveLength(0);
    expect(gap.applicable[0].summary).toContain('closed by 1 confirmed document');
  });

  it('ignores a closure for a requirement that does not apply', () => {
    // Otherwise satisfied could exceed applicable and a supplier could be
    // credited for closing something nobody asked them for.
    const gap = computeSupplierGap(
      input({
        applicability: [applies('r-allergen', 'Allergen Matrix')],
        closures: [closes('r-allergen'), closes('r-unrelated', 'doc-2')],
        documentCount: 2,
        classification: counts({ classified: 2 }),
      }),
    );
    expect(gap.counts.required.applicable).toBe(1);
    expect(gap.counts.required.satisfied).toBe(1);
    expect(gap.applicable).toHaveLength(1);
  });

  it('counts one requirement once even when two documents close it', () => {
    const gap = computeSupplierGap(
      input({
        applicability: [applies('r-allergen', 'Allergen Matrix')],
        closures: [closes('r-allergen', 'doc-1'), closes('r-allergen', 'doc-2')],
        documentCount: 2,
        classification: counts({ classified: 2 }),
      }),
    );
    expect(gap.counts.required).toEqual({ applicable: 1, satisfied: 1, open: 0 });
    expect(gap.applicable[0].satisfied_by).toHaveLength(2);
  });
});

describe('tier filtering — required by default, recommended opt-in', () => {
  it('defaults to required only', () => {
    expect(DEFAULT_GAP_OPTIONS.includeRecommended).toBe(false);

    const gap = computeSupplierGap(
      input({
        applicability: [
          applies('r-allergen', 'Allergen Matrix', 'required'),
          applies('r-advisory', 'Advisory Only', 'recommended'),
        ],
      }),
    );

    expect(gap.tiers_counted).toEqual(['required']);
    expect(gap.open.map((o) => o.requirement_id)).toEqual(['r-allergen']);
    // The recommended totals are still computed — they are just not what
    // `open` and `status` are derived from.
    expect(gap.counts.recommended).toEqual({ applicable: 1, satisfied: 0, open: 1 });
    expect(gap.caveats.map((c) => c.code)).toContain('recommended_excluded');
  });

  it('includes the recommended tier when asked', () => {
    const gap = computeSupplierGap(
      input({
        applicability: [
          applies('r-allergen', 'Allergen Matrix', 'required'),
          applies('r-advisory', 'Advisory Only', 'recommended'),
        ],
      }),
      { includeRecommended: true },
    );
    expect(gap.tiers_counted).toEqual(['required', 'recommended']);
    expect(gap.open).toHaveLength(2);
    expect(gap.caveats.map((c) => c.code)).not.toContain('recommended_excluded');
  });

  it('a supplier owing only recommended items is satisfied, not open, by default', () => {
    const gap = computeSupplierGap(
      input({ applicability: [applies('r-advisory', 'Advisory Only', 'recommended')] }),
    );
    // Nothing REQUIRED is open, so the counted answer is "satisfied" — but
    // `configured` is true and the caveat still names the excluded item, so
    // this cannot be mistaken for "nothing was ever asked for".
    expect(gap.status).toBe('satisfied');
    expect(gap.configured).toBe(true);
    expect(gap.caveats.find((c) => c.code === 'recommended_excluded')?.count).toBe(1);
  });

  it('required wins when the same requirement applies at both tiers', () => {
    const gap = computeSupplierGap(
      input({
        applicability: [applies('r-organic', 'Organic Certificate', 'recommended')],
        claimOpened: [opened('r-organic', 'Organic Certificate', 'Organic', 1)],
      }),
    );
    expect(gap.applicable).toHaveLength(1);
    expect(gap.applicable[0].tier).toBe('required');
    expect(gap.applicable[0].origins.sort()).toEqual(['applicability', 'claim']);
    expect(gap.counts.required.applicable).toBe(1);
    expect(gap.counts.recommended.applicable).toBe(0);
  });
});

describe('claims opening requirements', () => {
  it('a confirmed claim makes a requirement applicable with no configuration', () => {
    const gap = computeSupplierGap(
      input({
        claimOpened: [opened('r-organic', 'Organic Certificate', 'Organic')],
        documentCount: 1,
        classification: counts({ classified: 1 }),
      }),
    );

    expect(gap.status).toBe('open');
    expect(gap.open[0].requirement_id).toBe('r-organic');
    expect(gap.open[0].origins).toEqual(['claim']);
    expect(gap.open[0].opened_by[0].claim_type_name).toBe('Organic');
    expect(gap.open[0].summary).toBe(
      'Organic Certificate (required) — open; triggered by the "Organic" claim on this supplier\'s documents',
    );
    // Nothing was configured, so the report says so even though it found gaps.
    expect(gap.configured).toBe(false);
    expect(gap.caveats.map((c) => c.code)).toContain('no_requirements_configured');
  });

  it('demotes an advisory (is_required = 0) mapping to the recommended tier', () => {
    const gap = computeSupplierGap(
      input({ claimOpened: [opened('r-nice', 'Nice To Have', 'Organic', 0)] }),
    );
    expect(gap.counts.recommended.applicable).toBe(1);
    expect(gap.counts.required.applicable).toBe(0);
    expect(gap.open).toHaveLength(0);
  });

  it('collapses duplicate claim rows but keeps every distinct trigger', () => {
    const twice = opened('r-organic', 'Organic Certificate', 'Organic');
    const other = { ...opened('r-organic', 'Organic Certificate', 'Organic'), document_id: 'doc-2' };
    const gap = computeSupplierGap(
      input({ claimOpened: [twice, { ...twice }, other] }),
    );
    expect(gap.applicable).toHaveLength(1);
    expect(gap.applicable[0].opened_by).toHaveLength(2);
  });

  it('a claim-opened requirement can be closed like any other', () => {
    const gap = computeSupplierGap(
      input({
        claimOpened: [opened('r-organic', 'Organic Certificate', 'Organic')],
        closures: [closes('r-organic', 'doc-cert')],
        documentCount: 2,
        classification: counts({ classified: 2 }),
      }),
    );
    expect(gap.status).toBe('satisfied');
    expect(gap.counts.required).toEqual({ applicable: 1, satisfied: 1, open: 0 });
  });
});

describe('"nothing open" is not "nothing configured"', () => {
  it('a supplier with no applicability rows reads not_configured, never satisfied', () => {
    const gap = computeSupplierGap(
      input({ documentCount: 5, classification: counts({ classified: 5 }) }),
    );
    expect(gap.status).toBe('not_configured');
    expect(gap.status).not.toBe('satisfied');
    expect(gap.configured).toBe(false);
    expect(gap.counts.required).toEqual({ applicable: 0, satisfied: 0, open: 0 });
    expect(gap.caveats.find((c) => c.code === 'no_requirements_configured')?.message).toContain(
      'not the same as compliant',
    );
  });

  it('distinguishes it from a genuinely satisfied supplier', () => {
    const satisfied = computeSupplierGap(
      input({
        applicability: [applies('r-allergen', 'Allergen Matrix')],
        closures: [closes('r-allergen')],
        documentCount: 1,
        classification: counts({ classified: 1 }),
      }),
    );
    const unconfigured = computeSupplierGap(input());

    expect(satisfied.status).toBe('satisfied');
    expect(unconfigured.status).toBe('not_configured');
    expect(satisfied.configured).toBe(true);
    expect(unconfigured.configured).toBe(false);
  });

  it('flags a supplier with no active documents', () => {
    const gap = computeSupplierGap(
      input({ applicability: [applies('r-allergen', 'Allergen Matrix')] }),
    );
    expect(gap.caveats.map((c) => c.code)).toContain('no_documents');
  });
});

describe('the countable unclassified state', () => {
  it('carries the classification counts on every result', () => {
    const gap = computeSupplierGap(
      input({
        applicability: [applies('r-allergen', 'Allergen Matrix')],
        closures: [closes('r-allergen')],
        documentCount: 6,
        classification: counts({
          classified: 1,
          unclassified: 3,
          needs_review: 1,
          unclassifiable: 1,
        }),
      }),
    );

    expect(gap.status).toBe('satisfied');
    expect(gap.documents.total).toBe(6);
    expect(gap.documents.classification.unclassified).toBe(3);
    // 3 unclassified + 1 needs_review = 4 documents that cannot close anything.
    const caveat = gap.caveats.find((c) => c.code === 'unclassified_documents');
    expect(caveat?.count).toBe(4);
    expect(caveat?.message).toContain('cannot close anything yet');
  });

  it('does not count "unclassifiable" as backlog — it is a terminal human ruling', () => {
    const gap = computeSupplierGap(
      input({
        applicability: [applies('r-allergen', 'Allergen Matrix')],
        documentCount: 2,
        classification: counts({ classified: 1, unclassifiable: 1 }),
      }),
    );
    expect(gap.caveats.map((c) => c.code)).not.toContain('unclassified_documents');
  });
});

describe('ordering and rollup', () => {
  it('orders by checklist, then the tenant sort order, then name', () => {
    const gap = computeSupplierGap(
      input({
        applicability: [
          applies('r-c', 'Zulu', 'required', 0, 'SOP 200'),
          applies('r-b', 'Bravo', 'required', 5, 'SOP 102'),
          applies('r-a', 'Alpha', 'required', 1, 'SOP 102'),
        ],
      }),
    );
    expect(gap.applicable.map((a) => a.name)).toEqual(['Alpha', 'Bravo', 'Zulu']);
  });

  it('rolls several suppliers up without collapsing the three states', () => {
    const rollup = rollupSupplierGaps([
      computeSupplierGap(input({ supplier_id: 's1' })),
      computeSupplierGap(
        input({ supplier_id: 's2', applicability: [applies('r-a', 'A')] }),
      ),
      computeSupplierGap(
        input({
          supplier_id: 's3',
          applicability: [applies('r-a', 'A')],
          closures: [closes('r-a')],
          documentCount: 1,
          classification: counts({ unclassified: 1 }),
        }),
      ),
    ]);

    expect(rollup).toEqual({
      suppliers: 3,
      not_configured: 1,
      open: 1,
      satisfied: 1,
      open_requirements: 1,
      unclassified_documents: 1,
    });
  });
});
