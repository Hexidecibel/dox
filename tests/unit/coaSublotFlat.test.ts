/**
 * D1 — "sublot has no slot in the flat schema" (Q4/Q8 A/B, 2026-07-30).
 *
 * `sub_lot_code` used to exist ONLY inside the `records[]` schema, while the
 * COA prompt explicitly licensed omitting `records[]` on a page with exactly
 * one lot and one sublot. A *compliant* output for such a page therefore had
 * nowhere to put the sublot, so it was silently dropped and `lot_key` became
 * the bare main lot instead of lot+sublot — order⇄COA matching then keyed on
 * the wrong value. 17 of 28 affected pages lost it on BOTH quantizations, so
 * it was our schema defect, not a model limitation.
 *
 * The fix gives the FLAT field set a `sub_lot_code` slot (rather than
 * withdrawing the omit-records licence, which would have changed the output
 * SHAPE — and hence review-queue routing — for every single-lot COA). These
 * tests lock in the whole chain:
 *
 *   prompt declares the flat field
 *     → the worker canonicalizes every sublot spelling onto `sub_lot_code`
 *       → recordsFromPage carries it out of a flat page into its record
 *         → computeRecordLotKey / extractSubLotCode build lot+sublot lot_key.
 */

import { describe, it, expect } from 'vitest';
// @ts-expect-error — plain CJS module, no types.
import { mergeCoaRecords, recordsFromPage } from '../../bin/lib/coaRecords.js';
import processWorkerSource from '../../bin/process-worker?raw';
import { computeRecordLotKey } from '../../functions/lib/kinds/coa';
import { extractSubLotCode, extractLotNumber } from '../../functions/lib/entities/matching';

describe('D1 prompt — the flat COA schema has a sub_lot_code slot', () => {
  it('declares sub_lot_code among the canonical flat field names', () => {
    // Without this line a page with one lot and one sublot has no legal place
    // to report the sublot.
    expect(processWorkerSource).toContain(
      '- sub_lot_code — the sub-lot code that QUALIFIES lot_number'
    );
  });

  it('requires the sublot even when the page has a single lot and a single sublot', () => {
    // The exact carve-out that used to license dropping it.
    expect(processWorkerSource).toMatch(
      /INCLUDING when the page has only ONE lot and ONE sublot/
    );
  });

  it('resolves the omit-records contradiction by routing the sublot to the flat field', () => {
    // The omit licence survives (it keeps single-lot COAs on the flat review
    // path), but it now names where the sublot goes instead of leaving it
    // homeless.
    expect(processWorkerSource).toContain(
      'In THAT case you MUST still report the sublot in the FLAT "sub_lot_code" field'
    );
    expect(processWorkerSource).toContain('A printed sublot code is NEVER optional');
  });

  it('keeps the per-sublot records rule intact (multi-sublot pages still split)', () => {
    // Guard against the fix accidentally licensing flat collapse of a
    // multi-sublot matrix, which is the failure the records path exists for.
    expect(processWorkerSource).toContain(
      'If there are MULTIPLE sublots — even all under the same lot number — you MUST emit one record per sublot'
    );
  });

  it('canonicalizes every sublot spelling onto sub_lot_code', () => {
    expect(processWorkerSource).toMatch(
      /sub_lot_code:\s*\['sub_lot_number', 'sub_lot_no', 'sub_lot', 'sublot', 'sublot_code', 'sublot_number', 'sub_lot_num'\]/
    );
  });
});

