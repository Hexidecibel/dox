/**
 * Unit tests for schemaDiscovery — CSV discovery + autoSuggest heuristics +
 * buildFieldMappingsFromDetection.
 */

import { describe, it, expect } from 'vitest';
import {
  discoverFromCSV,
  autoSuggestTarget,
  buildFieldMappingsFromDetection,
  scoreSuggestion,
} from '../../functions/lib/connectors/schemaDiscovery';

describe('discoverFromCSV', () => {
  it('detects header names and sample rows from a well-formed CSV', () => {
    const csv = `Order #,Cust #,Customer Name,Ship Date,Qty
SO-1001,K00123,Acme Corp,2026-04-15,10
SO-1002,K00124,Beta Inc,2026-04-16,5
SO-1003,K00123,Acme Corp,2026-04-17,20`;
    const result = discoverFromCSV(csv);
    expect(result.detected_fields).toHaveLength(5);
    expect(result.detected_fields.map(f => f.name)).toEqual([
      'Order #', 'Cust #', 'Customer Name', 'Ship Date', 'Qty',
    ]);
    expect(result.sample_rows).toHaveLength(3);
    expect(result.warnings).toHaveLength(0);
    expect(result.layout_hint).toContain('5 columns');
  });

  it('infers column types from sample values', () => {
    const csv = `order_number,customer_number,quantity,email,ship_date
SO-1,K00123,10,alice@acme.test,2026-04-15
SO-2,K00124,20,bob@beta.test,2026-04-16`;
    const result = discoverFromCSV(csv);
    const byName = Object.fromEntries(result.detected_fields.map(f => [f.name, f]));
    expect(byName.order_number.inferred_type).toBe('id');
    expect(byName.customer_number.inferred_type).toBe('id');
    expect(byName.quantity.inferred_type).toBe('number');
    expect(byName.email.inferred_type).toBe('email');
    expect(byName.ship_date.inferred_type).toBe('date');
  });

  it('populates candidate_target + confidence via autoSuggest', () => {
    const csv = `Order No,Customer ID,Customer Name,PO #,Qty
SO-1,K00123,Acme,PO-500,5
SO-2,K00124,Beta,PO-600,10`;
    const result = discoverFromCSV(csv);
    const byName = Object.fromEntries(result.detected_fields.map(f => [f.name, f]));
    expect(byName['Order No'].candidate_target).toBe('order_number');
    expect(byName['Customer ID'].candidate_target).toBe('customer_number');
    expect(byName['Customer Name'].candidate_target).toBe('customer_name');
    expect(byName['PO #'].candidate_target).toBe('po_number');
    expect(byName.Qty.candidate_target).toBe('quantity');
    for (const f of result.detected_fields) {
      expect(f.confidence).toBeGreaterThan(0);
    }
  });

  it('flags duplicate headers with a warning', () => {
    const csv = `order_number,customer,customer
SO-1,K00123,Acme`;
    const result = discoverFromCSV(csv);
    expect(result.warnings.some(w => /Duplicate header/.test(w))).toBe(true);
  });

  it('handles an empty CSV gracefully', () => {
    const result = discoverFromCSV('');
    expect(result.detected_fields).toEqual([]);
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});

describe('autoSuggestTarget', () => {
  it('maps common order-number headers with high confidence', () => {
    const s = autoSuggestTarget('Order #', ['SO-123', 'SO-124']);
    expect(s.target).toBe('order_number');
    expect(s.confidence).toBeGreaterThanOrEqual(0.85);
  });

  it('maps Order No -> order_number', () => {
    const s = autoSuggestTarget('Order No', ['1784767']);
    expect(s.target).toBe('order_number');
    expect(s.confidence).toBeGreaterThanOrEqual(0.85);
  });

  it('maps SO# -> order_number (tight abbreviation)', () => {
    const s = autoSuggestTarget('SO#', ['SO-123']);
    expect(s.target).toBe('order_number');
    expect(s.confidence).toBeGreaterThanOrEqual(0.85);
  });

  it('maps Sales Order -> order_number', () => {
    const s = autoSuggestTarget('Sales Order', ['SO-5']);
    expect(s.target).toBe('order_number');
    expect(s.confidence).toBeGreaterThanOrEqual(0.85);
  });

  it('maps Invoice # -> order_number', () => {
    const s = autoSuggestTarget('Invoice #', ['INV-1']);
    expect(s.target).toBe('order_number');
  });

  it('maps Cust # -> customer_number', () => {
    const s = autoSuggestTarget('Cust #', ['K00123']);
    expect(s.target).toBe('customer_number');
    expect(s.confidence).toBeGreaterThanOrEqual(0.85);
  });

  it('maps Customer No -> customer_number', () => {
    const s = autoSuggestTarget('Customer No', ['K00123']);
    expect(s.target).toBe('customer_number');
    expect(s.confidence).toBeGreaterThanOrEqual(0.85);
  });

  it('maps Account # -> customer_number', () => {
    const s = autoSuggestTarget('Account #', ['ACCT-1']);
    expect(s.target).toBe('customer_number');
  });

  it('maps Customer Name -> customer_name', () => {
    const s = autoSuggestTarget('Customer Name', ['Acme Corp']);
    expect(s.target).toBe('customer_name');
    expect(s.confidence).toBeGreaterThanOrEqual(0.85);
  });

  it('maps PO -> po_number', () => {
    const s = autoSuggestTarget('PO', ['PO-100']);
    expect(s.target).toBe('po_number');
    expect(s.confidence).toBeGreaterThanOrEqual(0.85);
  });

  it('maps P.O. # -> po_number', () => {
    const s = autoSuggestTarget('P.O. #', ['PO-1']);
    expect(s.target).toBe('po_number');
    expect(s.confidence).toBeGreaterThanOrEqual(0.85);
  });

  it('maps Purchase Order -> po_number', () => {
    const s = autoSuggestTarget('Purchase Order', ['PO-1']);
    expect(s.target).toBe('po_number');
    expect(s.confidence).toBeGreaterThanOrEqual(0.85);
  });

  it('maps SKU -> product_code', () => {
    const s = autoSuggestTarget('SKU', ['SKU-A']);
    expect(s.target).toBe('product_code');
  });

  it('maps Item # -> product_code', () => {
    const s = autoSuggestTarget('Item #', ['12345']);
    expect(s.target).toBe('product_code');
  });

  it('maps Item Description -> product_name', () => {
    const s = autoSuggestTarget('Item Description', ['Organic apples, case of 12']);
    expect(s.target).toBe('product_name');
    expect(s.confidence).toBeGreaterThanOrEqual(0.75);
  });

  it('maps Qty -> quantity', () => {
    const s = autoSuggestTarget('Qty', ['10', '20', '5']);
    expect(s.target).toBe('quantity');
    expect(s.confidence).toBeGreaterThanOrEqual(0.85);
  });

  it('maps Cases -> quantity', () => {
    const s = autoSuggestTarget('Cases', ['12', '6']);
    expect(s.target).toBe('quantity');
  });

  it('maps Lot # -> lot_number', () => {
    const s = autoSuggestTarget('Lot #', ['LOT-42']);
    expect(s.target).toBe('lot_number');
  });

  it('maps Lot Code -> lot_number', () => {
    const s = autoSuggestTarget('Lot Code', ['L240101A']);
    expect(s.target).toBe('lot_number');
    expect(s.confidence).toBeGreaterThanOrEqual(0.85);
  });

  it('maps Batch # -> lot_number', () => {
    const s = autoSuggestTarget('Batch #', ['B-42']);
    expect(s.target).toBe('lot_number');
  });

  it('returns __none__ for unrecognized headers', () => {
    const s = autoSuggestTarget('MysteryColumn', ['foo', 'bar']);
    expect(s.target).toBe('__none__');
    expect(s.confidence).toBe(0);
  });

  it('returns __none__ for random gibberish', () => {
    const s = autoSuggestTarget('xyzqwopa', ['one', 'two']);
    expect(s.target).toBe('__none__');
    expect(s.confidence).toBe(0);
  });

  it('returns __none__ for bare ambiguous "Number"', () => {
    const s = autoSuggestTarget('Number', ['123']);
    expect(s.target).toBe('__none__');
    expect(s.confidence).toBe(0);
  });

  it('returns __none__ for bare ambiguous "No"', () => {
    const s = autoSuggestTarget('No', ['1']);
    expect(s.target).toBe('__none__');
    expect(s.confidence).toBe(0);
  });

  it('falls back to sample-pattern match when label is opaque', () => {
    const s = autoSuggestTarget('ColA', ['K00123', 'K00456', 'P001122']);
    expect(s.target).toBe('customer_number');
    expect(s.confidence).toBeCloseTo(0.55, 2);
  });
});

describe('scoreSuggestion', () => {
  it('boosts quantity target when samples are numeric', () => {
    const score = scoreSuggestion('Qty', ['10', '20'], 'quantity', 0.9);
    expect(score).toBeGreaterThan(0.9);
  });

  it('penalizes quantity target when samples are strings', () => {
    const score = scoreSuggestion('Qty', ['abc', 'def'], 'quantity', 0.9);
    expect(score).toBeLessThan(0.9);
  });
});

describe('buildFieldMappingsFromDetection', () => {
  it('slots detected headers into matching core fields and leftovers into extended', () => {
    const csv = `Order #,Cust #,Customer Name,Ship Date,Route Code
SO-1,K00123,Acme,2026-04-15,R705
SO-2,K00124,Beta,2026-04-16,R505`;
    const detection = discoverFromCSV(csv);
    const mapping = buildFieldMappingsFromDetection(detection);

    expect(mapping.core.order_number.enabled).toBe(true);
    expect(mapping.core.order_number.source_labels).toContain('Order #');
    expect(mapping.core.customer_number.source_labels).toContain('Cust #');
    expect(mapping.core.customer_name.source_labels).toContain('Customer Name');

    // Unmapped columns become extended entries.
    const extKeys = mapping.extended.map(e => e.key);
    expect(extKeys).toContain('ship_date');
    expect(extKeys).toContain('route_code');

    // Each extended entry carries the original source label for round-trip.
    const shipDate = mapping.extended.find(e => e.key === 'ship_date');
    expect(shipDate?.source_labels).toEqual(['Ship Date']);
  });

  it('never emits a config with order_number disabled', () => {
    // Build a detection that has NO order-like column at all.
    const csv = `Ship Date,Route
2026-04-15,R1
2026-04-16,R2`;
    const detection = discoverFromCSV(csv);
    const mapping = buildFieldMappingsFromDetection(detection);
    expect(mapping.core.order_number.enabled).toBe(true);
  });
});
