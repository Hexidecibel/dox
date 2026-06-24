/**
 * Unit tests for the per-supplier lot_scheme helpers (migration 0075):
 *   - applyLotScheme: date_code strips to MMDDYY + forces sub=''; lims_combined
 *     and auto/plain keep the historical concat; non-conforming date_code keys
 *     fall through unchanged.
 *   - detectLotScheme: suggests date_code for a CMF-shaped sample, auto otherwise.
 *   - normalizeProductNameKey: durable uppercase/collapse key for the map.
 *
 * Pure functions — no DB.
 */

import { describe, it, expect } from 'vitest';
import {
  applyLotScheme,
  detectLotScheme,
  normalizeProductNameKey,
} from '../../functions/lib/entities/lots';

describe('applyLotScheme', () => {
  it('date_code strips a CMF lot to its bare MMDDYY date and drops the sublot', () => {
    expect(applyLotScheme('date_code', '061626WHO', '')).toEqual({
      lotKey: '061626',
      subLotCode: '',
    });
    expect(applyLotScheme('date_code', '052226HAH', '')).toEqual({
      lotKey: '052226',
      subLotCode: '',
    });
    expect(applyLotScheme('date_code', '052926LC3', '')).toEqual({
      lotKey: '052926',
      subLotCode: '',
    });
  });

  it('date_code forces sub_lot_code to "" even when one was extracted', () => {
    expect(applyLotScheme('date_code', '061626WHO', '05')).toEqual({
      lotKey: '061626',
      subLotCode: '',
    });
  });

  it('date_code keeps a bare-date key unchanged (idempotent)', () => {
    expect(applyLotScheme('date_code', '061626', '')).toEqual({
      lotKey: '061626',
      subLotCode: '',
    });
  });

  it('date_code falls through a non-conforming key (no leading 6 digits)', () => {
    expect(applyLotScheme('date_code', 'ABC123', '')).toEqual({
      lotKey: 'ABC123',
      subLotCode: '',
    });
    expect(applyLotScheme('date_code', '12345', '')).toEqual({
      lotKey: '12345',
      subLotCode: '',
    });
  });

  it('lims_combined concatenates base + sublot (Darigold "10426110" + "05")', () => {
    expect(applyLotScheme('lims_combined', '10426110', '05')).toEqual({
      lotKey: '1042611005',
      subLotCode: '05',
    });
  });

  it('auto / plain / undefined keep the historical identity-plus-sublot concat', () => {
    for (const scheme of ['auto', 'plain', undefined, null] as const) {
      expect(applyLotScheme(scheme, '10426110', '05')).toEqual({
        lotKey: '1042611005',
        subLotCode: '05',
      });
      expect(applyLotScheme(scheme, '061926LC3', '')).toEqual({
        lotKey: '061926LC3',
        subLotCode: '',
      });
    }
  });
});

describe('detectLotScheme', () => {
  it('suggests date_code for a CMF-shaped sample', () => {
    expect(detectLotScheme(['061626WHO', '052226HAH', '052926LC3'])).toBe('date_code');
  });

  it('suggests date_code with punctuated raw inputs (normalized first)', () => {
    expect(detectLotScheme(['Lot# 061626 WHO', '052226-HAH'])).toBe('date_code');
  });

  it('falls back to auto when the sample is not date-code-like', () => {
    expect(detectLotScheme(['10426110', '1042611005', 'ABC123'])).toBe('auto');
  });

  it('falls back to auto for an empty / all-blank sample', () => {
    expect(detectLotScheme([])).toBe('auto');
    expect(detectLotScheme(['', '   ', null as unknown as string])).toBe('auto');
  });

  it('needs a clear majority — a single date-code among many is not enough', () => {
    expect(detectLotScheme(['061626WHO', '12345', 'ABCDEF', 'XYZ'])).toBe('auto');
  });
});

describe('normalizeProductNameKey', () => {
  it('uppercases, trims, and collapses non-alphanumerics to single spaces', () => {
    expect(normalizeProductNameKey('Cream - Heavy Whipping 40%')).toBe(
      'CREAM HEAVY WHIPPING 40'
    );
    expect(normalizeProductNameKey('  Milk - Whole  ')).toBe('MILK WHOLE');
    expect(normalizeProductNameKey('Half-and-Half')).toBe('HALF AND HALF');
  });

  it('is stable across punctuation/spacing drift (durable map key)', () => {
    expect(normalizeProductNameKey('Milk—Whole')).toBe(
      normalizeProductNameKey('Milk - Whole')
    );
    expect(normalizeProductNameKey('Milk  Whole')).toBe(
      normalizeProductNameKey('Milk Whole')
    );
  });

  it('returns "" for nullish/blank input', () => {
    expect(normalizeProductNameKey(null)).toBe('');
    expect(normalizeProductNameKey(undefined)).toBe('');
    expect(normalizeProductNameKey('   ')).toBe('');
    expect(normalizeProductNameKey('%%%')).toBe('');
  });
});
