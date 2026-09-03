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
  resolveUnits,
  resultRestatesSpec,
  specVerdictKey,
  isControlRowLabel,
  collectPrintedAssertions,
  classifySpecDisagreement,
  findSpecDisagreements,
  specResultKey,
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
      control_rows: [],
    });
  });
});


describe('placeholder unit cells read as "no unit", not as a unit', () => {
  // 45 of the 74 unjudgeable rows in a 100-COA prod sample were nothing but
  // this: a unit column literally containing "N/A". Classifying that as a unit
  // in its own right made it mismatch every real unit, so a placeholder was
  // treated HARDER than a blank — which already means "assume it matches".
  const placeholders = ['N/A', 'n/a', 'na', 'NA', 'n.a.', 'none', 'None', '-', '--', '—', '–', 'null', 'n/a.', '', '  '];

  it('resolves every placeholder spelling to the unknown family', () => {
    for (const p of placeholders) {
      expect(normalizeUnit(p).family, `unit ${JSON.stringify(p)}`).toBe('unknown');
    }
  });

  it('lets a placeholder unit compare against a real one, exactly as a blank does', () => {
    for (const p of placeholders) {
      expect(unitFactor(normalizeUnit(p), normalizeUnit('CFU/g')), `unit ${JSON.stringify(p)}`).toBe(1);
      expect(unitFactor(normalizeUnit('CFU/g'), normalizeUnit(p)), `unit ${JSON.stringify(p)}`).toBe(1);
    }
  });

  it('still refuses the units that genuinely do not line up', () => {
    // The fix must not become a blanket "assume it matches" — CFU/mL against a
    // CFU/g limit is a different basis and stays unjudged.
    expect(unitFactor(normalizeUnit('CFU/mL'), normalizeUnit('CFU/g'))).toBeNull();
    expect(normalizeUnit('per ml.').family).not.toBe('unknown');
  });

  it('judges a real result whose unit column is a placeholder', () => {
    const tests = [{ id: 'st_coliform', name: 'Coliform', aliases: [] }];
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
    const src = (unit: string) => [
      {
        scope: 'record[0]',
        tables: [
          {
            name: 'micro',
            headers: ['test', 'specification', 'result', 'units'],
            rows: [['Coliform', '', '40', unit]],
          },
        ],
      },
    ];
    for (const p of ['N/A', 'n.a.', '--', '—', 'null', '']) {
      const { verdicts } = checkConfiguredLimits(src(p), tests, [limit], {});
      expect(verdicts, `unit ${JSON.stringify(p)}`).toHaveLength(1);
      expect(verdicts[0].verdict, `unit ${JSON.stringify(p)}`).toBe('out_of_spec');
    }
  });
});

describe('a result identical to its own printed spec is not a measurement', () => {
  // Andersen COAs carry a certification paragraph naming the regulatory
  // thresholds, and the extractor lifts them straight into the results table.
  // Nothing was measured. Firing an out-of-spec alert on those — on a supplier
  // already under a sanitation alert — is the fastest way to teach a QA buyer
  // to ignore the feature.
  const andersen = [
    ['BACTERIA STANDARD PLATE COUNT', '100,000', 'per ml.', '100,000 per ml.', 'Pass'],
    ['SOMATIC CELL COUNT', '400,000', 'per ml.', '400,000 per ml.', 'Pass'],
  ];
  const andersenSrc = [
    {
      scope: 'record[0]',
      tables: [
        {
          name: 'certification',
          headers: ['test', 'result', 'units', 'specification', 'pass_fail'],
          rows: andersen,
        },
      ],
    },
  ];

  it('spots the restatement even though the unit lives in its own column', () => {
    // The result cell reads "100,000" and the spec cell "100,000 per ml." — the
    // two only line up once the row's unit column is put back on the value.
    expect(resultRestatesSpec('100,000', '100,000 per ml.', 'per ml.')).toBe(true);
    expect(resultRestatesSpec('100,000 per ml.', '100,000 per ml.', '')).toBe(true);
    expect(resultRestatesSpec('100000', '100,000', '')).toBe(true);
  });

  it('reports the boilerplate row as not_checked, never as a pass and never silently', () => {
    const v = checkPrintedSpecs(andersenSrc);
    expect(v).toHaveLength(2);
    for (const row of v) {
      expect(row.verdict).toBe('not_checked');
      expect(row.reason).toMatch(/limit restated rather than a measurement/);
      expect(row.message).toMatch(/identical to the specification printed beside it/);
    }
    expect(v[0].test_name_raw).toBe('BACTERIA STANDARD PLATE COUNT');
  });

  it('does not let our own tighter limit fire on it either', () => {
    const tests = [{ id: 'st_spc', name: 'Bacteria Standard Plate Count', aliases: [] }];
    const limit = {
      id: 'l_spc',
      spec_test_id: 'st_spc',
      operator: '<=' as const,
      value_min: null,
      value_max: 20000,
      unit: null,
      severity: 'alert' as const,
      active: true,
      supplier_id: null,
      document_type_id: null,
      product_id: null,
    };
    const { verdicts } = checkConfiguredLimits(andersenSrc, tests, [limit], {});
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]).toMatchObject({ verdict: 'not_checked', source: 'limit', limit_id: 'l_spc' });
    expect(verdicts[0].message).toMatch(/limit restated rather than a measurement/);
  });

  it('needs both cells present and saying something', () => {
    expect(resultRestatesSpec('100,000', '', 'per ml.')).toBe(false);
    expect(resultRestatesSpec('', '100,000', 'per ml.')).toBe(false);
    expect(resultRestatesSpec('N/A', 'N/A', '')).toBe(false);
    expect(resultRestatesSpec('—', '—', '')).toBe(false);
  });

  it('GUARD: a genuine measurement that happens to equal its spec is still judged', () => {
    // A real result CAN equal its own spec — a pH of 6.5 against a target of
    // 6.5, a count of 0 against a limit of 0, an "Absent" against a spec of
    // "Absent". The rule must not eat any of those; the bias is to keep
    // judging, because a wrongly-suppressed real failure is the expensive way
    // to be wrong here.
    expect(resultRestatesSpec('6.5', '6.5', '')).toBe(false); // short numeric
    expect(resultRestatesSpec('0', '0', '')).toBe(false);
    expect(resultRestatesSpec('35', '35', 'C')).toBe(false);
    expect(resultRestatesSpec('100', '100', 'CFU/g')).toBe(false); // 3 digits
    expect(resultRestatesSpec('Absent', 'Absent', '')).toBe(false); // qualitative
    expect(resultRestatesSpec('Negative', 'Negative', '')).toBe(false);
    expect(resultRestatesSpec('<10', '<10', 'CFU/g')).toBe(false); // a detection limit
  });

  it('GUARD, end to end: a short result equal to its spec is graded, not suppressed', () => {
    const tests = [{ id: 'st_coliform', name: 'Coliform', aliases: [] }];
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
    const src = (row: string[]) => [
      {
        scope: 'record[0]',
        tables: [{ name: 'micro', headers: ['test', 'specification', 'result', 'units'], rows: [row] }],
      },
    ];
    // Result 100 equals a printed spec of 100 — and it really is 100 CFU/g,
    // ten times our limit. It must still come back out of spec.
    const out = checkConfiguredLimits(src(['Coliform', '100', '100', 'CFU/g']), tests, [limit], {});
    expect(out.verdicts).toHaveLength(1);
    expect(out.verdicts[0].verdict).toBe('out_of_spec');

    // And a genuine pass that matches its spec is still a pass.
    const pass = checkConfiguredLimits(src(['Coliform', '10', '10', 'CFU/g']), tests, [limit], {}, {
      includePasses: true,
    });
    expect(pass.verdicts[0].verdict).toBe('in_spec');
  });
});

