/**
 * Could-not-check results a person must be TOLD about (rules table E1/E2,
 * ruled 2026-09-27).
 *
 * E1: MPN against CFU is never judged (D1) — and it notifies, every time.
 * E2: a presence/absence result on a smaller sample than the limit requires
 *     notifies, every time. (The hold half of E2 is out of scope: dox has no hold.)
 *
 * What is pinned here is the SHAPE of that: the verdict stays `not_checked`
 * (three states, no fourth), it carries a machine-readable category, and every
 * OTHER could-not-check reason carries none — so the alert path can never
 * start mailing about a censored "<50".
 */

import { describe, it, expect } from 'vitest';
import {
  compareToLimit,
  parseMeasuredValue,
  checkConfiguredLimits,
  isNotifyOnlyVerdict,
  normalizeUnit,
  unitRefusalCategory,
  type SpecLimit,
} from '../../shared/specCheck';

const lim = (partial: Partial<SpecLimit>): SpecLimit => ({
  operator: '<=',
  min: null,
  max: null,
  unit: null,
  raw: '',
  ...partial,
});

describe('unitRefusalCategory', () => {
  it('calls CFU against MPN a method mismatch, either way round', () => {
    expect(unitRefusalCategory(normalizeUnit('MPN/g'), normalizeUnit('CFU/g'))).toBe('method_mismatch');
    expect(unitRefusalCategory(normalizeUnit('CFU/g'), normalizeUnit('MPN/g'))).toBe('method_mismatch');
  });

  it('calls log MPN against log CFU a method mismatch too', () => {
    expect(unitRefusalCategory(normalizeUnit('log MPN/g'), normalizeUnit('log CFU/g'))).toBe('method_mismatch');
  });

  it('does not call anything else a method mismatch', () => {
    // basis, not method — a product question, not E1
    expect(unitRefusalCategory(normalizeUnit('CFU/mL'), normalizeUnit('CFU/g'))).toBeNull();
    // a cell count is a different measurement
    expect(unitRefusalCategory(normalizeUnit('cells/mL'), normalizeUnit('CFU/mL'))).toBeNull();
    // log against linear is a scale question
    expect(unitRefusalCategory(normalizeUnit('log MPN/g'), normalizeUnit('CFU/g'))).toBeNull();
    // a count with no method printed is a missing fact, not a contradiction
    expect(unitRefusalCategory(normalizeUnit('/g'), normalizeUnit('CFU/g'))).toBeNull();
    expect(unitRefusalCategory(normalizeUnit('%'), normalizeUnit('CFU/g'))).toBeNull();
  });
});

describe('compareToLimit — the notify categories', () => {
  it('E1: MPN against a CFU limit is not_checked AND categorised, never converted', () => {
    const c = compareToLimit(parseMeasuredValue('3 MPN/g'), lim({ max: 10, unit: 'CFU/g' }));
    expect(c.verdict).toBe('not_checked');
    expect(c.not_checked_category).toBe('method_mismatch');
    expect(c.reason).toMatch(/different counting methods/);
  });

  it('E2: absent in 10 g against absent in 25 g is a sample-basis mismatch', () => {
    const c = compareToLimit(
      parseMeasuredValue('Negative/10g'),
      lim({ operator: 'absent', basis_grams: 25, raw: 'Absent/25g' })
    );
    expect(c.verdict).toBe('not_checked');
    expect(c.not_checked_category).toBe('sample_basis_mismatch');
  });

  it('a larger sample than required is simply a pass, with no category', () => {
    const c = compareToLimit(
      parseMeasuredValue('Negative/375g'),
      lim({ operator: 'absent', basis_grams: 25, raw: 'Absent/25g' })
    );
    expect(c.verdict).toBe('in_spec');
    expect(c.not_checked_category).toBeUndefined();
  });

  it('every OTHER could-not-check carries no category — the censored straddle stays queue-only', () => {
    const cases = [
      compareToLimit(parseMeasuredValue('<50 CFU/g'), lim({ max: 10, unit: 'CFU/g' })),
      compareToLimit(parseMeasuredValue('120 CFU/mL'), lim({ max: 10, unit: 'CFU/g' })),
      compareToLimit(parseMeasuredValue('<1'), lim({ operator: 'absent' })),
    ];
    for (const c of cases) {
      expect(c.verdict).toBe('not_checked');
      expect(c.not_checked_category).toBeUndefined();
    }
  });
});

describe('checkConfiguredLimits — the category reaches the verdict', () => {
  const tests = [
    { id: 'st_ecoli', name: 'E. coli', aliases: [] },
    { id: 'st_salm', name: 'Salmonella', aliases: [] },
  ];
  const base = {
    value_min: null,
    severity: 'alert' as const,
    active: true,
    supplier_id: null,
    document_type_id: null,
    product_id: null,
  };
  const limits = [
    { ...base, id: 'l_ecoli', spec_test_id: 'st_ecoli', operator: '<=' as const, value_max: 10, unit: 'CFU/g' },
    { ...base, id: 'l_salm', spec_test_id: 'st_salm', operator: 'absent' as const, value_max: null, unit: 'per 25 g' },
  ];
  const src = (rows: string[][]) => [
    { scope: 'ai_fields', tables: [{ name: 'micro', headers: ['test', 'result', 'units'], rows }] },
  ];

  it('an E. coli MPN result against our CFU limit is notify-only', () => {
    const { verdicts } = checkConfiguredLimits(src([['E. coli', '3', 'MPN/g']]), tests, limits, {});
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]).toMatchObject({ verdict: 'not_checked', not_checked_category: 'method_mismatch' });
    expect(isNotifyOnlyVerdict(verdicts[0])).toBe(true);
  });

  it('reads the sample size off our absence limit, so "absent in 10 g" is caught against it', () => {
    const { verdicts } = checkConfiguredLimits(src([['Salmonella', 'Negative/10g', '']]), tests, limits, {});
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]).toMatchObject({ verdict: 'not_checked', not_checked_category: 'sample_basis_mismatch' });
    expect(isNotifyOnlyVerdict(verdicts[0])).toBe(true);
  });

  it('a plain censored could-not-check is NOT notify-only', () => {
    const { verdicts } = checkConfiguredLimits(src([['E. coli', '<50', 'CFU/g']]), tests, limits, {});
    expect(verdicts[0].verdict).toBe('not_checked');
    expect(isNotifyOnlyVerdict(verdicts[0])).toBe(false);
  });

  it('a judged failure is never notify-only', () => {
    const { verdicts } = checkConfiguredLimits(src([['E. coli', '40', 'CFU/g']]), tests, limits, {});
    expect(verdicts[0].verdict).toBe('out_of_spec');
    expect(isNotifyOnlyVerdict(verdicts[0])).toBe(false);
  });
});
