/**
 * D3 bands (rules table, ruled 2026-09-27): the MEANING of "how far out"
 * depends on the analyte's category. One test block per shape, plus the lines
 * that must not move: a band never exists without a category, never on a pass,
 * and never on a printed verdict.
 */

import { describe, it, expect } from 'vitest';
import {
  computeSpecBand,
  attachSpecBands,
  specBandRank,
  knownRegulatoryCeiling,
  type BandLimit,
} from '../../shared/specBand';
import { checkConfiguredLimits } from '../../shared/specCheck';

const ceiling = (max: number, unit = 'CFU/g'): BandLimit => ({ operator: '<=', value_min: null, value_max: max, unit });

describe('indicator organism — two lines, no gradient', () => {
  const analyte = { name: 'Coliform', category: 'indicator' };

  it('any exceedance is review', () => {
    expect(computeSpecBand({ verdict: 'out_of_spec', value_num: 2, analyte, limit: ceiling(1) })?.band).toBe('review');
    expect(computeSpecBand({ verdict: 'out_of_spec', value_num: 10, analyte, limit: ceiling(1) })?.band).toBe('review');
  });

  it('more than 10x is the violation band, not a louder review', () => {
    const b = computeSpecBand({ verdict: 'out_of_spec', value_num: 11, analyte, limit: ceiling(1) });
    expect(b?.band).toBe('violation');
    expect(b?.reason).toMatch(/11x the limit/);
  });

  it('a could-not-check is banded by its reported ceiling (D3: "<50" against 1)', () => {
    expect(computeSpecBand({ verdict: 'not_checked', value_num: 50, analyte, limit: ceiling(1) })?.band).toBe('violation');
    expect(computeSpecBand({ verdict: 'not_checked', value_num: 5, analyte, limit: ceiling(1) })?.band).toBe('review');
  });
});

describe('compositional — graduated', () => {
  const analyte = { name: 'Butterfat', category: 'compositional' };
  const min = (v: number): BandLimit => ({ operator: '>=', value_min: v, value_max: null, unit: '%' });

  it('a little past is light, moderately past a look, far past urgent', () => {
    expect(computeSpecBand({ verdict: 'out_of_spec', value_num: 10.5, analyte, limit: ceiling(10, '%') })?.band).toBe('light');
    expect(computeSpecBand({ verdict: 'out_of_spec', value_num: 13, analyte, limit: ceiling(10, '%') })?.band).toBe('look');
    expect(computeSpecBand({ verdict: 'out_of_spec', value_num: 20, analyte, limit: ceiling(10, '%') })?.band).toBe('urgent');
  });

  it('works below a minimum too', () => {
    expect(computeSpecBand({ verdict: 'out_of_spec', value_num: 3.2, analyte, limit: min(3.25) })?.band).toBe('light');
    expect(computeSpecBand({ verdict: 'out_of_spec', value_num: 1, analyte, limit: min(3.25) })?.band).toBe('urgent');
  });
});

describe('zero tolerance — no band, top priority', () => {
  const analyte = { name: 'Salmonella', category: 'zero_tolerance' };
  const absent: BandLimit = { operator: 'absent', value_min: null, value_max: null, unit: null };

  it('detected is top priority, with no number needed', () => {
    expect(computeSpecBand({ verdict: 'out_of_spec', value_num: null, analyte, limit: absent })?.band).toBe('top_priority');
  });

  it('could-not-confirm-clean is top priority too — no note-level stop', () => {
    const b = computeSpecBand({ verdict: 'not_checked', value_num: null, analyte, limit: absent });
    expect(b?.band).toBe('top_priority');
    expect(b?.reason).toMatch(/could not be confirmed clean/);
  });
});