describe('a bare "%" is a unit, not a blank', () => {
  // ORDERING BUG, live on prod. `norm()` keeps only alphanumerics, so "%" became
  // "" and returned the unknown family — which the comparator reads as "assume
  // it matches". A percent then compared cleanly against a CFU/g limit.
  it('resolves "%" to the percent family', () => {
    expect(normalizeUnit('%').family).toBe('percent');
    expect(normalizeUnit(' % ').family).toBe('percent');
    expect(normalizeUnit('%%').family).toBe('percent');
    expect(normalizeUnit('% fat').family).toBe('percent');
    expect(normalizeUnit('percent').family).toBe('percent');
    expect(normalizeUnit('pct').family).toBe('percent');
  });

  it('still reads a genuinely empty or placeholder unit as unknown', () => {
    // The 45-row placeholder fix must survive: a blank is "assume it matches".
    for (const p of ['', '  ', 'N/A', 'n.a.', 'na', '--', '—', 'null', 'none', '-']) {
      expect(normalizeUnit(p).family, `unit ${JSON.stringify(p)}`).toBe('unknown');
    }
  });

  it('refuses to compare a percent against a count', () => {
    expect(unitFactor(normalizeUnit('%'), normalizeUnit('CFU/g'))).toBeNull();
    expect(unitFactor(normalizeUnit('CFU/g'), normalizeUnit('%'))).toBeNull();
    expect(unitFactor(normalizeUnit('%'), normalizeUnit('%'))).toBe(1);
  });

  it('does not alert on the RASKAS row, where a micro spec landed on the FAT row', () => {
    // Verbatim from prod document "100/1OZ CUP CREAM CH SPRD - RASKAS": the
    // extractor misfiled a micro specification onto the fat row, and 24.26%
    // was reported as exceeding a 10 CFU/g limit.
    const raskas = [
      {
        scope: 'record[0]',
        tables: [
          {
            name: 'results',
            headers: ['test', 'result', 'specification'],
            rows: [['FAT', '24.26%', '<10 CFU/g']],
          },
        ],
      },
    ];
    const printed = checkPrintedSpecs(raskas);
    expect(printed).toHaveLength(1);
    expect(printed[0].verdict).toBe('not_checked');
    expect(printed[0].reason).toMatch(/not comparable/);

    // And the same row against one of OUR limits, in CFU/g.
    const tests = [{ id: 'st_fat', name: 'FAT', aliases: [] }];
    const limit = {
      id: 'l_fat',
      spec_test_id: 'st_fat',
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
    const { verdicts } = checkConfiguredLimits(raskas, tests, [limit], {});
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0].verdict).toBe('not_checked');
  });

  it('still judges a percent against a percent limit', () => {
    const tests = [{ id: 'st_fat', name: 'FAT', aliases: [] }];
    const limit = {
      id: 'l_fat',
      spec_test_id: 'st_fat',
      operator: 'between' as const,
      value_min: 30,
      value_max: 35,
      unit: '%',
      severity: 'warn' as const,
      active: true,
      supplier_id: null,
      document_type_id: null,
      product_id: null,
    };
    const src = (v: string) => [
      { scope: 'record[0]', tables: [{ name: 'r', headers: ['test', 'result'], rows: [['FAT', v]] }] },
    ];
    expect(checkConfiguredLimits(src('24.26%'), tests, [limit], {}).verdicts[0]).toMatchObject({
      verdict: 'out_of_spec',
    });
    expect(
      checkConfiguredLimits(src('33.09%'), tests, [limit], {}, { includePasses: true }).verdicts[0]
    ).toMatchObject({ verdict: 'in_spec' });
  });
});

