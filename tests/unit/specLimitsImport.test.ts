/**
 * bin/lib/specLimitsImport.js — the parse + plan half of `bin/import-spec-limits`.
 *
 * The contract under test, in the order it matters:
 *   1. A re-import never DELETES an alias. The REST API's PUT replaces the whole
 *      array; this must merge, or a re-run silently drops every spelling someone
 *      added by hand and the limit quietly stops matching that supplier's COA.
 *   2. `≤` maps to `<=` with the number in value_max; a presence row (empty
 *      operator, the word "absent") maps to operator `absent` with no bounds and
 *      no unit.
 *   3. A unit the engine cannot place BLOCKS the import. It would otherwise make
 *      every result for that analyte "not checked" forever, which reads as
 *      silence rather than as a misconfiguration.
 *   4. A variant row naming an analyte that is not on the Limits tab is a LOUD
 *      sheet error, never a new analyte and never a silent skip — it is exactly
 *      the spelling that would never be checked.
 *   5. `version` moves when a threshold moves and stays put when only notes do,
 *      because document_spec_checks.limit_snapshot records it as audit trail.
 */
import { describe, it, expect } from 'vitest';
// @ts-expect-error — plain CJS module, no types.
import mod from '../../bin/lib/specLimitsImport.js';
import { normalizeUnit, validateLimitShape, limitThresholdChanged } from '../../shared/specCheck';

const {
  parseAnalyteSheet,
  parseVariantSheet,
  mapOperator,
  mergeAliases,
  buildAliasMap,
  validateUnit,
  buildPlan,
  planToSql,
  sqlText,
  limitMateriallyDiffers,
} = mod;

/** The real workbook's shape: a banner row, a header row, then data. */
const ANALYTE_HEADER = [
  'analyte',
  'operator',
  'value',
  'unit',
  'applies to',
  'notes / basis for the limit',
];
const VARIANT_HEADER = [
  'analyte (must match the Limits by Analyte tab)',
  'test name exactly as printed on the COA',
  'provenance',
  'notes',
];

function analyteSheet(...rows: unknown[][]) {
  return [['Limits by Analyte — banner', '', '', '', '', ''], ANALYTE_HEADER, ...rows];
}
function variantSheet(...rows: unknown[][]) {
  return [['Every spelling your suppliers actually print.', '', '', ''], VARIANT_HEADER, ...rows];
}

const ENGINE = { normalizeUnit, validateLimitShape, newId: () => 'newid' };

function plan(analyteRows: unknown[][], variantRows: unknown[][], db: Record<string, unknown> = {}) {
  const a = parseAnalyteSheet(analyteSheet(...analyteRows));
  const v = parseVariantSheet(variantSheet(...variantRows));
  const p = buildPlan({
    tenantId: 't1',
    analytes: a.analytes,
    variants: v.variants,
    existingTests: (db.existingTests as unknown[]) || [],
    existingLimits: (db.existingLimits as unknown[]) || [],
    ...ENGINE,
  });
  p.errors = [...a.errors, ...v.errors, ...p.errors];
  return p;
}

// ---------------------------------------------------------------------------

describe('mapOperator', () => {
  it('maps the sheet\'s U+2264 to <= with the number in value_max', () => {
    expect(mapOperator('≤', '20000')).toEqual({
      operator: '<=',
      value_min: null,
      value_max: 20000,
    });
  });

  it('accepts the ASCII spelling a hand-typed row would use', () => {
    expect(mapOperator('<=', '10')).toEqual({ operator: '<=', value_min: null, value_max: 10 });
  });

  it('puts a lower bound in value_min, not value_max', () => {
    expect(mapOperator('≥', '4.5')).toEqual({ operator: '>=', value_min: 4.5, value_max: null });
  });

  it('reads a thousands separator', () => {
    expect(mapOperator('≤', '20,000').value_max).toBe(20000);
  });

  it('maps a presence row — empty operator, the word absent — to operator absent', () => {
    expect(mapOperator('', 'absent')).toEqual({
      operator: 'absent',
      value_min: null,
      value_max: null,
    });
    expect(mapOperator('', 'Negative').operator).toBe('absent');
    expect(mapOperator('', 'Not Detected').operator).toBe('absent');
  });

  it('refuses an operator paired with a presence word', () => {
    expect(mapOperator('≤', 'absent').error).toMatch(/makes no sense/);
  });

  it('refuses a number with no operator rather than guessing <=', () => {
    // Guessing here would invent a threshold nobody wrote down.
    expect(mapOperator('', '10').error).toMatch(/not a presence value/);
  });

  it('refuses a non-numeric value and an unknown operator', () => {
    expect(mapOperator('≤', 'ten').error).toMatch(/not a number/);
    expect(mapOperator('~', '10').error).toMatch(/unrecognised operator/);
  });
});

