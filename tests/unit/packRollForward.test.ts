/**
 * The roll-forward PLANNER, case by case (shared/packRollForward.ts).
 *
 * tests/api/pack-roll-forward.test.ts tells the whole story against a
 * database. These are the corners that story does not turn: a setting made of
 * several columns, a link whose other end is gone or renamed, a baselined
 * "absent" item, and the shape of `accept`.
 */

import { describe, it, expect } from 'vitest';
import {
  planPackRollForward,
  packFieldDiff,
  packPlanIsNoOp,
  samePackValue,
  type PackCurrentRow,
  type PackLedgerEntry,
  type PackRollForwardPlan,
} from '../../shared/packRollForward';
import {
  PACK_ITEM_KINDS,
  PACK_KIND_SPECS,
  inlineSql,
  packApplyStatements,
  packItems,
  type PackItemKind,
  type PackLike,
} from '../../shared/packItems';

function pack(version = 1): PackLike {
  return {
    pack: 'mini',
    version,
    owner_labels: [{ label: 'QA', owner_key: 'qa' }],
    document_types: [
      {
        name: 'Vendor Form',
        slug: 'vendor-form',
        aliases: [],
        description: 'A form.',
        owner: 'QA',
        closes: ['form-on-file'],
        extraction_instructions: 'Read the form.',
      },
    ],
    requirements: [
      { name: 'Form on file', slug: 'form-on-file', aliases: [], description: null, checklist: 'Forms', sort_order: 10, scope: 'supplier' },
    ],
    claim_types: [{ name: 'Organic', slug: 'organic', aliases: [], description: null, subject_grain: 'any', sort_order: 10 }],
    claim_rules: [{ claim: 'organic', requires: ['form-on-file'], recommends: [], notes: null }],
    spec_tests: [
      {
        name: 'Moisture',
        slug: 'moisture',
        aliases: ['H2O'],
        default_unit: '%',
        notes: null,
        limit: { operator: '<=', value_min: null, value_max: 5, unit: '%', severity: 'alert', criticality: 'medium', notes: null },
      },
    ],
    modules: { default_on: ['library'], default_off: [] },
  };
}

/** The organisation's tables and ledger exactly as an apply of `p` leaves them. */
function seeded(p: PackLike): { rows: Record<PackItemKind, PackCurrentRow[]>; ledger: PackLedgerEntry[] } {
  const rows = Object.fromEntries(PACK_ITEM_KINDS.map((k) => [k, [] as PackCurrentRow[]])) as Record<
    PackItemKind,
    PackCurrentRow[]
  >;
  const ledger: PackLedgerEntry[] = [];
  for (const item of packItems(p)) {
    const rowId = `${item.kind}:${item.key}`;
    rows[item.kind].push({ natural_key: item.natural, row_id: rowId, active: 1, ...item.fields, ...(item.kind === 'spec_limit' ? { version: 1 } : {}) });
    ledger.push({ kind: item.kind, item_key: item.key, row_id: rowId, pack_version: p.version, written: { ...item.fields }, differing: {}, state: 'pack' });
  }
  return { rows, ledger };
}

const rowOf = (rows: Record<PackItemKind, PackCurrentRow[]>, kind: PackItemKind, key: string) =>
  rows[kind].find((r) => r.row_id === `${kind}:${key}`)!;
const item = (plan: PackRollForwardPlan, kind: string, key: string) =>
  plan.items.find((i) => i.kind === kind && i.key === key)!;

describe('nothing changed', () => {
  it('the same version over untouched rows is a no-op', () => {
    const p = pack();
    const { rows, ledger } = seeded(p);
    const plan = planPackRollForward({ pack: p, fromVersion: 1, ledger, rows });
    expect(packPlanIsNoOp(plan)).toBe(true);
    expect(plan.summary.unchanged).toBe(packItems(p).length);
    expect(plan.items.every((i) => i.ledger === null && !i.row_update)).toBe(true);
  });

  it('a new version with no content change moves the ledger and no row', () => {
    const { rows, ledger } = seeded(pack(1));
    const plan = planPackRollForward({ pack: pack(2), fromVersion: 1, ledger, rows });
    expect(plan.items.every((i) => !i.row_update && i.outcome === 'unchanged')).toBe(true);
    expect(plan.items.every((i) => i.ledger?.pack_version === 2)).toBe(true);
    expect(packPlanIsNoOp(plan)).toBe(false);
  });
});