describe('the absence vocabulary labs actually print', () => {
  const absent = [
    'Absent',
    'Absent/25g',
    'Negative',
    'Neg',
    'ND',
    'Not Detected',
    'not detected',
    'None Detected',
    'Non-detectable',
    'Nondetectable',
    'non detected',
    'No Growth',
    'no growth',
  ];

  it('reads every spelling of "nothing found" as absent', () => {
    for (const s of absent) {
      expect(parseMeasuredValue(s), `value ${JSON.stringify(s)}`).toMatchObject({
        kind: 'qualitative',
        qualifier: 'absent',
      });
    }
  });

  it('reads the prod Listeria cell that could not be judged', () => {
    // From a live run: "Listeria monocytogenes could not be judged against our
    // limit of absent — result could not be read as a value."
    const v = parseMeasuredValue('Non-detectable for Listeria mono/25g');
    expect(v).toMatchObject({ kind: 'qualitative', qualifier: 'absent' });

    const tests = [{ id: 'st_lm', name: 'Listeria monocytogenes', aliases: ['Listeria mono'] }];
    const limit = {
      id: 'l_lm',
      spec_test_id: 'st_lm',
      operator: 'absent' as const,
      value_min: null,
      value_max: null,
      unit: null,
      severity: 'alert' as const,
      active: true,
      supplier_id: null,
      document_type_id: null,
      product_id: null,
    };
    const src = [
      {
        scope: 'record[0]',
        tables: [
          {
            name: 'micro',
            headers: ['test', 'result'],
            rows: [['Listeria monocytogenes', 'Non-detectable for Listeria mono/25g']],
          },
        ],
      },
    ];
    expect(checkConfiguredLimits(src, tests, [limit], {}).verdicts).toEqual([]);
    const withPasses = checkConfiguredLimits(src, tests, [limit], {}, { includePasses: true });
    expect(withPasses.verdicts[0]).toMatchObject({ verdict: 'in_spec' });
  });

  it('still reads presence, and still refuses a count dressed as a phrase', () => {
    expect(parseMeasuredValue('Positive')).toMatchObject({ qualifier: 'present' });
    expect(parseMeasuredValue('Detected in 25 g')).toMatchObject({ qualifier: 'present' });
    // A phrase carrying a real enumeration is a count, not a qualitative claim.
    expect(parseMeasuredValue('Negative, 20 CFU/g').kind).not.toBe('qualitative');
  });

  it('will not read an absence token buried inside a longer phrase', () => {
    // Only a LEADING token counts. Cells routinely arrive carrying text from a
    // neighbouring column, and a false "absent" on a pathogen is the worst
    // output this module can produce — so an unreadable phrase stays
    // unparseable, which surfaces as not_checked.
    for (const s of [
      'Salmonella spec is Absent/25g',
      'Tested to a standard of not detected',
      'See attached: negative',
    ]) {
      expect(parseMeasuredValue(s).kind, `value ${JSON.stringify(s)}`).toBe('unparseable');
    }
  });

  it('refuses a cell that claims both absence and presence', () => {
    expect(parseMeasuredValue('Negative for Listeria, Positive for Salmonella').kind).toBe(
      'unparseable'
    );
    expect(parseMeasuredValue('Not detected; presumptive positive').kind).toBe('unparseable');
  });

  it('reads the same vocabulary in a printed SPEC cell', () => {
    expect(parseLimitExpression('Non-detectable')).toMatchObject({ operator: 'absent' });
    expect(parseLimitExpression('No Growth')).toMatchObject({ operator: 'absent' });
    expect(parseLimitExpression('Negative/25g')).toMatchObject({ operator: 'absent', basis_grams: 25 });
    // And nothing that used to parse as a number has become an absence limit.
    expect(parseLimitExpression('NMT 100')).toMatchObject({ operator: '<=', max: 100 });
    expect(parseLimitExpression('not more than 100')).toMatchObject({ operator: '<=', max: 100 });
    expect(parseLimitExpression('no more than 100')).toMatchObject({ operator: '<=', max: 100 });
  });
});