describe('parseAnalyteSheet', () => {
  it('reads the real tab shape and drops the thousand blank rows below it', () => {
    const { analytes, errors } = parseAnalyteSheet(
      analyteSheet(
        ['Standard Plate Count', '≤', '20000', 'CFU/g', 'all suppliers', 'CFU/mL'],
        ['Salmonella', '', 'absent', '', 'all suppliers', 'PRESENCE TEST'],
        ['', '', '', '', '', ''],
        ['', '', '', '', '', '']
      )
    );
    expect(errors).toEqual([]);
    expect(analytes).toHaveLength(2);
    expect(analytes[0]).toMatchObject({
      row: 3,
      name: 'Standard Plate Count',
      operator: '<=',
      value_max: 20000,
      unit: 'CFU/g',
      notes: 'CFU/mL',
      severity: 'alert',
    });
  });

  it('drops the unit on a presence row — an absent limit has no magnitude', () => {
    const { analytes } = parseAnalyteSheet(
      analyteSheet(['Listeria monocytogenes', '', 'absent', 'CFU/g', 'all suppliers', ''])
    );
    expect(analytes[0]).toMatchObject({ operator: 'absent', unit: null, value_max: null });
  });

  it('rejects a scope this importer cannot honour instead of widening it to everyone', () => {
    const { analytes, errors } = parseAnalyteSheet(
      analyteSheet(['Coliform', '≤', '10', 'CFU/g', 'Darigold only', ''])
    );
    expect(analytes).toHaveLength(0);
    expect(errors[0]).toMatch(/Darigold only/);
    expect(errors[0]).toMatch(/tenant-wide/);
  });

  it('reports a repeated analyte with both row numbers', () => {
    const { analytes, errors } = parseAnalyteSheet(
      analyteSheet(
        ['Coliform', '≤', '10', 'CFU/g', 'all suppliers', ''],
        ['coliform', '≤', '100', 'CFU/g', 'all suppliers', '']
      )
    );
    expect(analytes).toHaveLength(1);
    expect(errors[0]).toMatch(/row 4/);
    expect(errors[0]).toMatch(/row 3/);
  });

  it('says so when the header is missing rather than importing the banner', () => {
    const { errors } = parseAnalyteSheet([['some', 'other', 'sheet']]);
    expect(errors[0]).toMatch(/no header row/);
  });
});

describe('parseVariantSheet', () => {
  it('reads analyte + printed name and ignores provenance chatter', () => {
    const { variants, errors } = parseVariantSheet(
      variantSheet(['Coliform', 'COLIFORM CT', "Chris's message 2026-08-20", ''])
    );
    expect(errors).toEqual([]);
    expect(variants).toEqual([
      { row: 3, analyte: 'Coliform', printed: 'COLIFORM CT', provenance: "Chris's message 2026-08-20" },
    ]);
  });

  it('reports a half-filled row', () => {
    const { variants, errors } = parseVariantSheet(variantSheet(['Coliform', '', 'x', '']));
    expect(variants).toHaveLength(0);
    expect(errors[0]).toMatch(/row 3/);
  });
});

describe('mergeAliases', () => {
  it('never drops a spelling that was already stored', () => {
    const r = mergeAliases(['Hand Added Spelling'], ['COLIFORM CT'], 'Coliform');
    expect(r.merged).toEqual(['Hand Added Spelling', 'COLIFORM CT']);
    expect(r.kept).toBe(1);
    expect(r.added).toEqual(['COLIFORM CT']);
  });

  it('dedupes case-insensitively and keeps the casing already stored', () => {
    const r = mergeAliases(['Total Coliform'], ['TOTAL COLIFORM', 'Coliforms'], 'Coliform');
    expect(r.merged).toEqual(['Total Coliform', 'Coliforms']);
    expect(r.duplicates).toEqual(['TOTAL COLIFORM']);
    expect(r.added).toEqual(['Coliforms']);
  });

  it('dedupes within one incoming batch too', () => {
    const r = mergeAliases([], ['Yeast/Mold', 'yeast/mold'], 'Yeast & Mold (combined)');
    expect(r.merged).toEqual(['Yeast/Mold']);
    expect(r.duplicates).toEqual(['yeast/mold']);
  });

  it('drops an alias that is only the analyte name in another case', () => {
    // matchSpecTest tries the canonical name first and normalises case, so such
    // an alias can never be the thing that makes a match.
    const r = mergeAliases([], ['COLIFORM', 'Coliform', 'Coliforms'], 'Coliform');
    expect(r.merged).toEqual(['Coliforms']);
    expect(r.sameAsName).toEqual(['COLIFORM', 'Coliform']);
  });

  it('keeps punctuation variants apart — they normalise differently to a human, not to us', () => {
    const r = mergeAliases([], ['E. coli', 'E.coli'], 'E. coli');
    // 'E. coli' is the name; 'E.coli' is a genuinely different printed string.
    expect(r.merged).toEqual(['E.coli']);
  });
});

