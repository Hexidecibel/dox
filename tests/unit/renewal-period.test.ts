/**
 * Unit tests for the renewal-period ladder (shared/renewalPeriod.ts).
 *
 * The rules under test are the client SME's regulatory definitions, not
 * preferences: annual by default, three years for specification sheets, and a
 * document's OWN stated expiry overriding both. The override is the case worth
 * guarding hardest — a certificate of insurance that prints 09/01/2027 expires
 * then even when it is filed under a type that renews at three years — so it
 * gets its own block below.
 */

import { describe, it, expect } from 'vitest';
import {
  resolveRenewalExpiry,
  resolveRenewalPeriodMonths,
  looksLikeSpecSheetType,
  looksLikeCoaType,
  defaultRenewalMonthsForTypeName,
  defaultRenewalPolicyForTypeName,
  renewalPeriodLabel,
  addMonths,
  ANNUAL_RENEWAL_MONTHS,
  SPEC_SHEET_RENEWAL_MONTHS,
  type RenewalPeriodInput,
} from '../../shared/renewalPeriod';
import { computeStatus, type RenewalInput } from '../../functions/lib/expirations';

function input(partial: Partial<RenewalPeriodInput>): RenewalPeriodInput {
  return {
    renewal_type: null,
    renewal_due_date: null,
    renewal_interval_months: null,
    renewal_decision: null,
    type_renewal_policy: null,
    type_renewal_interval_months: null,
    meta_document_expires_on: null,
    meta_effective_date: null,
    ...partial,
  };
}

describe('resolveRenewalExpiry — a stated expiry beats every default', () => {
  it("the document's printed expiry beats a three-year spec-sheet type default", () => {
    // The headline rule. A certificate of insurance filed under a type that
    // renews at three years still expires on the date it prints.
    const r = resolveRenewalExpiry(
      input({
        meta_document_expires_on: '2027-09-01',
        meta_effective_date: '2026-01-01',
        type_renewal_policy: 'period',
        type_renewal_interval_months: SPEC_SHEET_RENEWAL_MONTHS,
      }),
    );
    expect(r.due_date).toBe('2027-09-01');
    expect(r.rule).toBe('document_expiry');
    // The three-year default would have produced 2029-01-01. It must not win.
    expect(r.due_date).not.toBe('2029-01-01');
    expect(r.reason).toMatch(/overrides/i);
  });

  it("the printed expiry also beats a period set on the document itself", () => {
    const r = resolveRenewalExpiry(
      input({
        meta_document_expires_on: '2027-09-01',
        meta_effective_date: '2026-01-01',
        renewal_interval_months: 6,
        type_renewal_policy: 'period',
        type_renewal_interval_months: SPEC_SHEET_RENEWAL_MONTHS,
      }),
    );
    expect(r.due_date).toBe('2027-09-01');
    expect(r.rule).toBe('document_expiry');
  });

  it('the canonical renewal_due_date outranks everything, including a printed expiry', () => {
    const r = resolveRenewalExpiry(
      input({
        renewal_due_date: '2028-04-04',
        meta_document_expires_on: '2027-09-01',
        type_renewal_policy: 'period',
        type_renewal_interval_months: SPEC_SHEET_RENEWAL_MONTHS,
      }),
    );
    expect(r.due_date).toBe('2028-04-04');
    expect(r.rule).toBe('document_due_date');
  });

  it('strips a time component off a stated date', () => {
    const r = resolveRenewalExpiry(input({ renewal_due_date: '2027-05-05T12:00:00Z' }));
    expect(r.due_date).toBe('2027-05-05');
  });
});