describe('crosstab tables are judged, not skipped', () => {
  // 7 of 100 prod Andersen documents and several Schreiber documents were
  // dropped entirely by the row loop: no verdict, no not_checked, no unmatched.
  const tests = [
    { id: 'st_coli', name: 'Coliform', aliases: ['Coliforms'] },
    { id: 'st_aer', name: 'Aerobic', aliases: ['Aerobic Plate Count'] },
    { id: 'st_fat', name: 'Fat', aliases: [] },
  ];
  const mk = (id: string, spec_test_id: string, extra: Record<string, unknown> = {}) => ({
    id,
    spec_test_id,
    operator: '<=' as const,
    value_min: null,
    value_max: 10,
    unit: 'CFU/g',
    severity: 'alert' as const,
    active: true,
    supplier_id: null,
    document_type_id: null,
    product_id: null,
    ...extra,
  });
  const limits = [
    mk('l_coli', 'st_coli'),
    mk('l_aer', 'st_aer'),
    mk('l_fat', 'st_fat', { operator: 'between' as const, value_min: 30, value_max: 35, unit: '%' }),
  ];
  const table = (headers: string[], rows: string[][]) => [
    { scope: 'record[0]', tables: [{ name: 'micro', headers, rows }] },
  ];

  it('shape (a): a leading label column, then one column per analyte', () => {
    const src = table(
      ['Sample', 'Coliform', 'Aerobic'],
      [
        ['Buffer', '<1', '<1'],
        ['Product', '<1', '20'],
      ]
    );
    const r = checkConfiguredLimits(src, tests, limits, {});
    expect(r.verdicts).toHaveLength(1);
    expect(r.verdicts[0]).toMatchObject({
      verdict: 'out_of_spec',
      test_name_raw: 'Aerobic',
      value_raw: '20',
    });
    expect(r.verdicts[0].target).toMatchObject({ kind: 'table', row_index: 1, col_index: 2, row_label: 'Product' });
  });

  it('shape (b): every column an analyte', () => {
    const src = table(
      ['FAT', 'MOISTURE', 'pH', 'SALT', 'COLIFORMS', 'YEAST/MOLD'],
      [['33.09%', '54.67%', '4.62', '1.10%', '<10 CFU/g', '<10 CFU/g']]
    );
    const r = checkConfiguredLimits(src, tests, limits, {}, { includePasses: true });
    expect(r.verdicts.map((v) => v.test_name_raw).sort()).toEqual(['COLIFORMS', 'FAT']);
    expect(r.verdicts.every((v) => v.verdict === 'in_spec')).toBe(true);
    // The columns we hold no limit for land in the quiet unmatched count rather
    // than vanishing.
    expect(r.unmatched.sort()).toEqual(['MOISTURE', 'SALT', 'YEAST/MOLD', 'pH']);
    // And a failing fat reading in that same shape is caught.
    const bad = checkConfiguredLimits(
      table(['FAT', 'COLIFORMS'], [['24.26%', '<10 CFU/g']]),
      tests,
      limits,
      {}
    );
    expect(bad.verdicts).toHaveLength(1);
    expect(bad.verdicts[0]).toMatchObject({ verdict: 'out_of_spec', test_name_raw: 'FAT' });
  });

  it('gives each analyte in a crosstab row its own stable key', () => {
    const r = checkConfiguredLimits(
      table(['Sample', 'Coliform', 'Aerobic'], [['Product', '40', '50']]),
      tests,
      limits,
      {}
    );
    expect(r.verdicts).toHaveLength(2);
    expect(new Set(r.verdicts.map(specVerdictKey)).size).toBe(2);
  });

  it('does NOT judge a laboratory control row as product', () => {
    // "Buffer" is the negative control. A contaminated control would raise an
    // alarm about a product that was never tested that way — and a reviewer
    // taught to wave off "that's just the buffer" will wave off the real one.
    const r = checkConfiguredLimits(
      table(
        ['Sample', 'Coliform', 'Aerobic'],
        [
          ['Buffer', '400', '900'],
          ['Product', '<1', '<1'],
        ]
      ),
      tests,
      limits,
      {},
      { includePasses: true }
    );
    expect(r.verdicts.every((v) => (v.target as { row_label?: string }).row_label === 'Product')).toBe(true);
    expect(r.verdicts.some((v) => v.verdict === 'out_of_spec')).toBe(false);
    // Skipped, but never silently: the row's existence is reported.
    expect(r.control_rows).toEqual(['Buffer']);
  });

  it('recognises the control vocabulary exactly, and nothing looser', () => {
    for (const l of ['Buffer', 'buffer', 'Blank', 'CONTROL', 'Negative Control', 'neg control', 'Media', 'Media Control', 'Sterility', 'Water']) {
      expect(isControlRowLabel(l), `label ${JSON.stringify(l)}`).toBe(true);
    }
    // Substring matching would silently drop product rows, which is the false
    // negative this module exists to avoid.
    for (const l of ['Product', 'Buffered Cream Cheese', 'Control Sample #4', 'Composite', '']) {
      expect(isControlRowLabel(l), `label ${JSON.stringify(l)}`).toBe(false);
    }
  });

  it('does not crosstab a table that already has a result column', () => {
    // No double-counting: an ordinary table is walked once, by the row loop.
    const r = checkConfiguredLimits(
      table(['Coliform', 'Result', 'Aerobic'], [['Coliform', '40', 'x']]),
      tests,
      limits,
      {}
    );
    expect(r.verdicts).toHaveLength(1);
    expect(r.verdicts[0].target).not.toHaveProperty('col_index');
  });

  it('needs two distinct analyte headers before it claims a crosstab', () => {
    const r = checkConfiguredLimits(
      table(['Description', 'Coliform'], [['Something', '40']]),
      tests,
      limits,
      {}
    );
    expect(r.verdicts).toEqual([]);
  });
});

