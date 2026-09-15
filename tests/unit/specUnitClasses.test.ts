/**
 * Unit spellings and unit classes (SME rulings, 2026-09-14).
 *
 *   - Pure arithmetic is automated and VISIBLY flagged: every such comparison
 *     carries `conversion`, even at 1:1.
 *   - Product-dependent comparisons (per mL vs per g, % w/w vs v/v, mass fraction
 *     vs mass per volume) are could-not-check unless the tenant enabled the one
 *     equivalence that exists (0093).
 *   - Anything that cannot be fully confirmed is could-not-check, with a reason
 *     taken from the rule that fired.
 *
 * The spellings are the ones the production corpus actually prints (Andersen's
 * "per ml.", Cheese Merchants' "/g", "g/100g", "mg/kg", "pH Units") plus the
 * classes the brief named.
 */
import { describe, it, expect } from 'vitest';
import {
  normalizeUnit,
  parseMeasuredValue,
  compareToLimit,
  checkConfiguredLimits,
  checkPrintedSpecs,
  checkRequiredAnalytes,
  matchSpecTest,
  yeastMoldPart,
  yeastMoldMismatch,
  formatUnitConversion,
  type SpecLimit,
  type SpecTestDef,
  type ConfiguredLimit,
} from '../../shared/specCheck';
// @ts-expect-error — generated CJS bundle, no types.
import compiled from '../../bin/lib/shared/specCheck.js';

const lim = (partial: Partial<SpecLimit>): SpecLimit => ({
  operator: '<=',
  min: null,
  max: null,
  unit: null,
  raw: '',
  ...partial,
});

const judge = (value: string, limit: Partial<SpecLimit>, policy = {}) =>
  compareToLimit(parseMeasuredValue(value), lim(limit), policy);

const EQUIV = { volume_mass_equivalent: true };

describe('count spellings from the corpus', () => {
  it('reads a count whose method is not printed as a method-less count, not as an unknown unit', () => {
    for (const [raw, family] of [
      ['per ml.', 'any:volume'],
      ['per ml', 'any:volume'],
      ['per mL', 'any:volume'],
      ['/ml', 'any:volume'],
      ['/g', 'any:mass'],
      ['per gram', 'any:mass'],
    ] as const) {
      expect(normalizeUnit(raw).family, raw).toBe(family);
    }
    const per25 = normalizeUnit('per 25g');
    expect(per25.family).toBe('any:mass');
    expect(per25.perBasis).toBe(25);
  });

  it('still reads the method when one is printed, trailing full stop and "per" included', () => {
    expect(normalizeUnit('cfu per gram').family).toBe('cfu:mass');
    expect(normalizeUnit('CFU/g.').family).toBe('cfu:mass');
    expect(normalizeUnit('MPN/g').family).toBe('mpn:mass');
    expect(normalizeUnit('%.').family).toBe('percent');
    expect(normalizeUnit('pH Units').family).toBe('ph');
  });

  it('never reads a bare mass or a sample size as a count basis', () => {
    expect(normalizeUnit('g').family).toBe('other:g');
    expect(normalizeUnit('25g').family).toBe('other:25g');
    expect(normalizeUnit('in 25/g').family.startsWith('other:')).toBe(true);
  });

  it('keeps the slash on a trailing "/g" instead of clipping it to a mass', () => {
    expect(parseMeasuredValue('< 10 /g').unit).toBe('/g');
    expect(parseMeasuredValue('< 1000/g').unit).toBe('/g');
    expect(parseMeasuredValue('40 CFU/g').unit).toBe('CFU/g');
  });

  it('refuses a method-less count against a CFU limit — even with the tenant equivalence on — and says why', () => {
    // Andersen: the only "per ml." rows on production are the certification
    // paragraph's regulatory thresholds lifted into the results table.
    for (const policy of [{}, EQUIV]) {
      const cmp = judge('100,000 per ml.', { max: 20000, unit: 'CFU/g' }, policy);
      expect(cmp.verdict).toBe('not_checked');
      expect(cmp.reason).toContain('not comparable');
      expect(cmp.reason).toContain('"per ml." states a basis but no counting method');
      expect(cmp.conversion).toBeUndefined();
    }
    expect(judge('5 per ml.', { max: 10, unit: 'CFU/mL' }).verdict).toBe('not_checked');
  });

  it('compares a method-less count with a limit printed the same way', () => {
    const cmp = judge('5,000 per ml', { max: 100000, unit: 'per ml.' });
    expect(cmp.verdict).toBe('in_spec');
    expect(cmp.conversion).toBeUndefined();
  });

  it('judges the Andersen row shape end to end as could-not-check, not as a failure', () => {
    const tests: SpecTestDef[] = [
      { id: 'st_spc', name: 'Standard Plate Count', aliases: ['Bacteria Standard Plate Count'] },
    ];
    const limits: ConfiguredLimit[] = [
      {
        id: 'l_spc', spec_test_id: 'st_spc', operator: '<=', value_min: null, value_max: 20000,
        unit: 'CFU/g', severity: 'alert', active: true, supplier_id: null, document_type_id: null, product_id: null,
      },
    ];
    const sources = [
      {
        scope: 'ai_fields',
        tables: [
          {
            name: 'r',
            headers: ['test', 'result', 'units', 'pass_fail'],
            rows: [['BACTERIA STANDARD PLATE COUNT', '100,000', 'per ml.', 'Pass']],
          },
        ],
      },
    ];
    const r = checkConfiguredLimits(sources, tests, limits, {}, { includePasses: true, unitPolicy: EQUIV });
    expect(r.verdicts).toHaveLength(1);
    expect(r.verdicts[0].verdict).toBe('not_checked');
    expect(r.verdicts[0].message).toContain('no counting method');
  });
});

