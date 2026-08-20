/**
 * The Michael Foods COA regression (2026-08-20).
 *
 * The document prints BOTH "Lot#: 6203G" and "Batch Number: 2586083". The
 * extractor filed the batch as a sublot and the record then identified itself
 * by the batch, because the review tile resolved the lot through ONE spelling
 * (`lot_code`) while the record carried it as `lot_number`.
 */
import { describe, it, expect } from 'vitest';
import {
  COA_RECORD_LOT_KEYS,
  COA_RECORD_SUBLOT_KEYS,
  firstRecordField,
} from '../../shared/types';

describe('COA record identity resolution', () => {
  it('finds the lot when the record stored it as lot_number', () => {
    const fields = { lot_number: '6203G', sub_lot_code: '2586083' };
    expect(firstRecordField(fields, COA_RECORD_LOT_KEYS)).toBe('6203G');
  });

  it('prefers lot_code when both spellings are present', () => {
    expect(firstRecordField({ lot_code: 'A', lot_number: 'B' }, COA_RECORD_LOT_KEYS)).toBe('A');
  });

  it('resolves every sublot spelling the model emits', () => {
    for (const key of COA_RECORD_SUBLOT_KEYS) {
      expect(firstRecordField({ [key]: '07' }, COA_RECORD_SUBLOT_KEYS)).toBe('07');
    }
  });

  it('returns null rather than a blank chip', () => {
    expect(firstRecordField({ lot_number: '   ' }, COA_RECORD_LOT_KEYS)).toBeNull();
    expect(firstRecordField(undefined, COA_RECORD_LOT_KEYS)).toBeNull();
  });
});
