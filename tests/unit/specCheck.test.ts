/**
 * shared/specCheck.ts — spec-limit checking for COA test-result tables.
 *
 * The tests that matter most here are the ones pinning what the engine REFUSES
 * to judge. A spec engine sits downstream of ~90.6% extraction accuracy, and the
 * results table is where the known defects live, so a confident wrong answer is
 * the expensive failure: a false negative teaches a QA buyer that the portal
 * catches out-of-spec results when it does not.
 *
 * So `not_checked` is a first-class outcome and it is asserted as hard as
 * `out_of_spec` is. The censored-straddle case (`<50` against a ≤10 limit) is
 * the anchor: the true value could be 2 or 49, and both "pass" and "fail" are
 * lies.
 */

import { describe, it, expect } from 'vitest';
import {
  parseMeasuredValue,
  parseLimitExpression,
  normalizeUnit,
  unitFactor,
  compareToLimit,
  detectTableShape,
  checkPrintedSpecs,
  formatLimit,
  resolveSpecLimits,
  matchSpecTest,
  checkConfiguredLimits,
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

describe('parseMeasuredValue', () => {
  it('reads plain numbers, with and without a unit', () => {
    expect(parseMeasuredValue('40')).toMatchObject({ kind: 'numeric', value: 40 });
    expect(parseMeasuredValue('40 CFU/g')).toMatchObject({ kind: 'numeric', value: 40, unit: 'CFU/g' });
    expect(parseMeasuredValue('4,500')).toMatchObject({ kind: 'numeric', value: 4500 });
    expect(parseMeasuredValue('81.2')).toMatchObject({ kind: 'numeric', value: 81.2 });
  });

  it('reads the censored forms labs actually print', () => {
    expect(parseMeasuredValue('<10')).toMatchObject({ kind: 'censored_lt', value: 10 });
    expect(parseMeasuredValue('≤1')).toMatchObject({ kind: 'censored_lt', value: 1 });
    expect(parseMeasuredValue('< 10 est')).toMatchObject({ kind: 'censored_lt', value: 10 });
    expect(parseMeasuredValue('less than 100')).toMatchObject({ kind: 'censored_lt', value: 100 });
    expect(parseMeasuredValue('>1000')).toMatchObject({ kind: 'censored_gt', value: 1000 });
  });

  it('reads scientific shorthand', () => {
    expect(parseMeasuredValue('3.0x10^2')).toMatchObject({ kind: 'numeric', value: 300 });
    expect(parseMeasuredValue('1.2e3')).toMatchObject({ kind: 'numeric', value: 1200 });
    expect(parseMeasuredValue('2×10³')).toMatchObject({ kind: 'numeric', value: 2000 });
  });

  it('reads qualitative results, including with a sample basis', () => {
    expect(parseMeasuredValue('Absent/25g')).toMatchObject({ kind: 'qualitative', qualifier: 'absent' });
    expect(parseMeasuredValue('Absent in 25 g')).toMatchObject({ kind: 'qualitative', qualifier: 'absent' });
    expect(parseMeasuredValue('Negative')).toMatchObject({ kind: 'qualitative', qualifier: 'absent' });
    expect(parseMeasuredValue('ND')).toMatchObject({ kind: 'qualitative', qualifier: 'absent' });
    expect(parseMeasuredValue('None detected')).toMatchObject({ kind: 'qualitative', qualifier: 'absent' });
    expect(parseMeasuredValue('Positive')).toMatchObject({ kind: 'qualitative', qualifier: 'present' });
    expect(parseMeasuredValue('TNTC')).toMatchObject({ kind: 'qualitative', qualifier: 'tntc' });
  });

  it('never reads a conformance verdict as a measurement', () => {
    // "Pass" is the document asserting its own compliance. Treating it as a
    // value would let a row certify itself.
    expect(parseMeasuredValue('Pass').kind).toBe('unparseable');
    expect(parseMeasuredValue('Conforms').kind).toBe('unparseable');
  });

  it('gives up loudly rather than guessing', () => {
    expect(parseMeasuredValue('see attached').kind).toBe('unparseable');
    expect(parseMeasuredValue('').kind).toBe('unparseable');
  });
});

describe('parseLimitExpression', () => {
  it('reads the operator forms', () => {
    expect(parseLimitExpression('<10')).toMatchObject({ operator: '<', max: 10 });
    expect(parseLimitExpression('≤ 10')).toMatchObject({ operator: '<=', max: 10 });
    expect(parseLimitExpression('NMT 100')).toMatchObject({ operator: '<=', max: 100 });
    expect(parseLimitExpression('max 20000')).toMatchObject({ operator: '<=', max: 20000 });
    expect(parseLimitExpression('20000 max')).toMatchObject({ operator: '<=', max: 20000 });
    expect(parseLimitExpression('>80')).toMatchObject({ operator: '>', min: 80 });
    expect(parseLimitExpression('min 3.5')).toMatchObject({ operator: '>=', min: 3.5 });
  });

  it('reads ranges', () => {
    expect(parseLimitExpression('80-85')).toMatchObject({ operator: 'between', min: 80, max: 85 });
    expect(parseLimitExpression('6.4 to 6.8')).toMatchObject({ operator: 'between', min: 6.4, max: 6.8 });
  });

  it('reads absence limits and their sample basis', () => {
    expect(parseLimitExpression('Absent/25g')).toMatchObject({ operator: 'absent', basis_grams: 25 });
    expect(parseLimitExpression('Negative')).toMatchObject({ operator: 'absent' });
  });

  it('returns null when the cell states no limit', () => {
    for (const cell of ['', 'N/A', '—', 'Report', 'See spec', 'TBD']) {
      expect(parseLimitExpression(cell), cell).toBeNull();
    }
  });

  it('refuses a bare number rather than guessing a direction', () => {
    // A bare "100" in a spec column is conventionally a ceiling, but guessing is
    // exactly how a false negative gets manufactured.
    expect(parseLimitExpression('100')).toBeNull();
  });

  it('does not read "min" out of the middle of a word', () => {
    // "vitamin" contains "min". A substring test would call this a minimum.
    expect(parseLimitExpression('Vitamin A 100')).toBeNull();
  });
});

describe('units', () => {
  it('converts within a family', () => {
    const per100g = normalizeUnit('CFU/100g');
    const perG = normalizeUnit('CFU/g');
    expect(unitFactor(per100g, perG)).toBeCloseTo(0.01);
    expect(500 * (unitFactor(per100g, perG) as number)).toBe(5);
  });

  it('refuses to convert across enumeration method or basis', () => {
    expect(unitFactor(normalizeUnit('CFU/mL'), normalizeUnit('CFU/g'))).toBeNull();
    expect(unitFactor(normalizeUnit('MPN/g'), normalizeUnit('CFU/g'))).toBeNull();
  });

  it('treats an unknown unit as agreement', () => {
    // COAs routinely print the unit once in a header column. Refusing to compare
    // whenever a cell omits it would make the feature useless.
    expect(unitFactor(normalizeUnit(''), normalizeUnit('CFU/g'))).toBe(1);
  });
});

describe('compareToLimit — the cases that must be right', () => {
  const coliform = lim({ operator: '<=', max: 10, unit: 'CFU/g' });

  it("AJ's case: 40 against a ≤10 limit is out of spec", () => {
    const r = compareToLimit(parseMeasuredValue('40 CFU/g'), coliform);
    expect(r.verdict).toBe('out_of_spec');
    expect(r.value_num).toBe(40);
  });

  it('a censored value below the limit clears it', () => {
    expect(compareToLimit(parseMeasuredValue('<10'), coliform).verdict).toBe('in_spec');
    expect(compareToLimit(parseMeasuredValue('<1'), coliform).verdict).toBe('in_spec');
  });

  it('a censored value that STRADDLES the limit is not checked, never a pass', () => {
    const r = compareToLimit(parseMeasuredValue('<50'), coliform);
    expect(r.verdict).toBe('not_checked');
    expect(r.reason).toMatch(/straddle/i);
  });

  it('">1000" against a 20000 ceiling is not checked, never a fail', () => {
    const r = compareToLimit(parseMeasuredValue('>1000'), lim({ operator: '<=', max: 20000 }));
    expect(r.verdict).toBe('not_checked');
  });

  it('">25000" against a 20000 ceiling is out of spec', () => {
    expect(compareToLimit(parseMeasuredValue('>25000'), lim({ operator: '<=', max: 20000 })).verdict).toBe(
      'out_of_spec'
    );
  });

  it('TNTC exceeds any numeric ceiling', () => {
    expect(compareToLimit(parseMeasuredValue('TNTC'), coliform).verdict).toBe('out_of_spec');
  });

  it('an incompatible unit is not checked, never compared numerically', () => {
    // 40 CFU/mL against a 10 CFU/g limit must NOT become "40 > 10".
    const r = compareToLimit(parseMeasuredValue('40 CFU/mL'), coliform);
    expect(r.verdict).toBe('not_checked');
    expect(r.reason).toMatch(/not comparable/i);
  });

  it('normalizes a compatible unit before comparing', () => {
    // 500 CFU/100g is 5 CFU/g — inside the limit, despite 500 > 10.
    expect(compareToLimit(parseMeasuredValue('500 CFU/100g'), coliform).verdict).toBe('in_spec');
  });

  it('handles absence limits, including a weaker sample basis', () => {
    const absent25 = lim({ operator: 'absent', basis_grams: 25, raw: 'Absent/25g' });
    expect(compareToLimit(parseMeasuredValue('Absent/25g'), absent25).verdict).toBe('in_spec');
    expect(compareToLimit(parseMeasuredValue('Positive'), absent25).verdict).toBe('out_of_spec');
    // Absence proven over 10 g does not prove absence over 25 g.
    const weaker = compareToLimit(parseMeasuredValue('Absent in 10 g'), absent25);
    expect(weaker.verdict).toBe('not_checked');
    expect(weaker.reason).toMatch(/weaker test/i);
  });

  it('judges ranges and minimums', () => {
    const fat = lim({ operator: 'between', min: 80, max: 85, unit: '%' });
    expect(compareToLimit(parseMeasuredValue('81.2 %'), fat).verdict).toBe('in_spec');
    expect(compareToLimit(parseMeasuredValue('79 %'), fat).verdict).toBe('out_of_spec');
    const minFat = lim({ operator: '>=', min: 80, unit: '%' });
    expect(compareToLimit(parseMeasuredValue('79 %'), minFat).verdict).toBe('out_of_spec');
    expect(compareToLimit(parseMeasuredValue('80 %'), minFat).verdict).toBe('in_spec');
  });

  it('an unreadable result is not checked', () => {
    expect(compareToLimit(parseMeasuredValue('see attached'), coliform).verdict).toBe('not_checked');
  });
});

describe('detectTableShape', () => {
  it('finds the standard COA columns', () => {
    const s = detectTableShape(['test', 'test_method', 'specification', 'result', 'units', 'pass_fail']);
    expect(s).toEqual({ test: 0, spec: 2, result: 3, unit: 4, verdict: 5 });
  });

  it('never assigns one column two roles', () => {
    const s = detectTableShape(['Test Result', 'Spec']);
    expect(s.result).toBe(0);
    expect(s.test).not.toBe(0);
    expect(s.spec).toBe(1);
  });

  it('falls back to column 0 for an unlabelled analyte column', () => {
    expect(detectTableShape(['', 'Result']).test).toBe(0);
  });
});

describe('checkPrintedSpecs — Phase 0, no configuration required', () => {
  const table = (rows: string[][]) => [
    {
      scope: 'record[0]',
      tables: [
        {
          name: 'microbiological_analysis',
          headers: ['test', 'specification', 'result', 'units', 'pass_fail'],
          rows,
        },
      ],
    },
  ];

  it("flags a result outside the document's OWN printed limit", () => {
    const v = checkPrintedSpecs(table([['Coliform', '<10', '40', 'CFU/g', '']]));
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({
      verdict: 'out_of_spec',
      source: 'printed',
      test_name_raw: 'Coliform',
      scope: 'record[0]',
      target: { kind: 'table', table_index: 0, row_index: 0 },
    });
    expect(v[0].message).toContain('Coliform');
    expect(v[0].message).toContain('40');
  });

  it("flags the document's own Fail verdict", () => {
    const v = checkPrintedSpecs(table([['E. coli', 'Absent/25g', 'Positive', '', 'Fail']]));
    expect(v).toHaveLength(1);
    expect(v[0].verdict).toBe('out_of_spec');
    expect(v[0].message).toMatch(/pass\/fail column says "Fail"/);
  });

  it('flags a COA that contradicts itself', () => {
    const v = checkPrintedSpecs(table([['SPC', '<20000', '25000', 'CFU/g', 'Pass']]));
    expect(v).toHaveLength(1);
    expect(v[0].verdict).toBe('out_of_spec');
    expect(v[0].message).toMatch(/contradicts itself/);
  });

  it('says nothing at all about a clean COA', () => {
    const v = checkPrintedSpecs(
      table([
        ['Fat', '>80', '81.2', '%', 'Pass'],
        ['Moisture', '<16', '15.4', '%', 'Pass'],
        ['Coliform', '<10', '<1', 'CFU/g', 'Pass'],
        ['SPC', '<20000', '4500', 'CFU/g', 'Pass'],
      ])
    );
    expect(v).toEqual([]);
  });

  it('says nothing when the supplier printed no limit', () => {
    // "Report only" rows are extremely common and are not findings.
    expect(checkPrintedSpecs(table([['Yeast & Mold', 'Report', '250', 'CFU/g', '']]))).toEqual([]);
    expect(checkPrintedSpecs(table([['Yeast & Mold', 'N/A', '250', 'CFU/g', '']]))).toEqual([]);
  });

  it('does not treat a result column holding "Pass" as a measurement', () => {
    expect(checkPrintedSpecs(table([['Coliform', '<10', 'Pass', 'CFU/g', '']]))).toEqual([]);
  });

  it('reports a blocked comparison as not_checked, not as a pass', () => {
    const v = checkPrintedSpecs(table([['Coliform', '<10', '<50', 'CFU/g', '']]));
    expect(v).toHaveLength(1);
    expect(v[0].verdict).toBe('not_checked');
    expect(v[0].message).toMatch(/could not be judged/);
  });

  it('addresses each verdict to its exact table and row', () => {
    const v = checkPrintedSpecs([
      {
        scope: 'record[2]',
        tables: [
          { name: 'physical', headers: ['test', 'specification', 'result'], rows: [['Fat', '>80', '81']] },
          {
            name: 'micro',
            headers: ['test', 'specification', 'result'],
            rows: [
              ['SPC', '<20000', '4500'],
              ['Coliform', '<10', '40'],
            ],
          },
        ],
      },
    ]);
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({
      scope: 'record[2]',
      target: { kind: 'table', table_index: 1, row_index: 1, table_name: 'micro' },
    });
  });

  it('ignores tables that are not test results', () => {
    const v = checkPrintedSpecs([
      {
        scope: 'ai_fields',
        tables: [{ name: 'line_items', headers: ['item', 'qty', 'price'], rows: [['Butter', '4', '9.99']] }],
      },
    ]);
    expect(v).toEqual([]);
  });
});

describe('formatLimit', () => {
  it('renders limits the way a reviewer would write them', () => {
    expect(formatLimit(lim({ operator: '<=', max: 10, unit: 'CFU/g' }))).toBe('≤10 CFU/g');
    expect(formatLimit(lim({ operator: 'between', min: 80, max: 85, unit: '%' }))).toBe('80–85 %');
    expect(formatLimit(lim({ operator: 'absent', basis_grams: 25 }))).toBe('absent in 25 g');
  });
});

describe('checkPrintedSpecs — structured groups', () => {
  // The records assembler emits `CoaResultCell` ({value, unit, spec}) rather
  // than a table. Same judgement, different carrier — missing this shape would
  // leave records-mode COAs, the current primary path, unchecked.
  const groups = (cells: Record<string, { value?: string; unit?: string; spec?: string }>) => [
    { scope: 'record[0]', groups: { microbiological: cells } },
  ];

  it('judges a group cell against its own spec', () => {
    const v = checkPrintedSpecs(groups({ coliform: { value: '40', unit: 'CFU/g', spec: '<10' } }));
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({
      verdict: 'out_of_spec',
      target: { kind: 'group', group: 'microbiological', cell: 'coliform' },
    });
  });

  it('stays quiet on a clean cell and on a cell with no spec', () => {
    expect(checkPrintedSpecs(groups({ coliform: { value: '<1', unit: 'CFU/g', spec: '<10' } }))).toEqual([]);
    expect(checkPrintedSpecs(groups({ yeast_mold: { value: '250', unit: 'CFU/g' } }))).toEqual([]);
  });

  it('reads the analyte name out of the cell key', () => {
    const v = checkPrintedSpecs(groups({ standard_plate_count: { value: '25000', spec: '<20000' } }));
    expect(v[0].test_name_raw).toBe('standard plate count');
    expect(v[0].message).toContain('standard plate count');
  });

  it('survives a malformed payload without throwing', () => {
    const junk = [
      { scope: 'record[0]', groups: { bad: null as never } },
      { scope: 'record[1]', tables: undefined },
      { scope: 'record[2]', groups: { g: { c: null as never } } },
    ];
    expect(() => checkPrintedSpecs(junk)).not.toThrow();
    expect(checkPrintedSpecs(junk)).toEqual([]);
  });
});

describe('resolveSpecLimits — most specific wins', () => {
  const base = {
    spec_test_id: 'st_coliform',
    operator: '<=' as const,
    value_min: null,
    unit: 'CFU/g',
    severity: 'alert' as const,
    active: true,
    supplier_id: null,
    document_type_id: null,
    product_id: null,
  };
  const ctx = { supplier_id: 'sup_1', document_type_id: 'dt_coa', product_ids: ['prod_1'] };

  it('uses a tenant-wide default when nothing more specific exists', () => {
    // The day-one case: one row, no supplier configured yet, and it still fires.
    const r = resolveSpecLimits([{ ...base, id: 'l_tenant', value_max: 10 }], ctx);
    expect(r.get('st_coliform')?.id).toBe('l_tenant');
  });

  it('prefers supplier over tenant, and product over supplier', () => {
    const limits = [
      { ...base, id: 'l_tenant', value_max: 100 },
      { ...base, id: 'l_supplier', value_max: 50, supplier_id: 'sup_1' },
      { ...base, id: 'l_product', value_max: 10, product_id: 'prod_1' },
    ];
    expect(resolveSpecLimits(limits, ctx).get('st_coliform')?.id).toBe('l_product');
    expect(resolveSpecLimits(limits.slice(0, 2), ctx).get('st_coliform')?.id).toBe('l_supplier');
  });

  it('ignores limits scoped to a different supplier, doctype or product', () => {
    const limits = [
      { ...base, id: 'l_other_sup', value_max: 1, supplier_id: 'sup_2' },
      { ...base, id: 'l_other_dt', value_max: 1, document_type_id: 'dt_spec' },
      { ...base, id: 'l_other_prod', value_max: 1, product_id: 'prod_9' },
    ];
    expect(resolveSpecLimits(limits, ctx).size).toBe(0);
  });

  it('ignores inactive limits', () => {
    expect(resolveSpecLimits([{ ...base, id: 'l1', value_max: 10, active: false }], ctx).size).toBe(0);
  });

  it('breaks a specificity tie with the most recent edit', () => {
    const limits = [
      { ...base, id: 'l_old', value_max: 10, supplier_id: 'sup_1', updated_at: '2026-01-01' },
      { ...base, id: 'l_new', value_max: 5, supplier_id: 'sup_1', updated_at: '2026-08-01' },
    ];
    expect(resolveSpecLimits(limits, ctx).get('st_coliform')?.id).toBe('l_new');
  });
});

describe('matchSpecTest', () => {
  const tests = [
    { id: 'st_coliform', name: 'Coliform', aliases: ['Coliforms (MPN)', 'Total Coliform'] },
    { id: 'st_spc', name: 'Standard Plate Count', aliases: ['SPC', 'APC', 'Aerobic Plate Count'] },
  ];

  it('matches the canonical name regardless of case and punctuation', () => {
    expect(matchSpecTest('coliform', tests)?.id).toBe('st_coliform');
    expect(matchSpecTest('COLIFORM', tests)?.id).toBe('st_coliform');
  });

  it('matches the names suppliers actually print, via aliases', () => {
    expect(matchSpecTest('Coliforms (MPN)', tests)?.id).toBe('st_coliform');
    expect(matchSpecTest('APC', tests)?.id).toBe('st_spc');
    expect(matchSpecTest('aerobic plate count', tests)?.id).toBe('st_spc');
  });

  it('refuses a substring match', () => {
    // "Fecal Coliform" is a DIFFERENT test with a different limit. Applying the
    // coliform limit to it would be as wrong as applying none — and invisible.
    expect(matchSpecTest('Fecal Coliform', tests)).toBeNull();
    expect(matchSpecTest('Coliform Count', tests)).toBeNull();
  });
});

describe('checkConfiguredLimits — our limit, not theirs', () => {
  const tests = [{ id: 'st_coliform', name: 'Coliform', aliases: ['Total Coliform'] }];
  const limit = {
    id: 'l1',
    spec_test_id: 'st_coliform',
    operator: '<=' as const,
    value_min: null,
    value_max: 10,
    unit: 'CFU/g',
    severity: 'alert' as const,
    active: true,
    supplier_id: null,
    document_type_id: null,
    product_id: null,
  };
  const src = (rows: string[][]) => [
    {
      scope: 'record[0]',
      tables: [{ name: 'micro', headers: ['test', 'specification', 'result', 'units'], rows }],
    },
  ];

  it('catches a result the SUPPLIER passed but our tighter limit fails', () => {
    // The whole point of the feature: their COA says <50 and marks it Pass; our
    // limit is 10, and 40 fails it.
    const { verdicts } = checkConfiguredLimits(src([['Coliform', '<50', '40', 'CFU/g']]), tests, [limit], {});
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]).toMatchObject({ verdict: 'out_of_spec', source: 'limit', limit_id: 'l1' });
    expect(verdicts[0].message).toMatch(/outside our limit of ≤10 CFU\/g/);
  });

  it('stays silent on a passing result unless passes are requested', () => {
    expect(checkConfiguredLimits(src([['Coliform', '', '<1', 'CFU/g']]), tests, [limit], {}).verdicts).toEqual([]);
    const withPasses = checkConfiguredLimits(src([['Coliform', '', '<1', 'CFU/g']]), tests, [limit], {}, {
      includePasses: true,
    });
    expect(withPasses.verdicts[0].verdict).toBe('in_spec');
  });

  it('reports a test with no configured limit as unmatched, NOT as a warning', () => {
    const r = checkConfiguredLimits(src([['Yeast & Mold', '', '250', 'CFU/g']]), tests, [limit], {});
    expect(r.verdicts).toEqual([]);
    expect(r.unmatched).toEqual(['Yeast & Mold']);
  });

  it('still refuses to judge what it cannot compare', () => {
    const r = checkConfiguredLimits(src([['Coliform', '', '<50', 'CFU/g']]), tests, [limit], {});
    expect(r.verdicts[0].verdict).toBe('not_checked');
    expect(r.verdicts[0].message).toMatch(/could not be judged against our limit/);
  });

  it('does nothing at all when the tenant has configured no analytes', () => {
    expect(checkConfiguredLimits(src([['Coliform', '', '40', 'CFU/g']]), [], [], {})).toEqual({
      verdicts: [],
      unmatched: [],
    });
  });
});
