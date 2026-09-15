/**
 * bin/lib/lotProductionBackfill.js — the decision half of
 * `bin/backfill-lot-production-dates` (migration 0106).
 *
 *   1. A lot with ANY production date state is never touched; the SQL carries
 *      the same guard, so the second run writes nothing.
 *   2. Extraction first; a code date only when the page labels it production,
 *      and then labelled 'extracted_code_date_legacy'. West Point's printed
 *      code date stays a code date.
 *   3. Ambiguous and conflicting values are written raw with no day and listed.
 *   4. Split certificates get row-scoped search_text.
 *   5. The compiled bundles the script loads are the TS modules the approve path
 *      uses (no second copy of the rules).
 */
import { describe, it, expect } from 'vitest';
// @ts-expect-error — plain CJS module, no types.
import mod from '../../bin/lib/lotProductionBackfill.js';
// @ts-expect-error — generated CJS bundle, no types.
import compiledProduction from '../../bin/lib/shared/lotProductionDate.js';
import * as production from '../../shared/lotProductionDate';
import { rowScopedSearchText } from '../../shared/rowScopedText';
import { normalizeLotNumber, normalizeSubLotCode } from '../../shared/lotNormalize';
import cliSource from '../../bin/backfill-lot-production-dates?raw';

const { buildPlan, planToSql, searchTextToSql, formatPlan } = mod;
const RULES = { ...production, rowScopedSearchText, normalizeLotNumber, normalizeSubLotCode };
const RUN_AT = '2026-09-15T12:00:00.000Z';

const BUNDLE = 'DARIGOLD PO K135797 Lot 10426204 Sub Lot 13 Production Date 23-Jul-2026 Lot 10426203 Sub Lot 03 Production Date 22-Jul-2026';

function fixture() {
  const lots = [
    { id: 'l-13', lot_number: '10426204', sub_lot_code: '13', lot_key: '1042620413', production_date_status: null },
    { id: 'l-03', lot_number: '10426203', sub_lot_code: '03', lot_key: '1042620303', production_date_status: null },
    { id: 'l-legacy', lot_number: '10426038', sub_lot_code: '07', lot_key: '1042603807', production_date_status: null },
    { id: 'l-amb', lot_number: '10426199', sub_lot_code: '02', lot_key: '1042619902', production_date_status: null },
    { id: 'l-wp', lot_number: 'WP-A7', sub_lot_code: '', lot_key: 'WPA7', production_date_status: null },
    { id: 'l-order', lot_number: '777', sub_lot_code: '', lot_key: '777', production_date_status: null, first_seen_source: 'order' },
    { id: 'l-done', lot_number: '555', sub_lot_code: '', lot_key: '555', production_date_status: 'resolved' },
    { id: 'l-two', lot_number: '10426300', sub_lot_code: '01', lot_key: '1042630001', production_date_status: null },
  ];
  const docs = [
    { id: 'd-13', title: 'Row 13', external_ref: 'queue-abc-1042620413', supplier_name: 'Darigold, Inc.', version_id: 'v-13',
      primary_metadata: JSON.stringify({ lot_code: '10426204', sub_lot_code: '13', production_date: '2026-07-23' }), extracted_text: BUNDLE, search_text: null },
    { id: 'd-03', title: 'Row 03', external_ref: 'queue-abc-1042620303', supplier_name: 'Darigold, Inc.', version_id: 'v-03',
      primary_metadata: JSON.stringify({ lot_code: '10426203', sub_lot_code: '03', production_date: '22-Jul-2026' }), extracted_text: BUNDLE, search_text: null },
    { id: 'd-legacy', title: 'Older Darigold', external_ref: 'queue-old-p0', supplier_name: 'Darigold, Inc.', version_id: 'v-legacy',
      primary_metadata: JSON.stringify({ lot_number: '10426038', sub_lot_number: '07', code_date: '02/07/2026' }),
      extracted_text: 'Certificate of Analysis Lot Number 10426038 Sub Lot Number 07 Production Date 07-Feb-2026 Test', search_text: null },
    { id: 'd-amb', title: 'Ambiguous', external_ref: null, supplier_name: 'Darigold, Inc.', version_id: 'v-amb',
      primary_metadata: JSON.stringify({ lot_number: '10426199', production_date: '04-05-2026' }), extracted_text: 'Production Date 04-05-2026', search_text: null },
    { id: 'd-wp', title: 'West Point', external_ref: null, supplier_name: 'West Point', version_id: 'v-wp',
      primary_metadata: JSON.stringify({ lot_number: 'WP-A7', code_date: '2026-07-31' }), extracted_text: 'West Point Dairy butter certificate code date 07/31/2026', search_text: null },
    { id: 'd-two', title: 'Two lots', external_ref: null, supplier_name: 'Darigold, Inc.', version_id: 'v-two',
      primary_metadata: JSON.stringify({ lot_number: '10426999', production_date: '2026-08-01' }), extracted_text: 'x', search_text: null },
  ];
  const links = [
    { lot_id: 'l-13', document_id: 'd-13' },
    { lot_id: 'l-03', document_id: 'd-03' },
    { lot_id: 'l-legacy', document_id: 'd-legacy' },
    { lot_id: 'l-amb', document_id: 'd-amb' },
    { lot_id: 'l-wp', document_id: 'd-wp' },
    { lot_id: 'l-done', document_id: 'd-13' },
    { lot_id: 'l-two', document_id: 'd-two' },
    { lot_id: 'l-13', document_id: 'd-two' },
  ];
  return { tenantId: 't1', runAt: RUN_AT, lots, links, docs };
}

