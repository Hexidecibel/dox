/**
 * A SHELF LIFE NEVER BECOMES A RENEWAL DUE DATE.
 *
 * Extraction gained a `shelf_life` field on 2026-09-17: all four specification
 * sheets in tests/fixtures/real-corpus print one ("21 days", "22 days", "21
 * days at <=40F", "1 year frozen, 21 days refrigerated") and the schema had
 * nowhere to put it, so it was missed on every document that stated it.
 *
 * The field arrives in `primary_metadata` beside `document_expires_on` and
 * `effective_date`, which is exactly where migration 0097's defect lived: the
 * PRODUCT's life and the PAPERWORK's life sitting in one JSON object, one field
 * apart. `expiration_date` was the first temptation and the header of
 * shared/renewalPeriod.ts records what reading it would have cost (139 of 200
 * prod documents carry one; all 139 are COAs). `shelf_life` is the sharper
 * version of the same temptation, because it is ALREADY a period and tiers 5-7
 * of the ladder are periods — "21 days" would slot straight in and propose
 * re-collecting a specification sheet three weeks after it was issued.
 *
 * These tests stand at the two seams where it could get in:
 *   * `renewalDatesFromFields` — what the ladder reads out of extracted fields
 *   * `buildRenewalProposal`   — the proposal the Review Queue pre-fills
 * and use the corpus's real printed values.
 */

import { describe, it, expect } from 'vitest';
import { renewalDatesFromFields, buildRenewalProposal } from '../../functions/lib/renewal-proposal';
import { resolveRenewalExpiry, SPEC_SHEET_RENEWAL_MONTHS } from '../../shared/renewalPeriod';

/** The four real spec sheets, as `bin/eval-aj-docs` grades them. */
const CORPUS_SHELF_LIVES: Array<{ id: string; shelf_life: string }> = [
  { id: 'spec-cmf-light-cream-23', shelf_life: '21 days' },
  { id: 'spec-cmf-ice-cream-mix-14', shelf_life: '1 year frozen, 21 days refrigerated' },
  { id: 'spec-smithbrothers-heavy-whipping-cream-13106', shelf_life: '21 days at ≤40°F' },
  { id: 'spec-andersen-heavy-whip-cream-half-gallon', shelf_life: '22 days' },
];

/** A specification sheet's type configuration: three years, by definition. */
const SPEC_SHEET_TYPE = {
  renewal_policy: 'period' as const,
  renewal_interval_months: SPEC_SHEET_RENEWAL_MONTHS,
};

describe('renewalDatesFromFields ignores shelf_life entirely', () => {
  for (const doc of CORPUS_SHELF_LIVES) {
    it(`${doc.id}: reads neither date out of the shelf life`, () => {
      const dates = renewalDatesFromFields({
        shelf_life: doc.shelf_life,
        product_name: 'Cream',
      });
      expect(dates.document_expires_on).toBeNull();
      expect(dates.effective_date).toBeNull();
    });
  }

  it('does not let shelf_life stand in for a missing document expiry', () => {
    // The failure mode this guards: someone "helpfully" falling back to the
    // shelf life when document_expires_on is absent, which on a spec sheet it
    // always is.
    const withBoth = renewalDatesFromFields({
      shelf_life: '21 days',
      document_expires_on: '2027-09-01',
      effective_date: '2026-03-02',
    });
    expect(withBoth.document_expires_on).toBe('2027-09-01');
    expect(withBoth.effective_date).toBe('2026-03-02');
  });
});

describe('buildRenewalProposal — the shelf life changes nothing', () => {
  for (const doc of CORPUS_SHELF_LIVES) {
    it(`${doc.id}: proposes the three-year type rule, not the printed period`, () => {
      const fields = { shelf_life: doc.shelf_life, effective_date: '2026-03-02' };
      const proposal = buildRenewalProposal(fields, SPEC_SHEET_TYPE);

      // Three years from the effective date — the regulatory definition of a
      // current specification sheet.
      expect(proposal.due_date).toBe('2029-03-02');
      expect(proposal.rule).toBe('document_type_default');
      expect(proposal.period_months).toBe(SPEC_SHEET_RENEWAL_MONTHS);
    });
  }

  it('is byte-identical with and without the shelf life present', () => {
    const base = { effective_date: '2026-03-02' };
    const withShelfLife = { ...base, shelf_life: '21 days' };
    expect(buildRenewalProposal(withShelfLife, SPEC_SHEET_TYPE))
      .toEqual(buildRenewalProposal(base, SPEC_SHEET_TYPE));
  });

  it('a shelf life alone never produces a due date at all', () => {
    // No effective date to count from: the honest answer is "we could not fill
    // this in", NOT "21 days from something".
    const proposal = buildRenewalProposal({ shelf_life: '21 days' }, SPEC_SHEET_TYPE);
    expect(proposal.due_date).toBeNull();
    expect(proposal.rule).toBe('unresolvable');
  });
});

describe('the ladder has no shelf_life input to give it', () => {
  it('RenewalPeriodInput carries no shelf-life key, and an extra one is inert', () => {
    // The type has no such field; this proves the runtime does not read one
    // either, so adding the key to primary_metadata cannot change an answer.
    const answer = resolveRenewalExpiry({
      renewal_type: null,
      renewal_due_date: null,
      renewal_interval_months: null,
      renewal_decision: null,
      type_renewal_policy: 'period',
      type_renewal_interval_months: SPEC_SHEET_RENEWAL_MONTHS,
      meta_document_expires_on: null,
      meta_effective_date: '2026-03-02',
      // @ts-expect-error — deliberately passing a key the input type forbids.
      meta_shelf_life: '21 days',
      shelf_life: '21 days',
    });
    expect(answer.due_date).toBe('2029-03-02');
    expect(answer.period_months).toBe(SPEC_SHEET_RENEWAL_MONTHS);
  });
});