describe('scientific notation carrying a unit column', () => {
  // Regression for the worst class of bug this module can have. `applyRowUnit`
  // appends the unit column to the value, and the scientific-notation match used
  // to be anchored at the end — so `3.0x10^2` + `CFU/g` parsed as **3**, which
  // reads as in_spec against a <=100 limit. A value 3x over its limit passed
  // silently. Labs print micro counts this way routinely.
  const forms: Array<[string, number]> = [
    ['3.0x10^2 CFU/g', 300],
    ['1.2e3 CFU/g', 1200],
    ['2×10³ CFU/g', 2000],
    ['5.0 x 10^4 CFU/g', 50000],
  ];

  it('reads the magnitude, not the leading token', () => {
    for (const [raw, expected] of forms) {
      const v = parseMeasuredValue(raw);
      expect(v.kind, raw).toBe('numeric');
      expect(v.value, raw).toBe(expected);
    }
  });

  it('still recovers the unit, and never claims the exponent as part of it', () => {
    for (const [raw] of forms) {
      // `1.2e3 CFU/g` used to yield unit "e3 CFU/g", which matched no unit family.
      expect(parseMeasuredValue(raw).unit, raw).toBe('CFU/g');
    }
  });

  it('judges a value over its limit as OUT of spec, not in', () => {
    const limit: SpecLimit = {
      operator: '<=', min: null, max: 100, unit: 'CFU/g',
      raw: '<=100 CFU/g', basis_grams: null,
    };
    const c = compareToLimit(parseMeasuredValue('3.0x10^2 CFU/g'), limit);
    expect(c.verdict).toBe('out_of_spec');
    expect(c.value_num).toBe(300);
  });

  it('carries the magnitude through a censored reading', () => {
    const v = parseMeasuredValue('<3.0x10^2 CFU/g');
    expect(v.kind).toBe('censored_lt');
    expect(v.value).toBe(300);
    expect(v.unit).toBe('CFU/g');
  });

  it('leaves ordinary values exactly as they were', () => {
    const unchanged: Array<[string, string, number | null, string | null]> = [
      ['40 CFU/g', 'numeric', 40, 'CFU/g'],
      ['1,530 CFU/g', 'numeric', 1530, 'CFU/g'],
      ['1.10%', 'numeric', 1.1, '%'],
      ['3.0x10^2', 'numeric', 300, null],
      ['<10', 'censored_lt', 10, null],
      ['<1 est', 'censored_lt', 1, null],
    ];
    for (const [raw, kind, value, unit] of unchanged) {
      const v = parseMeasuredValue(raw);
      expect(v.kind, raw).toBe(kind);
      expect(v.value, raw).toBe(value);
      expect(v.unit, raw).toBe(unit);
    }
  });

  it('does not mistake a trailing word for an exponent', () => {
    // `1.2est` must read as 1.2, not as 1.2 x 10^st or similar.
    const v = parseMeasuredValue('1.2est');
    expect(v.kind).toBe('numeric');
    expect(v.value).toBe(1.2);
  });
});

// ---------------------------------------------------------------------------
// Per-tenant unit equivalence (migration 0093)
// ---------------------------------------------------------------------------

/**
 * A fluid-dairy tenant declares that CFU/mL and CFU/g are the same number for
 * its products. On production the majority of its results print `cfu/mL` while
 * every limit on file is written in CFU/g, so before this setting existed the
 * majority unit was judged against nothing at all.
 *
 * These tests exist in equal measure to pin what the setting must NOT do. It is
 * an equivalence between two BASES of one enumeration method, not permission to
 * ignore units: a percent against a CFU/g limit stays refused (that refusal
 * caught a real extraction bug — a micro spec misfiled onto a FAT row), and CFU
 * against MPN stays refused too. And nothing it makes reachable is allowed to
 * be quiet about it.
 */
const EQUATE = { volume_mass_equivalent: true };

const cfuGramLimit = (max: number): SpecLimit =>
  lim({ operator: '<=', max, unit: 'CFU/g' });

describe('unit equivalence — OFF by default', () => {
  it('still refuses CFU/mL against a CFU/g limit', () => {
    // The default must be today's behaviour, byte for byte. A tenant that has
    // said nothing gets the answer that is correct for a powder.
    expect(unitFactor(normalizeUnit('CFU/mL'), normalizeUnit('CFU/g'))).toBeNull();
    expect(resolveUnits(normalizeUnit('CFU/mL'), normalizeUnit('CFU/g'))).toBeNull();

    const cmp = compareToLimit(parseMeasuredValue('120 CFU/mL'), cfuGramLimit(20000));
    expect(cmp.verdict).toBe('not_checked');
    expect(cmp.reason).toMatch(/not comparable/);
    expect(cmp.unit_equivalence_applied).toBeUndefined();
  });

  it('is off when an empty policy object is passed, not just when omitted', () => {
    expect(unitFactor(normalizeUnit('CFU/mL'), normalizeUnit('CFU/g'), {})).toBeNull();
    expect(
      unitFactor(normalizeUnit('CFU/mL'), normalizeUnit('CFU/g'), {
        volume_mass_equivalent: false,
      })
    ).toBeNull();
  });
});

