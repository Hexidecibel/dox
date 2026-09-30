/**
 * Rules table D2 (distinction ruled 2026-09-14): inside "could not check",
 * "known wrong by your definitions" and "just verify this" are different work
 * and are presented differently. See `unitRefusalKind` / `notCheckedKindOf`
 * in shared/specCheck.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  checkConfiguredLimits,
  compareToLimit,
  normalizeUnit,
  notCheckedKindOf,
  parseMeasuredValue,
  unitRefusalKind,
  NOT_CHECKED_KIND_LABELS,
  type SpecLimit,
} from '../../shared/specCheck';

const kind = (from: string, to: string) => unitRefusalKind(normalizeUnit(from), normalizeUnit(to));

describe('unitRefusalKind', () => {
  it.each([
    ['%', 'CFU/g', 'a percent where the configuration counts colonies'],
    ['CFU/g', '%', 'a count where the configuration says percent'],
    ['MPN/g', 'CFU/g', 'a different counting method (E1)'],
    ['cells/mL', 'CFU/mL', 'a cell count is not a colony count'],
    ['pH', '%', 'pH against percent'],
    ['CFU/g', 'mg/kg', 'a count against a concentration'],
  ])('%s against %s is a known conflict (%s)', (from, to) => {
    expect(kind(from, to)).toBe('known_conflict');
  });

  it.each([
    ['CFU/mL', 'CFU/g', 'volume against mass basis is product-dependent (C2)'],
    ['% v/v', '% w/w', 'percent bases depend on the product'],
    ['mg/L', 'ppm', 'mass-per-volume against a mass fraction needs the density'],
    ['log CFU/g', 'CFU/g', 'log against linear is refused by policy, not a contradiction'],
    ['per ml.', 'CFU/g', 'a method-less count is missing a fact, not contradicting one'],
    ['furlongs', 'CFU/g', 'an unit nobody recognises'],
    ['CFU/oz', 'CFU/g', 'ounce could be weight or volume'],
  ])('%s against %s is verify (%s)', (from, to) => {
    expect(kind(from, to)).toBe('verify');
  });
});

describe('compareToLimit carries the kind', () => {
  const ceiling = (unit: string): SpecLimit =>
    ({ operator: '<=', min: null, max: 10, unit, raw: '<= 10' });

  it('a percent against a CFU limit is known wrong', () => {
    const cmp = compareToLimit(parseMeasuredValue('24.26%'), ceiling('CFU/g'));
    expect(cmp.verdict).toBe('not_checked');
    expect(cmp.not_checked_kind).toBe('known_conflict');
    expect(notCheckedKindOf(cmp)).toBe('known_conflict');
  });

  it('a censored result that straddles the limit is verify', () => {
    const cmp = compareToLimit(parseMeasuredValue('<50'), ceiling('CFU/g'));
    expect(cmp.verdict).toBe('not_checked');
    expect(notCheckedKindOf(cmp)).toBe('verify');
  });

  it('a judged result has no kind', () => {
    const cmp = compareToLimit(parseMeasuredValue('5 CFU/g'), ceiling('CFU/g'));
    expect(cmp.verdict).toBe('in_spec');
    expect(notCheckedKindOf(cmp)).toBeNull();
  });

  it('the two kinds are labelled in words', () => {
    expect(NOT_CHECKED_KIND_LABELS.known_conflict.label).toMatch(/configuration/i);
    expect(NOT_CHECKED_KIND_LABELS.verify.label).toMatch(/verify/i);
  });
});

describe('D2 on the configured-limit path', () => {
  const tests = [{ id: 'st_coli', name: 'Coliform', aliases: [] }];
  const limits = [
    {
      id: 'l1',
      spec_test_id: 'st_coli',
      operator: '<=' as const,
      value_min: null,
      value_max: 10,
      unit: 'CFU/g',
      severity: 'alert' as const,
      active: true,
      supplier_id: null,
      document_type_id: null,
      product_id: null,
    },
  ];
  const judge = (result: string, unit: string) =>
    checkConfiguredLimits(
      [{ scope: 'ai_fields', tables: [{ name: 'micro', headers: ['test', 'result', 'units'], rows: [['Coliform', result, unit]] }] }],
      tests,
      limits,
      {}
    ).verdicts[0];

  it('a result in a unit of another kind than OUR limit is known wrong', () => {
    const v = judge('3', 'MPN/g');
    expect(v.verdict).toBe('not_checked');
    expect(notCheckedKindOf(v)).toBe('known_conflict');
  });

  it('a per-mL result against a per-g limit is verify (product-dependent, C2)', () => {
    const v = judge('3', 'CFU/mL');
    expect(v.verdict).toBe('not_checked');
    expect(notCheckedKindOf(v)).toBe('verify');
    expect(v.not_checked_kind).toBeUndefined();
  });

  it('a censored result is verify', () => {
    expect(notCheckedKindOf(judge('<50', 'CFU/g'))).toBe('verify');
  });
});
