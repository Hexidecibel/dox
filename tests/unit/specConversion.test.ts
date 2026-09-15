/**
 * Conversions are shown, never silent (SME ruling, 2026-09-14).
 *
 * "Any unit conversion applied to a comparison must be a visible attribute of
 * the compared value (original units, converted units, operator), not a log
 * line." And: "Product-dependent comparisons (per mL vs per g, % w/w vs v/v) go
 * to could-not-check unless the tenant has explicitly enabled the equivalence."
 *
 * So these tests pin three things: the attribute is PRESENT whenever a printed
 * magnitude was scaled or equated, whatever the verdict; it is ABSENT when the
 * value was compared as printed (a chip on every value would be noise that
 * hides the real ones); and a refusal says, from the rule that fired, why.
 */

import { describe, it, expect } from 'vitest';
import {
  parseMeasuredValue,
  normalizeUnit,
  compareToLimit,
  checkConfiguredLimits,
  checkPrintedSpecs,
  formatUnitConversion,
  type SpecLimit,
} from '../../shared/specCheck';
import { buildLimitSnapshot } from '../../shared/specSnapshot';

const lim = (partial: Partial<SpecLimit>): SpecLimit => ({
  operator: '<=',
  min: null,
  max: null,
  unit: null,
  raw: '',
  ...partial,
});