describe('resolveRenewalExpiry — period tiers, when nothing is stated', () => {
  it('spec-sheet type default: three years from the effective date', () => {
    const r = resolveRenewalExpiry(
      input({
        meta_effective_date: '2026-01-15',
        type_renewal_policy: 'period',
        type_renewal_interval_months: SPEC_SHEET_RENEWAL_MONTHS,
      }),
    );
    expect(r.due_date).toBe('2029-01-15');
    expect(r.rule).toBe('document_type_default');
    expect(r.period_months).toBe(36);
    expect(r.anchor_date).toBe('2026-01-15');
  });

  it('no type configured: the annual default, one year from the effective date', () => {
    const r = resolveRenewalExpiry(input({ meta_effective_date: '2026-01-15' }));
    expect(r.due_date).toBe('2027-01-15');
    expect(r.rule).toBe('system_default_annual');
    expect(r.period_months).toBe(ANNUAL_RENEWAL_MONTHS);
  });

  it("a period on the document outranks the type's period", () => {
    const r = resolveRenewalExpiry(
      input({
        meta_effective_date: '2026-01-15',
        renewal_interval_months: 6,
        type_renewal_policy: 'period',
        type_renewal_interval_months: SPEC_SHEET_RENEWAL_MONTHS,
      }),
    );
    expect(r.due_date).toBe('2026-07-15');
    expect(r.rule).toBe('document_interval');
  });

  it('clamps the day when the anchor has no counterpart in the target month', () => {
    const r = resolveRenewalExpiry(
      input({ meta_effective_date: '2026-08-31', type_renewal_policy: 'period', type_renewal_interval_months: 6 }),
    );
    expect(r.due_date).toBe('2027-02-28');
  });

  it('a nonsense stored period (0, negative, absurd) falls through to the next tier', () => {
    expect(resolveRenewalPeriodMonths({ renewal_interval_months: 0, type_renewal_policy: 'period', type_renewal_interval_months: 36 }))
      .toEqual({ months: 36, rule: 'document_type_default' });
    expect(resolveRenewalPeriodMonths({ renewal_interval_months: -12, type_renewal_policy: null, type_renewal_interval_months: null }))
      .toEqual({ months: 12, rule: 'system_default_annual' });
    expect(resolveRenewalPeriodMonths({ renewal_interval_months: null, type_renewal_policy: 'period', type_renewal_interval_months: 99_999 }))
      .toEqual({ months: 12, rule: 'system_default_annual' });
  });
});

describe('resolveRenewalExpiry — when it refuses to answer', () => {
  it('no stated date and no anchor: no date, but it still names the period that would apply', () => {
    const r = resolveRenewalExpiry(input({ type_renewal_policy: 'period', type_renewal_interval_months: SPEC_SHEET_RENEWAL_MONTHS }));
    expect(r.due_date).toBeNull();
    expect(r.rule).toBe('unresolvable');
    expect(r.period_months).toBe(36);
    expect(r.reason).toMatch(/no stated expiry/i);
  });

  it('keep_current declares that it has no period, so no period is invented', () => {
    const r = resolveRenewalExpiry(
      input({
        renewal_type: 'keep_current',
        meta_effective_date: '2020-01-01',
        type_renewal_policy: 'period',
        type_renewal_interval_months: 12,
      }),
    );
    expect(r.due_date).toBeNull();
    expect(r.rule).toBe('no_renewal_period');
  });

  it('keep_current still honours a date it actually states', () => {
    const r = resolveRenewalExpiry(
      input({ renewal_type: 'keep_current', meta_document_expires_on: '2027-01-01' }),
    );
    expect(r.due_date).toBe('2027-01-01');
    expect(r.rule).toBe('document_expiry');
  });

  it('every result carries a non-empty reason', () => {
    const cases: RenewalPeriodInput[] = [
      input({ renewal_due_date: '2027-01-01' }),
      input({ meta_document_expires_on: '2027-01-01' }),
      input({ meta_effective_date: '2026-01-01' }),
      input({ renewal_type: 'keep_current' }),
      input({}),
    ];
    for (const c of cases) {
      expect(resolveRenewalExpiry(c).reason.length).toBeGreaterThan(0);
    }
  });
});

describe('spec-sheet detection (name match, used only to seed a stored value)', () => {
  it('matches the shapes a tenant actually names them', () => {
    for (const name of [
      'Spec Sheet',
      'spec sheets',
      'Specification Sheet',
      'Product Specification',
      'Specification',
      'Product Spec',
    ]) {
      expect(looksLikeSpecSheetType(name)).toBe(true);
    }
  });

  it('does not match unrelated types', () => {
    for (const name of ['Certificate of Analysis', 'COA', 'Safety Data Sheet', 'Insurance Certificate', '']) {
      expect(looksLikeSpecSheetType(name)).toBe(false);
    }
  });

  it('proposes three years for a spec sheet and nothing (annual) for anything else', () => {
    expect(defaultRenewalMonthsForTypeName('Spec Sheet')).toBe(SPEC_SHEET_RENEWAL_MONTHS);
    expect(defaultRenewalMonthsForTypeName('Certificate of Analysis')).toBeNull();
  });
});