describe('a setting made of several columns moves whole or not at all', () => {
  it('a limit whose operator the organisation changed keeps its bound too', () => {
    const { rows, ledger } = seeded(pack(1));
    rowOf(rows, 'spec_limit', 'moisture').operator = '<';
    const next = pack(2);
    next.spec_tests[0].limit!.value_max = 4;

    const plan = planPackRollForward({ pack: next, fromVersion: 1, ledger, rows });
    const limit = item(plan, 'spec_limit', 'moisture');
    expect(limit.row_update).toBeUndefined();
    const byField = Object.fromEntries(limit.fields.map((f) => [f.field, f]));
    // The bound is untouched and the pack moved it -- but half a threshold is
    // not a threshold, so it waits with the operator.
    expect(byField.value_max).toMatchObject({ action: 'keep', reason: 'setting', current: 5, target: 4 });
    expect(byField.operator).toMatchObject({ action: 'customised', reason: 'edited', current: '<', target: '<=' });
    // Severity is not part of the threshold and would still move on its own.
    next.spec_tests[0].limit!.severity = 'warn';
    const again = planPackRollForward({ pack: next, fromVersion: 1, ledger, rows });
    expect(item(again, 'spec_limit', 'moisture').row_update).toEqual({ set: { severity: 'warn' }, guard: { severity: 'alert' } });
  });

  it('accepting one column of the setting takes the whole setting', () => {
    const { rows, ledger } = seeded(pack(1));
    rowOf(rows, 'spec_limit', 'moisture').operator = '<';
    const next = pack(2);
    next.spec_tests[0].limit!.value_max = 4;
    const plan = planPackRollForward({
      pack: next,
      fromVersion: 1,
      ledger,
      rows,
      accept: [{ kind: 'spec_limit', key: 'moisture', field: 'value_max' }],
    });
    expect(item(plan, 'spec_limit', 'moisture').row_update).toEqual({
      set: { operator: '<=', value_max: 4 },
      guard: { operator: '<', value_max: 5 },
    });
  });

  it('a type\'s renewal is one setting as well', () => {
    expect(PACK_KIND_SPECS.document_type.groups).toEqual([['renewal_policy', 'renewal_interval_months', 'renewal_window']]);
    expect(PACK_KIND_SPECS.spec_limit.groups).toEqual([['operator', 'value_min', 'value_max', 'unit']]);
  });
});

describe('a link needs both of its ends', () => {
  it('a new link to something the organisation deleted is gone with it, and that is recorded', () => {
    const { rows, ledger } = seeded(pack(1));
    // The organisation removed the requirement outright, and its links with it.
    rows.requirement = [];
    rows.claim_rule = [];
    rows.type_requirement = [];
    const next = pack(2);
    next.claim_types.push({ name: 'Kosher', slug: 'kosher', aliases: [], description: null, subject_grain: 'any', sort_order: 20 });
    next.claim_rules.push({ claim: 'kosher', requires: ['form-on-file'], recommends: [], notes: null });

    const plan = planPackRollForward({ pack: next, fromVersion: 1, ledger, rows });
    expect(item(plan, 'requirement', 'form-on-file')).toMatchObject({ outcome: 'deleted', news: true });
    expect(item(plan, 'claim_type', 'kosher').outcome).toBe('insert');
    const rule = item(plan, 'claim_rule', 'kosher__form-on-file');
    expect(rule.outcome).toBe('absent');
    expect(rule.missing).toMatch(/requirement "Form on file"/);
    expect(rule.ledger).toMatchObject({ state: 'absent', row_id: null });
  });

  it('a new limit for a lab test the organisation renamed waits, and says why', () => {
    const base = pack(1);
    base.spec_tests[0].limit = null;
    const { rows, ledger } = seeded(base);
    // Renamed in the organisation: the ledger still finds it by id.
    const test = rowOf(rows, 'spec_test', 'moisture');
    test.natural_key = 'Moisture content';
    test.name = 'Moisture content';

    const plan = planPackRollForward({ pack: pack(2), fromVersion: 1, ledger, rows });
    expect(item(plan, 'spec_test', 'moisture').fields).toEqual([
      expect.objectContaining({ field: 'name', action: 'customised', current: 'Moisture content' }),
    ]);
    const limit = item(plan, 'spec_limit', 'moisture');
    expect(limit.outcome).toBe('parent_missing');
    expect(limit.missing).toMatch(/has renamed/);
    // Nothing is recorded for it, so it is offered again once the name is back.
    expect(limit.ledger).toBeNull();
  });
});

