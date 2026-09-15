/**
 * Which RESULT a register row is about (migration 0105).
 *
 * The shapes below are lifted from production documents that looked, on the
 * Out-of-Spec page, like the register had written the same result several
 * times. Replaying the engine showed every one was a distinct result at a
 * distinct place on the certificate. These tests pin both halves of that:
 *
 *   1. The engine gives each of those results its own identity — a multi-lot
 *      crosstab and a two-batch COA are NOT collapsed, however equal the values.
 *   2. The only thing that IS collapsed is the same place on the page judged
 *      twice by the same source, which is what the unique index forbids.
 */
import { describe, it, expect } from 'vitest';
import { checkConfiguredLimits, checkPrintedSpecs } from '../../shared/specCheck';
import type { ConfiguredLimit, SpecTestDef, SpecVerdict } from '../../shared/specCheck';
import { registerIdentity, uniqueByRegisterIdentity } from '../../shared/specSnapshot';
// @ts-expect-error — generated CJS bundle, no types.
import compiledSnapshot from '../../bin/lib/shared/specSnapshot.js';

const TESTS: SpecTestDef[] = [
  { id: 'st-coliform', name: 'Coliform', aliases: ['Coliforms'], default_unit: 'CFU/g' },
  { id: 'st-ym', name: 'Yeast/Mold', aliases: ['Yeast Mold'], default_unit: 'CFU/g' },
  { id: 'st-ecoli', name: 'E. coli', aliases: ['E-Coli'], default_unit: 'CFU/g' },
];

function limit(id: string, spec_test_id: string, value_max: number): ConfiguredLimit {
  return {
    id,
    spec_test_id,
    operator: '<=',
    value_min: null,
    value_max,
    unit: 'CFU/g',
    severity: 'warn',
    active: true,
    supplier_id: null,
    document_type_id: null,
    product_id: null,
  };
}

const LIMITS = [
  limit('l-coliform', 'st-coliform', 10),
  limit('l-ym', 'st-ym', 100),
  limit('l-ecoli', 'st-ecoli', 10),
];
const CTX = { supplier_id: null, document_type_id: null, product_ids: [] };

// "TUB WHIP CREAM CH SPRD - RASKAS": six lots, and every one of them printed
// "<10 CFU/g" for both micro columns. Twelve results, twelve rows.
const MULTI_LOT_CROSSTAB = {
  name: 'microbiological_results',
  headers: ['FAT', 'MOISTURE', 'pH', 'SALT', 'COLIFORMS', 'YEAST/MOLD'],
  rows: [
    ['33.09%', '54.67%', '4.62', '1.10%', '<10 CFU/g', '<10 CFU/g'],
    ['22.06%', '61.43%', '4.85', '1.02%', '<10 CFU/g', '<10 CFU/g'],
    ['21.36%', '62.09%', '4.81', '1.13%', '<10 CFU/g', '<10 CFU/g'],
    ['33.09%', '54.54%', '4.64', '1.13%', '<10 CFU/g', '<10 CFU/g'],
    ['33.01%', '53.91%', '4.67', '1.21%', '<10 CFU/g', '<10 CFU/g'],
    ['23.57%', '61.69%', '4.89', '.89%', '<10 CFU/g', '<10 CFU/g'],
  ],
};

// "NT-Medosweet-32LB-Tub-NaturalSourCream": two batches on one certificate.
// The micro rows agree; the butterfat and solids show they are two batches.
const batch = (butterfat: string, solids: string) => ({
  headers: ['Test', 'UOM', 'Result', 'Specification', 'Units'],
  rows: [
    ['Butterfat', '%', butterfat, 'N/A', '%'],
    ['Coliform', 'CFU/G', '<10', 'N/A', 'CFU/G'],
    ['E-Coli', 'CFU/G', '<10', 'N/A', 'CFU/G'],
    ['Total Solids', '%', solids, 'N/A', '%'],
  ],
});
const TWO_BATCHES = [
  { name: 'test_results', ...batch('18.00', '26.86') },
  { name: 'test_results_3', ...batch('18.50', '26.00') },
];

const visible = (v: SpecVerdict) =>
  JSON.stringify([v.test_name_raw, v.value_raw, v.unit_raw, v.source, v.limit_id, v.verdict]);

