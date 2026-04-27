/**
 * Unit tests for the Phase 3.5 per-field uncertainty heuristic and the
 * payload builder that layers dual-mode disagreement on top.
 */

import { describe, it, expect } from 'vitest';
import {
  computeFieldUncertainty,
  computeUncertaintyPayload,
} from '../../functions/lib/fieldUncertainty';

describe('computeFieldUncertainty', () => {
  it('returns 1.0 for null', () => {
    expect(computeFieldUncertainty('lot_number', null)).toBe(1.0);
  });

  it('returns 1.0 for empty / whitespace string', () => {
    expect(computeFieldUncertainty('lot_number', '')).toBe(1.0);
    expect(computeFieldUncertainty('lot_number', '   ')).toBe(1.0);
  });

  it('returns 0.7 when value contains a (?) marker', () => {
    expect(computeFieldUncertainty('lot_number', 'L-12 (?)')).toBe(0.7);
  });

  it('returns 0.7 when value is a bare ? marker', () => {
    expect(computeFieldUncertainty('lot_number', '?')).toBe(0.7);
  });

  it('returns 0.6 for lot fields shorter than 3 chars', () => {
    expect(computeFieldUncertainty('lot_number', 'L1')).toBe(0.6);
  });

  it('does not flag a long lot value', () => {
    expect(computeFieldUncertainty('lot_number', 'L-12345')).toBe(0.2);
  });

  it('returns 0.7 for date fields with non-date values', () => {
    expect(computeFieldUncertainty('expiration_date', 'next year')).toBe(0.7);
  });

  it('accepts ISO dates without flagging', () => {
    expect(computeFieldUncertainty('expiration_date', '2026-12-31')).toBe(0.2);
  });

  it('accepts US-format dates without flagging', () => {
    expect(computeFieldUncertainty('expiration_date', '12/31/2026')).toBe(0.2);
  });

  it('returns 0.7 for numeric-shaped fields with letters only', () => {
    expect(computeFieldUncertainty('po_number', 'ABCDEF')).toBe(0.7);
  });

  it('returns the default 0.2 for ordinary values', () => {
    expect(computeFieldUncertainty('supplier_name', 'ACME Corp')).toBe(0.2);
  });
});

describe('computeUncertaintyPayload', () => {
  it('returns empty object when both inputs are empty', () => {
    expect(computeUncertaintyPayload({}, {})).toEqual({});
  });

  it('forces >= 0.7 when text and VLM disagree on a non-empty value', () => {
    const u = computeUncertaintyPayload(
      { lot_number: 'L-1' },
      { lot_number: 'L-2' }
    );
    expect(u.lot_number).toBeGreaterThanOrEqual(0.7);
  });

  it('does not force when one side is empty (no disagreement)', () => {
    const u = computeUncertaintyPayload(
      { lot_number: 'L-12345' },
      {}
    );
    expect(u.lot_number).toBe(0.2);
  });

  it('uses the heuristic when both sides agree', () => {
    const u = computeUncertaintyPayload(
      { lot_number: 'L-12345' },
      { lot_number: 'L-12345' }
    );
    expect(u.lot_number).toBe(0.2);
  });

  it('flags missing fields as 1.0', () => {
    const u = computeUncertaintyPayload({ lot_number: '' }, {});
    expect(u.lot_number).toBe(1.0);
  });

  it('union of keys: VLM-only key is included', () => {
    const u = computeUncertaintyPayload(
      { lot_number: 'L-1' },
      { product_code: 'P-9' }
    );
    expect(Object.keys(u).sort()).toEqual(['lot_number', 'product_code']);
  });
});