describe('buildAliasMap', () => {
  it('reports a variant whose analyte is not on the Limits tab', () => {
    const { byAnalyte, unmatched } = buildAliasMap(
      [{ name: 'Coliform' }],
      [
        { row: 3, analyte: 'Coliform', printed: 'COLIFORM' },
        { row: 4, analyte: 'Enterobacteriaceae', printed: 'ENTERO' },
      ]
    );
    expect(byAnalyte.get('coliform')).toHaveLength(1);
    expect(unmatched).toHaveLength(1);
    expect(unmatched[0].analyte).toBe('Enterobacteriaceae');
  });
});

describe('validateUnit', () => {
  it('accepts the two units the sheet actually uses', () => {
    expect(validateUnit('CFU/g', normalizeUnit)).toBeNull();
    expect(validateUnit('CFU/mL', normalizeUnit)).toBeNull();
    expect(validateUnit('MPN/g', normalizeUnit)).toBeNull();
    expect(validateUnit('%', normalizeUnit)).toBeNull();
    expect(validateUnit('pH', normalizeUnit)).toBeNull();
  });

  it('accepts a blank unit — that is "unknown", which the comparator allows', () => {
    expect(validateUnit(null, normalizeUnit)).toBeNull();
    expect(validateUnit('', normalizeUnit)).toBeNull();
  });

  it('rejects a typo, because it would silently yield not_checked forever', () => {
    const err = validateUnit('CFUX/gg', normalizeUnit);
    expect(err).toMatch(/not one the spec engine recognises/);
    expect(err).toMatch(/not checked/);
  });
});

describe('buildPlan — a first import', () => {
  const p = plan(
    [
      ['Standard Plate Count', '≤', '20000', 'CFU/g', 'all suppliers', 'basis'],
      ['Salmonella', '', 'absent', '', 'all suppliers', 'PRESENCE TEST'],
    ],
    [
      ['Standard Plate Count', 'SPC', '', ''],
      ['Standard Plate Count', 'APC', '', ''],
      ['Salmonella', 'SALMONELLA', '', ''],
    ]
  );

  it('creates one analyte and one limit per Limits row — never one per spelling', () => {
    expect(p.summary).toMatchObject({
      analytesCreated: 2,
      analytesUpdated: 0,
      limitsCreated: 2,
      limitsUpdated: 0,
      limitsUnchanged: 0,
      errors: 0,
    });
  });

  it('seeds default_unit from the analyte row', () => {
    expect(p.tests[0].defaultUnit).toBe('CFU/g');
    expect(p.tests[1].defaultUnit).toBeNull();
  });

  it('writes every scope column as literal NULL, not the empty string', () => {
    // Migration 0086 COALESCEs at the index precisely so the stored value can
    // stay NULL — resolveSpecLimits and the LEFT JOINs depend on it.
    const sql = planToSql(p).find((s: string) => s.startsWith('INSERT INTO spec_limits'));
    expect(sql).toContain('NULL, NULL,');
    expect(sql).not.toContain("'', ''");
  });

  it('starts every new limit at version 1', () => {
    expect(p.limits.every((l: { version: number }) => l.version === 1)).toBe(true);
  });
});