describe('what a baseline recorded is respected', () => {
  it('an item baselined as absent is not inserted', () => {
    const p = pack(1);
    const { rows, ledger } = seeded(p);
    rows.claim_type = [];
    rows.claim_rule = [];
    for (const e of ledger) {
      if (e.kind === 'claim_type' || e.kind === 'claim_rule') {
        e.state = 'absent';
        e.row_id = null;
      }
    }
    const plan = planPackRollForward({ pack: pack(2), fromVersion: 1, ledger, rows });
    expect(item(plan, 'claim_type', 'organic')).toMatchObject({ outcome: 'absent', news: false, ledger: null });
    expect(item(plan, 'claim_rule', 'organic__form-on-file')).toMatchObject({ outcome: 'absent', news: false });
    expect(plan.summary.inserted).toBe(0);
  });

  it('a column baselined as "differs, origin unknown" is never overwritten on a guess', () => {
    const { rows, ledger } = seeded(pack(1));
    rowOf(rows, 'requirement', 'form-on-file').checklist = 'Legacy group';
    const entry = ledger.find((e) => e.kind === 'requirement')!;
    entry.differing = { checklist: 'unknown' };
    entry.state = 'differs';
    const next = pack(2);
    next.requirements[0].checklist = 'Paperwork';

    const plan = planPackRollForward({ pack: next, fromVersion: 1, ledger, rows });
    const req = item(plan, 'requirement', 'form-on-file');
    expect(req.row_update).toBeUndefined();
    expect(req.fields).toEqual([
      { field: 'checklist', action: 'keep', reason: 'unknown', current: 'Legacy group', target: 'Paperwork' },
    ]);
    // No `base` is shown: nobody knows what the pack wrote there.
    expect(req.fields[0]).not.toHaveProperty('base');
  });

  it('an absent item a person later made by hand is adopted, not duplicated', () => {
    const { rows, ledger } = seeded(pack(1));
    const entry = ledger.find((e) => e.kind === 'claim_type')!;
    entry.state = 'absent';
    entry.row_id = null;
    rowOf(rows, 'claim_type', 'organic').row_id = 'made-by-hand';
    rowOf(rows, 'claim_rule', 'organic__form-on-file');
    const plan = planPackRollForward({ pack: pack(1), fromVersion: 1, ledger, rows });
    expect(item(plan, 'claim_type', 'organic')).toMatchObject({ outcome: 'adopt', row_id: 'made-by-hand' });
    expect(item(plan, 'claim_type', 'organic').ledger).toMatchObject({ state: 'pack', row_id: 'made-by-hand' });
  });
});

describe('the comparison is one rule in SQL and in JavaScript', () => {
  it('samePackValue is null-safe and type-strict', () => {
    expect(samePackValue(null, undefined)).toBe(true);
    expect(samePackValue(5, 5)).toBe(true);
    expect(samePackValue('5', 5)).toBe(false);
    expect(samePackValue('', null)).toBe(false);
  });

  it('packFieldDiff marks every differing column unknown', () => {
    expect(packFieldDiff({ name: 'A', description: null, sort_order: 10 }, { name: 'A', description: 'x', sort_order: 20 })).toEqual({
      description: 'unknown',
      sort_order: 'unknown',
    });
  });

  it('the ledger statement compares every written column, null-safely', () => {
    const { ledger } = packApplyStatements(pack(1), { tenantId: 't1', tenantSlug: 'acme', source: 'cli', appliedBy: null });
    const req = inlineSql(ledger.find((s) => s.sql.includes('FROM requirements x'))!);
    for (const column of ['name', 'description', 'checklist', 'sort_order', 'scope']) {
      expect(req).toContain(`CASE WHEN x.${column} IS NOT `);
      expect(req).toContain(`'"${column}":"unknown",'`);
    }
    expect(req).toContain('x.description IS NOT NULL');
    expect(req).toContain("CASE WHEN y.differing = '{}' THEN 'pack' ELSE 'differs' END");
    // A link has no columns of its own: it is the pack's by existing.
    const linkEntry = inlineSql(ledger.find((s) => s.sql.includes('FROM document_type_requirements x'))!);
    expect(linkEntry).toContain(`'{}' AS differing`);
    // THE STAMP IS THE GATE, and it comes first: once only, and only for an
    // organisation that does not already hold half the pack's vocabulary.
    const { rows } = packApplyStatements(pack(2), { tenantId: 't1', tenantSlug: 'acme', source: 'cli', appliedBy: null });
    const stamp = inlineSql(rows[0]);
    expect(stamp).toMatch(/^INSERT OR IGNORE INTO tenant_packs .* WHERE NOT EXISTS \(SELECT 1 FROM tenant_packs/);
    expect(stamp).toContain(`json_each('["vendor-form"]')`);
    expect(stamp).toMatch(/\* 2 < 3 AND NOT \(\(NOT EXISTS \(SELECT 1 FROM tenant_packs WHERE tenant_id = 't1'\)/);
    // ...and that shows no evidence of an earlier seeding, however little is left:
    // a row at a pack key under a pack-shaped id, or a setup run that applied the pack.
    expect(stamp).toContain(`id LIKE 'dt\\_%' ESCAPE '\\'`);
    expect(stamp).toContain(`json_extract(applied, '$.pack.name') = 'mini'`);
    // Every other statement of an apply -- row or ledger entry -- writes only
    // for an organisation ON RECORD as being on this version. No record (never
    // stamped: already seeded, never baselined) or another version: nothing.
    for (const s of [...rows.slice(1), ...ledger]) {
      expect(inlineSql(s)).toMatch(
        /\(SELECT MAX\(version\) FROM tenant_packs WHERE tenant_id = 't1' AND pack = 'mini'\) = [12]/,
      );
    }
    // A supplier's own document type is never the row a link hangs off.
    const link = inlineSql(rows.find((s) => s.sql.includes('INTO document_type_requirements'))!);
    expect(link).toContain('dt.supplier_id IS NULL');
  });
});