describe('D1 assembly — a flat single-sublot page keeps its sublot', () => {
  it('recordsFromPage carries flat sub_lot_code into the synthesized record', () => {
    const recs = recordsFromPage(
      {
        fields: {
          supplier_name: 'Darigold, Inc.',
          product_name: 'DG HH Qt UP',
          lot_number: '22026110',
          sub_lot_code: '02',
        },
        tables: [],
        products: [],
      },
      [1]
    );
    expect(recs).toHaveLength(1);
    expect(recs[0].fields.sub_lot_code).toBe('02');
    expect(recs[0].fields.lot_number).toBe('22026110');
  });

  it('mergeCoaRecords reports key_basis lot+sublot for flat single-sublot pages', () => {
    // Two flat pages, each one lot + one sublot — the shape that used to
    // degrade to key_basis 'lot'.
    const payload = mergeCoaRecords(
      [
        { fields: { lot_number: '22026105', sub_lot_code: '12', product_name: 'DG CC Sm Curd' }, tables: [] },
        { fields: { lot_number: '10426034', sub_lot_code: '05', product_name: 'DG CC Sm Curd' }, tables: [] },
      ],
      [[3], [4]]
    );
    expect(payload.record_key_basis).toBe('lot+sublot');
    expect(payload.records.map((r: { fields: Record<string, string> }) => r.fields.sub_lot_code))
      .toEqual(['12', '05']);
  });
});

describe('D1 downstream — lot_key becomes lot+sublot on the flat path', () => {
  it('computeRecordLotKey combines a flat lot_number + sub_lot_code', () => {
    expect(computeRecordLotKey({ lot_number: '22026110', sub_lot_code: '02' })).toEqual({
      lotNumber: '22026110',
      subLotCode: '02',
      lotKey: '2202611002',
    });
  });

  it('accepts the record-schema spelling and the flat spelling identically', () => {
    const fromRecords = computeRecordLotKey({ lot_code: '10326080', sub_lot_code: '24' });
    const fromFlat = computeRecordLotKey({ lot_number: '10326080', sub_lot_code: '24' });
    expect(fromFlat).toEqual(fromRecords);
    expect(fromFlat?.lotKey).toBe('1032608024');
  });

  it('accepts sub_lot_number / sublot spellings a reviewer edit may carry', () => {
    // Record fields are RAW model output — they never pass through the
    // worker's canonicalizeFields — so every spelling must resolve here too.
    expect(computeRecordLotKey({ lot_number: 'L1', sub_lot_number: '07' })?.lotKey).toBe('L107');
    expect(computeRecordLotKey({ lot_number: 'L1', sublot: '07' })?.lotKey).toBe('L107');
  });

  it('is unchanged (bare main lot) when no sublot is printed', () => {
    expect(computeRecordLotKey({ lot_number: '10426110' })).toEqual({
      lotNumber: '10426110',
      subLotCode: '',
      lotKey: '10426110',
    });
  });

  it('extractSubLotCode pulls the sublot the flat approve path passes to findOrCreateLot', () => {
    // produceCoa reads approvedFields then primary_metadata with these
    // helpers; before D1 it read only the lot and the sublot was dropped at
    // storage time even when the model had extracted it.
    const approved = { lot_number: '22026110', sub_lot_code: '02', product_name: 'DG HH Qt UP' };
    expect(extractLotNumber(approved)).toBe('22026110');
    expect(extractSubLotCode(approved)).toBe('02');
  });

  it('extractSubLotCode returns null (main-lot-only) when absent or blank', () => {
    expect(extractSubLotCode({ lot_number: 'L1' })).toBeNull();
    expect(extractSubLotCode({ lot_number: 'L1', sub_lot_code: '   ' })).toBeNull();
    expect(extractSubLotCode(null)).toBeNull();
  });
});

describe('D1 flat producers thread the sublot into attachLotToCoaDocument', () => {
  it('produceCoa passes subLotCode alongside lotNumber', async () => {
    const src = await import('../../functions/lib/kinds/coa?raw').then(m => m.default as string);
    // Both flat producers must forward it; produceCoaRecords already did.
    expect(src).toContain(
      'extractSubLotCode(approvedFields) ?? extractSubLotCode(primaryMetadata)'
    );
    expect(src).toContain('const subLotCode = extractSubLotCode(mergedFields);');
    // Three attach sites (produceCoa, produceMultiProductCoa, produceCoaRecords)
    // and every one of them now carries a sublot.
    expect(src.match(/subLotCode/g)?.length).toBeGreaterThanOrEqual(6);
  });
});
