/**
 * Unit tests for mergeCoaRecords — the deterministic PAGE-FIRST assembly that
 * turns per-PAGE COA extractions into a single CoaRecordsPayload (first-class
 * multi-product / multi-lot / multi-page COAs, P1; see coa-multi-record.md).
 *
 * Domain fact: a multi-page COA PDF is N independent single-page COAs bundled
 * by a PO/EDI order number. Each page = exactly ONE product. The worker runs
 * one LLM call per PAGE, and this module CONCATENATES the pages' records with
 * NO cross-page merge (two pages with a coincidentally equal lot are still two
 * records). Only fields byte-identical across ALL records of the whole doc
 * hoist into page_metadata.
 *
 * mergeCoaRecords lives in bin/lib/coaRecords.js (CommonJS, so the plain-Node
 * bin/process-worker can require it without a TS build step) and is unit-tested
 * directly here — mirroring how bin/lib/classifyCommit.js is tested.
 */

import { describe, it, expect } from 'vitest';
// @ts-expect-error — plain CJS module, no types.
import { mergeCoaRecords } from '../../bin/lib/coaRecords.js';

type Rec = { record_index: number; fields: Record<string, string>; source_pages: number[]; flags?: string[]; _confidence?: number };

describe('mergeCoaRecords (page-first)', () => {
  it('single-page single-product → 1 record, cardinality single', () => {
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

  it('single-page multi-sublot → 3 records, key lot+sublot, multi_lot, sublots distinct', () => {
    const records = [1, 2, 3].map((n) => ({
      fields: {
        lot_code: 'L100',
        sub_lot_code: 'S' + n,
        product_name: 'Cheddar',
        manufacturing_facility: 'Plant 42',
        butterfat: (30 + n).toString(),
      },
    }));
    const payload = mergeCoaRecords([{ records, confidenceNum: 0.8 }], [[6]]);

    expect(payload.records).toHaveLength(3);
    expect(payload.record_key_basis).toBe('lot+sublot');
    expect(payload.record_cardinality).toBe('multi_lot');
    // One product across all 3 → product/facility/lot identical → hoisted.
    expect(payload.page_metadata.product_name).toBe('Cheddar');
    expect(payload.page_metadata.manufacturing_facility).toBe('Plant 42');
    expect(payload.page_metadata.lot_code).toBe('L100');
    // The 3 sublots are DISTINCT records (no intra-page merge beyond model output).
    const subs = (payload.records as Rec[]).map((r) => r.fields.sub_lot_code).sort();
    expect(subs).toEqual(['S1', 'S2', 'S3']);
    expect(payload.records[0].fields.butterfat).toBe('31');
    expect(payload.records[0].fields.product_name).toBeUndefined();
    // All back the same single page.
    expect((payload.records as Rec[]).every((r) => JSON.stringify(r.source_pages) === '[6]')).toBe(true);
    // Reindexed 1..N.
    expect((payload.records as Rec[]).map((r) => r.record_index)).toEqual([1, 2, 3]);
  });

  it('multi-page bundle: 7 pages (page 7 has 3 sublots) → 9 records, products NOT collapsed', () => {
    // 6 single-lot single-product pages + 1 page with 3 sublots of a 7th product.
    const products = [
      { code: '810001', name: 'Butter A', lot: 'LA' },
      { code: '810002', name: 'Butter B', lot: 'LB' },
      { code: '810003', name: 'Butter C', lot: 'LC' },
      { code: '810004', name: 'Butter D', lot: 'LD' },
      { code: '810005', name: 'Butter E', lot: 'LE' },
      { code: '810006', name: 'Butter F', lot: 'LF' },
    ];
    const supplier = 'Darigold Inc.';
    const order = 'EDI178057';

    const chunks: any[] = [];
    const ranges: number[][] = [];

    products.forEach((p, i) => {
      chunks.push({
        records: [
          {
            fields: {
              supplier_name: supplier,
              order_number: order,
              product_code: p.code,
              product_name: p.name,
              lot_code: p.lot,
            },
          },
        ],
        confidenceNum: 0.9,
      });
      ranges.push([i + 1]);
    });

    // Page 7: one product, 3 sublots.
    chunks.push({
      records: [1, 2, 3].map((n) => ({
        fields: {
          supplier_name: supplier,
          order_number: order,
          product_code: '810007',
          product_name: 'Butter G',
          lot_code: 'LG',
          sub_lot_code: 'G' + n,
        },
      })),
      confidenceNum: 0.85,
    });
    ranges.push([7]);

    const payload = mergeCoaRecords(chunks, ranges);

    // 6 + 3 = 9 records total.
    expect(payload.records).toHaveLength(9);
    // All 7 products present — NOT collapsed to one (the v1 bug).
    const codes = new Set(
      (payload.records as Rec[]).map((r) => r.fields.product_code).filter(Boolean)
    );
    expect(codes).toEqual(new Set(['810001', '810002', '810003', '810004', '810005', '810006', '810007']));
    expect(payload.record_cardinality).toBe('multi_product');
    // Supplier + order are doc-wide constant → hoisted.
    expect(payload.page_metadata.supplier_name).toBe(supplier);
    expect(payload.page_metadata.order_number).toBe(order);
    // Product + lot vary per page → NOT hoisted.
    expect(payload.page_metadata.product_code).toBeUndefined();
    expect(payload.page_metadata.product_name).toBeUndefined();
    expect(payload.page_metadata.lot_code).toBeUndefined();
    // Each record tagged with its own page; reindexed 1..9.
    const pages = (payload.records as Rec[]).map((r) => r.source_pages[0]);
    expect(pages).toEqual([1, 2, 3, 4, 5, 6, 7, 7, 7]);
    expect((payload.records as Rec[]).map((r) => r.record_index)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('no cross-page merge: two pages, SAME lot_code, different products → stay 2 records', () => {
    const payload = mergeCoaRecords(
      [
        { records: [{ fields: { lot_code: 'L9', product_name: 'Brie', product_code: 'P1' } }], confidenceNum: 0.9 },
        { records: [{ fields: { lot_code: 'L9', product_name: 'Gouda', product_code: 'P2' } }], confidenceNum: 0.7 },
      ],
      [[1], [2]]
    );
    // Same lot but different products on different pages → NOT merged.
    expect(payload.records).toHaveLength(2);
    expect(payload.record_cardinality).toBe('multi_product');
    expect(payload.records[0].source_pages).toEqual([1]);
    expect(payload.records[1].source_pages).toEqual([2]);
    expect(payload.records[0].fields.product_name).toBe('Brie');
    expect(payload.records[1].fields.product_name).toBe('Gouda');
    // lot_code is identical across both → it hoists (byte-identical doc-wide);
    // products differ so they stay per-record. Either way, two records.
    expect(payload.records[0].fields.product_code).toBe('P1');
    expect(payload.records[1].fields.product_code).toBe('P2');
  });

  it('distinct products on separate pages → multi_product, product not hoisted', () => {
    const payload = mergeCoaRecords(
      [
        { records: [{ fields: { lot_code: 'A', product_name: 'Brie' } }], confidenceNum: 0.7 },
        { records: [{ fields: { lot_code: 'B', product_name: 'Gouda' } }], confidenceNum: 0.7 },
      ],
      [[1], [2]]
    );
    expect(payload.records).toHaveLength(2);
    expect(payload.record_cardinality).toBe('multi_product');
    expect(payload.page_metadata.product_name).toBeUndefined();
    const names = (payload.records as Rec[]).map((r) => r.fields.product_name).sort();
    expect(names).toEqual(['Brie', 'Gouda']);
  });

  it('hoist: supplier identical across pages → page_metadata, lot stays per-record', () => {
    const payload = mergeCoaRecords(
      [
        { records: [{ fields: { lot_code: 'L1', manufacturer: 'ACME Dairy', product_name: 'A', butterfat: '80' } }], confidenceNum: 0.85 },
        { records: [{ fields: { lot_code: 'L2', manufacturer: 'ACME Dairy', product_name: 'B', butterfat: '81' } }], confidenceNum: 0.85 },
      ],
      [[1], [2]]
    );
    expect(payload.records).toHaveLength(2);
    expect(payload.page_metadata.manufacturer).toBe('ACME Dairy');
    expect(payload.records[0].fields.manufacturer).toBeUndefined();
    expect(payload.records[1].fields.manufacturer).toBeUndefined();
    // Per-page distinguishers stay per-record.
    expect(payload.records[0].fields.lot_code).toBe('L1');
    expect(payload.records[1].fields.lot_code).toBe('L2');
    expect(payload.records[0].fields.butterfat).toBe('80');
    expect(payload.records[1].fields.butterfat).toBe('81');
  });

  it('no explicit lot → record kept, flagged lot_not_explicitly_labeled', () => {
    const payload = mergeCoaRecords(
      [
        { records: [{ fields: { product_name: 'P1' } }], confidenceNum: 0.5 },
        { records: [{ fields: { product_name: 'P2' } }], confidenceNum: 0.5 },
        { records: [{ fields: { lot_code: 'L1', product_name: 'P3' } }], confidenceNum: 0.5 },
      ],
      [[1], [2], [3]]
    );
    // 3 distinct records — never merged across pages.
    expect(payload.records).toHaveLength(3);
    const flagged = (payload.records as Rec[]).filter((r) =>
      (r.flags || []).includes('lot_not_explicitly_labeled')
    );
    expect(flagged).toHaveLength(2);
  });

  it('per-page confidence: each record keeps its own page confidence', () => {
    const payload = mergeCoaRecords(
      [
        { records: [{ fields: { lot_code: 'L1', product_name: 'A' }, _confidence: 0.9 }], confidenceNum: 0.9 },
        { records: [{ fields: { lot_code: 'L2', product_name: 'B' }, _confidence: 0.6 }], confidenceNum: 0.6 },
      ],
      [[1], [2]]
    );
    expect(payload.records).toHaveLength(2);
    expect(payload.records[0]._confidence).toBe(0.9);
    expect(payload.records[1]._confidence).toBe(0.6);
  });

  it('flat page with no records[] → one synthesized record (page = one product)', () => {
    const payload = mergeCoaRecords(
      [
        {
          fields: { supplier_name: 'Savencia', coa_number: 'C-100', lot_number: 'L7' },
          products: ['Brie'],
          tables: [{ name: 'tests', headers: ['x'], rows: [['1']] }],
          confidenceNum: 0.7,
        },
      ],
      [[1]]
    );
    // A flat page is ONE product → exactly one record (not one-per-products[]).
    expect(payload.records).toHaveLength(1);
    expect(payload.record_cardinality).toBe('single');
    const flat = { ...payload.page_metadata, ...payload.records[0].fields };
    expect(flat.supplier_name).toBe('Savencia');
    expect(flat.product_name).toBe('Brie');
    expect(payload.records[0].tables).toHaveLength(1);
  });

  it('ONE page, tabular multi-product COA → one record per row, cardinality multi_product', () => {
    // The Savencia/Alouette shape: a single page whose table prints one row per
    // lot, with two different product CODES under one shared product NAME. The
    // shared name hoists into page_metadata; the codes stay per-record. This is
    // the multi-record-collapse case — it must NOT come back as one record, and
    // it must NOT be mislabelled multi_lot just because the name hoisted.
    const payload = mergeCoaRecords(
      [
        {
          records: [
            { fields: { product_code: '38292', product_name: 'Alouette Pro Cream Cheese', lot_code: '083126', expiration_date: '2026-08-31' } },
            { fields: { product_code: '38295', product_name: 'Alouette Pro Cream Cheese', lot_code: '110926', expiration_date: '2026-11-09' } },
            { fields: { product_code: '38295', product_name: 'Alouette Pro Cream Cheese', lot_code: '111126', expiration_date: '2026-11-11' } },
          ],
          page_metadata: { supplier_name: 'Savencia', po_number: 'K135095' },
          confidenceNum: 0.9,
        },
      ],
      [[1]]
    );

    expect(payload.records).toHaveLength(3);
    expect(payload.record_cardinality).toBe('multi_product');
    // Shared across all three rows → hoisted.
    expect(payload.page_metadata.product_name).toBe('Alouette Pro Cream Cheese');
    expect(payload.page_metadata.supplier_name).toBe('Savencia');
    // Varying → stay per-record, never comma-joined.
    expect((payload.records as Rec[]).map((r) => r.fields.product_code)).toEqual(['38292', '38295', '38295']);
    expect((payload.records as Rec[]).map((r) => r.fields.lot_code)).toEqual(['083126', '110926', '111126']);
    // All three came off the same page.
    expect((payload.records as Rec[]).map((r) => r.source_pages[0])).toEqual([1, 1, 1]);
  });

  it('one product, several lots on one page → multi_lot (not multi_product)', () => {
    const payload = mergeCoaRecords(
      [
        {
          records: [
            { fields: { product_code: '38292', product_name: 'Cream Cheese', lot_code: 'A1' } },
            { fields: { product_code: '38292', product_name: 'Cream Cheese', lot_code: 'A2' } },
          ],
          confidenceNum: 0.9,
        },
      ],
      [[1]]
    );
    expect(payload.records).toHaveLength(2);
    expect(payload.record_cardinality).toBe('multi_lot');
    expect(payload.page_metadata.product_code).toBe('38292');
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

  it('garbage/empty page contributes no records', () => {
    const payload = mergeCoaRecords(
      [
        { fields: {}, products: [], tables: [], confidenceNum: 0.1 },
        { records: [{ fields: { lot_code: 'L1', product_name: 'Real' } }], confidenceNum: 0.9 },
      ],
      [[1], [2]]
    );
    // Only the real page contributes.
    expect(payload.records).toHaveLength(1);
    expect(payload.records[0].source_pages).toEqual([2]);
  });
});
