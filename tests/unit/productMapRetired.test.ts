/**
 * supplier_product_map (0075) was retired by migration 0113 -- product identity
 * lives in ONE store, product_identifiers -- and DROPPED by 0124 once prod
 * showed every map row accounted for (bin/verify-product-map-retired).
 *
 * Pins three things:
 *   - after the full chain the table (and its index) no longer exist;
 *   - no SQL in the app or in bin/ reads or writes it (a statement naming a
 *     dropped table fails at runtime, and a bin script is where one would hide:
 *     bin/seed-cmf-bridge and bin/reprocess-cmf-files both cleared it until 0124);
 *   - GET/PUT /api/product-map stays removed: its replacement is
 *     GET /api/suppliers/:id/product-identifiers plus the Product page's
 *     identifier endpoints (one API, two views).
 */
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import m0124 from '../../migrations/0124_drop_supplier_product_map.sql?raw';

const SOURCES = import.meta.glob(
  ['../../functions/**/*.ts', '../../shared/**/*.ts', '../../src/**/*.{ts,tsx}', '../../workers/**/*.ts'],
  { query: '?raw', import: 'default', eager: true },
) as Record<string, string>;

const BIN = import.meta.glob(['../../bin/*', '../../bin/lib/*.{js,mjs}'], {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const SQL_TOUCH = /\b(FROM|INTO|UPDATE|JOIN|TABLE)\s+supplier_product_map\b/i;

describe('supplier_product_map is gone', () => {
  it('the source scans actually see the code', () => {
    expect(Object.keys(SOURCES).some((k) => k.endsWith('functions/lib/entities/matching.ts'))).toBe(true);
    expect(Object.keys(SOURCES).length).toBeGreaterThan(100);
    expect(Object.keys(BIN).some((k) => k.endsWith('bin/seed-cmf-bridge'))).toBe(true);
  });

  it('the migrated database has no such table or index (0124)', async () => {
    const rows = await env.DB
      .prepare("SELECT name FROM sqlite_master WHERE name IN ('supplier_product_map', 'idx_supplier_product_map_lookup')")
      .all<{ name: string }>();
    expect(rows.results ?? []).toEqual([]);
    expect(m0124).toMatch(/DROP TABLE IF EXISTS supplier_product_map;/);
  });

  it('no SQL in functions/, shared/, src/ or workers/ touches the table', () => {
    const offenders = Object.entries(SOURCES)
      .filter(([, text]) => SQL_TOUCH.test(text))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });

  it('no bin/ script touches the table (except the pre-flight that checks it still exists)', () => {
    const offenders = Object.entries(BIN)
      .filter(([path]) => !path.endsWith('bin/verify-product-map-retired'))
      .filter(([, text]) => SQL_TOUCH.test(text))
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
