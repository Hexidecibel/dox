/**
 * Unit tests for parseCoaRecords — the pure, never-throw shape-validator that
 * turns a `processing_queue.ai_records` value into a CoaRecordsPayload for the
 * COA review UI (P2 of coa-multi-record.md). Anything that isn't a well-formed
 * COA records payload (order/shipment payload, garbage, null) must return null.
 */

import { describe, it, expect } from 'vitest';
import { parseCoaRecords } from '../../shared/types';
import type { CoaRecordsPayload } from '../../shared/types';

const validPayload: CoaRecordsPayload = {
  record_cardinality: 'multi_lot',
  record_key_basis: 'lot+sublot',
  page_metadata: { supplier_name: 'Darigold', coa_number: 'C-100' },
  records: [
    {
      record_index: 0,
      fields: { lot_code: 'L1', sub_lot_code: 'A', butterfat: '82.1' },
      source_pages: [6],
      _confidence: 0.91,
    },
    {
      record_index: 1,
      fields: { lot_code: 'L1', sub_lot_code: 'B', butterfat: '82.4' },
      source_pages: [6],
      _confidence: 0.88,
    },
  ],
};

describe('parseCoaRecords', () => {
  it('parses a valid COA records JSON string', () => {
    const out = parseCoaRecords(JSON.stringify(validPayload));
    expect(out).not.toBeNull();
    expect(out?.record_cardinality).toBe('multi_lot');
    expect(out?.record_key_basis).toBe('lot+sublot');
    expect(out?.records).toHaveLength(2);
    expect(out?.records[1].fields.sub_lot_code).toBe('B');
    expect(out?.page_metadata.supplier_name).toBe('Darigold');
  });

  it('accepts an already-parsed object (not just a string)', () => {
    const out = parseCoaRecords(JSON.stringify(validPayload));
    // Round-trip the object form too.
    const out2 = parseCoaRecords(validPayload as unknown as string);
    expect(out2).not.toBeNull();
    expect(out2?.records).toHaveLength(2);
    expect(out).toEqual(out2);
  });

  it('parses a single-record COA payload', () => {
    const single: CoaRecordsPayload = {
      record_cardinality: 'single',
      record_key_basis: 'lot',
      page_metadata: { supplier_name: 'Acme' },
      records: [{ record_index: 0, fields: { lot_code: 'X' } }],
    };
    const out = parseCoaRecords(JSON.stringify(single));
    expect(out?.record_cardinality).toBe('single');
    expect(out?.records).toHaveLength(1);
  });

  it('defaults a missing/invalid record_key_basis to "lot"', () => {
    const out = parseCoaRecords(
      JSON.stringify({ record_cardinality: 'single', records: [] })
    );
    expect(out).not.toBeNull();
    expect(out?.record_key_basis).toBe('lot');
    expect(out?.page_metadata).toEqual({});
  });

  it('returns null for null / undefined / empty string', () => {
    expect(parseCoaRecords(null)).toBeNull();
    expect(parseCoaRecords(undefined)).toBeNull();
    expect(parseCoaRecords('')).toBeNull();
    expect(parseCoaRecords('   ')).toBeNull();
  });

  it('returns null for non-JSON garbage', () => {
    expect(parseCoaRecords('not json {')).toBeNull();
    expect(parseCoaRecords('<html>')).toBeNull();
  });

  it('returns null for a JSON array (not an object)', () => {
    expect(parseCoaRecords('[]')).toBeNull();
    expect(parseCoaRecords('[{"record_cardinality":"single","records":[]}]')).toBeNull();
  });

  it('returns null for an order payload (no record_cardinality)', () => {
    const order = { customers: [{ name: 'A' }], orders: [{ order_number: '1' }] };
    expect(parseCoaRecords(JSON.stringify(order))).toBeNull();
  });

  it('returns null for a shipment payload (no record_cardinality)', () => {
    const shipment = { shipments: [{ tracking: 'T1' }] };
    expect(parseCoaRecords(JSON.stringify(shipment))).toBeNull();
  });

  it('returns null when record_cardinality is an unknown value', () => {
    expect(
      parseCoaRecords(JSON.stringify({ record_cardinality: 'bogus', records: [] }))
    ).toBeNull();
  });

  it('returns null when records is missing or not an array', () => {
    expect(
      parseCoaRecords(JSON.stringify({ record_cardinality: 'single' }))
    ).toBeNull();
    expect(
      parseCoaRecords(JSON.stringify({ record_cardinality: 'single', records: 'nope' }))
    ).toBeNull();
  });
});
