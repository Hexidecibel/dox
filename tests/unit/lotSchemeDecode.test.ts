/**
 * shared/lotScheme.ts — a supplier's DECLARED lot format (migration 0109).
 *
 * The decoder is exercised on every lot shape AJ listed (R2) and on the §6
 * table; the validator refuses a declaration that cannot mean one thing; and
 * the legacy enum values, now expressed as specs, key byte-identically to the
 * 0075 transforms they replace.
 */
import { describe, it, expect } from 'vitest';
import {
  decodeLot,
  legacyLotSchemeSpec,
  lotIdentity,
  LOT_SCHEME_TEMPLATES,
  validateLotSchemeSpec,
  type LotSchemeSpec,
} from '../../shared/lotScheme';
import { applyLotScheme } from '../../functions/lib/entities/lots';
import { normalizeLotNumber, normalizeSubLotCode } from '../../shared/lotNormalize';

const DARIGOLD = LOT_SCHEME_TEMPLATES.plant_yy_julian.spec;
const CMF = LOT_SCHEME_TEMPLATES.best_by_mmddyy_suffix.spec;
const NONE = LOT_SCHEME_TEMPLATES.none.spec;

describe('decodeLot — Darigold plant · YY · Julian day + sublot', () => {
  it('decodes a base lot: 10426212 is Julian day 212 of 2026 = Jul 31, 2026 (the King and Prince question)', () => {
    const d = decodeLot(DARIGOLD, '10426212');
    expect(d.fits).toBe(true);
    expect(d.base).toBe('10426212');
    expect(d.sublot).toBe('');
    expect(d.decoded_date).toBe('2026-07-31');
    expect(d.date_role).toBe('production');
    expect(d.segments).toEqual([
      { name: 'plant', kind: 'digits', value: '104' },
      { name: 'year', kind: 'yy', value: '26' },
      { name: 'day', kind: 'julian_day', value: '212' },
    ]);
  });

  it.each([
    ['10426203-03', undefined],
    ['10426203 03', undefined],
    ['1042620303', undefined],
    ['10426203', '03'],
    ['1042620303', '03'],
    ['Lot# 10426203-03', undefined],
  ])('reads %s (sublot %s) as base 10426203, sublot 03, produced Jul 22, 2026', (lot, sub) => {
    const d = decodeLot(DARIGOLD, lot, sub);
    expect(d.fits).toBe(true);
    expect(d.base).toBe('10426203');
    expect(d.sublot).toBe('03');
    expect(d.composite).toBe('1042620303');
    expect(d.key).toBe('1042620303');
    expect(d.key_sublot).toBe('03');
    expect(d.decoded_date).toBe('2026-07-22');
  });

  it('matches all four rows of AJ §6', () => {
    expect(decodeLot(DARIGOLD, '10426204-13').decoded_date).toBe('2026-07-23');
    for (const sub of ['04', '03', '02']) expect(decodeLot(DARIGOLD, `10426203-${sub}`).decoded_date).toBe('2026-07-22');
  });

  it('pads a one-digit separated sublot', () => {
    expect(decodeLot(DARIGOLD, '10426203-3').sublot).toBe('03');
  });

  it('accepts day 366 in a leap year and refuses it otherwise', () => {
    expect(decodeLot(DARIGOLD, '10428366').decoded_date).toBe('2028-12-31');
    const d = decodeLot(DARIGOLD, '10426366');
    expect(d.fits).toBe(false);
    expect(d.reason).toContain('1–365');
  });

  it('refuses day 400 and day 000', () => {
    const d = decodeLot(DARIGOLD, '10426400');
    expect(d.fits).toBe(false);
    expect(d.reason).toBe('Day "400" is not a day of 2026 (1–365).');
    expect(decodeLot(DARIGOLD, '10426000').fits).toBe(false);
  });

  it('refuses a PO in the lot field (K134889)', () => {
    const d = decodeLot(DARIGOLD, 'K134889');
    expect(d.fits).toBe(false);
    expect(d.reason).toContain('7 characters');
    expect(d.decoded_date).toBeNull();
    // Identity is untouched: as written.
    expect(d.key).toBe('K134889');
  });

  it('refuses three lots merged into one field', () => {
    const d = decodeLot(DARIGOLD, '10326076, 10326051, 10326051');
    expect(d.fits).toBe(false);
    expect(d.key).toBe('103260761032605110326051');
  });

  it('refuses a base extracted into the sublot field, keeping the stored key (the 1032610210326102 class)', () => {
    const d = decodeLot(DARIGOLD, '10326102', '10326102');
    expect(d.fits).toBe(false);
    expect(d.reason).toContain('Sublot "10326102"');
    expect(d.key).toBe('1032610210326102');
  });

  it('refuses a lot whose own sublot disagrees with the sublot field', () => {
    const d = decodeLot(DARIGOLD, '1042620303', '04');
    expect(d.fits).toBe(false);
    expect(d.reason).toContain('ends in sublot 03');
  });

  it('never throws on junk', () => {
    for (const junk of [null, undefined, '', '   ', '#', '-----', '🧈', 'x'.repeat(500)]) {
      const d = decodeLot(DARIGOLD, junk as string);
      expect(d.fits).toBe(false);
      expect(typeof d.reason).toBe('string');
    }
    expect(decodeLot(null, '10426212').fits).toBe(false);
  });

  it('honours declared plant values', () => {
    const spec: LotSchemeSpec = { ...DARIGOLD, segments: [{ name: 'plant', kind: 'digits', width: 3, values: ['103', '104'] }, ...DARIGOLD.segments!.slice(1)] };
    expect(decodeLot(spec, '10426212').fits).toBe(true);
    const d = decodeLot(spec, '99926212');
    expect(d.fits).toBe(false);
    expect(d.reason).toContain('not one of the declared values (103, 104)');
  });
});