describe('cells/mL is a cell count, not a colony count', () => {
  it('has its own kind', () => {
    expect(normalizeUnit('cells/mL').family).toBe('cells:volume');
    expect(normalizeUnit('cells per ml').family).toBe('cells:volume');
    expect(normalizeUnit('SCC/mL').family).toBe('cells:volume');
  });

  it('compares only with the same kind', () => {
    expect(judge('180,000 cells/mL', { max: 400000, unit: 'cells/mL' }).verdict).toBe('in_spec');
    expect(judge('500,000 cells/mL', { max: 400000, unit: 'cells/mL' }).verdict).toBe('out_of_spec');

    const cfu = judge('180,000 cells/mL', { max: 400000, unit: 'CFU/mL' });
    expect(cfu.verdict).toBe('not_checked');
    expect(cfu.reason).toContain('a cell count is not a colony count');
  });

  it('is not reached by the tenant volume/mass equivalence', () => {
    const cmp = judge('180,000 cells/mL', { max: 400000, unit: 'cells/g' }, EQUIV);
    expect(cmp.verdict).toBe('not_checked');
    expect(cmp.unit_equivalence_applied).toBeUndefined();
  });
});

describe('mass fractions are exact arithmetic, and flagged as a conversion', () => {
  it('puts every spelling on a ppm footing', () => {
    for (const raw of ['ppm', 'mg/kg', 'µg/g', 'μg/g', 'ug/g', 'mcg/g', 'mg per kg', 'mg/kg.', 'MG/KG']) {
      const u = normalizeUnit(raw);
      expect(u.family, raw).toBe('massfrac');
      expect(u.perBasis, raw).toBe(1);
    }
    expect(normalizeUnit('ppb').perBasis).toBe(1000);
    expect(normalizeUnit('µg/kg').perBasis).toBe(1000);
    expect(normalizeUnit('mg/100g').perBasis).toBe(0.1);
    expect(normalizeUnit('g/100g').perBasis).toBe(0.0001);
  });

  it('µg/g no longer falls to other:gg', () => {
    expect(normalizeUnit('µg/g').family).not.toBe('other:gg');
  });

  it('µg/g against ppm is a 1:1 conversion — still shown', () => {
    const cmp = judge('0.8 µg/g', { max: 1, unit: 'ppm' });
    expect(cmp.verdict).toBe('in_spec');
    expect(cmp.conversion).toEqual({ from: 'µg/g', to: 'ppm', rule: 'unit_arithmetic', factor: 1, operation: '1:1' });
    expect(formatUnitConversion(cmp.conversion!)).toBe('Converted: µg/g → ppm (1:1)');
  });

  it('ppb against mg/kg', () => {
    const cmp = judge('500 ppb', { max: 1, unit: 'mg/kg' });
    expect(cmp.verdict).toBe('in_spec');
    expect(cmp.value_num).toBe(0.5);
    expect(cmp.conversion).toMatchObject({ rule: 'unit_arithmetic', operation: '÷ 1000' });
    expect(cmp.reason).toContain('ppb converted to mg/kg, ÷ 1000');
  });

  it('mg/100g is 10 ppm, and a value exactly on the limit stays on it', () => {
    const over = judge('15 mg/100g', { max: 100, unit: 'ppm' });
    expect(over.verdict).toBe('out_of_spec');
    expect(over.value_num).toBe(150);
    expect(over.conversion).toMatchObject({ rule: 'unit_arithmetic', operation: '× 10' });

    const onTheLine = judge('10 mg/100g', { max: 100, unit: 'mg/kg' });
    expect(onTheLine.verdict).toBe('in_spec');
    expect(onTheLine.value_num).toBe(100);
  });

  it('1% is 10,000 ppm, in both directions', () => {
    const pct = judge('0.02 %', { max: 100, unit: 'ppm' });
    expect(pct.verdict).toBe('out_of_spec');
    expect(pct.value_num).toBe(200);
    expect(pct.conversion).toMatchObject({ rule: 'unit_arithmetic', from: '%', to: 'ppm', operation: '× 10000' });

    const ppm = judge('15000 mg/kg', { operator: '>=', min: 1.2, unit: '% w/w' });
    expect(ppm.verdict).toBe('in_spec');
    expect(ppm.value_num).toBe(1.5);

    expect(judge('3.5 g/100g', { operator: '>=', min: 3.25, unit: '%' }).verdict).toBe('in_spec');
  });

  it('refuses % v/v against a mass fraction — that depends on the product', () => {
    const cmp = judge('3 % v/v', { max: 10000, unit: 'ppm' });
    expect(cmp.verdict).toBe('not_checked');
    expect(cmp.reason).toContain('depends on the product');
    expect(cmp.conversion).toBeUndefined();
  });

  it('refuses a concentration against a count', () => {
    const cmp = judge('5 ppm', { max: 10, unit: 'CFU/g' });
    expect(cmp.verdict).toBe('not_checked');
    expect(cmp.reason).toContain('a count and a concentration measure different things');
  });
});

