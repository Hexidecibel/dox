/**
 * bin/lib/lotSchemeSeed.js + bin/lib/lotKeySchemeReport.js — the plan halves of
 * bin/seed-supplier-lot-schemes and bin/report-lot-key-scheme (migration 0110).
 *
 *   - Darigold / Country Morning / Andersen get the declared formats; fit counts
 *     on the prod-shaped fixture: Darigold's three known extraction errors do
 *     not fit, everything else does, and no decoded date disagrees.
 *   - A supplier with any existing declaration is never overwritten; an
 *     ambiguous supplier is skipped, not guessed.
 *   - The key report finds the 1032610210326102 class and the kept-whole
 *     composite, says what a repair would be and when it would merge, and has
 *     no write path at all.
 *   - The bin scripts run the compiled engine, which is the TypeScript one.
 */
import { describe, it, expect } from 'vitest';
// @ts-expect-error — plain CJS module, no types.
import seedMod from '../../bin/lib/lotSchemeSeed.js';
// @ts-expect-error — plain CJS module, no types.
import reportMod from '../../bin/lib/lotKeySchemeReport.js';
// @ts-expect-error — generated CJS bundle, no types.
import compiled from '../../bin/lib/shared/lotScheme.js';
import * as lotScheme from '../../shared/lotScheme';
import seedCli from '../../bin/seed-supplier-lot-schemes?raw';
import reportCli from '../../bin/report-lot-key-scheme?raw';

const { buildSeedPlan, planToSql } = seedMod;
const { reportLots } = reportMod;

/** 30 of Cush Co's 32 Darigold lots on prod, 2026-09-15 (lot_number, sub_lot_code, lot_key, production_date). */
const DARIGOLD_LOTS: Array<[string, string, string, string | null]> = [
  ['1032603623', '', '1032603623', '2026-02-05'],
  ['10326051', '', '10326051', '2026-02-20'],
  ['10326063', '', '10326063', '2026-03-04'],
  ['10326074', '', '10326074', '2026-03-15'],
  ['10326076, 10326051, 10326051', '', '103260761032605110326051', null],
  ['10326102', '', '10326102', '2026-04-12'],
  ['10326102', '10326102', '1032610210326102', '2026-04-12'],
  ['10326102', '13', '1032610213', '2026-04-12'],
  ['10326102', '14', '1032610214', '2026-04-12'],
  ['10326117', '', '10326117', '2026-04-27'],
  ['10326124', '', '10326124', '2026-05-04'],
  ['10326181', '20', '1032618120', '2026-06-30'],
  ['10326187', '26', '1032618726', '2026-07-06'],
  ['10326187', '27', '1032618727', '2026-07-06'],
  ['10426038', '', '10426038', '2026-02-07'],
  ['10426057', '', '10426057', '2026-02-26'],
  ['10426060', '', '10426060', '2026-03-01'],
  ['10426062', '', '10426062', '2026-03-03'],
  ['10426121', '05', '1042612105', '2026-05-01'],
  ['12125346', '', '12125346', '2025-12-12'],
  ['12126101', '', '12126101', '2026-04-11'],
  ['22026071', '', '22026071', '2026-03-12'],
  ['22026089', '', '22026089', '2026-03-30'],
  ['22026106', '03', '2202610603', '2026-04-16'],
  ['22026110', '', '22026110', '2026-04-20'],
  ['22026152', '', '22026152', '2026-06-01'],
  ['22026169', '03', '2202616903', '2026-06-18'],
  ['22026191', '02', '2202619102', '2026-07-10'],
  ['22026217', '12', '2202621712', '2026-08-05'],
  ['K134889', '', 'K134889', null],
];

const lots = (rows: typeof DARIGOLD_LOTS) =>
  rows.map(([lot_number, sub_lot_code, lot_key, production_date], i) => ({
    lot_id: `dg${i}`, product_id: null, lot_number, sub_lot_code, lot_key, production_date,
    production_date_source: production_date ? 'extracted' : null,
  }));

const CMF_LOTS = ['042426HCR', '050526BUO', '052226', '052926LC3', '061026ICR', '090826BUO'].map((l, i) => ({
  lot_id: `cmf${i}`, product_id: null, lot_number: l, sub_lot_code: '', lot_key: l.slice(0, 6), production_date: null, production_date_source: null,
}));

let n = 0;
const input = (over: Record<string, unknown> = {}) => ({
  tenantId: 'cush',
  suppliers: [
    { id: 'dg', name: 'Darigold, Inc.', active: 1 },
    { id: 'cmf', name: 'Country Morning Farms', active: 1 },
    { id: 'and', name: 'Andersen Dairy Inc.', active: 1 },
    { id: 'wp', name: 'West Point', active: 1 },
  ],
  current: {},
  lotsBySupplier: { dg: lots(DARIGOLD_LOTS), cmf: CMF_LOTS, and: [] },
  ...over,
});
const opts = { lotScheme: compiled, newId: () => `id${++n}` };

