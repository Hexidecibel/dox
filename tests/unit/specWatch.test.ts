/**
 * Supplier watch, completeness and "No limit configured" — the SME rulings of
 * 2026-09-14, pinned at the engine (shared/specCheck.ts, pure).
 *
 *   1. A COA is complete by default. Only a configured REQUIRED ANALYTE can make
 *      it incomplete, and a missing one is its own state — never a pass, never
 *      `not_checked`.
 *   2. A watch's review-by date is a reminder, not an expiry: after it passes
 *      the tighter rule STILL APPLIES and is flagged.
 *   3. A printed analyte with no limit and no printed spec is UNJUDGED — a state
 *      distinct from `not_checked` (we held a limit and could not apply it) and
 *      from in/out of spec.
 */

import { describe, it, expect } from 'vitest';
import {
  checkConfiguredLimits,
  checkRequiredAnalytes,
  overdueWatches,
  requiredAnalyteApplies,
  watchStatus,
  type ConfiguredLimit,
  type RequiredAnalyte,
  type SpecSource,
  type SpecTestDef,
} from '../../shared/specCheck';
import { buildLimitSnapshot } from '../../shared/specSnapshot';

const TESTS: SpecTestDef[] = [
  { id: 'st_coli', name: 'Coliform', aliases: ['Total Coliform', 'COLIFORM CT'], default_unit: 'CFU/g' },
  { id: 'st_spc', name: 'Standard Plate Count', aliases: ['SPC', 'Aerobic'], default_unit: 'CFU/g' },
  { id: 'st_ecoli', name: 'E. coli', aliases: ['Escherichia coli'], default_unit: 'CFU/g' },
];

const CTX = { supplier_id: 'sup_andersen', document_type_id: 'dt_coa', product_ids: [] };

const req = (over: Partial<RequiredAnalyte> = {}): RequiredAnalyte => ({
  id: 'ra_coli',
  spec_test_id: 'st_coli',
  supplier_id: 'sup_andersen',
  document_type_id: 'dt_coa',
  effective_from: null,
  review_by: null,
  reason: 'Sanitation watch',
  ...over,
});

const limit = (over: Partial<ConfiguredLimit> = {}): ConfiguredLimit => ({
  id: 'l_coli_company',
  spec_test_id: 'st_coli',
  operator: '<=',
  value_min: null,
  value_max: 10,
  unit: 'CFU/g',
  severity: 'alert',
  active: true,
  supplier_id: null,
  document_type_id: null,
  product_id: null,
  ...over,
});

const flat = (rows: string[][], headers = ['Test', 'Result', 'Units']): SpecSource[] => [
  { scope: 'ai_fields', tables: [{ name: 'micro', headers, rows }] },
];