describe('mg/L is its own volume-concentration class', () => {
  it('parses mass-per-volume spellings onto mg/L', () => {
    expect(normalizeUnit('mg/L').family).toBe('massvol');
    expect(normalizeUnit('µg/mL').perBasis).toBe(1);
    expect(normalizeUnit('g/100 mL').perBasis).toBe(0.0001);
  });

  it('compares within the class, flagged', () => {
    const cmp = judge('5 mg/L', { max: 10, unit: 'µg/mL' });
    expect(cmp.verdict).toBe('in_spec');
    expect(cmp.conversion).toMatchObject({ rule: 'unit_arithmetic', operation: '1:1' });
    expect(judge('0.5 % w/v', { max: 10000, unit: 'mg/L' }).verdict).toBe('in_spec');
    expect(judge('1.5 % w/v', { max: 10000, unit: 'mg/L' }).verdict).toBe('out_of_spec');
  });

  it('refuses mg/L against ppm, and a bare % against mg/L — density is the product\'s', () => {
    for (const [value, unit] of [['5 mg/L', 'ppm'], ['5 ppm', 'mg/L'], ['0.5 %', 'mg/L']] as const) {
      const cmp = judge(value, { max: 10, unit });
      expect(cmp.verdict, `${value} vs ${unit}`).toBe('not_checked');
      expect(cmp.conversion).toBeUndefined();
    }
    expect(judge('5 mg/L', { max: 10, unit: 'ppm' }).reason).toContain("depends on the product's density");
  });

  it('is not reached by the tenant equivalence', () => {
    expect(judge('5 mg/L', { max: 10, unit: 'mg/kg' }, EQUIV).verdict).toBe('not_checked');
  });
});

