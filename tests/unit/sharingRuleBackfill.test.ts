/**
 * The plan behind bin/backfill-sharing-rules (migration 0137).
 *
 * The script's one promise is that it changes NOTHING about what may leave the
 * portal: it writes, onto a type with no stored rule, exactly the rule that
 * type is already read as. So the plan is checked against the same function
 * the server reads a NULL through.
 */
import { describe, it, expect } from 'vitest';
import { planSharingRuleBackfill, fillToSql } from '../../bin/lib/sharingRuleBackfill';
import { effectiveSharingRule } from '../../shared/sharingRule';

const sqlStr = (v: unknown) => (v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);

const TYPES = [
  { id: 't1', name: 'Certificate of Analysis', active: 1, sharing_rule: null },
  { id: 't2', name: 'W-9', active: 1, sharing_rule: null },
  { id: 't3', name: 'Vendor Questionnaire', active: 0, sharing_rule: null },
  { id: 't4', name: 'Certificate of Analysis (internal)', active: 1, sharing_rule: 'locked' },
  { id: 't5', name: 'Letter of Guarantee', active: 1, sharing_rule: 'public' },
];

describe('planSharingRuleBackfill', () => {
  it('fills only the types with nothing stored, with the rule each is already read as', () => {
    const plan = planSharingRuleBackfill(TYPES);
    expect(plan.total).toBe(5);
    expect(plan.fills).toEqual([
      { id: 't1', name: 'Certificate of Analysis', active: true, rule: 'free' },
      { id: 't2', name: 'W-9', active: true, rule: 'locked' },
      { id: 't3', name: 'Vendor Questionnaire', active: false, rule: 'qa' },
    ]);
    for (const fill of plan.fills) {
      const type = TYPES.find((t) => t.id === fill.id)!;
      const readAs = effectiveSharingRule({ typeRule: type.sharing_rule, typeName: type.name, hasType: true });
      expect(fill.rule, type.name).toBe(readAs.rule);
    }
  });

  it('never re-decides a stored rule, whatever the name suggests', () => {
    const plan = planSharingRuleBackfill(TYPES);
    expect(plan.stored).toEqual([{ id: 't4', name: 'Certificate of Analysis (internal)', rule: 'locked' }]);
    expect(plan.fills.map((f) => f.id)).not.toContain('t4');
  });

  it('reports a stored value that is not a rule, and does not overwrite it', () => {
    const plan = planSharingRuleBackfill(TYPES);
    expect(plan.unreadable).toEqual([{ id: 't5', name: 'Letter of Guarantee', value: 'public', reads_as: 'qa' }]);
    expect(plan.fills.map((f) => f.id)).not.toContain('t5');
  });

  it('an empty tenant plans nothing', () => {
    expect(planSharingRuleBackfill([])).toEqual({ total: 0, stored: [], unreadable: [], fills: [] });
  });
});

describe('fillToSql', () => {
  it('is scoped to the tenant and re-checks that the rule is still NULL', () => {
    const sql = fillToSql('tenant-1', { id: 't1', name: 'COA', active: true, rule: 'free' }, sqlStr);
    expect(sql).toBe(
      "UPDATE document_types SET sharing_rule = 'free', updated_at = datetime('now') " +
        "WHERE id = 't1' AND tenant_id = 'tenant-1' AND sharing_rule IS NULL;",
    );
  });

  it('quotes an id that carries a quote', () => {
    const sql = fillToSql("t'x", { id: "a'b", name: 'n', active: true, rule: 'qa' }, sqlStr);
    expect(sql).toContain("id = 'a''b'");
    expect(sql).toContain("tenant_id = 't''x'");
  });
});
