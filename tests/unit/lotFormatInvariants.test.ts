/**
 * Review-time checks against a supplier's DECLARED lot format (migration 0110).
 *
 * The decode is a validator, never an authority: a lot that does not fit is
 * flagged with the reason; a decoded date that disagrees with the stated one is
 * flagged with BOTH values; nothing is rewritten; and without a declaration no
 * check runs at all.
 */
import { describe, it, expect } from 'vitest';
import { checkExtraction, type InvariantFailure } from '../../shared/extractionInvariants';
import { LOT_SCHEME_TEMPLATES } from '../../shared/lotScheme';
import { invariantWarningsFor, withInvariantWarnings } from '../../functions/lib/queue-warnings';

const DARIGOLD = { supplierName: 'Darigold, Inc.', spec: LOT_SCHEME_TEMPLATES.plant_yy_julian.spec };
const CMF = { supplierName: 'Country Morning Farms', spec: LOT_SCHEME_TEMPLATES.best_by_mmddyy_suffix.spec };

const LOT_CHECKS = ['lot_fits_declared_format', 'lot_code_production_date', 'lot_code_best_by_date'];

function lotWarnings(
  input: { ai_fields?: Record<string, unknown>; ai_records?: unknown },
  scheme: typeof DARIGOLD | null,
): InvariantFailure[] {
  const fields = input.ai_fields ? JSON.stringify(input.ai_fields) : null;
  const records = input.ai_records ? JSON.stringify(input.ai_records) : null;
  return checkExtraction({ ai_fields: fields, ai_records: records, extracted_text: null }, { lotScheme: scheme })
    .failures.filter((f) => LOT_CHECKS.includes(f.check));
}

describe('lot_fits_declared_format', () => {
  it("flags a PO in the lot field: lot 'K134889' does not fit Darigold's declared format", () => {
    const [f, ...rest] = lotWarnings({ ai_fields: { lot_number: 'K134889', production_date: '2026-04-12' } }, DARIGOLD);
    expect(rest).toEqual([]);
    expect(f.check).toBe('lot_fits_declared_format');
    expect(f.field).toBe('lot_number');
    expect(f.message).toContain(`Lot "K134889" does not fit Darigold, Inc.'s declared lot format (plant · YY · Julian day)`);
    expect(f.message).toContain('7 characters');
  });

  it('flags three lots merged into one field, and a base read into the sublot field', () => {
    expect(lotWarnings({ ai_fields: { lot_number: '10326076, 10326051, 10326051' } }, DARIGOLD)[0].check).toBe('lot_fits_declared_format');
    const [f] = lotWarnings({ ai_fields: { lot_number: '10326102', sub_lot_code: '10326102' } }, DARIGOLD);
    expect(f.value).toBe('10326102 / sublot 10326102');
  });

  it('passes every lot shape that fits', () => {
    for (const fields of [
      { lot_number: '10426203', sub_lot_code: '03' },
      { lot_number: '10426203-03' },
      { lot_number: '1042620303' },
      { lot_code: '10426212' },
    ]) {
      expect(lotWarnings({ ai_fields: fields }, DARIGOLD), JSON.stringify(fields)).toEqual([]);
    }
  });

  it('runs nothing without a declaration, or for a declared none', () => {
    expect(lotWarnings({ ai_fields: { lot_number: 'K134889' } }, null)).toEqual([]);
    expect(lotWarnings({ ai_fields: { lot_number: 'K134889' } }, { supplierName: 'Andersen Dairy Inc.', spec: LOT_SCHEME_TEMPLATES.none.spec })).toEqual([]);
  });
});

