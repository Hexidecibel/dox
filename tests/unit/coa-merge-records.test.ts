/**
 * Unit tests for mergeCoaRecords — the deterministic cross-chunk assembly that
 * turns per-chunk COA extractions into a single CoaRecordsPayload (first-class
 * multi-product / multi-lot / multi-page COAs, P1; see coa-multi-record.md).
 *
 * mergeCoaRecords lives in bin/lib/coaRecords.js (CommonJS, so the plain-Node
 * bin/process-worker can require it without a TS build step) and is unit-tested
 * directly here — mirroring how bin/lib/classifyCommit.js is tested.
 */

import { describe, it, expect } from 'vitest';
// @ts-expect-error — plain CJS module, no types.
import { mergeCoaRecords } from '../../bin/lib/coaRecords.js';

describe('mergeCoaRecords', () => {
  it('single product → 1 record, cardinality single', () => {
    const payload = mergeCoaRecords(
      [
        {
          fields: { supplier_name: 'Darigold', lot_number: 'L1', product_name: 'Butter' },
          products: ['Butter'],
          tables: [],
          confidenceNum: 0.9,
        },
      ],
      [[1]]
    );
    expect(payload.record_cardinality).toBe('single');
    expect(payload.records).toHaveLength(1);
    // With one record, everything reconstructs from page_metadata ∪ fields.
    const flat = { ...payload.page_metadata, ...payload.records[0].fields };
    expect(flat.supplier_name).toBe('Darigold');
    expect(flat.lot_number).toBe('L1');
    expect(payload.records[0].source_pages).toEqual([1]);
  });

  it('4 sublots same page → 4 records, key lot+sublot, product hoisted, multi_lot', () => {
    const records = [1, 2, 3, 4].map((n) => ({
      fields: {
        lot_code: 'L100',
        sub_lot_code: 'S' + n,
        product_name: 'Cheddar',
        manufacturing_facility: 'Plant 42',
        butterfat: (30 + n).toString(),
      },
    }));
    const payload = mergeCoaRecords([{ records, confidenceNum: 0.8 }], [[6]]);

    expect(payload.records).toHaveLength(4);
    expect(payload.record_key_basis).toBe('lot+sublot');
    expect(payload.record_cardinality).toBe('multi_lot');
    // Product + facility + lot identical across all 4 → hoisted into page_metadata.
    expect(payload.page_metadata.product_name).toBe('Cheddar');
    expect(payload.page_metadata.manufacturing_facility).toBe('Plant 42');
    expect(payload.page_metadata.lot_code).toBe('L100');
    // Per-record distinguishers stay on the record.
    expect(payload.records[0].fields.sub_lot_code).toBe('S1');
    expect(payload.records[0].fields.butterfat).toBe('31');
    expect(payload.records[0].fields.product_name).toBeUndefined();
    // All back this single page.
    expect(payload.records[3].source_pages).toEqual([6]);
    // Reindexed 1..N.
    expect(payload.records.map((r: { record_index: number }) => r.record_index)).toEqual([1, 2, 3, 4]);
  });

  it('distinct products → multi_product', () => {
    const payload = mergeCoaRecords(
      [
        {
          records: [
            { fields: { lot_code: 'A', product_name: 'Brie' } },
            { fields: { lot_code: 'B', product_name: 'Gouda' } },
          ],
          confidenceNum: 0.7,
        },
      ],
      [[1]]
    );
    expect(payload.records).toHaveLength(2);
    expect(payload.record_cardinality).toBe('multi_product');
    // product_name varies → NOT hoisted.
    expect(payload.page_metadata.product_name).toBeUndefined();
    expect(payload.records[0].fields.product_name).toBe('Brie');
    expect(payload.records[1].fields.product_name).toBe('Gouda');
  });

  it('same lot key split across 2 chunks → 1 merged record, unioned source_pages + tables', () => {
    const payload = mergeCoaRecords(
      [
        {
          records: [
            {
              fields: { lot_code: 'L9', product_name: 'X' },
              tables: [{ name: 't1', headers: ['a'], rows: [['1']] }],
            },
          ],
          confidenceNum: 0.9,
        },
        {
          records: [
            {
              fields: { lot_code: 'L9', expiration_date: '2026-01-01' },
              tables: [{ name: 't2', headers: ['b'], rows: [['2']] }],
            },
          ],
          confidenceNum: 0.6,
        },
      ],
      [[1], [2]]
    );
    expect(payload.records).toHaveLength(1);
    const rec = payload.records[0];
    expect(rec.source_pages).toEqual([1, 2]);
    expect(rec.tables).toHaveLength(2);
    // Min confidence across the two chunks.
    expect(rec._confidence).toBe(0.6);
    // The late expiration_date backfilled (reconstructs via page_metadata ∪ fields).
    const flat = { ...payload.page_metadata, ...rec.fields };
    expect(flat.expiration_date).toBe('2026-01-01');
    expect(flat.lot_code).toBe('L9');
  });

  it('hoist: manufacturer identical across records → page_metadata, not per-record', () => {
    const payload = mergeCoaRecords(
      [
        {
          records: [
            { fields: { lot_code: 'L1', manufacturer: 'ACME Dairy', butterfat: '80' } },
            { fields: { lot_code: 'L2', manufacturer: 'ACME Dairy', butterfat: '81' } },
          ],
          confidenceNum: 0.85,
        },
      ],
      [[1]]
    );
    expect(payload.records).toHaveLength(2);
    expect(payload.page_metadata.manufacturer).toBe('ACME Dairy');
    expect(payload.records[0].fields.manufacturer).toBeUndefined();
    expect(payload.records[1].fields.manufacturer).toBeUndefined();
    // The varying field stays per-record.
    expect(payload.records[0].fields.butterfat).toBe('80');
    expect(payload.records[1].fields.butterfat).toBe('81');
  });

  it('null lot key → records kept distinct and flagged', () => {
    const payload = mergeCoaRecords(
      [
        {
          records: [
            { fields: { product_name: 'P1' } },
            { fields: { product_name: 'P2' } },
            { fields: { lot_code: 'L1', product_name: 'P3' } },
          ],
          confidenceNum: 0.5,
        },
      ],
      [[1]]
    );
    // 3 distinct records — the two null-lot ones are NOT merged together.
    expect(payload.records).toHaveLength(3);
    expect(payload.record_key_basis).toBe('lot');
    const flagged = payload.records.filter((r: { flags?: string[] }) =>
      (r.flags || []).includes('lot_not_explicitly_labeled')
    );
    expect(flagged).toHaveLength(2);
  });

  it('flat chunk with multiple products → one record per product', () => {
    const payload = mergeCoaRecords(
      [
        {
          fields: { supplier_name: 'Savencia', coa_number: 'C-100' },
          products: ['Brie', 'Camembert'],
          tables: [{ name: 'tests', headers: ['x'], rows: [['1']] }],
          confidenceNum: 0.7,
        },
      ],
      [[1]]
    );
    expect(payload.records).toHaveLength(2);
    expect(payload.record_cardinality).toBe('multi_product');
    expect(payload.record_key_basis).toBe('product');
    // Shared cover fields hoisted.
    expect(payload.page_metadata.supplier_name).toBe('Savencia');
    expect(payload.page_metadata.coa_number).toBe('C-100');
    const names = payload.records.map((r: { fields: Record<string, string> }) => r.fields.product_name).sort();
    expect(names).toEqual(['Brie', 'Camembert']);
  });

  it('truncation fallback → single record flagged truncated_multipage', () => {
    const payload = mergeCoaRecords(
      [{ fields: { lot_number: 'L', supplier_name: 'Acme' }, products: [], confidenceNum: 0.3 }],
      [[]],
      { truncated: true }
    );
    expect(payload.records).toHaveLength(1);
    expect(payload.records[0].flags).toContain('truncated_multipage');
  });

  it('garbage/empty chunk contributes no records', () => {
    const payload = mergeCoaRecords(
      [
        { fields: {}, products: [], tables: [], confidenceNum: 0.1 },
        { fields: { lot_code: 'L1', product_name: 'Real' }, products: ['Real'], confidenceNum: 0.9 },
      ],
      [[1], [2]]
    );
    // Only the real chunk contributes.
    expect(payload.records).toHaveLength(1);
    expect(payload.records[0].source_pages).toEqual([2]);
  });
});