describe('buildPlan — re-importing onto existing rows', () => {
  const existingTests = [
    {
      id: 'st_col',
      name: 'Coliform',
      aliases: ['Coliforms (MPN)', 'Hand Added By An Operator'],
      default_unit: 'CFU/g',
    },
  ];
  const existingLimits = [
    {
      id: 'sl_col',
      spec_test_id: 'st_col',
      supplier_id: null,
      document_type_id: null,
      product_id: null,
      operator: '<=',
      value_min: null,
      value_max: 10,
      unit: 'CFU/g',
      severity: 'alert',
      notes: null,
      active: 1,
      version: 3,
    },
  ];

  it('is a no-op when the sheet already matches the database', () => {
    const p = plan(
      [['Coliform', '≤', '10', 'CFU/g', 'all suppliers', '']],
      [['Coliform', 'Coliforms (MPN)', '', '']],
      { existingTests, existingLimits }
    );
    expect(p.summary).toMatchObject({
      analytesCreated: 0,
      analytesUpdated: 0,
      analytesUnchanged: 1,
      limitsCreated: 0,
      limitsUpdated: 0,
      limitsUnchanged: 1,
      aliasesAdded: 0,
    });
    expect(planToSql(p)).toEqual([]);
  });

  it('adds new spellings and keeps the hand-added one', () => {
    const p = plan(
      [['Coliform', '≤', '10', 'CFU/g', 'all suppliers', '']],
      [
        ['Coliform', 'Coliforms (MPN)', '', ''],
        ['Coliform', 'COLIFORM CT', '', ''],
      ],
      { existingTests, existingLimits }
    );
    expect(p.tests[0].aliases).toEqual([
      'Coliforms (MPN)',
      'Hand Added By An Operator',
      'COLIFORM CT',
    ]);
    expect(p.summary.aliasesAdded).toBe(1);
    expect(p.summary.aliasesKept).toBe(2);
    expect(p.summary.analytesUpdated).toBe(1);
  });

  it('updates the limit in place rather than inserting a duplicate scope', () => {
    const p = plan(
      [['Coliform', '≤', '5', 'CFU/g', 'all suppliers', '']],
      [['Coliform', 'Coliforms (MPN)', '', '']],
      { existingTests, existingLimits }
    );
    expect(p.summary).toMatchObject({ limitsCreated: 0, limitsUpdated: 1 });
    expect(p.limits[0].id).toBe('sl_col');
    const sql = planToSql(p);
    expect(sql.some((s: string) => s.startsWith('INSERT INTO spec_limits'))).toBe(false);
    expect(sql.some((s: string) => s.startsWith('UPDATE spec_limits'))).toBe(true);
  });

  it('bumps version when the threshold moves', () => {
    const p = plan(
      [['Coliform', '≤', '5', 'CFU/g', 'all suppliers', '']],
      [],
      { existingTests, existingLimits }
    );
    expect(p.limits[0].bumpVersion).toBe(true);
    expect(p.limits[0].version).toBe(4);
    expect(planToSql(p).join('\n')).toContain('version = 4');
  });

  it('bumps version when only the unit moves — CFU/g and CFU/mL judge differently', () => {
    const p = plan([['Coliform', '≤', '10', 'CFU/mL', 'all suppliers', '']], [], {
      existingTests,
      existingLimits,
    });
    expect(p.limits[0].bumpVersion).toBe(true);
    expect(p.limits[0].version).toBe(4);
  });

  it('does NOT bump version for a notes-only edit', () => {
    // version is frozen into document_spec_checks.limit_snapshot as the record
    // of what a result was judged against. Prose must not move it.
    const p = plan([['Coliform', '≤', '10', 'CFU/g', 'all suppliers', 'new basis note']], [], {
      existingTests,
      existingLimits,
    });
    expect(p.limits[0].action).toBe('update');
    expect(p.limits[0].bumpVersion).toBe(false);
    expect(p.limits[0].version).toBe(3);
  });

  it('leaves an existing default_unit alone but fills a blank one', () => {
    const blank = [{ id: 'st_col', name: 'Coliform', aliases: [], default_unit: null }];
    const filled = plan([['Coliform', '≤', '10', 'CFU/g', 'all suppliers', '']], [], {
      existingTests: blank,
    });
    expect(filled.tests[0].setDefaultUnit).toBe('CFU/g');

    const kept = plan([['Coliform', '≤', '10', 'MPN/g', 'all suppliers', '']], [], {
      existingTests: [{ id: 'st_col', name: 'Coliform', aliases: [], default_unit: 'CFU/g' }],
    });
    expect(kept.tests[0].setDefaultUnit).toBeNull();
  });

  it('reuses an analyte stored under different casing instead of creating a second one', () => {
    const p = plan([['COLIFORM', '≤', '10', 'CFU/g', 'all suppliers', '']], [], {
      existingTests,
      existingLimits,
    });
    expect(p.tests[0].id).toBe('st_col');
    expect(p.tests[0].casingDiffers).toBe(true);
    expect(p.summary.analytesCreated).toBe(0);
  });

  it('ignores a scoped limit when looking for the tenant-wide one', () => {
    const scoped = [
      { ...existingLimits[0], id: 'sl_scoped', supplier_id: 'sup1', value_max: 999 },
    ];
    const p = plan([['Coliform', '≤', '10', 'CFU/g', 'all suppliers', '']], [], {
      existingTests,
      existingLimits: scoped,
    });
    expect(p.summary.limitsCreated).toBe(1);
    expect(p.limits[0].id).not.toBe('sl_scoped');
  });
});

