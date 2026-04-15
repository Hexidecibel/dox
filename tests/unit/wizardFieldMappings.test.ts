/**
 * Unit tests for the file-first wizard's schema-review action helpers.
 *
 * These helpers live in `src/components/connectors/fieldMappingActions.ts`
 * and are pure — they take a v2 ConnectorFieldMappings plus a DetectedField
 * and return a new mapping. We test them directly here rather than through
 * the React component because the Workers-pool vitest runner can't render
 * JSX.
 *
 * Coverage:
 *  - removeSourceFromMappings: strips a source label from every core + extended slot
 *  - applyTargetToMappings: core mapping, extended mapping, __ignore__, __extended__ with custom key
 *  - currentTargetFor: maps a source back to its current target
 *  - acceptAllHighConfidenceSuggestions: only picks up >=0.7 confidence matches
 */

import { describe, it, expect } from 'vitest';
import {
  acceptAllHighConfidenceSuggestions,
  applyTargetToMappings,
  currentTargetFor,
  removeSourceFromMappings,
} from '../../src/components/connectors/fieldMappingActions';
import { defaultFieldMappings, TARGET_EXTENDED, TARGET_IGNORE } from '../../src/components/connectors/doxFields';
import type { DetectedField } from '../../src/types/connectorSchema';

function field(name: string, overrides: Partial<DetectedField> = {}): DetectedField {
  return {
    name,
    inferred_type: 'string',
    sample_values: ['sample-1'],
    inferred_aliases: [name],
    ...overrides,
  };
}

describe('removeSourceFromMappings', () => {
  it('strips the source from every core.source_labels list', () => {
    const initial = defaultFieldMappings();
    initial.core.order_number.source_labels = ['Order #', 'SO'];
    initial.core.customer_number.source_labels = ['Order #', 'Cust #'];

    const result = removeSourceFromMappings(initial, 'Order #');

    expect(result.core.order_number.source_labels).toEqual(['SO']);
    expect(result.core.customer_number.source_labels).toEqual(['Cust #']);
  });

  it('drops extended entries that lose their last source label', () => {
    const initial = defaultFieldMappings();
    initial.extended = [
      { key: 'ship_date', label: 'Ship Date', source_labels: ['Ship Date'] },
      { key: 'carrier', label: 'Carrier', source_labels: ['Carrier', 'Shipper'] },
    ];

    const result = removeSourceFromMappings(initial, 'Ship Date');

    expect(result.extended.map((e) => e.key)).toEqual(['carrier']);
    expect(result.extended[0].source_labels).toEqual(['Carrier', 'Shipper']);
  });

  it('does not mutate the input mapping', () => {
    const initial = defaultFieldMappings();
    initial.core.order_number.source_labels = ['Order #'];
    const copy = structuredClone(initial);

    removeSourceFromMappings(initial, 'Order #');

    expect(initial).toEqual(copy);
  });
});

describe('applyTargetToMappings', () => {
  it('maps a source column onto a core field and enables it', () => {
    const m = defaultFieldMappings();
    m.core.order_number.enabled = false;
    m.core.order_number.source_labels = [];

    const result = applyTargetToMappings(m, field('Order #'), 'order_number');

    expect(result.core.order_number.enabled).toBe(true);
    expect(result.core.order_number.source_labels).toEqual(['Order #']);
  });

  it('re-homes a source to a new core field, stripping its old slot', () => {
    const m = defaultFieldMappings();
    m.core.customer_name.source_labels = ['Name'];
    m.core.customer_number.source_labels = [];

    const result = applyTargetToMappings(m, field('Name'), 'customer_number');

    expect(result.core.customer_name.source_labels).toEqual([]);
    expect(result.core.customer_number.source_labels).toEqual(['Name']);
  });

  it('creates an extended entry with a snake_case key from the source name', () => {
    const m = defaultFieldMappings();
    const result = applyTargetToMappings(
      m,
      field('Ship Date', { sample_values: ['2026-04-13'] }),
      TARGET_EXTENDED,
    );

    expect(result.extended).toHaveLength(1);
    expect(result.extended[0]).toMatchObject({
      key: 'ship_date',
      label: 'Ship Date',
      source_labels: ['Ship Date'],
    });
    expect(result.extended[0].format_hint).toBe('e.g. 2026-04-13');
  });

  it('honors a custom extended key provided by the caller', () => {
    const m = defaultFieldMappings();
    const result = applyTargetToMappings(
      m,
      field('Arr. Date'),
      TARGET_EXTENDED,
      { extendedKey: 'arrival_date' },
    );

    expect(result.extended).toHaveLength(1);
    expect(result.extended[0].key).toBe('arrival_date');
  });

  it('rejects an extended key that would collide with a core key', () => {
    const m = defaultFieldMappings();
    const result = applyTargetToMappings(
      m,
      field('Order #'),
      TARGET_EXTENDED,
      { extendedKey: 'order_number' },
    );

    expect(result.extended).toHaveLength(0);
  });

  it('removes the source from everything when target is __ignore__', () => {
    const m = defaultFieldMappings();
    m.core.po_number.source_labels = ['PO'];

    const result = applyTargetToMappings(m, field('PO'), TARGET_IGNORE);

    expect(result.core.po_number.source_labels).toEqual([]);
  });
});