describe('log counts are their own family', () => {
  it('parses the log spellings without claiming a linear CFU', () => {
    expect(normalizeUnit('log cfu/g').family).toBe('log:cfu:mass');
    expect(normalizeUnit('log10 CFU/mL').family).toBe('log:cfu:volume');
    expect(normalizeUnit('Log CFU/g').family).toBe('log:cfu:mass');
    expect(normalizeUnit('log10').family).toBe('log:unspecified');
    expect(normalizeUnit('log cfu/g').family.startsWith('cfu')).toBe(false);
  });

  it('refuses a log count against a linear limit, with a clear reason', () => {
    const cmp = judge('2.3 log cfu/g', { max: 10, unit: 'CFU/g' });
    expect(cmp.verdict).toBe('not_checked');
    expect(cmp.reason).toContain('a log count and a linear count are on different scales');
    expect(judge('500 CFU/g', { max: 3, unit: 'log cfu/g' }).verdict).toBe('not_checked');
  });

  it('judges a log count against a log limit on the same basis', () => {
    expect(judge('2.3 log cfu/g', { max: 3, unit: 'log CFU/g' }).verdict).toBe('in_spec');
    expect(judge('3.4 log10 cfu/g', { max: 3, unit: 'log cfu/g' }).verdict).toBe('out_of_spec');
    expect(judge('2.3 log cfu/g', { max: 3, unit: 'log10' }).verdict).toBe('in_spec');
  });

  it('never shifts a log basis', () => {
    expect(judge('2.3 log cfu/100g', { max: 3, unit: 'log cfu/g' }).verdict).toBe('not_checked');
    expect(judge('2.3 log cfu/mL', { max: 3, unit: 'log cfu/g' }, EQUIV).verdict).toBe('not_checked');
  });
});

describe('ounces: weight or fluid, and the page must say which', () => {
  it('files a bare ounce as its own basis, a fluid ounce as volume and a weight ounce as mass', () => {
    expect(normalizeUnit('cfu/oz').family).toBe('cfu:oz');
    const fl = normalizeUnit('CFU/fl oz');
    expect(fl.family).toBe('cfu:volume');
    expect(fl.perBasis).toBeCloseTo(29.5735);
    expect(normalizeUnit('CFU/fl. oz.').family).toBe('cfu:volume');
    const wt = normalizeUnit('cfu/oz wt');
    expect(wt.family).toBe('cfu:mass');
    expect(wt.perBasis).toBeCloseTo(28.3495);
    expect(normalizeUnit('CFU/avdp oz').family).toBe('cfu:mass');
  });

  it('refuses a bare ounce against grams or millilitres, whatever the tenant setting', () => {
    for (const unit of ['CFU/g', 'CFU/mL']) {
      for (const policy of [{}, EQUIV]) {
        const cmp = judge('50 cfu/oz', { max: 10, unit }, policy);
        expect(cmp.verdict, `${unit} ${JSON.stringify(policy)}`).toBe('not_checked');
        expect(cmp.reason).toContain('ounce could be weight or fluid ounce');
      }
    }
  });

  it('compares a bare ounce with an ounce limit, sample amount included', () => {
    expect(judge('50 cfu/oz', { max: 100, unit: 'CFU/oz' }).verdict).toBe('in_spec');
    const ten = judge('500 cfu/10 oz', { max: 10, unit: 'CFU/oz' });
    expect(ten.verdict).toBe('out_of_spec');
    expect(ten.value_num).toBe(50);
  });

  it('converts a stated fluid or weight ounce like any other sample basis', () => {
    const fl = judge('295.735 cfu/fl oz', { max: 10, unit: 'CFU/mL' });
    expect(fl.verdict).toBe('in_spec');
    expect(fl.value_num).toBeCloseTo(10);
    expect(fl.conversion).toMatchObject({ rule: 'sample_basis' });

    const wt = judge('567 cfu/oz wt', { max: 10, unit: 'CFU/g' });
    expect(wt.verdict).toBe('out_of_spec');
    expect(wt.value_num).toBeCloseTo(20, 1);
  });
});