describe('decodeLot — Country Morning best-by MMDDYY + product suffix', () => {
  it('decodes 092326WHO as best-by Sep 23, 2026 with suffix WHO', () => {
    const d = decodeLot(CMF, '092326WHO');
    expect(d.fits).toBe(true);
    expect(d.decoded_date).toBe('2026-09-23');
    expect(d.date_role).toBe('best_by');
    expect(d.segments.find((s) => s.name === 'product')?.value).toBe('WHO');
    expect(d.key).toBe('092326');
    expect(d.key_sublot).toBe('');
  });

  it('accepts a bare date (the WMS side) and a digit in the suffix', () => {
    expect(decodeLot(CMF, '061626').key).toBe('061626');
    expect(decodeLot(CMF, '052926LC3').fits).toBe(true);
  });

  it('drops an extracted sublot: the suffix is the item, not a sublot', () => {
    expect(lotIdentity(CMF, '061626WHO', '05')).toEqual({ lotKey: '061626', subLotCode: '' });
  });

  it('refuses an impossible date', () => {
    const d = decodeLot(CMF, '133126WHO');
    expect(d.fits).toBe(false);
    expect(d.reason).toBe('"133126" is not a month-day-year date.');
    expect(decodeLot(CMF, '023026WHO').fits).toBe(false);
  });
});

describe('decodeLot — declared none (Andersen)', () => {
  it('stores the lot as written and decodes nothing', () => {
    const d = decodeLot(NONE, '9-9-26', '');
    expect(d.fits).toBe(false);
    expect(d.decoded_date).toBeNull();
    expect(d.key).toBe('9926');
    expect(lotIdentity(NONE, '10426110', '05')).toEqual({ lotKey: '1042611005', subLotCode: '05' });
  });
});

describe('legacy enum values run through the same engine, byte-identically', () => {
  const samples: Array<[string, string]> = [
    ['10426110', '05'], ['10426110', ''], ['061926LC3', ''], ['061626WHO', ''], ['061626WHO', '05'],
    ['061626', ''], ['ABC123', ''], ['12345', ''], ['1234567', ''], ['K134889', ''], ['103260761032605110326051', ''],
    ['10326102', '10326102'], ['9926', ''], ['20260503', ''], ['999999X', '7'],
  ];
  for (const scheme of ['auto', 'plain', 'lims_combined', 'date_code'] as const) {
    it(`${scheme}: identical keys to the 0075 transform on every sample`, () => {
      for (const [lot, sub] of samples) {
        expect(lotIdentity(legacyLotSchemeSpec(scheme), lot, sub), `${scheme} ${lot}/${sub}`).toEqual(
          // findOrCreateLot normalised both parts before the 0075 transform ran.
          legacyTransform(scheme, normalizeLotNumber(lot), normalizeSubLotCode(sub)),
        );
      }
    });
  }

  it('applyLotScheme (now spec-backed) still equals the original transform', () => {
    for (const scheme of ['auto', 'plain', 'lims_combined', 'date_code', null, undefined] as const) {
      for (const [lot, sub] of samples) {
        const [n, ns] = [normalizeLotNumber(lot), normalizeSubLotCode(sub)];
        expect(applyLotScheme(scheme, n, ns)).toEqual(legacyTransform(scheme, n, ns));
      }
    }
  });
});