describe('lot_code_production_date — decode vs the stated production date', () => {
  it('flags a row whose stated production date is not the day its lot encodes, naming both', () => {
    const records = {
      page_metadata: { lot_number: '10426203' },
      records: [
        { fields: { sub_lot_code: '13', lot_number: '10426204', production_date: '22-Jul-2026' } },
        { fields: { sub_lot_code: '04', production_date: '22-Jul-2026' } },
      ],
    };
    const fs = lotWarnings({ ai_records: records }, DARIGOLD);
    expect(fs).toHaveLength(1);
    expect(fs[0]).toMatchObject({ check: 'lot_code_production_date', scope: 'record[0]', field: 'production_date', value: '22-Jul-2026' });
    expect(fs[0].message).toContain('22-Jul-2026');
    expect(fs[0].message).toContain('Jul 23, 2026');
    expect(fs[0].message).toContain('Nothing has been changed');
  });

  it('passes AJ §6: all four rows agree', () => {
    const records = {
      page_metadata: {},
      records: [
        { fields: { lot_number: '10426204', sub_lot_code: '13', production_date: '23-Jul-2026' } },
        { fields: { lot_number: '10426203', sub_lot_code: '04', production_date: '22-Jul-2026' } },
        { fields: { lot_number: '10426203', sub_lot_code: '03', production_date: '2026-07-22' } },
        { fields: { lot_number: '10426203', sub_lot_code: '02', production_date: '07/22/2026' } },
      ],
    };
    expect(lotWarnings({ ai_records: records }, DARIGOLD)).toEqual([]);
  });

  it('does not flag an ambiguous stated date one of whose readings is the decoded day', () => {
    // 10326124 = May 4, 2026; "04-05-2026" reads Apr 5 or May 4.
    expect(lotWarnings({ ai_fields: { lot_number: '10326124', production_date: '04-05-2026' } }, DARIGOLD)).toEqual([]);
    expect(lotWarnings({ ai_fields: { lot_number: '10326124', production_date: '06-05-2026' } }, DARIGOLD)[0].check).toBe('lot_code_production_date');
  });

  it('checks nothing when no production date is stated (the write path fills it, labelled)', () => {
    expect(lotWarnings({ ai_fields: { lot_number: '10426212' } }, DARIGOLD)).toEqual([]);
  });

  it('never rewrites the extraction', () => {
    const fields = { lot_number: '10426204', production_date: '2026-07-22' };
    const before = JSON.stringify(fields);
    lotWarnings({ ai_fields: fields }, DARIGOLD);
    expect(JSON.stringify(fields)).toBe(before);
  });
});

describe('lot_code_best_by_date — a best-by format (Country Morning)', () => {
  it('flags an expiration that is not the best-by the lot encodes', () => {
    const [f] = lotWarnings({ ai_fields: { lot_number: '092326WHO', expiration_date: '2026-09-30' } }, CMF);
    expect(f.check).toBe('lot_code_best_by_date');
    expect(f.message).toContain('Sep 23, 2026');
    expect(f.message).toContain("Country Morning Farms' declared lot format");
  });

  it('passes when they agree, and never checks a production date', () => {
    expect(lotWarnings({ ai_fields: { lot_number: '092326WHO', expiration_date: '09/23/2026', production_date: '2026-09-02' } }, CMF)).toEqual([]);
  });
});

describe('queue-warnings plumbing', () => {
  it('reads the declared format from the row and strips it from the response', () => {
    const row = {
      ai_fields: JSON.stringify({ lot_number: 'K134889' }),
      extracted_text: 'K134889',
      lot_scheme_spec: JSON.stringify(DARIGOLD.spec),
      lot_scheme_supplier_name: 'Darigold, Inc.',
    };
    expect(invariantWarningsFor(row).some((w) => w.check === 'lot_fits_declared_format')).toBe(true);
    const out = withInvariantWarnings(row);
    expect(out).not.toHaveProperty('lot_scheme_spec');
    expect(out).not.toHaveProperty('lot_scheme_supplier_name');
  });

  it('ignores a stored spec that no longer validates', () => {
    const row = { ai_fields: JSON.stringify({ lot_number: 'K134889' }), lot_scheme_spec: '{"format":1,"kind":"structured"}' };
    expect(invariantWarningsFor(row).some((w) => w.check === 'lot_fits_declared_format')).toBe(false);
  });
});
