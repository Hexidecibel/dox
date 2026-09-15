/**
 * supplier_product_map (0075) is retired by migration 0113: product identity
 * lives in ONE store, product_identifiers. The table stays in the schema for one
 * release (a later migration drops it once prod is verified), so nothing stops
 * code from quietly reading it again — except this.
 *
 * Also pins the removal of GET/PUT /api/product-map: its replacement is
 * GET /api/suppliers/:id/product-identifiers plus the Product page's identifier
 * endpoints (one API, two views).
 */
import { describe, it, expect } from 'vitest';

const SOURCES = import.meta.glob(
  ['../../functions/**/*.ts', '../../shared/**/*.ts', '../../src/**/*.{ts,tsx}', '../../workers/**/*.ts'],
  { query: '?raw', import: 'default', eager: true },
) as Record<string, string>;

describe('supplier_product_map is not read or written', () => {
  it('the source scan actually sees the code', () => {
    expect(Object.keys(SOURCES).some((k) => k.endsWith('functions/lib/entities/matching.ts'))).toBe(true);
    expect(Object.keys(SOURCES).length).toBeGreaterThan(100);
  });

  it('no SQL touches the table', () => {
    const offenders = Object.entries(SOURCES)
      .filter(([, text]) => /\b(FROM|INTO|UPDATE|JOIN)\s+supplier_product_map\b/i.test(text))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });

  it('the /api/product-map endpoint and its client are gone', () => {
    expect(Object.keys(SOURCES).some((k) => k.endsWith('functions/api/product-map.ts'))).toBe(false);
    const clients = Object.entries(SOURCES)
      .filter(([, text]) => /['"`]\/product-map[?'"`]/.test(text))
      .map(([path]) => path);
    expect(clients).toEqual([]);
  });
});