describe('lot production date backfill plan', () => {
  it('reads each lot from its certificate, with source and status', () => {
    const plan = buildPlan(fixture(), RULES);
    const byLot = Object.fromEntries(plan.updates.map((u: any) => [u.lot_id, u]));
    expect(byLot['l-13']).toMatchObject({ production_date: '2026-07-23', production_date_source: 'extracted', production_date_status: 'resolved', production_date_document_id: 'd-13' });
    expect(byLot['l-03']).toMatchObject({ production_date: '2026-07-22', production_date_raw: '22-Jul-2026' });
    expect(byLot['l-legacy']).toMatchObject({ production_date: '2026-02-07', production_date_raw: '02/07/2026', production_date_source: 'extracted_code_date_legacy' });
    expect(byLot['l-amb']).toMatchObject({ production_date: null, production_date_raw: '04-05-2026', production_date_status: 'ambiguous' });
    expect(plan.counts.by_source).toEqual({ extracted: 3, extracted_code_date_legacy: 1 });
  });

  it('never reads a printed code date as a production date, never touches a lot already set, skips order lots', () => {
    const plan = buildPlan(fixture(), RULES);
    const ids = plan.updates.map((u: any) => u.lot_id);
    expect(ids).not.toContain('l-wp');
    expect(ids).not.toContain('l-done');
    expect(plan.counts.already_set).toBe(1);
    expect(plan.refusals.find((r: any) => r.lot_id === 'l-wp')).toMatchObject({ reason: 'document_prints_code_date' });
    expect(plan.skipped.find((s: any) => s.lot_id === 'l-order')).toMatchObject({ reason: 'no_linked_document' });
  });

  it("a certificate linked to several lots gives its date only to the lot its metadata names", () => {
    const plan = buildPlan(fixture(), RULES);
    // d-two names 10426999, which is neither l-two nor l-13.
    expect(plan.updates.map((u: any) => u.lot_id)).not.toContain('l-two');
    expect(plan.updates.find((u: any) => u.lot_id === 'l-13').production_date_document_id).toBe('d-13');
  });

  it('lists every row not resolved to a day in the report', () => {
    const lines = formatPlan(buildPlan(fixture(), RULES)).join('\n');
    expect(lines).toMatch(/\[ambiguous\] lot 10426199-02 · "04-05-2026"/);
    expect(lines).toMatch(/extracted_code_date_legacy \(code date, page-labelled\) 1/);
  });

  it('certificates that disagree are a conflict naming both values, never a winner', () => {
    const f = fixture();
    f.docs.push({ id: 'd-03b', title: 'Row 03 again', external_ref: null, supplier_name: 'Darigold, Inc.', version_id: 'v-03b',
      primary_metadata: JSON.stringify({ lot_code: '10426203', sub_lot_code: '03', production_date: '2026-07-25' }), extracted_text: '', search_text: null });
    f.links.push({ lot_id: 'l-03', document_id: 'd-03b' });
    const u = buildPlan(f, RULES).updates.find((x: any) => x.lot_id === 'l-03');
    expect(u).toMatchObject({ production_date: null, production_date_status: 'conflict', production_date_raw: '22-Jul-2026 | 2026-07-25' });
  });

  it('is idempotent: SQL is guarded, and a second plan over written rows is empty', () => {
    const f = fixture();
    const first = buildPlan(f, RULES);
    for (const sql of planToSql(first)) expect(sql).toMatch(/AND production_date_status IS NULL;$/);
    const written = new Map(first.updates.map((u: any) => [u.lot_id, u.production_date_status]));
    const scoped = new Map(first.searchText.map((s: any) => [s.document_id, s.search_text]));
    const second = buildPlan({
      ...f,
      lots: f.lots.map((l) => ({ ...l, production_date_status: written.get(l.id) ?? l.production_date_status })),
      docs: f.docs.map((d) => ({ ...d, search_text: scoped.get(d.id) ?? d.search_text })),
    }, RULES);
    expect(second.updates).toEqual([]);
    expect(second.searchText).toEqual([]);
  });

  it('writes row-scoped search_text for split siblings only', () => {
    const plan = buildPlan(fixture(), RULES);
    expect(plan.searchText.map((s: any) => s.document_id).sort()).toEqual(['d-03', 'd-13']);
    const d13 = plan.searchText.find((s: any) => s.document_id === 'd-13');
    expect(d13.search_text).not.toMatch(/22-Jul-2026|10426203/);
    expect(searchTextToSql(plan)[0]).toMatch(/^UPDATE document_versions SET search_text = '.*' WHERE id = 'v-/);
  });

  it('the script loads the compiled shared rules, which agree with the TS modules', () => {
    expect(cliSource).toMatch(/require\('\.\/lib\/shared\/lotProductionDate'\)/);
    const fields = { code_date: '02/07/2026' };
    const text = 'Production Date 07-Feb-2026';
    expect(compiledProduction.legacyCodeDateAsProduction(fields, text)).toEqual(production.legacyCodeDateAsProduction(fields, text));
    // Only UPDATEs of the two columns' rows plus one audit row — nothing else.
    expect(cliSource).not.toMatch(/DELETE FROM/);
  });
});
