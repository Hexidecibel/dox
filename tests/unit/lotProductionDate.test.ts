/**
 * shared/lotProductionDate.ts — a lot row's production date, its source, and the
 * refusal to guess (migration 0106; AJ Conner R3 / R8).
 */
import { describe, it, expect } from 'vitest';
import {
  combineProductionDates,
  datesUnderProductionLabels,
  legacyCodeDateAsProduction,
  resolveProductionDate,
} from '../../shared/lotProductionDate';
import { productionDateSets } from '../../functions/lib/entities/lots';

describe('resolveProductionDate', () => {
  it('reads the record\'s own production date as extracted', () => {
    expect(resolveProductionDate({ production_date: '2026-07-22' })).toMatchObject({
      iso: '2026-07-22', raw: '2026-07-22', status: 'resolved', source: 'extracted', field: 'production_date',
    });
    expect(resolveProductionDate({ production_date: '22-Jul-2026' })).toMatchObject({ iso: '2026-07-22', raw: '22-Jul-2026' });
  });

  it('takes a manufacture-date spelling, never a code date', () => {
    expect(resolveProductionDate({ mfg_date: '7/22/2026' })?.iso).toBe('2026-07-22');
    expect(resolveProductionDate({ code_date: '2026-07-31' })).toBeNull();
  });

  it('stores an ambiguous day raw with no ISO, never a guess', () => {
    expect(resolveProductionDate({ production_date: '04-05-2026' })).toMatchObject({
      iso: null, raw: '04-05-2026', status: 'ambiguous',
    });
  });

  it('settles the order only on evidence from the same record', () => {
    const r = resolveProductionDate({ production_date: '04-05-2026', expiration_date: '18-01-2027' });
    expect(r).toMatchObject({ iso: '2026-05-04', status: 'resolved' });
    expect(r?.note).toMatch(/day\/month/);
  });

  it('flags unreadable and multi-date values', () => {
    expect(resolveProductionDate({ production_date: 'see label' })).toMatchObject({ iso: null, status: 'unparseable' });
    expect(resolveProductionDate({ production_date: '2026-03-17, 2026-02-20' })).toMatchObject({ iso: null, status: 'conflict' });
  });
});

describe('legacyCodeDateAsProduction', () => {
  const darigoldText = 'Certificate of Analysis Lot Number 10426038 Sub Lot Number 07 Weight – LB 1950 Production Date 07-Feb-2026 Test Methodology';

  it('accepts a code date the page prints under its production date label, and labels the source', () => {
    const r = legacyCodeDateAsProduction({ code_date: '2026-02-07' }, darigoldText);
    expect(r).toMatchObject({ ok: true, resolution: { iso: '2026-02-07', source: 'extracted_code_date_legacy', field: 'code_date' } });
  });

  it('lets the page settle a value that reads two ways — only when exactly one reading is printed', () => {
    const r = legacyCodeDateAsProduction({ code_date: '02/07/2026' }, darigoldText);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.resolution).toMatchObject({ iso: '2026-02-07', status: 'resolved', raw: '02/07/2026' });
      expect(r.resolution.note).toMatch(/prints 2026-02-07 under its production date label/);
    }
    const both = legacyCodeDateAsProduction(
      { code_date: '02/07/2026' },
      'Production Date 07-Feb-2026 02-Jul-2026',
    );
    expect(both).toMatchObject({ ok: true, resolution: { iso: null, status: 'ambiguous' } });
  });

  it('refuses whenever the page does not say so', () => {
    expect(legacyCodeDateAsProduction({ code_date: '2026-07-31' }, 'West Point Dairy butter certificate code date 07/31/2026'))
      .toEqual({ ok: false, refusal: 'document_prints_code_date' });
    expect(legacyCodeDateAsProduction({ code_date: '2026-07-31' }, 'Country Morning Farms 073126 WHOLE MILK'))
      .toEqual({ ok: false, refusal: 'no_production_label' });
    expect(legacyCodeDateAsProduction({ code_date: '2026-08-22' }, 'Production Date 31-Jul-2026 Best By 22-Aug-2026'))
      .toEqual({ ok: false, refusal: 'not_printed_under_production_label' });
    expect(legacyCodeDateAsProduction({ code_date: '2026-02-07', production_date: '2026-02-07' }, darigoldText))
      .toEqual({ ok: false, refusal: 'has_production_field' });
    expect(legacyCodeDateAsProduction({ code_date: '2026-02-07' }, '')).toEqual({ ok: false, refusal: 'no_text' });
  });

  it('reads a row-wise table label across a run of dates, but not across another label', () => {
    const days = datesUnderProductionLabels('Production Date 22-Jul-2026 22-Jul-2026 23-Jul-2026 Expiration Date 18-Jan-2027');
    expect([...days].sort()).toEqual(['2026-07-22', '2026-07-23']);
  });
});