describe('equal values at different places are different results', () => {
  it('a multi-lot crosstab keeps one register row per lot', () => {
    const { verdicts } = checkConfiguredLimits(
      [{ scope: 'ai_fields', tables: [MULTI_LOT_CROSSTAB] }],
      TESTS,
      LIMITS,
      CTX,
      { includePasses: true }
    );
    expect(verdicts).toHaveLength(12);
    // Indistinguishable on every column the page used to show…
    expect(new Set(verdicts.map(visible)).size).toBe(2);
    // …and twelve distinct identities all the same.
    expect(new Set(verdicts.map((v) => registerIdentity(v).result_key)).size).toBe(12);

    const { kept, dropped } = uniqueByRegisterIdentity(verdicts);
    expect(kept).toHaveLength(12);
    expect(dropped).toHaveLength(0);
    expect(registerIdentity(verdicts[2]).result_location).toBe('Table 1, row 2 (22.06%)');
  });

  it('two batches on one certificate keep both batches', () => {
    const { verdicts } = checkConfiguredLimits(
      [{ scope: 'ai_fields', tables: TWO_BATCHES }],
      TESTS,
      LIMITS,
      CTX,
      { includePasses: true }
    );
    const coliform = verdicts.filter((v) => v.test_name_raw === 'Coliform');
    expect(coliform).toHaveLength(2);
    expect(coliform.map((v) => registerIdentity(v).result_location)).toEqual([
      'Table 1, row 2',
      'Table 2, row 2',
    ]);
    expect(uniqueByRegisterIdentity(verdicts).kept).toHaveLength(verdicts.length);
  });

  it('the engine never emits one place twice for one source', () => {
    const sources = [
      { scope: 'ai_fields', tables: [MULTI_LOT_CROSSTAB, ...TWO_BATCHES] },
      { scope: 'record[1]', tables: TWO_BATCHES },
    ];
    const all = [
      ...checkPrintedSpecs(sources),
      ...checkConfiguredLimits(sources, TESTS, LIMITS, CTX, { includePasses: true }).verdicts,
    ];
    expect(uniqueByRegisterIdentity(all).dropped).toEqual([]);
  });
});

describe('the one thing that is collapsed', () => {
  const base = checkConfiguredLimits(
    [{ scope: 'ai_fields', tables: TWO_BATCHES }],
    TESTS,
    LIMITS,
    CTX,
    { includePasses: true }
  ).verdicts[0];

  it('drops the same place judged twice by the same source', () => {
    const { kept, dropped } = uniqueByRegisterIdentity([base, { ...base }]);
    expect(kept).toHaveLength(1);
    expect(dropped).toHaveLength(1);
  });

  it('keeps the COA\'s own verdict and ours on the same cell', () => {
    const printed: SpecVerdict = { ...base, source: 'printed', limit_id: null };
    expect(uniqueByRegisterIdentity([base, printed]).kept).toHaveLength(2);
  });

  it('keeps the same place in two different records', () => {
    expect(uniqueByRegisterIdentity([base, { ...base, scope: 'record[2]' }]).kept).toHaveLength(2);
  });
});

describe('the location in words', () => {
  it('names the record, the table and the row label', () => {
    expect(
      registerIdentity({
        scope: 'record[0]',
        target: { kind: 'table', table_index: 1, row_index: 3, table_name: 'x', col_index: 9, row_label: '26141R' },
      })
    ).toEqual({ result_key: 'record[0]::t1r3c9', result_location: 'Record 1, table 2, row 4 (26141R)' });
  });

  it('names a structured group cell', () => {
    expect(
      registerIdentity({ scope: 'ai_fields', target: { kind: 'group', group: 'micro', cell: 'Coliform' } })
    ).toEqual({ result_key: 'ai_fields::gmicro/Coliform', result_location: 'micro › Coliform' });
  });

  it('the bundle bin/ loads agrees with the source the Worker loads', () => {
    const cases: Array<Pick<SpecVerdict, 'scope' | 'target'>> = [
      { scope: 'ai_fields', target: { kind: 'table', table_index: 0, row_index: 0, table_name: '' } },
      { scope: 'record[4]', target: { kind: 'table', table_index: 2, row_index: 1, table_name: 't', col_index: 3, row_label: 'L1' } },
      { scope: 'ai_fields', target: { kind: 'group', group: 'g', cell: 'c' } },
    ];
    for (const c of cases) {
      expect(compiledSnapshot.registerIdentity(c)).toEqual(registerIdentity(c));
    }
  });
});