describe('the 0093 tenant equivalence still works and still names itself', () => {
  const tests: SpecTestDef[] = [{ id: 'st_c', name: 'Coliform', aliases: [] }];
  const limits: ConfiguredLimit[] = [
    {
      id: 'l1', spec_test_id: 'st_c', operator: '<=', value_min: null, value_max: 10, unit: 'CFU/g',
      severity: 'alert', active: true, supplier_id: null, document_type_id: null, product_id: null,
    },
  ];
  const sources = (value: string, unit: string) => [
    { scope: 'ai_fields', tables: [{ name: 'm', headers: ['Test', 'Result', 'Units'], rows: [['Coliform', value, unit]] }] },
  ];

  it('judges CFU/mL as CFU/g only when the tenant said so', () => {
    const on = checkConfiguredLimits(sources('4', 'cfu/mL'), tests, limits, {}, { includePasses: true, unitPolicy: EQUIV });
    expect(on.verdicts[0].verdict).toBe('in_spec');
    expect(on.verdicts[0].unit_equivalence_applied).toBe(true);
    expect(on.verdicts[0].conversion).toMatchObject({ rule: 'tenant_volume_mass', operation: '1:1' });
    expect(on.verdicts[0].message).toContain("cfu/mL judged as CFU/g, per this tenant's setting");

    const off = checkConfiguredLimits(sources('4', 'cfu/mL'), tests, limits, {}, { includePasses: true });
    expect(off.verdicts[0].verdict).toBe('not_checked');
    expect(off.verdicts[0].reason).toContain('Settings › Spec Limits');
  });

  it('still refuses MPN against CFU with the setting on', () => {
    const r = checkConfiguredLimits(sources('4', 'MPN/mL'), tests, limits, {}, { includePasses: true, unitPolicy: EQUIV });
    expect(r.verdicts[0].verdict).toBe('not_checked');
    expect(r.verdicts[0].reason).toContain('(different counting methods)');
  });
});

// ---------------------------------------------------------------------------
// Yeast & mold
// ---------------------------------------------------------------------------

const cfuLimit = (id: string, spec_test_id: string, value_max: number): ConfiguredLimit => ({
  id, spec_test_id, operator: '<=', value_min: null, value_max, unit: 'CFU/g',
  severity: 'alert', active: true, supplier_id: null, document_type_id: null, product_id: null,
});

const YEAST: SpecTestDef = { id: 'st_y', name: 'Yeast', aliases: [] };
const MOLD: SpecTestDef = { id: 'st_m', name: 'Mold', aliases: ['Mould'] };
const COMBINED: SpecTestDef = { id: 'st_ym', name: 'Yeast & Mold (combined)', aliases: ['Y&M', 'Yeast/Mold'] };

const rows = (...r: string[][]) => [
  { scope: 'ai_fields', tables: [{ name: 'micro', headers: ['Test', 'Result', 'Units'], rows: r }] },
];