describe('labels + date math', () => {
  it('labels a null period as the annual default', () => {
    expect(renewalPeriodLabel(null)).toBe('Annual (default)');
    expect(renewalPeriodLabel(null, 'none')).toBe('Does not renew');
    expect(renewalPeriodLabel(36, 'none')).toBe('Does not renew');
    expect(renewalPeriodLabel(36)).toBe('3 years');
    expect(renewalPeriodLabel(12)).toBe('One year');
    expect(renewalPeriodLabel(6)).toBe('6 months');
  });

  it('addMonths clamps and rolls the year', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2026-11-15', 3)).toBe('2027-02-15');
    expect(addMonths('not-a-date', 12)).toBeNull();
  });
});

describe('computeStatus carries the rule through to the dashboard row', () => {
  const AS_OF = '2026-07-22';

  function statusInput(partial: Partial<RenewalInput>): RenewalInput {
    return {
      renewal_type: null,
      renewal_due_date: null,
      renewal_interval_months: null,
      renewal_decision: null,
      meta_document_expires_on: null,
      meta_effective_date: null,
      type_renewal_policy: null,
      type_renewal_interval_months: null,
      ...partial,
    };
  }

  it('a three-year type default classifies off the derived date and says so', () => {
    const r = computeStatus(
      statusInput({
        renewal_type: 'review_cycle',
        meta_effective_date: '2023-08-01',
        type_renewal_policy: 'period',
        type_renewal_interval_months: SPEC_SHEET_RENEWAL_MONTHS,
      }),
      AS_OF,
      60,
    );
    expect(r.due_date).toBe('2026-08-01');
    expect(r.status).toBe('expiring');
    expect(r.rule).toBe('document_type_default');
    expect(r.period_months).toBe(36);
  });

  it("a stated expiry wins and is reported as the document's own", () => {
    const r = computeStatus(
      statusInput({
        meta_document_expires_on: '2026-06-01',
        meta_effective_date: '2026-01-01',
        type_renewal_policy: 'period',
        type_renewal_interval_months: SPEC_SHEET_RENEWAL_MONTHS,
      }),
      AS_OF,
      60,
    );
    expect(r.due_date).toBe('2026-06-01');
    expect(r.status).toBe('expired');
    expect(r.rule).toBe('document_expiry');
  });

  it('a document with nothing to go on is still excluded from the dashboard', () => {
    const r = computeStatus(statusInput({ renewal_type: 'hard_expiry' }), AS_OF, 60);
    expect(r.status).toBeNull();
    expect(r.due_date).toBeNull();
    expect(r.rule).toBe('unresolvable');
  });
});