/** The 0075 transform, copied verbatim from the pre-0109 lots.ts, as the parity oracle. */
function legacyTransform(scheme: string | null | undefined, baseLotKey: string, subLotCode: string) {
  switch (scheme) {
    case 'date_code': {
      const m = /^(\d{6})/.exec(baseLotKey);
      return { lotKey: m ? m[1] : baseLotKey, subLotCode: '' };
    }
    default:
      return { lotKey: baseLotKey + subLotCode, subLotCode };
  }
}

describe('validateLotSchemeSpec', () => {
  it('accepts every template and returns it normalised', () => {
    for (const t of Object.values(LOT_SCHEME_TEMPLATES)) {
      const v = validateLotSchemeSpec(t.spec);
      expect(v.ok, JSON.stringify(v)).toBe(true);
    }
    const v = validateLotSchemeSpec(DARIGOLD);
    expect(v.ok && v.spec.segments![1].width).toBe(2);
  });

  const refuse = (spec: unknown, fragment: string) => {
    const v = validateLotSchemeSpec(spec);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.errors.join(' | ')).toContain(fragment);
  };

  it('refuses non-objects and wrong format', () => {
    refuse(null, 'must be an object');
    refuse('plant·yy·ddd', 'must be an object');
    refuse({ ...DARIGOLD, format: 2 }, 'format must be 1');
    refuse({ ...DARIGOLD, kind: 'regex' }, 'kind must be');
  });

  it('refuses unknown settings (a typo must not silently do nothing)', () => {
    refuse({ ...DARIGOLD, sublot_width: 2 }, 'Unknown setting "sublot_width"');
    refuse({ ...DARIGOLD, segments: [{ name: 'plant', kind: 'digits', width: 3, widht: 3 }, ...DARIGOLD.segments!.slice(1)] }, 'unknown setting "widht"');
  });

  it('refuses a Julian day with no year, a year with no day, and two date encodings', () => {
    refuse({ ...DARIGOLD, segments: [{ name: 'plant', kind: 'digits', width: 5 }, { name: 'day', kind: 'julian_day' }] }, 'needs a YY segment');
    refuse({ ...DARIGOLD, segments: [{ name: 'plant', kind: 'digits', width: 6 }, { name: 'year', kind: 'yy' }] }, 'not a date');
    refuse({ ...CMF, segments: [{ name: 'a', kind: 'mmddyy' }, { name: 'b', kind: 'yymmdd' }] }, 'one date encoding');
  });

  it('refuses a date encoding without a role, and a role without a date', () => {
    refuse({ ...DARIGOLD, date_role: null }, 'Say which date');
    refuse({ ...NONE, kind: 'structured', segments: [{ name: 'code', kind: 'digits', width: 6 }], date_role: 'production' }, 'no segment encodes a date');
  });

  it('refuses a variable-width segment that is not last, and a sublot after one', () => {
    refuse({ ...CMF, segments: [{ name: 'product', kind: 'letters' }, { name: 'best_by', kind: 'mmddyy' }] }, 'only the last segment');
    refuse({ ...CMF, sublot: { width: 2, kind: 'digits' } }, 'fixed-width base');
  });

  it('refuses a wrong implied width, duplicate names, and bad key segments', () => {
    refuse({ ...DARIGOLD, segments: [{ name: 'plant', kind: 'digits', width: 3 }, { name: 'year', kind: 'yy', width: 4 }, { name: 'day', kind: 'julian_day' }] }, 'always 2 characters');
    refuse({ ...DARIGOLD, segments: [{ name: 'x', kind: 'digits', width: 3 }, { name: 'x', kind: 'yy' }, { name: 'day', kind: 'julian_day' }] }, 'used twice');
    refuse({ ...CMF, key_segments: ['lot'] }, 'not a segment');
    refuse({ ...DARIGOLD, key: 'segments' }, 'needs key_segments');
  });

  it('refuses values that do not fit their segment', () => {
    refuse({ ...DARIGOLD, segments: [{ name: 'plant', kind: 'digits', width: 3, values: ['1O4'] }, ...DARIGOLD.segments!.slice(1)] }, '"1O4"');
  });

  it('refuses structure on a none declaration', () => {
    refuse({ format: 1, kind: 'none', segments: DARIGOLD.segments }, 'declares no segments');
  });
});
