/**
 * Unit tests for the ConnectorDetail page's pure reducer helpers.
 *
 * Mirrors wizardFieldMappings.test.ts for the wizard. These helpers power
 * the inline FieldMappingEditor on ConnectorDetail — they mutate a v2
 * ConnectorFieldMappings directly, without needing a DetectedField from a
 * sample file.
 */

import { describe, it, expect } from 'vitest';
import {
  appendBlankExtendedField,
  deleteExtendedField,
  normalizeSourceLabelList,
  updateCoreField,
  updateExtendedField,
} from '../../src/components/connectors/detailMappingActions';
import { defaultFieldMappings } from '../../src/components/connectors/doxFields';

describe('normalizeSourceLabelList', () => {
  it('trims and dedupes case-insensitively', () => {
    expect(normalizeSourceLabelList(['Order #', 'order #', ' order # ', 'SO', ''])).toEqual([
      'Order #',
      'SO',
    ]);
  });

  it('drops empty + whitespace-only entries', () => {
    expect(normalizeSourceLabelList(['', '   ', 'a'])).toEqual(['a']);
  });

  it('returns [] for an empty input', () => {
    expect(normalizeSourceLabelList([])).toEqual([]);
  });
});

describe('updateCoreField', () => {
  it('patches source_labels + normalizes them', () => {
    const m = defaultFieldMappings();
    const next = updateCoreField(m, 'customer_number', {
      source_labels: ['Cust #', 'cust #', 'Customer ID'],
    });
    expect(next.core.customer_number.source_labels).toEqual(['Cust #', 'Customer ID']);
    // Original untouched (pure).
    expect(m.core.customer_number.source_labels).not.toEqual(
      next.core.customer_number.source_labels,
    );
  });

  it('toggles enabled independently', () => {
    const m = defaultFieldMappings();
    const next = updateCoreField(m, 'po_number', { enabled: false });
    expect(next.core.po_number.enabled).toBe(false);
    expect(next.core.order_number.enabled).toBe(true);
  });

  it('updates format_hint', () => {
    const m = defaultFieldMappings();
    const next = updateCoreField(m, 'order_number', { format_hint: 'e.g. SO-0001' });
    expect(next.core.order_number.format_hint).toBe('e.g. SO-0001');
  });

  it('ignores unknown keys as no-ops (defensive)', () => {
    const m = defaultFieldMappings();
    // TS would normally block this; cast for the test.
    const next = updateCoreField(m, 'not_a_field' as never, { enabled: true });
    // Nothing should change.
    expect(next).toEqual(m);
  });
});

describe('updateExtendedField', () => {
  it('patches an existing extended entry by index', () => {
    const m = appendBlankExtendedField(defaultFieldMappings());
    const next = updateExtendedField(m, 0, {
      key: 'ship_date',
      label: 'Ship Date',
      source_labels: ['Ship Date', 'ship date'],
      format_hint: 'YYYY-MM-DD',
    });
    expect(next.extended[0].key).toBe('ship_date');
    expect(next.extended[0].label).toBe('Ship Date');
    expect(next.extended[0].source_labels).toEqual(['Ship Date']);
    expect(next.extended[0].format_hint).toBe('YYYY-MM-DD');
  });

  it('is a no-op for out-of-bound indexes', () => {
    const m = defaultFieldMappings();
    const next = updateExtendedField(m, 5, { label: 'Nope' });
    expect(next.extended).toEqual([]);
  });
});

describe('deleteExtendedField', () => {
  it('removes the entry at the given index', () => {
    let m = appendBlankExtendedField(defaultFieldMappings());
    m = appendBlankExtendedField(m);
    expect(m.extended.length).toBe(2);
    const next = deleteExtendedField(m, 0);
    expect(next.extended.length).toBe(1);
    // Original untouched (pure).
    expect(m.extended.length).toBe(2);
  });

  it('is a no-op for out-of-bound indexes', () => {
    const m = defaultFieldMappings();
    const next = deleteExtendedField(m, 0);
    expect(next.extended).toEqual([]);
  });
});

describe('appendBlankExtendedField', () => {
  it('uses the base key if free', () => {
    const next = appendBlankExtendedField(defaultFieldMappings());
    expect(next.extended[0].key).toBe('extra_field');
  });

  it('picks a unique suffix when the base is taken', () => {
    let m = appendBlankExtendedField(defaultFieldMappings());
    m = appendBlankExtendedField(m);
    m = appendBlankExtendedField(m);
    expect(m.extended.map((e) => e.key)).toEqual([
      'extra_field',
      'extra_field_2',
      'extra_field_3',
    ]);
  });

  it('avoids collisions with core field keys', () => {
    const next = appendBlankExtendedField(defaultFieldMappings(), 'order_number');
    // order_number is a core key, so should get suffixed.
    expect(next.extended[0].key).toBe('order_number_2');
  });
});