// ---------------------------------------------------------------------------
// THE REGRESSION BLOCK
//
// An earlier draft of the ladder read `primary_metadata.expiration_date` as
// "the date printed on the document". That field is the PRODUCT's shelf life.
// On production 139 of 200 documents carry one and every single one of them is
// a Certificate of Analysis, so the bug would have given each of those 139 a
// renewal due date equal to its product's shelf life, put it on the renewal
// dashboard, and mailed its owner.
//
// These tests exist to make that specific mistake fail loudly if anyone
// reintroduces it.
// ---------------------------------------------------------------------------
describe("a COA's product shelf life is NOT its renewal date", () => {
  // The exact production shape: a COA type (policy 'none'), a printed product
  // expiry, an effective date the annual default could have counted from.
  const coa = (partial: Partial<RenewalPeriodInput> = {}): RenewalPeriodInput =>
    input({
      type_renewal_policy: 'none',
      meta_effective_date: '2026-03-15',
      ...partial,
    });

  it('resolves to no_renewal_period, not to the product date and not to annual', () => {
    const r = resolveRenewalExpiry(coa());
    expect(r.rule).toBe('no_renewal_period');
    expect(r.due_date).toBeNull();
    // The shelf life the certificate prints.
    expect(r.due_date).not.toBe('2026-09-15');
    // What the annual default would have produced from the effective date.
    expect(r.due_date).not.toBe('2027-03-15');
    expect(r.reason).toMatch(/do not renew/i);
  });

  it('the product expiry is not even an input — the field does not exist here', () => {
    // A caller cannot hand `expiration_date` to the resolver: the only expiry
    // input is `meta_document_expires_on`. This assertion is on the TYPE as
    // much as the value — the cast is what proves the field is not read.
    const withProductExpiry = {
      ...coa(),
      // @ts-expect-error `expiration_date` is deliberately not part of the input.
      meta_expiration_date: '2026-09-15',
    } as RenewalPeriodInput;
    expect(resolveRenewalExpiry(withProductExpiry).due_date).toBeNull();
  });

  it('the type exclusion outranks a date printed on the document', () => {
    // Defence in depth: even if an extraction wrongly filled the DOCUMENT
    // expiry on a COA, the type exclusion is categorical and still wins.
    const r = resolveRenewalExpiry(coa({ meta_document_expires_on: '2026-09-15' }));
    expect(r.rule).toBe('no_renewal_period');
    expect(r.due_date).toBeNull();
  });

  it('a human can still date one deliberately, via the canonical field', () => {
    const r = resolveRenewalExpiry(coa({ renewal_due_date: '2027-01-01' }));
    expect(r.due_date).toBe('2027-01-01');
    expect(r.rule).toBe('document_due_date');
  });

  it('or via a period set on that one document', () => {
    const r = resolveRenewalExpiry(coa({ renewal_interval_months: 12 }));
    expect(r.due_date).toBe('2027-03-15');
    expect(r.rule).toBe('document_interval');
  });
});

describe("a certificate's own expiry beats its type's default", () => {
  it('a COI printing 09/01/2027 expires then, not a year after we filed it', () => {
    const r = resolveRenewalExpiry(
      input({
        // Filed under a type that renews annually, with an effective date the
        // annual default would happily count from.
        type_renewal_policy: 'inherit',
        meta_effective_date: '2026-01-01',
        meta_document_expires_on: '2027-09-01',
      }),
    );
    expect(r.due_date).toBe('2027-09-01');
    expect(r.rule).toBe('document_expiry');
    expect(r.due_date).not.toBe('2027-01-01'); // the annual default
  });

  it('and beats an explicitly configured type period too', () => {
    const r = resolveRenewalExpiry(
      input({
        type_renewal_policy: 'period',
        type_renewal_interval_months: 24,
        meta_effective_date: '2026-01-01',
        meta_document_expires_on: '2027-09-01',
      }),
    );
    expect(r.due_date).toBe('2027-09-01');
    expect(r.rule).toBe('document_expiry');
    expect(r.due_date).not.toBe('2028-01-01'); // the two-year type default
  });
});