describe('required analytes — complete by default', () => {
  it('reports nothing when no requirement is configured, however little the COA reports', () => {
    expect(checkRequiredAnalytes(flat([['SPC', '120', 'CFU/g']]), TESTS, [], CTX)).toEqual([]);
  });

  it('is satisfied by the analyte under its own name', () => {
    expect(checkRequiredAnalytes(flat([['Coliform', '<1', 'CFU/g']]), TESTS, [req()], CTX)).toEqual([]);
  });

  it('is satisfied by an alias, with the same exact matching limits use', () => {
    expect(checkRequiredAnalytes(flat([['COLIFORM CT', '<1', 'CFU/g']]), TESTS, [req()], CTX)).toEqual([]);
  });

  it('does NOT accept a substring match ("Fecal Coliform" is a different test)', () => {
    const missing = checkRequiredAnalytes(flat([['Fecal Coliform', '<1', 'CFU/g']]), TESTS, [req()], CTX);
    expect(missing).toHaveLength(1);
    expect(missing[0].why).toBe('not_on_certificate');
  });

  it('reports a missing required analyte as its own state with a reason from the rule', () => {
    const missing = checkRequiredAnalytes(flat([['SPC', '120', 'CFU/g']]), TESTS, [req()], CTX);
    expect(missing).toEqual([
      expect.objectContaining({
        state: 'missing_required',
        scope: 'ai_fields',
        requirement_id: 'ra_coli',
        spec_test_id: 'st_coli',
        analyte_name: 'Coliform',
        why: 'not_on_certificate',
        requirement_reason: 'Sanitation watch',
      }),
    ]);
    expect(missing[0].reason).toContain('not reported on this certificate under its name or any alias');
    expect(missing[0].message).toContain('the certificate is incomplete');
  });

  it('treats a printed analyte with a blank or pending result as not reported', () => {
    const missing = checkRequiredAnalytes(flat([['Total Coliform', 'Pending', 'CFU/g']]), TESTS, [req()], CTX);
    expect(missing).toHaveLength(1);
    expect(missing[0]).toMatchObject({ why: 'no_result', printed_as: 'Total Coliform' });
  });

  it('counts a crosstab column and a structured group cell as reported', () => {
    const cross: SpecSource[] = [
      { scope: 'ai_fields', tables: [{ name: 'x', headers: ['Sample', 'Coliform', 'Aerobic'], rows: [['Product', '<1', '20']] }] },
    ];
    expect(checkRequiredAnalytes(cross, TESTS, [req()], CTX)).toEqual([]);
    const groups: SpecSource[] = [{ scope: 'ai_fields', groups: { micro: { Coliform: { value: '<1', unit: 'CFU/g' } } } }];
    expect(checkRequiredAnalytes(groups, TESTS, [req()], CTX)).toEqual([]);
  });

  it('judges each record on its own table (plus page-level tables)', () => {
    const sources: SpecSource[] = [
      { scope: 'record[0]', tables: [{ name: 'a', headers: ['Test', 'Result'], rows: [['Coliform', '<1']] }] },
      { scope: 'record[1]', tables: [{ name: 'b', headers: ['Test', 'Result'], rows: [['SPC', '40']] }] },
    ];
    const missing = checkRequiredAnalytes(sources, TESTS, [req()], CTX);
    expect(missing.map((m) => m.scope)).toEqual(['record[1]']);
  });

  it('says so when no results were read from the certificate at all', () => {
    const missing = checkRequiredAnalytes([], TESTS, [req()], CTX);
    expect(missing).toHaveLength(1);
    expect(missing[0].reason).toContain('no test results were read from this certificate');
  });

  it('applies only to its own supplier and document type', () => {
    expect(checkRequiredAnalytes(flat([]), TESTS, [req()], { ...CTX, supplier_id: 'other' })).toEqual([]);
    expect(checkRequiredAnalytes(flat([]), TESTS, [req()], { ...CTX, document_type_id: 'dt_spec' })).toEqual([]);
    expect(checkRequiredAnalytes(flat([]), TESTS, [req()], { ...CTX, document_type_id: null })).toEqual([]);
  });

  it('does not apply before its effective date', () => {
    expect(requiredAnalyteApplies(req({ effective_from: '2026-10-01' }), CTX, '2026-09-15')).toBe(false);
    expect(requiredAnalyteApplies(req({ effective_from: '2026-10-01' }), CTX, '2026-10-01')).toBe(true);
    // No "today" known: a requirement somebody wrote is never silently disabled.
    expect(requiredAnalyteApplies(req({ effective_from: '2026-10-01' }), CTX, null)).toBe(true);
  });
});

describe('review-by — the watch still applies after the date, and says so', () => {
  it('is inside the period on the review-by day and overdue the day after', () => {
    expect(watchStatus('2026-10-01', '2026-10-01')).toEqual({ review_by: '2026-10-01', review_overdue: false });
    expect(watchStatus('2026-10-01', '2026-10-02')).toEqual({ review_by: '2026-10-01', review_overdue: true });
    expect(watchStatus(null, '2026-10-02')).toBeNull();
    expect(watchStatus('2026-10-01', null)?.review_overdue).toBe(false);
  });

  it('a required analyte past its review-by is STILL reported missing, flagged overdue', () => {
    const missing = checkRequiredAnalytes(flat([['SPC', '1', 'CFU/g']]), TESTS, [req({ review_by: '2026-09-01' })], CTX, {
      asOf: '2026-09-15',
    });
    expect(missing).toHaveLength(1);
    expect(missing[0].watch).toEqual({ review_by: '2026-09-01', review_overdue: true });
  });

  it('a supplier limit past its review-by STILL judges (never silently loosens), flagged overdue', () => {
    const limits = [
      limit(),
      limit({ id: 'l_coli_watch', supplier_id: 'sup_andersen', value_max: 1, review_by: '2026-09-01' }),
    ];
    const r = checkConfiguredLimits(flat([['Coliform', '5', 'CFU/g']]), TESTS, limits, CTX, {
      asOf: '2026-09-15',
    });
    // 5 passes the company ≤10 but fails the watch ≤1 — and the watch still governs.
    expect(r.verdicts).toHaveLength(1);
    expect(r.verdicts[0]).toMatchObject({
      verdict: 'out_of_spec',
      limit_id: 'l_coli_watch',
      watch: { review_by: '2026-09-01', review_overdue: true },
    });

    const snap = JSON.parse(buildLimitSnapshot(r.verdicts[0], limits)!);
    expect(snap).toMatchObject({ review_by: '2026-09-01', review_overdue: true, supplier_id: 'sup_andersen', value_max: 1 });
  });

  it('a limit with no review-by carries no watch and snapshots none', () => {
    const limits = [limit()];
    const r = checkConfiguredLimits(flat([['Coliform', '50', 'CFU/g']]), TESTS, limits, CTX, { asOf: '2026-09-15' });
    expect(r.verdicts[0].watch).toBeUndefined();
    expect(JSON.parse(buildLimitSnapshot(r.verdicts[0], limits)!).review_by).toBeUndefined();
  });

  it('lists every overdue watch in force for the document, failing result or not', () => {
    const limits = [
      limit(),
      limit({ id: 'l_watch', supplier_id: 'sup_andersen', value_max: 1, review_by: '2026-09-01' }),
      limit({ id: 'l_other_sup', supplier_id: 'sup_other', value_max: 1, review_by: '2026-09-01' }),
    ];
    const required = [req({ id: 'ra_ecoli', spec_test_id: 'st_ecoli', review_by: '2026-08-01' }), req({ review_by: '2026-12-01' })];
    const due = overdueWatches(TESTS, limits, required, CTX, '2026-09-15');
    expect(due).toEqual([
      { kind: 'limit', id: 'l_watch', spec_test_id: 'st_coli', analyte_name: 'Coliform', review_by: '2026-09-01' },
      { kind: 'required_analyte', id: 'ra_ecoli', spec_test_id: 'st_ecoli', analyte_name: 'E. coli', review_by: '2026-08-01' },
    ]);
  });
});

