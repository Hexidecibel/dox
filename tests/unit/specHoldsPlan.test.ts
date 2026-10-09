/**
 * The plan behind bin/propose-spec-holds (migration 0139): which EXISTING
 * documents the stored approval-time verdicts would have put on hold.
 *
 * The script's promises: it reads only honest evidence (never a bulk-recheck
 * row), it proposes exactly what the approval path would have placed, and a
 * result already held -- or held and released -- is left alone.
 */
import { describe, it, expect } from 'vitest';
import { planSpecHolds, proposalToSql } from '../../bin/lib/specHoldsPlan';
import { automaticHoldsForResults } from '../../shared/holds';
import { HOLDING_SPEC_CRITICALITY } from '../../shared/specCriticality';

const sqlStr = (v: unknown) => (v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);

const check = (over: Record<string, unknown> = {}) => ({
  id: 'c1',
  document_id: 'd1',
  version_number: 1,
  current_version: 1,
  document_status: 'active',
  document_title: 'Cream COA',
  supplier_name: 'Northfield Creamery',
  test_name_raw: 'Coliform',
  value_raw: '40',
  unit_raw: 'CFU/g',
  verdict: 'out_of_spec',
  reason: '40 exceeds 10',
  source: 'limit',
  limit_snapshot: JSON.stringify({ criticality: HOLDING_SPEC_CRITICALITY, text: '<=10 CFU/g' }),
  judgement_origin: 'approval',
  result_key: 'ai_fields::t0r0',
  result_location: 'Table 1, row 1',
  analyte_category: null,
  ...over,
});

describe('planSpecHolds', () => {
  it('proposes what the approval path would have placed, on the document\'s one lot row', () => {
    const plan = planSpecHolds([check()], [], [{ document_id: 'd1', lot_id: 'l1', lot_number: '5501', sub_lot_code: '03' }]);
    expect(plan.proposals).toHaveLength(1);
    const p = plan.proposals[0];
    const [same] = automaticHoldsForResults(
      [{ verdict: 'out_of_spec', source: 'limit', criticality: HOLDING_SPEC_CRITICALITY, result_key: 'ai_fields::t0r0', result_location: 'Table 1, row 1', test_name_raw: 'Coliform', value_raw: '40', unit_raw: 'CFU/g', limit_text: '<=10 CFU/g', reason: '40 exceeds 10' }],
      { origin: 'approval', version: 1 },
    );
    expect(p).toMatchObject({ document_id: 'd1', source: 'spec_critical', source_key: same.source_key, reason: same.reason, lot_id: 'l1', lot_label: '5501 / 03', spec_check_id: 'c1' });
    expect(plan.documents).toBe(1);
  });

  it('NEVER reads a bulk-recheck row, or one with no origin, as evidence', () => {
    const plan = planSpecHolds(
      [check({ judgement_origin: 'bulk_recheck' }), check({ id: 'c2', judgement_origin: null, result_key: 'k2' })],
      [],
      [],
    );
    expect(plan.proposals).toEqual([]);
    expect(plan.skipped).toMatchObject({ bulk_recheck: 1, origin_not_recorded: 1 });
    expect(plan.rows_considered).toBe(0);
  });

  it('skips a replaced version, an inactive document, and a row with no result identity -- and counts each', () => {
    const plan = planSpecHolds(
      [
        check({ current_version: 2 }),
        check({ id: 'c2', document_id: 'd2', document_status: 'archived' }),
        check({ id: 'c3', document_id: 'd3', result_key: null }),
      ],
      [],
      [],
    );
    expect(plan.proposals).toEqual([]);
    expect(plan.skipped).toMatchObject({ superseded_version: 1, document_not_active: 1, no_result_identity: 1 });
  });

  it('reads criticality and the could-not-check category as FROZEN on the row', () => {
    const major = planSpecHolds([check({ limit_snapshot: JSON.stringify({ criticality: 'medium' }) })], [], []);
    expect(major.proposals).toEqual([]);
    expect(planSpecHolds([check({ limit_snapshot: null })], [], []).proposals).toEqual([]);
    expect(planSpecHolds([check({ limit_snapshot: 'not json' })], [], []).proposals).toEqual([]);

    const e2 = (category: string | null, snapshotCategory: string) =>
      planSpecHolds(
        [check({ verdict: 'not_checked', analyte_category: category, limit_snapshot: JSON.stringify({ criticality: 'medium', not_checked_category: snapshotCategory }) })],
        [],
        [],
      ).proposals.map((p) => p.source);
    expect(e2('zero_tolerance', 'sample_basis_mismatch')).toEqual(['zero_tolerance']);
    expect(e2('indicator', 'sample_basis_mismatch')).toEqual([]);
    expect(e2(null, 'sample_basis_mismatch')).toEqual([]);
    // E1: a method mismatch never holds.
    expect(e2('zero_tolerance', 'method_mismatch')).toEqual([]);
  });

  it('a result already held, or held and released, is left alone', () => {
    const key = 'v1:limit:ai_fields::t0r0';
    for (const released_at of [null, '2026-10-01 00:00:00']) {
      const plan = planSpecHolds([check()], [{ document_id: 'd1', source: 'spec_critical', source_key: key, released_at }], []);
      expect(plan.proposals).toEqual([]);
      expect(plan.already_placed).toBe(1);
    }
    // A hold for another result of the same document does not cover this one.
    expect(planSpecHolds([check()], [{ document_id: 'd1', source: 'spec_critical', source_key: 'v1:limit:other', released_at: null }], []).proposals).toHaveLength(1);
  });

  it('a document with several lot rows, or none, is held whole', () => {
    const lots = [
      { document_id: 'd1', lot_id: 'l1', lot_number: '5501', sub_lot_code: null },
      { document_id: 'd1', lot_id: 'l2', lot_number: '5502', sub_lot_code: null },
    ];
    expect(planSpecHolds([check()], [], lots).proposals[0]).toMatchObject({ lot_id: null, lot_label: null });
    expect(planSpecHolds([check()], [], []).proposals[0]).toMatchObject({ lot_id: null, lot_label: null });
  });
});

describe('proposalToSql', () => {
  it('writes the hold once per result, only on the version it was judged on, and audits only a hold that was written', () => {
    const [p] = planSpecHolds([check({ test_name_raw: "O'Brien count" })], [], []).proposals;
    const [insert, audit] = proposalToSql('tenant-1', p, 'hold-1', sqlStr);
    expect(insert).toMatch(/^INSERT OR IGNORE INTO document_holds/);
    expect(insert).toContain("d.tenant_id = 'tenant-1'");
    expect(insert).toContain("d.status = 'active'");
    expect(insert).toContain('d.current_version = 1');
    expect(insert).toContain("O''Brien");
    // An automatic hold: no person placed it.
    expect(insert).toMatch(/, NULL FROM documents d/);
    expect(audit).toContain("'document.hold_placed'");
    expect(audit).toContain('propose-spec-holds');
    expect(audit).toContain("WHERE EXISTS (SELECT 1 FROM document_holds WHERE id = 'hold-1')");
  });
});
