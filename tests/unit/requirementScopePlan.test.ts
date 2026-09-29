import { describe, it, expect } from 'vitest';
import {
  REQUIREMENT_SCOPES as PLAN_SCOPES,
  planRequirementScopes,
  proposalToSql,
  auditNamesScope,
  packScopes,
} from '../../bin/lib/requirementScopePlan.js';
import { REQUIREMENT_SCOPES } from '../../shared/requirementScope';
import fsqaRaw from '../../starter-packs/fsqa.json?raw';

const pack = JSON.parse(fsqaRaw);
const req = (id: string, slug: string, scope = 'supplier', active = 1) => ({
  id,
  slug,
  name: slug,
  scope,
  active,
});

describe('bin/propose-requirement-scopes — the plan', () => {
  it('mirrors the shared vocabulary', () => {
    expect(PLAN_SCOPES).toEqual([...REQUIREMENT_SCOPES]);
  });

  it('reads the pack: product for the per-product documents, lot for the COA', () => {
    const m = packScopes(pack);
    expect(m.get('spec-sheet')).toBe('product');
    expect(m.get('coa-on-file')).toBe('lot');
    expect(m.has('certificate-of-insurance')).toBe(false);
  });

  it('proposes only rows still at the default nobody decided', () => {
    const plan = planRequirementScopes({
      requirements: [
        req('r1', 'spec-sheet'),
        req('r2', 'allergen-matrix', 'lot'),
        req('r3', 'ingredient-statement'),
        req('r4', 'product-label', 'supplier', 0),
        req('r5', 'certificate-of-insurance'),
        req('r6', 'coa-on-file'),
      ],
      pack,
      humanDecided: new Set(['r3']),
    });
    expect(plan.proposals.map((p: any) => [p.id, p.to])).toEqual([
      ['r1', 'product'],
      ['r6', 'lot'],
    ]);
    expect(plan.skipped.map((s: any) => [s.id, s.reason])).toEqual([
      ['r2', 'already_scoped'],
      ['r3', 'human_decided'],
      ['r4', 'inactive'],
    ]);
  });

  it('recognises every audit trace of a scope decision', () => {
    expect(auditNamesScope('requirement.scope_changed', '{}')).toBe(true);
    expect(auditNamesScope('requirement_updated', JSON.stringify({ changes: { scope: 'supplier' } }))).toBe(true);
    expect(auditNamesScope('requirement_updated', JSON.stringify({ changes: { name: 'x' } }))).toBe(false);
    expect(auditNamesScope('requirement_created', JSON.stringify({ name: 'x', scope: 'supplier' }))).toBe(true);
    expect(auditNamesScope('requirement_created', JSON.stringify({ name: 'x' }))).toBe(false);
    expect(auditNamesScope('requirement_created', 'not json')).toBe(false);
  });

  it('writes guarded SQL: the audit row and the update both need the default still in place', () => {
    const sql = proposalToSql('t-1', { id: "r'1", name: 'Spec', from: 'supplier', to: 'product' });
    expect(sql).toHaveLength(2);
    expect(sql[0]).toMatch(/^INSERT INTO audit_log .* WHERE EXISTS \(SELECT 1 FROM requirements WHERE id = 'r''1' AND tenant_id = 't-1' AND scope = 'supplier'\);$/);
    expect(sql[1]).toBe(
      "UPDATE requirements SET scope = 'product', updated_at = datetime('now') WHERE id = 'r''1' AND tenant_id = 't-1' AND scope = 'supplier';",
    );
  });
});