describe('seed plan', () => {
  it('declares the three formats and previews the lots on file', () => {
    const plan = buildSeedPlan(input(), opts);
    const byKey = Object.fromEntries(plan.entries.map((e: any) => [e.key, e]));
    expect(byKey.darigold).toMatchObject({ action: 'insert', supplier: { id: 'dg' } });
    expect(byKey.darigold.spec.date_role).toBe('production');
    expect(byKey.darigold.preview).toMatchObject({ total: 30, fits: 27 });
    expect(byKey.darigold.preview.not_fitting.map((l: any) => l.lot_number)).toEqual(['10326076, 10326051, 10326051', '10326102', 'K134889']);
    // Every fitting lot that carries a production date agrees with its lot code.
    expect(byKey.darigold.preview.date_disagreements).toEqual([]);
    expect(byKey.country_morning.preview).toMatchObject({ total: 6, fits: 6, key_differs: 0 });
    expect(byKey.andersen.spec.kind).toBe('none');
    expect(byKey.darigold.note).toContain('AJ Conner');
  });

  it('writes one guarded INSERT and one audit row per new declaration, and nothing else', () => {
    const sql = planToSql(buildSeedPlan(input(), opts));
    expect(sql).toHaveLength(6);
    for (const s of sql) expect(s).toMatch(/^INSERT INTO (supplier_lot_schemes|audit_log) /);
    expect(sql[0]).toContain('WHERE NOT EXISTS (SELECT 1 FROM supplier_lot_schemes WHERE supplier_id = ');
    expect(sql[1]).toContain("'supplier.lot_scheme_declared'");
    expect(sql.join('\n')).not.toMatch(/\bUPDATE\b|\bDELETE\b|INSERT INTO lots/);
  });

  it('never overwrites an existing declaration, and says which kind it is', () => {
    const darigold = lotScheme.LOT_SCHEME_TEMPLATES.plant_yy_julian.spec;
    const plan = buildSeedPlan(input({ current: { dg: lotScheme.validateLotSchemeSpec(darigold).ok ? (lotScheme.validateLotSchemeSpec(darigold) as any).spec : null, cmf: { format: 1, kind: 'none' } } }), opts);
    const byKey = Object.fromEntries(plan.entries.map((e: any) => [e.key, e]));
    expect(byKey.darigold.action).toBe('unchanged');
    expect(byKey.country_morning.action).toBe('keep_existing');
    expect(planToSql(plan).filter((s: string) => s.startsWith('INSERT INTO supplier_lot_schemes'))).toHaveLength(1);
  });

  it('skips an ambiguous supplier rather than guessing', () => {
    const plan = buildSeedPlan(input({ suppliers: [{ id: 'a', name: 'Darigold, Inc.', active: 1 }, { id: 'b', name: 'Darigold Inc', active: 1 }] }), opts);
    expect(plan.entries.find((e: any) => e.key === 'darigold')).toMatchObject({ action: 'skip' });
  });
});

describe('key report', () => {
  it('finds the composite kept whole and the base read into the sublot field, with what a repair would do', () => {
    const report = reportLots(lotScheme.LOT_SCHEME_TEMPLATES.plant_yy_julian.spec, lots(DARIGOLD_LOTS), compiled);
    expect(report.counts).toEqual({ total: 30, ok: 26, split_composite: 1, key_differs: 0, sublot_not_a_sublot: 1, does_not_fit: 2 });
    const sub = report.rows.find((r: any) => r.class === 'sublot_not_a_sublot');
    expect(sub).toMatchObject({ lot_number: '10326102', stored: { key: '1032610210326102', sub: '10326102' }, suggested: { key: '10326102', sub: '' }, would_merge_into: 'dg5' });
    const split = report.rows.find((r: any) => r.class === 'split_composite');
    expect(split).toMatchObject({ lot_number: '1032603623', suggested: { key: '1032603623', sub: '23' }, would_merge_into: null });
  });

  it('reports nothing for a none format', () => {
    expect(reportLots(lotScheme.LOT_SCHEME_TEMPLATES.none.spec, lots(DARIGOLD_LOTS), compiled).rows).toEqual([]);
  });

  it('the report script has no write path', () => {
    expect(reportCli).not.toMatch(/--apply|execFileSync|wrangler', 'd1', 'execute'|\bUPDATE\b|\bDELETE\b|\bINSERT\b/);
    expect(seedCli).toContain("'--apply'");
  });
});

describe('the compiled engine is the TypeScript engine', () => {
  it('decodes and validates identically', () => {
    const spec = lotScheme.LOT_SCHEME_TEMPLATES.plant_yy_julian.spec;
    for (const [lot, sub] of DARIGOLD_LOTS) expect(compiled.decodeLot(spec, lot, sub)).toEqual(lotScheme.decodeLot(spec, lot, sub));
    expect(compiled.validateLotSchemeSpec({ format: 1 })).toEqual(lotScheme.validateLotSchemeSpec({ format: 1 }));
  });
});
