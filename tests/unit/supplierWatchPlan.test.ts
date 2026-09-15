/**
 * bin/lib/supplierWatchPlan.js — the plan behind `bin/seed-supplier-watch`.
 *
 *   1. A re-run of the same command plans NOTHING (idempotent).
 *   2. An analyte is resolved exactly as the engine matches it — id, name or
 *      alias, never a substring — and an unknown one is an error, not a skip.
 *   3. A supplier limit is written at the supplier-only scope, with the review-by,
 *      and `version` moves only when the threshold does.
 *   4. Every write carries an audit row.
 */
import { describe, it, expect } from 'vitest';
// @ts-expect-error — plain CJS module, no types.
import mod from '../../bin/lib/supplierWatchPlan.js';
import { normalizeUnit, validateLimitShape } from '../../shared/specCheck';

const { parseLimitFlag, buildWatchPlan, watchPlanToSql } = mod;

const TESTS = [
  { id: 'st_coli', name: 'Coliform', aliases: ['Total Coliform'], default_unit: 'CFU/g' },
  { id: 'st_spc', name: 'Standard Plate Count', aliases: ['SPC'], default_unit: 'CFU/g' },
];

let n = 0;
const base = (over: Record<string, unknown> = {}) => ({
  tenantId: 't1',
  supplier: { id: 'sup', name: 'Andersen Dairy Inc.' },
  documentType: { id: 'dt', name: 'Certificate of Analysis' },
  tests: TESTS,
  existingLimits: [],
  existingRequired: [],
  require: ['Coliform', 'SPC'],
  limits: ['Coliform<=1 CFU/g'],
  reviewBy: '2026-12-15',
  effectiveFrom: null,
  reason: 'Sanitation watch',
  newId: () => `id${++n}`,
  validateLimitShape,
  normalizeUnit,
  ...over,
});

describe('parseLimitFlag', () => {
  it('reads ceilings, floors and absence', () => {
    expect(parseLimitFlag('Coliform<=1 CFU/g')).toEqual({ analyte: 'Coliform', operator: '<=', value_min: null, value_max: 1, unit: 'CFU/g' });
    expect(parseLimitFlag('Standard Plate Count ≤ 10000')).toMatchObject({ operator: '<=', value_max: 10000, unit: null });
    expect(parseLimitFlag('Fat>=3.25 %')).toMatchObject({ operator: '>=', value_min: 3.25 });
    expect(parseLimitFlag('Listeria=absent')).toMatchObject({ operator: 'absent', value_max: null });
    expect(parseLimitFlag('Coliform about 1').error).toBeTruthy();
  });
});

describe('buildWatchPlan', () => {
  it('plans creates, at supplier scope, with audit rows', () => {
    const plan = buildWatchPlan(base());
    expect(plan.errors).toEqual([]);
    expect(plan.summary).toMatchObject({ requiredCreated: 2, limitsCreated: 1 });
    const sql = watchPlanToSql(plan).join('\n');
    expect(sql).toContain('INSERT INTO supplier_required_analytes');
    expect(sql).toMatch(/INSERT INTO spec_limits .* 'sup', NULL, NULL, '<=', NULL, 1, 'CFU\/g', 'alert'.*'2026-12-15'\);/);
    expect(sql.match(/INSERT INTO audit_log/g)).toHaveLength(3);
    expect(sql).toContain('bin/seed-supplier-watch');
  });

  it('plans nothing on a re-run of the same command', () => {
    const plan = buildWatchPlan(
      base({
        existingRequired: [
          { id: 'ra1', spec_test_id: 'st_coli', document_type_id: 'dt', review_by: '2026-12-15', effective_from: null, reason: 'Sanitation watch' },
          { id: 'ra2', spec_test_id: 'st_spc', document_type_id: 'dt', review_by: '2026-12-15', effective_from: null, reason: 'Sanitation watch' },
        ],
        existingLimits: [
          { id: 'l1', spec_test_id: 'st_coli', supplier_id: 'sup', document_type_id: null, product_id: null, operator: '<=', value_min: null, value_max: 1, unit: 'CFU/g', active: 1, version: 1, review_by: '2026-12-15' },
        ],
      })
    );
    expect(plan.required.map((r: { action: string }) => r.action)).toEqual(['unchanged', 'unchanged']);
    expect(plan.limits[0].action).toBe('unchanged');
    expect(watchPlanToSql(plan)).toEqual([]);
  });

  it('extending only the review-by does not bump the limit version', () => {
    const plan = buildWatchPlan(
      base({
        require: [],
        reviewBy: '2027-03-01',
        existingLimits: [
          { id: 'l1', spec_test_id: 'st_coli', supplier_id: 'sup', document_type_id: null, product_id: null, operator: '<=', value_min: null, value_max: 1, unit: 'CFU/g', active: 1, version: 4, review_by: '2026-12-15' },
        ],
      })
    );
    expect(plan.limits[0]).toMatchObject({ action: 'update', version: 4 });
    const tighter = buildWatchPlan(
      base({
        require: [],
        limits: ['Coliform<1 CFU/g'],
        existingLimits: [
          { id: 'l1', spec_test_id: 'st_coli', supplier_id: 'sup', document_type_id: null, product_id: null, operator: '<=', value_min: null, value_max: 1, unit: 'CFU/g', active: 1, version: 4, review_by: '2026-12-15' },
        ],
      })
    );
    expect(tighter.limits[0]).toMatchObject({ action: 'update', version: 5 });
  });

  it('refuses an unknown analyte, a substring, a bad date and an unplaceable unit', () => {
    const plan = buildWatchPlan(
      base({ require: ['Fecal Coliform'], limits: ['Coliform<=1 colonies'], reviewBy: '12/15/2026' })
    );
    expect(plan.errors.join('\n')).toMatch(/Fecal Coliform" matches no analyte/);
    expect(plan.errors.join('\n')).toMatch(/not YYYY-MM-DD/);
    expect(plan.errors.join('\n')).toMatch(/unit "colonies"/);
  });

  it('resolves an alias to its analyte', () => {
    const plan = buildWatchPlan(base({ require: ['Total Coliform'], limits: [] }));
    expect(plan.required[0]).toMatchObject({ specTestId: 'st_coli', analyte: 'Coliform' });
  });
});