describe('buildPlan — errors are loud', () => {
  it('fails the import on a variant row that names no known analyte', () => {
    const p = plan(
      [['Coliform', '≤', '10', 'CFU/g', 'all suppliers', '']],
      [['Enterobacteriaceae', 'ENTERO', '', '']]
    );
    expect(p.unmatchedVariants).toHaveLength(1);
    expect(p.summary.errors).toBe(1);
    expect(p.errors[0]).toMatch(/Enterobacteriaceae/);
    expect(p.errors[0]).toMatch(/never be checked/);
    // and it must not have invented an analyte for it
    expect(p.tests.map((t: { name: string }) => t.name)).toEqual(['Coliform']);
  });

  it('reports a bad unit against the row it came from', () => {
    const p = plan([['Coliform', '≤', '10', 'CFUX/gg', 'all suppliers', '']], []);
    expect(p.summary.errors).toBe(1);
    expect(p.errors[0]).toMatch(/row 3/);
    expect(p.errors[0]).toMatch(/CFUX\/gg/);
  });

  it('reports a shape the engine would reject', () => {
    // '>=' with the number parked in value_max would be a limit with no bound.
    const p = buildPlan({
      tenantId: 't1',
      analytes: [
        { row: 3, name: 'X', operator: '>=', value_min: null, value_max: 5, unit: null, notes: null, severity: 'alert' },
      ],
      variants: [],
      existingTests: [],
      existingLimits: [],
      ...ENGINE,
    });
    expect(p.errors[0]).toMatch(/minimum value is required/);
  });
});

describe('planToSql escaping', () => {
  it('doubles a quote rather than ending the literal', () => {
    expect(sqlText("Chris's note")).toBe("'Chris''s note'");
    expect(sqlText(null)).toBe('NULL');
  });

  it('carries an apostrophe from the sheet through to the statement intact', () => {
    const p = plan([["Chris's Analyte", '≤', '10', 'CFU/g', 'all suppliers', "it's fine"]], []);
    const sql = planToSql(p).join('\n');
    expect(sql).toContain("'Chris''s Analyte'");
    expect(sql).toContain("'it''s fine'");
  });
});

// ---------------------------------------------------------------------------
// Criticality (migration 0095) — the optional column
// ---------------------------------------------------------------------------

/**
 * WHY THE COLUMN IS FOUND BY NAME AND THE OTHERS BY POSITION: the six original
 * columns have always been there, so a positional read cannot drift; an
 * OPTIONAL column can be absent or elsewhere, and reading position 6 would file
 * whatever is there — often the notes — as a tier.
 *
 * WHY AN UNKNOWN WORD IS FATAL RATHER THAN A DEFAULT: quietly defaulting a
 * typo'd "Criticial" DEMOTES a limit somebody deliberately marked as
 * load-stopping, and nothing downstream would ever show that it happened. The
 * REST API answers 400 for the same reason. A BLANK cell is the opposite: it is
 * the default, and it is what every workbook written before tiers existed has.
 */
