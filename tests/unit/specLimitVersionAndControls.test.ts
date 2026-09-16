/**
 * Two small facts the register and the review queue depend on.
 *
 * 1. `limit_snapshot` NAMES THE REVISION. Migration 0085 described the frozen
 *    copy as "{operator, value_min, value_max, unit, version}" and the version
 *    was the one key never written — so a reader of an old verdict could see the
 *    numbers but not which edition of the limit produced them, which is the
 *    entire job of the counter. It is written now, and only when the row
 *    actually carried one: a snapshot citing a version the limit never had would
 *    be worse than one that is silent.
 *
 * 2. CONTROL ROWS ARE COUNTED OUT LOUD. The engine recognises a buffer/blank row
 *    and excludes it from product verdicts, and `spec-warnings.ts` used to drop
 *    that fact on the floor. A reviewer then had two readings of a skipped row —
 *    "it was missed" and "a clean buffer means clean product" — and both are
 *    wrong.
 */

import { describe, it, expect } from 'vitest';
import { checkConfiguredLimits, type ConfiguredLimit, type SpecTestDef } from '../../shared/specCheck';
import { buildLimitSnapshot } from '../../shared/specSnapshot';
import { specResultsWithConfig, EMPTY_SPEC_CONFIG } from '../../functions/lib/spec-warnings';

const TESTS: SpecTestDef[] = [
  { id: 'st_coli', name: 'Coliform', aliases: [], default_unit: 'CFU/g' },
  { id: 'st_spc', name: 'Standard Plate Count', aliases: ['SPC'], default_unit: 'CFU/g' },
];

const CTX = { supplier_id: 'sup_1', document_type_id: 'dt_coa', product_ids: [] };

const limit = (over: Partial<ConfiguredLimit> = {}): ConfiguredLimit => ({
  id: 'l_coli',
  spec_test_id: 'st_coli',
  operator: '<=',
  value_min: null,
  value_max: 10,
  unit: 'CFU/g',
  severity: 'alert',
  criticality: 'medium',
  active: true,
  supplier_id: null,
  document_type_id: null,
  product_id: null,
  ...over,
});

const flat = (rows: string[][]) => [
  {
    scope: 'ai_fields',
    tables: [{ name: 'micro', headers: ['test', 'result', 'units'], rows }],
  },
];

describe('limit_snapshot carries the revision', () => {
  it('freezes the version the limit held when it judged', () => {
    const limits = [limit({ version: 4 })];
    const r = checkConfiguredLimits(flat([['Coliform', '50', 'CFU/g']]), TESTS, limits, CTX);
    const snap = JSON.parse(buildLimitSnapshot(r.verdicts[0], limits)!);
    expect(snap).toMatchObject({ operator: '<=', value_max: 10, unit: 'CFU/g', version: 4 });
  });

  it('omits it rather than inventing one when the row carried none', () => {
    const limits = [limit()];
    const r = checkConfiguredLimits(flat([['Coliform', '50', 'CFU/g']]), TESTS, limits, CTX);
    const snap = JSON.parse(buildLimitSnapshot(r.verdicts[0], limits)!);
    expect('version' in snap).toBe(false);
  });

  it('says nothing about a version on a printed-spec verdict — it is not our limit', () => {
    const r = checkConfiguredLimits(flat([['Coliform', '50', 'CFU/g']]), TESTS, [limit({ version: 2 })], CTX);
    const printedish = { ...r.verdicts[0], source: 'printed' as const, limit_id: null };
    const snap = JSON.parse(buildLimitSnapshot(printedish, [])!);
    expect('version' in snap).toBe(false);
    expect(snap.printed).toBeTruthy();
  });
});

describe('control rows reach the review summary', () => {
  /** A crosstab with a laboratory control row beneath the product rows. */
  const crosstabRow = {
    tables: JSON.stringify([
      {
        name: 'micro',
        headers: ['Sample', 'Coliform', 'SPC'],
        rows: [
          ['Product', '<10', '200'],
          ['Buffer', '<1', '<1'],
        ],
      },
    ]),
  };

  it('counts and names the rows it recognised and did not judge', () => {
    const out = specResultsWithConfig(
      crosstabRow,
      { ...EMPTY_SPEC_CONFIG, tests: TESTS, limits: [limit()] },
      CTX
    );
    expect(out.summary.control_rows).toBe(1);
    expect(out.summary.control_row_labels).toEqual(['Buffer']);
  });

  it('is zero, and says nothing, on an ordinary certificate', () => {
    const out = specResultsWithConfig(
      { tables: JSON.stringify([{ name: 'micro', headers: ['test', 'result'], rows: [['Coliform', '<10']] }]) },
      { ...EMPTY_SPEC_CONFIG, tests: TESTS, limits: [limit()] },
      CTX
    );
    expect(out.summary.control_rows).toBe(0);
    expect(out.summary.control_row_labels).toBeUndefined();
  });

  it('never turns a control row into a verdict', () => {
    const out = specResultsWithConfig(
      crosstabRow,
      { ...EMPTY_SPEC_CONFIG, tests: TESTS, limits: [limit({ value_max: 0 })] },
      CTX
    );
    // The buffer reads <1 against a limit of 0; if it were judged as product it
    // would be a finding. It is not judged at all.
    expect(out.results.every((v) => v.target.kind !== 'table' || v.target.row_label !== 'Buffer')).toBe(true);
  });
});