describe('a reviewer who clears the field means "no renewal"', () => {
  it('a recorded decision with no date stops the defaults dead', () => {
    const r = resolveRenewalExpiry(
      input({
        renewal_decision: 'cleared',
        // Everything a default would need to manufacture a date.
        meta_effective_date: '2026-01-15',
        type_renewal_policy: 'period',
        type_renewal_interval_months: 12,
      }),
    );
    expect(r.rule).toBe('no_renewal_period');
    expect(r.due_date).toBeNull();
    expect(r.due_date).not.toBe('2027-01-15');
    expect(r.reason).toMatch(/cleared/i);
  });

  it('accepting a "does not renew" proposal is recorded, and behaves the same', () => {
    // The decision is keyed on EXISTING, not on being the literal 'cleared'.
    // An accepted no-renewal proposal must not fall through to annual.
    const r = resolveRenewalExpiry(
      input({ renewal_decision: 'accepted', meta_effective_date: '2026-01-15' }),
    );
    expect(r.rule).toBe('no_renewal_period');
    expect(r.due_date).toBeNull();
  });

  it('is distinguishable from nobody having looked, which still gets a default', () => {
    const nobodyLooked = resolveRenewalExpiry(
      input({ renewal_decision: null, meta_effective_date: '2026-01-15' }),
    );
    expect(nobodyLooked.due_date).toBe('2027-01-15');
    expect(nobodyLooked.rule).toBe('system_default_annual');
  });

  it('an UNRESOLVABLE document nobody ruled on is still to be decided, not "does not renew"', () => {
    // The approve-path defect, read from the dashboard's end. A document with a
    // period but no anchor produces no date either way; what must stay
    // different is WHY. No decision → `unresolvable`, which says "we could not
    // work this out" and leaves the question open. A recorded decision →
    // `no_renewal_period`, which says a person answered and closes it.
    const nobodyRuled = resolveRenewalExpiry(input({ renewal_decision: null }));
    expect(nobodyRuled.due_date).toBeNull();
    expect(nobodyRuled.rule).toBe('unresolvable');
    expect(nobodyRuled.period_months).toBe(12);
    expect(nobodyRuled.reason).toMatch(/no effective date|could not be read/i);

    const someoneRuled = resolveRenewalExpiry(input({ renewal_decision: 'cleared' }));
    expect(someoneRuled.due_date).toBeNull();
    expect(someoneRuled.rule).toBe('no_renewal_period');
    expect(someoneRuled.rule).not.toBe(nobodyRuled.rule);

    // And the dashboard row carries that difference through.
    const open = computeStatus(input({ renewal_decision: null }) as RenewalInput, '2026-07-22', 60);
    const closed = computeStatus(
      input({ renewal_decision: 'cleared' }) as RenewalInput,
      '2026-07-22',
      60,
    );
    expect(open.rule).toBe('unresolvable');
    expect(closed.rule).toBe('no_renewal_period');
    // Neither is DUE — an undated record cannot be chased — but only one of
    // them has been answered.
    expect(open.status).toBeNull();
    expect(closed.status).toBeNull();
  });

  it('a confirmed date is read back as the canonical date, not re-derived', () => {
    const r = resolveRenewalExpiry(
      input({
        renewal_decision: 'overridden',
        renewal_due_date: '2028-06-30',
        meta_effective_date: '2026-01-15',
        type_renewal_policy: 'period',
        type_renewal_interval_months: 12,
      }),
    );
    expect(r.due_date).toBe('2028-06-30');
    expect(r.rule).toBe('document_due_date');
  });
});

describe('COA type detection (name match, used only to seed a stored value)', () => {
  it('matches what a tenant actually calls a COA', () => {
    for (const name of [
      'COA',
      'coa',
      'COAs',
      'Certificate of Analysis',
      'Supplier Certificate of Analysis',
      'Certificates of Analysis',
      'Analysis Certificate',
      'C of A',
    ]) {
      expect(looksLikeCoaType(name)).toBe(true);
    }
  });

  it('does NOT match certificates that DO renew — the expensive direction', () => {
    // A false positive here produces silence, not a wrong date: a certificate
    // that lapses and never appears on any dashboard.
    for (const name of [
      'Certificate of Insurance',
      'Certification',
      'Organic Certificate',
      'Third-Party Audit Certificate',
      'Spec Sheet',
      'Cocoas',
      '',
    ]) {
      expect(looksLikeCoaType(name)).toBe(false);
    }
  });

  it('proposes a starting policy from the name and nothing more', () => {
    expect(defaultRenewalPolicyForTypeName('Certificate of Analysis')).toBe('none');
    expect(defaultRenewalPolicyForTypeName('Spec Sheet')).toBe('period');
    expect(defaultRenewalPolicyForTypeName('Certificate of Insurance')).toBe('inherit');
  });
});

describe('the type policy gates whether its period is read at all', () => {
  it("'inherit' ignores a stale months value and uses the annual default", () => {
    // The invariant the API and the 0097 backfill maintain: a non-NULL period
    // exists only under 'period'. If one survives anyway it is not obeyed.
    const r = resolveRenewalExpiry(
      input({
        meta_effective_date: '2026-01-15',
        type_renewal_policy: 'inherit',
        type_renewal_interval_months: 36,
      }),
    );
    expect(r.due_date).toBe('2027-01-15');
    expect(r.rule).toBe('system_default_annual');
  });

  it("'none' is the third state a nullable months column could not express", () => {
    expect(
      resolveRenewalPeriodMonths({
        renewal_interval_months: null,
        type_renewal_policy: 'none',
        type_renewal_interval_months: null,
      }),
    ).toEqual({ months: null, rule: 'no_renewal_period' });
  });
});