describe('criticality column', () => {
  const HEADER_WITH_TIER = [...ANALYTE_HEADER, 'criticality'];
  const sheetWithTier = (...rows: unknown[][]) => [
    ['Limits by Analyte — banner', '', '', '', '', '', ''],
    HEADER_WITH_TIER,
    ...rows,
  ];

  it('accepts the words the screen shows and the words the database stores', () => {
    const p = parseAnalyteSheet(
      sheetWithTier(
        ['Coliform', '≤', '10', 'CFU/g', '', '', 'Critical'],
        ['Standard Plate Count', '≤', '20000', 'CFU/g', '', '', 'low'],
        ['Yeast', '≤', '100', 'CFU/g', '', '', 'Tracked']
      )
    );
    expect(p.errors).toEqual([]);
    expect(p.analytes.map((a: any) => a.criticality)).toEqual(['high', 'low', 'medium']);
  });

  it('defaults a blank cell to the middle tier, and says nothing about it', () => {
    const p = parseAnalyteSheet(sheetWithTier(['Coliform', '≤', '10', 'CFU/g', '', '', '']));
    expect(p.errors).toEqual([]);
    expect(p.analytes[0].criticality).toBe('medium');
  });

  it('defaults every row when the column is absent entirely', () => {
    const p = parseAnalyteSheet(analyteSheet(['Coliform', '≤', '10', 'CFU/g', '', '']));
    expect(p.errors).toEqual([]);
    expect(p.analytes[0].criticality).toBe('medium');
  });

  it('fails the import on a word it does not know, naming the row', () => {
    const p = parseAnalyteSheet(
      sheetWithTier(['Coliform', '≤', '10', 'CFU/g', '', '', 'Criticial'])
    );
    expect(p.analytes).toHaveLength(0);
    expect(p.errors[0]).toMatch(/row 3 \(Coliform\)/);
    expect(p.errors[0]).toMatch(/Criticial/);
    expect(p.errors[0]).toMatch(/Critical \(high\)/);
  });

  it('writes the tier on a created limit', () => {
    const p = buildPlan({
      tenantId: 't1',
      analytes: parseAnalyteSheet(
        sheetWithTier(['Coliform', '≤', '10', 'CFU/g', '', '', 'Critical'])
      ).analytes,
      variants: [],
      existingTests: [],
      existingLimits: [],
      ...ENGINE,
    });
    const sql = planToSql(p).join('\n');
    expect(sql).toMatch(/criticality/);
    expect(sql).toMatch(/'high'/);
  });

  it('updates a tier WITHOUT moving the version — a rank is not a threshold', () => {
    const analytes = parseAnalyteSheet(
      sheetWithTier(['Coliform', '≤', '10', 'CFU/g', '', '', 'Critical'])
    ).analytes;
    const p = buildPlan({
      tenantId: 't1',
      analytes,
      variants: [],
      existingTests: [{ id: 'st1', name: 'Coliform', aliases: [], default_unit: 'CFU/g' }],
      existingLimits: [
        {
          id: 'l1',
          spec_test_id: 'st1',
          supplier_id: null,
          document_type_id: null,
          product_id: null,
          operator: '<=',
          value_min: null,
          value_max: 10,
          unit: 'CFU/g',
          severity: 'alert',
          criticality: 'medium',
          notes: null,
          active: 1,
          version: 3,
        },
      ],
      ...ENGINE,
    });
    expect(p.limits[0].action).toBe('update');
    expect(p.limits[0].bumpVersion).toBe(false);
    expect(p.limits[0].version).toBe(3);
    expect(planToSql(p).join('\n')).toMatch(/criticality = 'high'/);
  });
});

// ---------------------------------------------------------------------------
// One version rule, two writers
// ---------------------------------------------------------------------------

/**
 * The importer and `PUT /api/spec-limits/:id` must answer "is this a new version
 * of the limit?" identically — they did not, which is what this now pins. The
 * rule lives in the engine (`limitThresholdChanged`); the importer reads it from
 * the generated bundle, so this also catches a bundle left stale after an edit
 * to shared/specCheck.ts.
 */
describe('version rule, shared with the REST API', () => {
  const before = {
    operator: '<=',
    value_min: null,
    value_max: 10,
    unit: 'CFU/g',
  };

  const cases: Array<[string, Record<string, unknown>, boolean]> = [
    ['an unchanged limit', { ...before }, false],
    ['a moved maximum', { ...before, value_max: 20 }, true],
    ['a moved operator', { ...before, operator: '<' }, true],
    ['a moved unit', { ...before, unit: 'CFU/mL' }, true],
    ['a unit that was cleared', { ...before, unit: null }, true],
    ['a minimum that appeared', { ...before, value_min: 1 }, true],
    ['the same number as text', { ...before, value_max: '10' }, false],
  ];

  for (const [name, after, expected] of cases) {
    it(`${expected ? 'bumps' : 'holds'} for ${name}`, () => {
      expect(limitMateriallyDiffers(before, after)).toBe(expected);
      // …and the engine the API calls says exactly the same thing.
      expect(limitThresholdChanged(before, after)).toBe(expected);
    });
  }
});
