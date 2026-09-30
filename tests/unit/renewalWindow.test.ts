/**
 * Rules table G3 (AJ, ruled 2026-09-20): fixed-window renewal as a general rule
 * type, and the FDA food facility registration type. See shared/renewalPeriod.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  FDA_FOOD_FACILITY_REGISTRATION_WINDOW,
  defaultRenewalSettingForTypeName,
  describeRenewalWindow,
  looksLikeFdaFacilityRegistrationType,
  nextRenewalWindow,
  parseRenewalWindow,
  renewalPeriodLabel,
  renewalRuleLabel,
  resolveRenewalExpiry,
  validateRenewalWindow,
  type RenewalPeriodInput,
  type RenewalWindow,
} from '../../shared/renewalPeriod';

const FDA = FDA_FOOD_FACILITY_REGISTRATION_WINDOW;

function input(over: Partial<RenewalPeriodInput> = {}): RenewalPeriodInput {
  return {
    renewal_type: null,
    renewal_due_date: null,
    renewal_interval_months: null,
    renewal_decision: null,
    type_renewal_policy: 'period',
    type_renewal_interval_months: 24,
    type_renewal_window: FDA,
    meta_document_expires_on: null,
    meta_effective_date: null,
    ...over,
  };
}

describe('nextRenewalWindow — the FDA biennial window', () => {
  it.each([
    // A renewal filed inside the 2024 window is good until the 2026 window closes.
    ['2024-11-15', '2026-10-01', '2026-12-31'],
    // A registration made between windows still renews in the next one.
    ['2025-03-01', '2026-10-01', '2026-12-31'],
    ['2026-09-30', '2026-10-01', '2026-12-31'],
    // Filed ON the opening day: that filing IS the 2026 renewal.
    ['2026-10-01', '2028-10-01', '2028-12-31'],
    ['2026-12-31', '2028-10-01', '2028-12-31'],
  ])('effective %s -> window %s .. %s', (anchor, opens, closes) => {
    expect(nextRenewalWindow(anchor, FDA)).toEqual({ opens, closes });
  });

  it('handles a window that crosses New Year', () => {
    const w: RenewalWindow = { opens: '11-01', closes: '02-28', every_years: 1, reference_year: 2020, source: null };
    expect(nextRenewalWindow('2026-12-15', w)).toEqual({ opens: '2027-11-01', closes: '2028-02-28' });
    expect(nextRenewalWindow('2026-06-01', w)).toEqual({ opens: '2026-11-01', closes: '2027-02-28' });
  });

  it('refuses an unreadable anchor', () => {
    expect(nextRenewalWindow('someday', FDA)).toBeNull();
  });
});

describe('resolveRenewalExpiry with a window', () => {
  it('is due at the close of the next window, whatever the document prints', () => {
    const r = resolveRenewalExpiry(input({ meta_effective_date: '2024-11-15', meta_document_expires_on: '2025-11-15' }));
    expect(r.rule).toBe('document_type_window');
    expect(r.due_date).toBe('2026-12-31');
    expect(r.anchor_date).toBe('2024-11-15');
    expect(r.period_months).toBe(24);
    expect(r.reason).toMatch(/window/i);
    expect(renewalRuleLabel(r)).toMatch(/window/i);
  });

  it('with no effective date there is nothing to count from, and it says so', () => {
    const r = resolveRenewalExpiry(input({ meta_document_expires_on: '2027-01-01' }));
    expect(r.rule).toBe('unresolvable');
    expect(r.due_date).toBeNull();
    expect(r.reason).toMatch(/window/i);
  });

  it('a date a human recorded, a reviewer decision, and a non-renewing type still win', () => {
    expect(resolveRenewalExpiry(input({ renewal_due_date: '2030-01-01', meta_effective_date: '2024-11-15' })).due_date).toBe('2030-01-01');
    expect(resolveRenewalExpiry(input({ renewal_decision: 'cleared', meta_effective_date: '2024-11-15' })).rule).toBe('no_renewal_period');
    expect(resolveRenewalExpiry(input({ type_renewal_policy: 'none', meta_effective_date: '2024-11-15' })).rule).toBe('no_renewal_period');
  });

  it('a period set on this one document is more specific than the type window', () => {
    const r = resolveRenewalExpiry(input({ renewal_interval_months: 12, meta_effective_date: '2024-11-15' }));
    expect(r.rule).toBe('document_interval');
    expect(r.due_date).toBe('2025-11-15');
  });

  it('a window is read ONLY under the period policy', () => {
    const r = resolveRenewalExpiry(
      input({ type_renewal_policy: 'inherit', type_renewal_interval_months: null, meta_effective_date: '2024-11-15' })
    );
    expect(r.rule).toBe('system_default_annual');
    expect(r.due_date).toBe('2025-11-15');
  });

  it('accepts the stored JSON string as well as the object', () => {
    const r = resolveRenewalExpiry(input({ type_renewal_window: JSON.stringify(FDA), meta_effective_date: '2025-03-01' }));
    expect(r.due_date).toBe('2026-12-31');
  });

  it('a corrupt stored window is ignored, not obeyed', () => {
    const r = resolveRenewalExpiry(input({ type_renewal_window: '{"opens":"13-45"}', meta_effective_date: '2025-03-01' }));
    expect(r.rule).toBe('document_type_default');
    expect(r.due_date).toBe('2027-03-01');
  });
});

describe('validateRenewalWindow', () => {
  it('accepts the FDA window and normalizes it', () => {
    const v = validateRenewalWindow({ opens: '10-01', closes: '12-31', every_years: 2, reference_year: 2024 });
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.window).toEqual({ opens: '10-01', closes: '12-31', every_years: 2, reference_year: 2024, source: null });
  });

  it.each([
    [{ opens: '10-01', closes: '12-31', every_years: 0, reference_year: 2024 }, /every_years/],
    [{ opens: '13-01', closes: '12-31', every_years: 2, reference_year: 2024 }, /opens/],
    [{ opens: '02-29', closes: '12-31', every_years: 2, reference_year: 2024 }, /opens/],
    [{ opens: '10-01', closes: '10-01', every_years: 2, reference_year: 2024 }, /differ/],
    [{ opens: '10-01', closes: '12-31', every_years: 2 }, /reference_year/],
    [{ opens: '10-01', closes: '12-31', every_years: 2, reference_year: 2024, extra: 1 }, /unknown/],
    ['nope', /object/],
  ])('refuses %j', (raw, msg) => {
    const v = validateRenewalWindow(raw);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toMatch(msg);
  });

  it('parseRenewalWindow reads null, strings and junk safely', () => {
    expect(parseRenewalWindow(null)).toBeNull();
    expect(parseRenewalWindow('not json')).toBeNull();
    expect(parseRenewalWindow(JSON.stringify(FDA))).toEqual(FDA);
  });
});

describe('the FDA food facility registration type', () => {
  it.each(['FDA Food Facility Registration', 'FDA Registration', 'Food Facility Registration', 'FDA facility registration certificate'])(
    'recognises %s',
    (name) => expect(looksLikeFdaFacilityRegistrationType(name)).toBe(true)
  );

  it.each(['Business License', 'Certificate of Insurance', 'Organic Registration', 'Specification Sheet'])('does not claim %s', (name) => {
    expect(looksLikeFdaFacilityRegistrationType(name)).toBe(false);
  });

  it('starts life as a 24-month period with the regulation window', () => {
    expect(defaultRenewalSettingForTypeName('FDA Food Facility Registration')).toEqual({
      policy: 'period',
      interval_months: 24,
      window: FDA,
    });
    expect(defaultRenewalSettingForTypeName('Business License').window).toBeNull();
  });

  it('cites its source and describes itself in words', () => {
    expect(FDA.source).toMatch(/21 CFR 1\.230/);
    expect(describeRenewalWindow(FDA)).toBe('October 1 to December 31, every 2 years (2024, 2026, ...)');
    expect(renewalPeriodLabel(24, 'period', FDA)).toBe('October 1 to December 31, every 2 years (2024, 2026, ...)');
    expect(renewalPeriodLabel(24, 'period', null)).toBe('2 years');
  });
});