describe('regulatory ceiling — graduated but tighter, around the legal line', () => {
  const afm1 = { name: 'Aflatoxin M1', category: 'regulatory_ceiling' };
  const ourLimit: BandLimit = { operator: '<=', value_min: null, value_max: 0.25, unit: 'ppb' };

  it('ships the FDA action level as a documented default, by name', () => {
    expect(knownRegulatoryCeiling('Aflatoxin M1')?.value).toBe(0.5);
    expect(knownRegulatoryCeiling('AFM1')?.unit).toBe('ppb');
    expect(knownRegulatoryCeiling('Aflatoxin B1')).toBeNull();
  });

  it("D3's own example: '<1.0 ppb' is 2x the 0.5 ceiling and gets CALLED", () => {
    const b = computeSpecBand({ verdict: 'not_checked', value_num: 1.0, analyte: afm1, limit: ourLimit });
    expect(b?.band).toBe('call');
    expect(b?.reason).toMatch(/2x the default ceiling/);
  });

  it('past our tighter limit but under the ceiling is a note', () => {
    expect(computeSpecBand({ verdict: 'out_of_spec', value_num: 0.3, analyte: afm1, limit: ourLimit })?.band).toBe('note');
  });

  it('a measured result over the ceiling is a violation', () => {
    expect(computeSpecBand({ verdict: 'out_of_spec', value_num: 0.6, analyte: afm1, limit: ourLimit })?.band).toBe('violation');
  });

  it('a reported bound beyond the band is a violation; the band is configurable', () => {
    expect(computeSpecBand({ verdict: 'not_checked', value_num: 2, analyte: afm1, limit: ourLimit })?.band).toBe('violation');
    expect(
      computeSpecBand({
        verdict: 'not_checked',
        value_num: 2,
        analyte: { ...afm1, regulatory_band_factor: 5 },
        limit: ourLimit,
      })?.band
    ).toBe('call');
  });

  it('a configured ceiling in another unit is converted exactly (0.05 µg/kg = 0.05 ppb)', () => {
    const b = computeSpecBand({
      verdict: 'out_of_spec',
      value_num: 0.06,
      analyte: { name: 'Aflatoxin M1', category: 'regulatory_ceiling', regulatory_ceiling_value: 0.05, regulatory_ceiling_unit: 'µg/kg' },
      limit: { operator: '<=', value_min: null, value_max: 0.025, unit: 'ppb' },
    });
    expect(b?.band).toBe('violation');
    expect(b?.reason).toMatch(/configured ceiling/);
  });

  it('a ceiling in a unit that cannot be converted gives no band rather than a guess', () => {
    expect(
      computeSpecBand({
        verdict: 'out_of_spec',
        value_num: 1,
        analyte: { name: 'X', category: 'regulatory_ceiling', regulatory_ceiling_value: 1, regulatory_ceiling_unit: 'CFU/g' },
        limit: { operator: '<=', value_min: null, value_max: 0.5, unit: 'ppb' },
      })
    ).toBeNull();
  });
});

describe('what a band never does', () => {
  it('no category, no band — every analyte today', () => {
    expect(computeSpecBand({ verdict: 'out_of_spec', value_num: 99, analyte: { name: 'Coliform' }, limit: ceiling(1) })).toBeNull();
  });

  it('never bands a pass', () => {
    expect(
      computeSpecBand({ verdict: 'in_spec', value_num: 0, analyte: { name: 'S', category: 'zero_tolerance' }, limit: ceiling(1) })
    ).toBeNull();
  });

  it('ranks top priority first and an unbanded result last', () => {
    expect(specBandRank('top_priority')).toBe(0);
    expect(specBandRank(null)).toBeGreaterThan(specBandRank('light'));
  });

  it('attaches after judging and leaves the verdict exactly as the engine decided it', () => {
    const tests = [{ id: 'st_coli', name: 'Coliform', aliases: [], category: 'indicator' }];
    const limits = [
      {
        id: 'l1',
        spec_test_id: 'st_coli',
        operator: '<=' as const,
        value_min: null,
        value_max: 1,
        unit: 'CFU/g',
        severity: 'alert' as const,
        active: true,
        supplier_id: null,
        document_type_id: null,
        product_id: null,
      },
    ];
    const sources = [
      { scope: 'ai_fields', tables: [{ name: 'micro', headers: ['test', 'result', 'units'], rows: [['Coliform', '40', 'CFU/g']] }] },
    ];
    const { verdicts } = checkConfiguredLimits(sources, tests, limits, {});
    const banded = attachSpecBands(verdicts, tests, limits);
    expect(banded[0].verdict).toBe(verdicts[0].verdict);
    expect(banded[0].reason).toBe(verdicts[0].reason);
    expect(banded[0].band?.band).toBe('violation');

    // A printed verdict carries no analyte category and stays unbanded.
    const printed = { ...verdicts[0], source: 'printed' as const };
    expect(attachSpecBands([printed], tests, limits)[0].band).toBeUndefined();
  });
});