describe('unit equivalence — ON, and never silent about it', () => {
  it('compares CFU/mL against a CFU/g limit at 1:1', () => {
    const match = resolveUnits(normalizeUnit('CFU/mL'), normalizeUnit('CFU/g'), EQUATE);
    expect(match).toEqual({ factor: 1, equated: true });
  });

  it('names itself in the reason of a pass — the whole point', () => {
    // A bare "120 is within the 20000 limit" here would be exactly the false
    // confidence the three-state design exists to prevent.
    const cmp = compareToLimit(parseMeasuredValue('120 CFU/mL'), cfuGramLimit(20000), EQUATE);
    expect(cmp.verdict).toBe('in_spec');
    expect(cmp.value_num).toBe(120);
    expect(cmp.unit_equivalence_applied).toBe(true);
    expect(cmp.reason).toBe(
      "120 is within the 20000 limit (CFU/mL judged as CFU/g, per this tenant's setting)"
    );
  });

  it('names itself in the reason of a failure too', () => {
    const cmp = compareToLimit(parseMeasuredValue('40000 CFU/mL'), cfuGramLimit(20000), EQUATE);
    expect(cmp.verdict).toBe('out_of_spec');
    expect(cmp.reason).toMatch(/40000 exceeds the 20000 limit \(cfu\/mL judged as CFU\/g/i);
  });

  it('names itself on a refusal that happened for a DIFFERENT reason', () => {
    // The units were bridged; the censored value is what blocked the verdict.
    // Both facts belong in the record.
    const cmp = compareToLimit(parseMeasuredValue('<50 CFU/mL'), cfuGramLimit(10), EQUATE);
    expect(cmp.verdict).toBe('not_checked');
    expect(cmp.reason).toMatch(/straddles the 10 limit/);
    expect(cmp.reason).toMatch(/judged as CFU\/g, per this tenant's setting/);
  });

  it('works in the other direction — a CFU/g result against a CFU/mL limit', () => {
    const cmp = compareToLimit(
      parseMeasuredValue('5 CFU/g'),
      lim({ operator: '<=', max: 10, unit: 'CFU/mL' }),
      EQUATE
    );
    expect(cmp.verdict).toBe('in_spec');
    expect(cmp.unit_equivalence_applied).toBe(true);
  });

  it('carries the per-basis scaling across the bridge', () => {
    // 500 CFU/100mL is 5 per mL, which is 5 per g once the bases are equated.
    const cmp = compareToLimit(parseMeasuredValue('500 CFU/100mL'), cfuGramLimit(10), EQUATE);
    expect(cmp.verdict).toBe('in_spec');
    expect(cmp.value_num).toBeCloseTo(5);
  });

  it('applies to MPN as well, within MPN', () => {
    const cmp = compareToLimit(
      parseMeasuredValue('3 MPN/mL'),
      lim({ operator: '<=', max: 10, unit: 'MPN/g' }),
      EQUATE
    );
    expect(cmp.verdict).toBe('in_spec');
    expect(cmp.unit_equivalence_applied).toBe(true);
  });

  it('leaves an ordinary same-unit comparison completely unmarked', () => {
    // Turning the setting on must not add noise to results that never needed it.
    const cmp = compareToLimit(parseMeasuredValue('5 CFU/g'), cfuGramLimit(10), EQUATE);
    expect(cmp.verdict).toBe('in_spec');
    expect(cmp.reason).toBe('5 is within the 10 limit');
    expect(cmp.unit_equivalence_applied).toBeUndefined();
  });

  it('leaves a unitless result unmarked — it was never a mismatch', () => {
    const cmp = compareToLimit(parseMeasuredValue('5'), cfuGramLimit(10), EQUATE);
    expect(cmp.verdict).toBe('in_spec');
    expect(cmp.unit_equivalence_applied).toBeUndefined();
  });
});

describe('unit equivalence is NOT "ignore units"', () => {
  it('still refuses a percent against a CFU/g limit, setting on or off', () => {
    // THE line this feature must not cross. A prod COA had a micro
    // specification misfiled onto its FAT row, and 24.26% was compared against
    // a ≤10 CFU/g limit and reported OUT OF SPEC. A percent and a count are
    // incomparable; loosening units for fluid dairy must not resurrect that.
    for (const policy of [{}, EQUATE]) {
      const cmp = compareToLimit(parseMeasuredValue('24.26%'), cfuGramLimit(10), policy);
      expect(cmp.verdict).toBe('not_checked');
      expect(cmp.reason).toMatch(/not comparable/);
      expect(cmp.unit_equivalence_applied).toBeUndefined();
    }
    expect(unitFactor(normalizeUnit('%'), normalizeUnit('CFU/g'), EQUATE)).toBeNull();
    expect(unitFactor(normalizeUnit('CFU/g'), normalizeUnit('%'), EQUATE)).toBeNull();
  });

  it('still refuses MPN against CFU — a different method, not a different basis', () => {
    expect(unitFactor(normalizeUnit('MPN/g'), normalizeUnit('CFU/g'), EQUATE)).toBeNull();
    expect(unitFactor(normalizeUnit('MPN/mL'), normalizeUnit('CFU/g'), EQUATE)).toBeNull();
    const cmp = compareToLimit(parseMeasuredValue('3 MPN/mL'), cfuGramLimit(10), EQUATE);
    expect(cmp.verdict).toBe('not_checked');
  });

  it('still refuses pH and temperature against a count', () => {
    expect(unitFactor(normalizeUnit('pH'), normalizeUnit('CFU/g'), EQUATE)).toBeNull();
    expect(unitFactor(normalizeUnit('C'), normalizeUnit('CFU/g'), EQUATE)).toBeNull();
  });
});

describe('unit equivalence through the checkers', () => {
  const tests = [{ id: 'st_coliform', name: 'Coliform', aliases: ['Total Coliform'] }];
  const configured = {
    id: 'l1',
    spec_test_id: 'st_coliform',
    operator: '<=' as const,
    value_min: null,
    value_max: 20000,
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
  const fluid = src([['Coliform', '', '120', 'CFU/mL']]);

  it('is refused by default — the tenant that has said nothing', () => {
    const { verdicts } = checkConfiguredLimits(fluid, tests, [configured], {});
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0].verdict).toBe('not_checked');
    expect(verdicts[0].message).toMatch(/could not be judged against our limit/);
  });

  it('passes with the setting on, and the reviewer sentence says why', () => {
    const { verdicts } = checkConfiguredLimits(fluid, tests, [configured], {}, {
      includePasses: true,
      unitPolicy: EQUATE,
    });
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]).toMatchObject({ verdict: 'in_spec', unit_equivalence_applied: true });
    expect(verdicts[0].message).toBe(
      "Coliform is 120, within our limit of ≤20000 CFU/g (CFU/mL judged as CFU/g, per this tenant's setting)."
    );
    expect(verdicts[0].reason).toMatch(/judged as CFU\/g, per this tenant's setting/);
  });

  it('says it on a failure the setting made reachable', () => {
    const { verdicts } = checkConfiguredLimits(
      src([['Coliform', '', '40000', 'CFU/mL']]),
      tests,
      [configured],
      {},
      { unitPolicy: EQUATE }
    );
    expect(verdicts[0].verdict).toBe('out_of_spec');
    expect(verdicts[0].unit_equivalence_applied).toBe(true);
    expect(verdicts[0].message).toMatch(/outside our limit of ≤20000 CFU\/g \(CFU\/mL judged as CFU\/g/);
  });

  it('says it exactly once on a refusal — the message must not repeat the note', () => {
    const { verdicts } = checkConfiguredLimits(
      src([['Coliform', '', '<50000', 'CFU/mL']]),
      tests,
      [configured],
      {},
      { unitPolicy: EQUATE }
    );
    expect(verdicts[0].verdict).toBe('not_checked');
    expect(verdicts[0].message.match(/per this tenant's setting/g)).toHaveLength(1);
  });

  it('reaches the COA\'s OWN printed spec too', () => {
    // The tenant's statement is about its products, not about whose limit is
    // being read, so a printed CFU/g spec beside a CFU/mL result is judged on
    // the same footing.
    const printedSrc = src([['Coliform', '≤10 CFU/g', '4000', 'CFU/mL']]);
    expect(checkPrintedSpecs(printedSrc)[0]).toMatchObject({ verdict: 'not_checked' });

    const on = checkPrintedSpecs(printedSrc, { unitPolicy: EQUATE })[0];
    expect(on).toMatchObject({ verdict: 'out_of_spec', unit_equivalence_applied: true });
    expect(on.message).toMatch(/per this tenant's setting/);
  });

  it('leaves a percent row refused even with the setting on', () => {
    // The prod shape verbatim: a micro specification misfiled onto a FAT row,
    // so 24.26% arrives against a ≤10 CFU/g limit. Compared, it reads OUT OF
    // SPEC and is a fabricated alert; refused, it is the honest answer. Turning
    // on fluid-dairy unit equivalence must not change that by one character.
    const tight = { ...configured, id: 'l-tight', value_max: 10 };
    const off = checkConfiguredLimits(src([['Coliform', '', '24.26%', '']]), tests, [tight], {});
    const on = checkConfiguredLimits(src([['Coliform', '', '24.26%', '']]), tests, [tight], {}, {
      unitPolicy: EQUATE,
    });
    for (const { verdicts } of [off, on]) {
      expect(verdicts).toHaveLength(1);
      expect(verdicts[0].verdict).toBe('not_checked');
      expect(verdicts[0].unit_equivalence_applied).toBeUndefined();
      expect(verdicts[0].reason).toMatch(/not comparable/);
    }
  });
});

/**
 * "Asserted pass, extracted fail" — the catch metric.
 *
 * This is the number the product is actually sold on: a certificate that CLAIMS
 * compliance on a row whose value breaches a limit. A human reviewer misses it
 * precisely because the paper says it is fine, so the tests below pin the two
 * boundaries that decide whether the number can be trusted at all:
 *
 *   * `not_checked` NEVER counts. It is the engine refusing to judge, and a
 *     refusal counted as a finding is the same lie as a two-state verdict.
 *   * a result the document made no claim about is not in the denominator, so it
 *     can never become a catch however badly it fails.
 */
describe('catches — the certificate said pass, the value says otherwise', () => {
  const tests = [{ id: 'st_coliform', name: 'Coliform', aliases: ['Total Coliform'] }];
  const ours = {
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
  /** test | specification | result | units | pass/fail — every column a COA prints. */
  const src = (rows: string[][]) => [
    {
      scope: 'ai_fields',
      tables: [
        {
          name: 'micro',
          headers: ['test', 'specification', 'result', 'units', 'pass/fail'],
          rows,
        },
      ],
    },
  ];
  /** Both passes, exactly as the register and the recheck script ask for them. */
  const judgeAll = (rows: string[][]) => {
    const sources = src(rows);
    const printed = checkPrintedSpecs(sources);
    const configured = checkConfiguredLimits(sources, tests, [ours], {}, { includePasses: true });
    return findSpecDisagreements(sources, [...printed, ...configured.verdicts]);
  };

  it('counts a row the COA marked Pass that our limit fails', () => {
    // The supplier certifies against ≤50 and ticks Pass; we hold ≤10 and the
    // value is 40. Nobody re-reads a certificate that says Pass — this is the
    // catch.
    const report = judgeAll([['Coliform', '<50', '40', 'CFU/g', 'Pass']]);
    expect(report.catches).toHaveLength(1);
    expect(report.catches[0]).toMatchObject({
      kind: 'asserted_pass_extracted_fail',
      judged_by: 'limit',
      asserted_by: 'verdict_cell',
      assertion_text: 'Pass',
      test_name_raw: 'Coliform',
      value_raw: '40',
    });
    expect(report.catches[0].message).toMatch(/the certificate says "Pass", but 40 is outside our limit of ≤10 CFU\/g/);
    expect(report.asserted_pass).toBe(1);
    expect(report.asserted_pass_judged).toBe(1);
    expect(report.reverse).toEqual([]);
  });

  it('counts a certificate that contradicts its OWN printed limit', () => {
    // No configuration involved: the document prints ≤10, reports 40, and still
    // ticks Pass. The printed judgement is preferred for the report line
    // because it needs nothing of ours to be true.
    const report = judgeAll([['Coliform', '≤10', '40', 'CFU/g', 'Pass']]);
    expect(report.catches).toHaveLength(1);
    expect(report.catches[0].judged_by).toBe('printed');
    // Our ≤10 limit fails it too — one result, one catch, both sources listed.
    expect(report.catches[0].judged_by_all.sort()).toEqual(['limit', 'printed']);
  });

  it('counts a value inside the certificate\'s own spec that breaks ours', () => {
    // No pass/fail column at all. Printing 40 against its own ≤50 IS the
    // document asserting conformance, arithmetically rather than in words.
    const sources = src([['Coliform', '≤50', '40', 'CFU/g', '']]);
    const configured = checkConfiguredLimits(sources, tests, [ours], {}, { includePasses: true });
    const report = findSpecDisagreements(sources, [
      ...checkPrintedSpecs(sources),
      ...configured.verdicts,
    ]);
    expect(report.catches).toHaveLength(1);
    expect(report.catches[0]).toMatchObject({ asserted_by: 'printed_limit', judged_by: 'limit' });
    expect(report.catches[0].message).toMatch(
      /meets the certificate's own printed ≤50, but is outside our limit of ≤10 CFU\/g/
    );
  });

  it('NEVER counts not_checked, however loudly the COA claims a pass', () => {
    // `<50` against a ≤10 limit straddles: the true value could be 2 or 49. The
    // engine refuses, and a refusal is not a finding — if this ever counted,
    // the headline number would be inflated by exactly the cases we were honest
    // enough not to judge.
    const report = judgeAll([['Coliform', '', '<50', 'CFU/g', 'Pass']]);
    expect(report.catches).toEqual([]);
    expect(report.reverse).toEqual([]);
    // Still in the denominator as a claim, but not as a claim we could test.
    expect(report.asserted_pass).toBe(1);
    expect(report.asserted_pass_judged).toBe(0);
  });

  it('refuses a not_checked verdict at the classifier itself', () => {
    const sources = src([['Coliform', '', '<50', 'CFU/g', 'Pass']]);
    const [assertion] = collectPrintedAssertions(sources);
    const { verdicts } = checkConfiguredLimits(sources, tests, [ours], {}, { includePasses: true });
    expect(verdicts[0].verdict).toBe('not_checked');
    expect(assertion.assertion).toBe('pass');
    expect(classifySpecDisagreement(assertion, verdicts[0])).toBeNull();
  });

  it('leaves a result the document claimed nothing about out of the metric', () => {
    // "Report" states no limit and there is no pass/fail column, so the
    // certificate asserted nothing. 40 still fails our limit — it is a finding,
    // it is simply not a CATCH, and it is not in this denominator either.
    const report = judgeAll([['Coliform', 'Report', '40', 'CFU/g', '']]);
    expect(report.catches).toEqual([]);
    expect(report.asserted_pass).toBe(0);
    expect(report.asserted_fail).toBe(0);
    expect(collectPrintedAssertions(src([['Coliform', 'Report', '40', 'CFU/g', '']]))[0]).toMatchObject({
      assertion: 'none',
      basis: null,
    });
  });

  it('counts the reverse direction separately and never as a catch', () => {
    // The COA declares a failure and our limit passes the value. Interesting —
    // a conservative supplier, or an extraction error — but it is not a catch
    // and must never be added to one.
    const report = judgeAll([['Coliform', '', '5', 'CFU/g', 'Fail']]);
    expect(report.catches).toEqual([]);
    expect(report.reverse).toHaveLength(1);
    expect(report.reverse[0]).toMatchObject({
      kind: 'asserted_fail_extracted_pass',
      judged_by: 'limit',
      assertion_text: 'Fail',
    });
    expect(report.asserted_fail).toBe(1);
    expect(report.asserted_pass).toBe(0);
  });

  it('has no reverse to report when passes were not asked for', () => {
    // The review queue omits in_spec verdicts by design. Nothing to compare a
    // printed failure against, so the list is legitimately empty rather than
    // wrong.
    const sources = src([['Coliform', '', '5', 'CFU/g', 'Fail']]);
    const configured = checkConfiguredLimits(sources, tests, [ours], {});
    const report = findSpecDisagreements(sources, [
      ...checkPrintedSpecs(sources),
      ...configured.verdicts,
    ]);
    expect(report.reverse).toEqual([]);
    expect(report.catches).toEqual([]);
  });

  it('never pairs a claim with a judgement from a different result', () => {
    const sources = src([
      ['Coliform', '', '40', 'CFU/g', 'Pass'],
      ['Coliform', '', '1', 'CFU/g', 'Pass'],
    ]);
    const assertions = collectPrintedAssertions(sources);
    const { verdicts } = checkConfiguredLimits(sources, tests, [ours], {}, { includePasses: true });
    const failing = verdicts.find((v) => v.verdict === 'out_of_spec');
    expect(failing).toBeDefined();
    // Row 0's failure against row 1's claim is not a catch, it is two unrelated
    // cells.
    expect(specResultKey(assertions[1].scope, assertions[1].target)).not.toBe(
      specResultKey(failing!.scope, failing!.target)
    );
    expect(classifySpecDisagreement(assertions[1], failing!)).toBeNull();
    // …and the real pairing still is one.
    expect(classifySpecDisagreement(assertions[0], failing!)).toBe('asserted_pass_extracted_fail');
  });

  it('reads claims out of the records path too, not only flat tables', () => {
    const sources = [
      {
        scope: 'record[0]',
        groups: {
          micro: { Coliform: { value: '40', unit: 'CFU/g', spec: '≤50 CFU/g' } },
        },
      },
    ];
    const configured = checkConfiguredLimits(sources, tests, [ours], {}, { includePasses: true });
    const report = findSpecDisagreements(sources, [
      ...checkPrintedSpecs(sources),
      ...configured.verdicts,
    ]);
    expect(report.catches).toHaveLength(1);
    expect(report.catches[0]).toMatchObject({ scope: 'record[0]', asserted_by: 'printed_limit' });
  });
});