const tests = [{ id: 'st_c', name: 'Coliform', aliases: [] as string[] }];
const limits = [
  {
    id: 'l1',
    spec_test_id: 'st_c',
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

describe('a conversion is an attribute of the compared value', () => {
  it('carries the tenant equivalence as a conversion with from, to and rule', () => {
    const cmp = compareToLimit(parseMeasuredValue('120 cfu/mL'), lim({ max: 20000, unit: 'CFU/g' }), {
      volume_mass_equivalent: true,
    });
    expect(cmp.verdict).toBe('in_spec');
    expect(cmp.unit_equivalence_applied).toBe(true);
    expect(cmp.conversion).toEqual({
      from: 'cfu/mL',
      to: 'CFU/g',
      rule: 'tenant_volume_mass',
      factor: 1,
      operation: '1:1',
    });
    expect(formatUnitConversion(cmp.conversion!)).toBe('Converted: cfu/mL → CFU/g (tenant setting)');
  });

  it('carries sample-basis arithmetic too, and names it in the reason', () => {
    const cmp = compareToLimit(parseMeasuredValue('500 CFU/100g'), lim({ max: 10, unit: 'CFU/g' }));
    expect(cmp.verdict).toBe('in_spec');
    expect(cmp.value_num).toBe(5);
    expect(cmp.unit_equivalence_applied).toBeUndefined();
    expect(cmp.conversion).toMatchObject({
      from: 'CFU/100g',
      to: 'CFU/g',
      rule: 'sample_basis',
      operation: '÷ 100',
    });
    expect(cmp.reason).toContain('CFU/100g converted to CFU/g, ÷ 100');
    expect(formatUnitConversion(cmp.conversion!)).toBe('Converted: CFU/100g → CFU/g (÷ 100)');
  });

  it('is present on a failure and on a could-not-check that still converted', () => {
    const out = compareToLimit(parseMeasuredValue('5 cfu/0.1g'), lim({ max: 10, unit: 'CFU/g' }));
    expect(out.verdict).toBe('out_of_spec');
    expect(out.conversion).toMatchObject({ rule: 'sample_basis', operation: '× 10' });

    const straddle = compareToLimit(parseMeasuredValue('<5 cfu/0.1g'), lim({ max: 10, unit: 'CFU/g' }));
    expect(straddle.verdict).toBe('not_checked');
    expect(straddle.conversion).toMatchObject({ rule: 'sample_basis' });
  });

  it('is absent when the value was compared as printed', () => {
    expect(
      compareToLimit(parseMeasuredValue('5 CFU/g'), lim({ max: 10, unit: 'CFU/g' })).conversion
    ).toBeUndefined();
    // No unit on the result is not a conversion either — nothing was changed.
    expect(compareToLimit(parseMeasuredValue('5'), lim({ max: 10, unit: 'CFU/g' })).conversion).toBeUndefined();
  });

  it('is absent on a refusal, whose reason says why from the rule that fired', () => {
    const vol = compareToLimit(parseMeasuredValue('120 CFU/mL'), lim({ max: 20000, unit: 'CFU/g' }));
    expect(vol.verdict).toBe('not_checked');
    expect(vol.conversion).toBeUndefined();
    // The long-standing prefix survives (the spec corpus matches on it) …
    expect(vol.reason).toContain('result is in CFU/mL but the limit is in CFU/g — not comparable');
    // … and the rule behind the refusal follows it.
    expect(vol.reason).toContain('per-volume against per-mass depends on the product');

    const method = compareToLimit(parseMeasuredValue('3 MPN/g'), lim({ max: 10, unit: 'CFU/g' }));
    expect(method.reason).toContain('(different counting methods)');
  });

  it('rides through the configured-limit checker onto the verdict and its message', () => {
    const sources = [
      {
        scope: 'ai_fields',
        tables: [{ name: 'm', headers: ['Test', 'Result', 'Units'], rows: [['Coliform', '500', 'CFU/100g']] }],
      },
    ];
    const r = checkConfiguredLimits(sources, tests, limits, {}, { includePasses: true });
    expect(r.verdicts[0].verdict).toBe('in_spec');
    expect(r.verdicts[0].conversion).toMatchObject({ rule: 'sample_basis', from: 'CFU/100g', to: 'CFU/g' });
    expect(r.verdicts[0].message).toContain('CFU/100g converted to CFU/g, ÷ 100');
  });

  it('rides through the printed-spec checker too', () => {
    const printed = checkPrintedSpecs([
      {
        scope: 'ai_fields',
        tables: [
          {
            name: 'm',
            headers: ['Test', 'Specification', 'Result', 'Units'],
            rows: [['Coliform', '≤10 CFU/g', '5000', 'CFU/100g']],
          },
        ],
      },
    ]);
    expect(printed).toHaveLength(1);
    expect(printed[0].verdict).toBe('out_of_spec');
    expect(printed[0].conversion).toMatchObject({ rule: 'sample_basis', operation: '÷ 100' });
  });

  it('is frozen into limit_snapshot, beside the older unit_equivalence key', () => {
    const sources = [
      {
        scope: 'ai_fields',
        tables: [{ name: 'm', headers: ['Test', 'Result', 'Units'], rows: [['Coliform', '4', 'CFU/mL']] }],
      },
    ];
    const r = checkConfiguredLimits(sources, tests, limits, {}, {
      includePasses: true,
      unitPolicy: { volume_mass_equivalent: true },
    });
    const snap = JSON.parse(buildLimitSnapshot(r.verdicts[0], limits)!);
    expect(snap.unit_equivalence).toBe('volume_mass');
    expect(snap.conversion).toEqual({
      from: 'CFU/mL',
      to: 'CFU/g',
      rule: 'tenant_volume_mass',
      factor: 1,
      operation: '1:1',
    });

    const plain = checkConfiguredLimits(
      [{ scope: 'ai_fields', tables: [{ name: 'm', headers: ['Test', 'Result', 'Units'], rows: [['Coliform', '4', 'CFU/g']] }] }],
      tests,
      limits,
      {},
      { includePasses: true }
    );
    const plainSnap = JSON.parse(buildLimitSnapshot(plain.verdicts[0], limits)!);
    expect(plainSnap.conversion).toBeUndefined();
    expect(plainSnap.unit_equivalence).toBeUndefined();
  });
});

describe('% w/w against % v/v is product-dependent and never judged', () => {
  it('keeps the stated basis of a percentage', () => {
    expect(normalizeUnit('% w/w').family).toBe('percent:w/w');
    expect(normalizeUnit('%v/v').family).toBe('percent:v/v');
    expect(normalizeUnit('% w/v').family).toBe('percent:w/v');
    expect(normalizeUnit('%').family).toBe('percent');
  });

  it('refuses w/w against v/v, even with the tenant equivalence on', () => {
    const cmp = compareToLimit(
      parseMeasuredValue('3.5 % v/v'),
      lim({ operator: '>=', min: 3.25, unit: '% w/w' }),
      { volume_mass_equivalent: true }
    );
    expect(cmp.verdict).toBe('not_checked');
    expect(cmp.reason).toContain('depends on the product');
    expect(cmp.conversion).toBeUndefined();
  });

  it('still compares a bare % against a stated basis, as it always has', () => {
    const cmp = compareToLimit(parseMeasuredValue('3.5%'), lim({ operator: '>=', min: 3.25, unit: '% w/w' }));
    expect(cmp.verdict).toBe('in_spec');
    expect(cmp.conversion).toBeUndefined();
  });
});