describe('yeast & mold — reading the name', () => {
  it('recognises every combined spelling', () => {
    for (const name of ['Yeast & Mold', 'Y&M', 'Y & M', 'Yeast/Mold', 'Yeasts and Molds', 'Yeast & Mould', 'YEAST MOLD', 'Molds & Yeasts', 'Yeast & Mold (combined)']) {
      expect(yeastMoldPart(name), name).toBe('combined');
    }
    expect(yeastMoldPart('Yeasts')).toBe('yeast');
    expect(yeastMoldPart('Moulds')).toBe('mold');
    expect(yeastMoldPart('Mold (Yeast excluded)')).toBe('mold');
    expect(yeastMoldPart('Coliform')).toBeNull();
  });

  it('matches spelling variants to a test of the same combination, and nothing else', () => {
    const tests = [YEAST, MOLD, { ...COMBINED, aliases: [] }];
    expect(matchSpecTest('Yeasts and Molds', tests)?.id).toBe('st_ym');
    expect(matchSpecTest('Yeast & Mould', tests)?.id).toBe('st_ym');
    expect(matchSpecTest('Total Yeast and Mold Count', tests)?.id).toBe('st_ym');
    expect(matchSpecTest('Yeasts', tests)?.id).toBe('st_y');
    expect(matchSpecTest('Moulds', tests)?.id).toBe('st_m');
    // A name with any other word is not a spelling variant.
    expect(matchSpecTest('Osmophilic Yeast', tests)).toBeNull();
    expect(matchSpecTest('Yeast & Mold Enumeration Method B', tests)).toBeNull();
  });
});

describe('yeast & mold — a combined result is never judged against a separate limit', () => {
  it('refuses Y&M against a Mold limit reached through a mistaken alias, for every spelling', () => {
    // Somebody put the combined spellings on the Mold analyte. The alias
    // matches; the judgement must still refuse.
    const mold = { ...MOLD, aliases: ['Mould', 'Y&M', 'Yeast/Mold', 'Yeasts and Molds', 'Yeast & Mould'] };
    for (const name of ['Y&M', 'Yeast/Mold', 'Yeasts and Molds', 'Yeast & Mould']) {
      const r = checkConfiguredLimits(rows([name, '<10', 'CFU/g']), [mold], [cfuLimit('l_m', 'st_m', 1)], {}, { includePasses: true });
      expect(r.verdicts, name).toHaveLength(1);
      expect(r.verdicts[0].verdict).toBe('not_checked');
      expect(r.verdicts[0].reason).toBe("a combined yeast & mold result can't be split to check the mold limit");
      expect(r.verdicts[0].message).toContain("can't be split to check the mold limit");
      expect(r.verdicts[0].limit_id).toBe('l_m');
    }
    expect(yeastMoldMismatch('Y&M', YEAST)).toBe("a combined yeast & mold result can't be split to check the yeast limit");
  });

  it('refuses it even when the value would have "passed"', () => {
    const mold = { ...MOLD, aliases: ['Y&M'] };
    const r = checkConfiguredLimits(rows(['Y&M', '0', 'CFU/g']), [mold], [cfuLimit('l_m', 'st_m', 10)], {}, { includePasses: true });
    expect(r.verdicts[0].verdict).toBe('not_checked');
  });

  it('judges a combined result against a combined limit, whatever the spelling', () => {
    const tests = [YEAST, MOLD, COMBINED];
    const limits = [cfuLimit('l_y', 'st_y', 10), cfuLimit('l_m', 'st_m', 1), cfuLimit('l_ym', 'st_ym', 10)];
    for (const name of ['Y&M', 'Yeast/Mold', 'Yeasts and Molds', 'Yeast & Mould']) {
      const r = checkConfiguredLimits(rows([name, '40', 'CFU/g']), tests, limits, {}, { includePasses: true });
      expect(r.verdicts, name).toHaveLength(1);
      expect(r.verdicts[0].verdict).toBe('out_of_spec');
      expect(r.verdicts[0].limit_id).toBe('l_ym');
    }
  });

  it('a certificate that prints Y&M does not report a required Mold analyte', () => {
    const mold = { ...MOLD, aliases: ['Y&M'] };
    const ctx = { supplier_id: 's1', document_type_id: 'dt1' };
    const missing = checkRequiredAnalytes(
      rows(['Y&M', '<10', 'CFU/g']),
      [mold],
      [{ id: 'r1', spec_test_id: 'st_m', supplier_id: 's1', document_type_id: 'dt1' }],
      ctx
    );
    expect(missing).toHaveLength(1);
    expect(missing[0].why).toBe('not_on_certificate');
  });
});

