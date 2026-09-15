/**
 * bin/lib/productIdentifierSeed.js — the plan half of bin/seed-product-identifiers.
 *
 *   - 310348 is left out unless asked for, and then only unconfirmed + former.
 *   - 08012 is never asserted to be 0801 (open question to AJ).
 *   - The anchor is the product WMS order lines already use for the SKU; a new
 *     product only when there is none.
 *   - A re-run writes nothing new, and an ambiguous supplier is skipped, not guessed.
 *   - value_norm comes from the compiled shared vocabulary the API uses.
 */
import { describe, it, expect } from 'vitest';
// @ts-expect-error — plain CJS module, no types.
import mod from '../../bin/lib/productIdentifierSeed.js';
// @ts-expect-error — generated CJS bundle, no types.
import compiledVocabulary from '../../bin/lib/shared/productVocabulary.js';
import { normalizeCode, normalizeName } from '../../shared/productVocabulary';

const { buildSeedPlan, planToSql, IDENTITIES } = mod;

let n = 0;
const opts = (includePending = false) => ({ includePending, normalizeCode, normalizeName, newId: () => `id${++n}` });
const input = (over: Record<string, unknown> = {}) => ({
  tenantId: 't1',
  suppliers: [{ id: 'dg', name: 'Darigold, Inc.' }, { id: 'cmf', name: 'Country Morning Farms' }],
  products: [{ id: 'pWhip', name: 'WHIP 5 GL BAG  (1/CS), M', slug: 'whip-5-gl-bag-1-cs-m' }],
  orderProducts: [{ product_code: '0801', product_id: 'pWhip' }],
  existing: [],
  ...over,
});

describe('seed plan', () => {
  it('leaves 310348 out by default, and seeds it only as an unconfirmed former item when asked', () => {
    const plan = buildSeedPlan(input(), opts());
    expect(plan.inserts.some((r: any) => r.value === '310348')).toBe(false);
    expect(plan.pendingLeftOut.map((p: any) => p.value)).toEqual(['310348']);
    const withPending = buildSeedPlan(input(), opts(true));
    expect(withPending.inserts.find((r: any) => r.value === '310348')).toMatchObject({ confirmed: 0, superseded: 1, supplier_id: 'dg' });
  });

  it('never records 08012, and every row names its evidence', () => {
    for (const identity of IDENTITIES) {
      for (const i of identity.identifiers) {
        expect(i.value).not.toBe('08012');
        expect(i.note).toBeTruthy();
      }
    }
  });

  it('anchors 0801 on the product the WMS order lines use, and creates the rest', () => {
    const plan = buildSeedPlan(input(), opts());
    expect(plan.inserts.filter((r: any) => r.value === '0801').map((r: any) => r.product_id)).toEqual(['pWhip']);
    expect(plan.createProducts.map((p: any) => p.name).sort()).toEqual(
      ['40% CREAM 300GL', 'DG BTR BULK U/S 55.115#', 'MS WHOLE 5 GL BAG', 'Whole Milk 300 Gallon Tote'].sort(),
    );
  });

  it('a re-run with the rows present writes nothing', () => {
    const first = buildSeedPlan(input(), opts());
    const existing = first.inserts.map((r: any) => ({ product_id: r.product_id, kind: r.kind, supplier_id: r.supplier_id, value_norm: r.value_norm }));
    const products = [...input().products, ...first.createProducts];
    const again = buildSeedPlan(input({ existing, products }), opts());
    expect(again.inserts).toEqual([]);
    expect(again.createProducts).toEqual([]);
    expect(planToSql(again, '2026-09-15T00:00:00Z')).toEqual([]);
  });

  it('skips an identity whose supplier is ambiguous', () => {
    const plan = buildSeedPlan(input({ suppliers: [{ id: 'dg', name: 'Darigold, Inc.' }, { id: 'dg2', name: 'Darigold Farms' }] }), opts());
    expect(plan.skipped.find((s: any) => s.key.startsWith('darigold'))?.reason).toMatch(/several suppliers match/);
  });

  it('normalizes with the same compiled vocabulary the API uses', () => {
    for (const v of ['0801', 'Cream - Heavy Whipping 40%', '300 Gallon Tote']) {
      expect(compiledVocabulary.normalizeCode(v)).toBe(normalizeCode(v));
      expect(compiledVocabulary.normalizeName(v)).toBe(normalizeName(v));
    }
  });
});