describe('currentTargetFor', () => {
  it('finds the core key that currently owns the source', () => {
    const m = defaultFieldMappings();
    m.core.order_number.source_labels = ['Order #'];

    expect(currentTargetFor(m, 'Order #')).toEqual({ target: 'order_number' });
  });

  it('returns the extended target when source lives in extended[]', () => {
    const m = defaultFieldMappings();
    m.extended = [{ key: 'ship_date', label: 'Ship Date', source_labels: ['Ship Date'] }];

    expect(currentTargetFor(m, 'Ship Date')).toEqual({
      target: TARGET_EXTENDED,
      extendedKey: 'ship_date',
    });
  });

  it('returns __ignore__ when the source is unmapped', () => {
    const m = defaultFieldMappings();
    // Reset all core fields so nothing inherits a default alias by accident.
    for (const key of Object.keys(m.core) as Array<keyof typeof m.core>) {
      m.core[key].source_labels = [];
    }

    expect(currentTargetFor(m, 'Untracked Column')).toEqual({ target: TARGET_IGNORE });
  });
});

describe('acceptAllHighConfidenceSuggestions', () => {
  it('only applies suggestions at or above the default threshold', () => {
    const m = defaultFieldMappings();
    // Strip default aliases so we observe only what the suggestions bring in.
    for (const key of Object.keys(m.core) as Array<keyof typeof m.core>) {
      m.core[key].source_labels = [];
      m.core[key].enabled = false;
    }

    const detected: DetectedField[] = [
      field('Order #', { candidate_target: 'order_number', confidence: 0.95 }),
      field('Customer', { candidate_target: 'customer_name', confidence: 0.6 }), // below threshold
      field('PO', { candidate_target: 'po_number', confidence: 0.9 }),
    ];

    const result = acceptAllHighConfidenceSuggestions(m, detected);

    expect(result.core.order_number.source_labels).toEqual(['Order #']);
    expect(result.core.customer_name.source_labels).toEqual([]);
    expect(result.core.po_number.source_labels).toEqual(['PO']);
  });

  it('skips detected fields with no candidate_target', () => {
    const m = defaultFieldMappings();
    for (const key of Object.keys(m.core) as Array<keyof typeof m.core>) {
      m.core[key].source_labels = [];
      m.core[key].enabled = false;
    }

    const detected: DetectedField[] = [
      field('Mystery Col', { confidence: 0.95 }), // no candidate_target
      field('Order #', { candidate_target: 'order_number', confidence: 0.9 }),
    ];

    const result = acceptAllHighConfidenceSuggestions(m, detected);

    expect(result.core.order_number.source_labels).toEqual(['Order #']);
  });

  it('respects a custom threshold override', () => {
    const m = defaultFieldMappings();
    for (const key of Object.keys(m.core) as Array<keyof typeof m.core>) {
      m.core[key].source_labels = [];
      m.core[key].enabled = false;
    }

    const detected: DetectedField[] = [
      field('Customer', { candidate_target: 'customer_name', confidence: 0.55 }),
    ];

    const withDefault = acceptAllHighConfidenceSuggestions(m, detected);
    const withLowered = acceptAllHighConfidenceSuggestions(m, detected, 0.5);

    expect(withDefault.core.customer_name.source_labels).toEqual([]);
    expect(withLowered.core.customer_name.source_labels).toEqual(['Customer']);
  });
});
