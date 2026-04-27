/**
 * Unit tests for the Phase 3.5 field-ordering helpers used by the Review
 * Queue UI. Bands are derived from the worker's uncertainty payload; sort
 * is stable (band, then score desc, then key asc).
 */

import { describe, it, expect } from 'vitest';
import {
  bandFor,
  sortFieldsByUncertainty,
  partitionByBand,
} from '../../src/pages/reviewFieldOrder';

describe('bandFor', () => {
  it('returns low when uncertainty is undefined', () => {
    expect(bandFor(undefined)).toBe('low');
  });
  it('returns high at exactly 0.7', () => {
    expect(bandFor(0.7)).toBe('high');
  });
  it('returns medium at exactly 0.4', () => {
    expect(bandFor(0.4)).toBe('medium');
  });
  it('returns low below 0.4', () => {
    expect(bandFor(0.39)).toBe('low');
  });
  it('treats NaN as low', () => {
    expect(bandFor(NaN)).toBe('low');
  });
});

describe('sortFieldsByUncertainty', () => {
  it('orders by band first, then by score desc, then by key asc', () => {
    const sorted = sortFieldsByUncertainty(
      ['supplier_name', 'lot_number', 'product_code', 'expiration_date'],
      {
        supplier_name: 0.2,
        lot_number: 0.9,
        product_code: 0.5,
        expiration_date: 0.7,
      }
    );
    expect(sorted.map(e => e.key)).toEqual([
      'lot_number',
      'expiration_date',
      'product_code',
      'supplier_name',
    ]);
  });

  it('treats missing uncertainty as 0 (low band, last)', () => {
    const sorted = sortFieldsByUncertainty(
      ['a', 'b'],
      { a: 0.8 }
    );
    expect(sorted.map(e => e.key)).toEqual(['a', 'b']);
    expect(sorted[1].band).toBe('low');
  });

  it('alphabetically tie-breaks within same band and score', () => {
    const sorted = sortFieldsByUncertainty(
      ['z_field', 'a_field'],
      { z_field: 0.9, a_field: 0.9 }
    );
    expect(sorted.map(e => e.key)).toEqual(['a_field', 'z_field']);
  });
});

describe('partitionByBand', () => {
  it('splits into the three buckets', () => {
    const sorted = sortFieldsByUncertainty(
      ['hi', 'mid', 'lo'],
      { hi: 0.95, mid: 0.5, lo: 0.1 }
    );
    const parts = partitionByBand(sorted);
    expect(parts.high.map(e => e.key)).toEqual(['hi']);
    expect(parts.medium.map(e => e.key)).toEqual(['mid']);
    expect(parts.low.map(e => e.key)).toEqual(['lo']);
  });
});