describe('combineProductionDates', () => {
  const item = (iso: string | null, raw: string, status: any, source: any = 'extracted', document_id = 'd') => ({
    iso, raw, status, source, field: 'production_date', note: null, document_id,
  });

  it('agreeing certificates resolve; disagreeing ones are a conflict naming both', () => {
    expect(combineProductionDates([item('2026-07-22', '2026-07-22', 'resolved'), item('2026-07-22', '22-Jul-2026', 'resolved')]))
      .toMatchObject({ iso: '2026-07-22', status: 'resolved' });
    expect(combineProductionDates([item('2026-07-22', '2026-07-22', 'resolved'), item('2026-07-23', '2026-07-23', 'resolved', 'extracted_code_date_legacy')]))
      .toMatchObject({ iso: null, status: 'conflict', raw: '2026-07-22 | 2026-07-23' });
  });

  it('an ambiguous value that could be the resolved day does not contradict it', () => {
    expect(combineProductionDates([item('2026-04-05', '2026-04-05', 'resolved'), item(null, '04-05-2026', 'ambiguous')]))
      .toMatchObject({ iso: '2026-04-05', status: 'resolved' });
    expect(combineProductionDates([item('2026-06-05', '2026-06-05', 'resolved'), item(null, '04-05-2026', 'ambiguous')]))
      .toMatchObject({ status: 'conflict' });
  });
});

describe('productionDateSets (the lot writer)', () => {
  const next = (iso: string | null, raw: string, status: any) => ({
    iso, raw, status, source: 'extracted' as const, field: 'production_date', note: null, documentId: 'doc-2',
  });
  const none = { production_date: null, production_date_raw: null, production_date_status: null };

  it('fills an empty lot', () => {
    const r = productionDateSets(none, next('2026-07-22', '2026-07-22', 'resolved'));
    expect(r.binds).toEqual(['2026-07-22', '2026-07-22', 'extracted', 'resolved', 'doc-2']);
  });

  it('leaves the same day alone and turns a different day into a conflict, never a winner', () => {
    const held = { production_date: '2026-07-22', production_date_raw: '2026-07-22', production_date_status: 'resolved' };
    expect(productionDateSets(held, next('2026-07-22', '22-Jul-2026', 'resolved')).sets).toEqual([]);
    const c = productionDateSets(held, next('2026-07-23', '2026-07-23', 'resolved'));
    expect(c.sets).toContain("production_date_status = 'conflict'");
    expect(c.sets).toContain('production_date = NULL');
    expect(c.binds).toEqual(['2026-07-22 | 2026-07-23']);
    // Re-running the same approval adds nothing.
    const conflicted = { production_date: null, production_date_raw: '2026-07-22 | 2026-07-23', production_date_status: 'conflict' };
    expect(productionDateSets(conflicted, next('2026-07-23', '2026-07-23', 'resolved')).sets).toEqual([]);
  });

  it('a later plain statement of one reading settles an ambiguous lot', () => {
    const amb = { production_date: null, production_date_raw: '04-05-2026', production_date_status: 'ambiguous' };
    expect(productionDateSets(amb, next('2026-05-04', '2026-05-04', 'resolved')).binds).toEqual(['2026-05-04', '2026-05-04', 'extracted', 'doc-2']);
  });
});