describe('unjudged — "No limit configured" is its own state', () => {
  it('lists a printed analyte with no configured analyte and no printed spec', () => {
    const r = checkConfiguredLimits(flat([['Somatic Cell Count', '180000', 'per ml']]), TESTS, [limit()], CTX);
    expect(r.verdicts).toEqual([]);
    expect(r.unjudged).toEqual([
      expect.objectContaining({
        state: 'unjudged',
        why: 'no_analyte',
        test_name_raw: 'Somatic Cell Count',
        value_raw: '180000',
        spec_test_id: null,
      }),
    ]);
    expect(r.unjudged[0].message).toContain('no limit configured');
  });

  it('names a configured analyte that has no limit in scope for this supplier', () => {
    const r = checkConfiguredLimits(
      flat([['SPC', '120', 'CFU/g']]),
      TESTS,
      [limit({ id: 'l_spc_other', spec_test_id: 'st_spc', supplier_id: 'sup_other' })],
      CTX
    );
    expect(r.unjudged[0]).toMatchObject({ why: 'no_limit_in_scope', spec_test_id: 'st_spc' });
    expect(r.unjudged[0].reason).toContain('Standard Plate Count is a configured analyte, but no limit applies');
  });

  it('is NOT unjudged when the certificate prints its own specification (the printed pass judges it)', () => {
    const r = checkConfiguredLimits(
      flat([['Fat', '3.5', '%', '≥3.25']], ['Test', 'Result', 'Units', 'Specification']),
      TESTS,
      [limit()],
      CTX
    );
    expect(r.unjudged).toEqual([]);
  });

  it('is NOT unjudged when the certificate itself marks it failed', () => {
    const r = checkConfiguredLimits(
      flat([['Yeast', '400', 'CFU/g', 'Fail']], ['Test', 'Result', 'Units', 'Pass/Fail']),
      TESTS,
      [limit()],
      CTX
    );
    expect(r.unjudged).toEqual([]);
  });

  it('carries the lab word when a "Pass" stands where a number belongs', () => {
    const r = checkConfiguredLimits(flat([['Somatic Cell Count', 'Pass', '']]), TESTS, [limit()], CTX);
    expect(r.unjudged[0]).toMatchObject({ lab_verdict: 'pass' });
  });

  it('ignores a blank result — nothing was printed to judge', () => {
    expect(checkConfiguredLimits(flat([['Somatic Cell Count', 'N/A', '']]), TESTS, [limit()], CTX).unjudged).toEqual([]);
  });

  it('keeps all four states apart on one certificate', () => {
    const r = checkConfiguredLimits(
      flat([
        ['Coliform', '50', 'CFU/g'], // out of spec
        ['SPC', '<50000', 'CFU/g'], // not checked: straddles
        ['E. coli', '<1', 'CFU/g'], // in spec
        ['Somatic Cell Count', '180000', 'per ml'], // unjudged
      ]),
      TESTS,
      [
        limit(),
        limit({ id: 'l_spc', spec_test_id: 'st_spc', value_max: 20000 }),
        limit({ id: 'l_ecoli', spec_test_id: 'st_ecoli', value_max: 10 }),
      ],
      CTX,
      { includePasses: true }
    );
    expect(r.verdicts.map((v) => [v.test_name_raw, v.verdict])).toEqual([
      ['Coliform', 'out_of_spec'],
      ['SPC', 'not_checked'],
      ['E. coli', 'in_spec'],
    ]);
    expect(r.unjudged.map((u) => u.test_name_raw)).toEqual(['Somatic Cell Count']);
  });
});