describe('yeast & mold — separate results are never summed against a combined limit', () => {
  it('refuses separate Yeast and Mold results against the combined limit when they have no limit of their own', () => {
    const r = checkConfiguredLimits(
      rows(['Yeast', '4', 'CFU/g'], ['Mould', '3', 'CFU/g']),
      [COMBINED],
      [cfuLimit('l_ym', 'st_ym', 5)],
      {},
      { includePasses: true }
    );
    expect(r.verdicts).toHaveLength(2);
    for (const v of r.verdicts) {
      expect(v.verdict).toBe('not_checked');
      expect(v.limit_id).toBe('l_ym');
      expect(v.reason).toContain('separate yeast and mold results are not added together');
    }
    // Refused, so not also listed as "no limit configured".
    expect(r.unjudged).toHaveLength(0);
  });

  it('judges separate results against their own limits and leaves the combined limit out of it', () => {
    const r = checkConfiguredLimits(
      rows(['Yeast', '4', 'CFU/g'], ['Mold', '3', 'CFU/g']),
      [YEAST, MOLD, COMBINED],
      [cfuLimit('l_y', 'st_y', 10), cfuLimit('l_m', 'st_m', 1), cfuLimit('l_ym', 'st_ym', 5)],
      {},
      { includePasses: true }
    );
    expect(r.verdicts.map((v) => [v.test_name_raw, v.limit_id, v.verdict])).toEqual([
      ['Yeast', 'l_y', 'in_spec'],
      ['Mold', 'l_m', 'out_of_spec'],
    ]);
  });

  it('refuses a separate result reached through a mistaken alias on the combined analyte', () => {
    const combined = { ...COMBINED, aliases: ['Yeast'] };
    const r = checkConfiguredLimits(rows(['Yeast', '4', 'CFU/g']), [combined], [cfuLimit('l_ym', 'st_ym', 5)], {}, { includePasses: true });
    expect(r.verdicts[0].verdict).toBe('not_checked');
    expect(r.verdicts[0].reason).toContain('not added together');
  });
});

describe('the printed-spec path is unaffected by analyte names', () => {
  it('still judges a COA against its own printed limit', () => {
    const v = checkPrintedSpecs([
      { scope: 'ai_fields', tables: [{ name: 'm', headers: ['Test', 'Specification', 'Result', 'Units'], rows: [['Yeast & Mold', '≤10', '40', 'CFU/g']] }] },
    ]);
    expect(v).toHaveLength(1);
    expect(v[0].verdict).toBe('out_of_spec');
  });
});

describe('the compiled mirror agrees with the source', () => {
  const spellings = [
    'per ml.', '/g', 'cells/mL', 'µg/g', 'ppb', 'mg/100g', 'g/100g', 'mg/L', 'log cfu/g', 'cfu/oz',
    'cfu/fl oz', 'cfu/oz wt', 'pH Units', '%', '% w/w', 'CFU/100g', 'N/A', 'colonies',
  ];

  it('normalizes every unit the same way', () => {
    for (const s of spellings) expect(compiled.normalizeUnit(s), s).toEqual(normalizeUnit(s));
  });

  it('reaches the same comparisons', () => {
    const cases: Array<[string, Partial<SpecLimit>]> = [
      ['0.02 %', { max: 100, unit: 'ppm' }],
      ['50 cfu/oz', { max: 10, unit: 'CFU/g' }],
      ['2.3 log cfu/g', { max: 10, unit: 'CFU/g' }],
      ['100,000 per ml.', { max: 20000, unit: 'CFU/g' }],
    ];
    for (const [value, l] of cases) {
      expect(compiled.compareToLimit(compiled.parseMeasuredValue(value), lim(l), EQUIV), value).toEqual(
        compareToLimit(parseMeasuredValue(value), lim(l), EQUIV)
      );
    }
    expect(compiled.yeastMoldMismatch('Y&M', MOLD)).toBe(yeastMoldMismatch('Y&M', MOLD));
  });
});
