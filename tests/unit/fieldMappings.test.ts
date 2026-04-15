/**
 * Unit tests for the shared open-ended field-mapping module.
 *
 * Covers:
 *  - Default config shape + enabled flags
 *  - Legacy shape detection (empty, v1 AI toggles, v1 CSV manual map)
 *  - v2 pass-through + partial upgrade
 *  - Validation (order_number required, snake_case keys, no collisions)
 *  - Prompt fragment composition (buildAiFieldsSection, buildJsonShapeForPrompt)
 */

import { describe, it, expect } from 'vitest';
import {
  defaultFieldMappings,
  normalizeFieldMappings,
  validateFieldMappings,
  buildAiFieldsSection,
  buildJsonShapeForPrompt,
  CORE_FIELD_DEFINITIONS,
  CORE_FIELD_KEYS,
} from '../../shared/fieldMappings';

describe('defaultFieldMappings', () => {
  it('returns a v2 shape with every core field enabled', () => {
    const m = defaultFieldMappings();
    expect(m.version).toBe(2);
    for (const def of CORE_FIELD_DEFINITIONS) {
      expect(m.core[def.key].enabled).toBe(true);
      expect(m.core[def.key].source_labels.length).toBeGreaterThan(0);
    }
    expect(m.extended).toEqual([]);
  });

  it('populates format_hint for every core field from the catalog', () => {
    const m = defaultFieldMappings();
    for (const def of CORE_FIELD_DEFINITIONS) {
      expect(m.core[def.key].format_hint).toBe(def.default_format_hint);
    }
  });
});

describe('normalizeFieldMappings', () => {
  it('returns defaults for null / undefined / empty object', () => {
    expect(normalizeFieldMappings(null).version).toBe(2);
    expect(normalizeFieldMappings(undefined).version).toBe(2);
    expect(normalizeFieldMappings({}).version).toBe(2);
  });

  it('parses a JSON string through to v2', () => {
    const m = normalizeFieldMappings(JSON.stringify({}));
    expect(m.version).toBe(2);
  });

  it('detects legacy v1 AI-toggle shape (boolean values)', () => {
    const raw = { order_number: true, customer_number: true };
    const m = normalizeFieldMappings(raw);
    expect(m.core.order_number.enabled).toBe(true);
    expect(m.core.customer_number.enabled).toBe(true);
    expect(m.core.po_number.enabled).toBe(false);
    expect(m.core.product_name.enabled).toBe(false);
  });

  it('detects legacy v1 AI-toggle shape (self-referential string values)', () => {
    const raw = { order_number: 'order_number', customer_name: 'customer_name' };
    const m = normalizeFieldMappings(raw);
    expect(m.core.order_number.enabled).toBe(true);
    expect(m.core.customer_name.enabled).toBe(true);
    expect(m.core.lot_number.enabled).toBe(false);
  });

  it('detects legacy v1 CSV manual-map shape (source_col -> target)', () => {
    const raw = { 'Order Ref': 'order_number', 'Cust ID': 'customer_number' };
    const m = normalizeFieldMappings(raw);
    expect(m.core.order_number.enabled).toBe(true);
    expect(m.core.customer_number.enabled).toBe(true);
    expect(m.core.order_number.source_labels).toContain('Order Ref');
    expect(m.core.customer_number.source_labels).toContain('Cust ID');
    // Fields not in the legacy map are disabled.
    expect(m.core.po_number.enabled).toBe(false);
  });

  it('upgrades a partial v2 shape by filling in missing core keys', () => {
    const raw = {
      version: 2,
      core: {
        order_number: { enabled: true, source_labels: ['OrderNo'] },
      },
      extended: [],
    };
    const m = normalizeFieldMappings(raw);
    expect(m.core.order_number.source_labels).toEqual(['OrderNo']);
    // Missing keys come through at default.
    for (const key of CORE_FIELD_KEYS) {
      if (key === 'order_number') continue;
      expect(m.core[key]).toBeDefined();
    }
  });

  it('preserves extended[] entries from a v2 shape and fills in missing labels', () => {
    const raw = {
      version: 2,
      core: defaultFieldMappings().core,
      extended: [
        { key: 'ship_date', source_labels: ['Ship Date'] },
        { key: 'route', label: 'Route Code', source_labels: [] },
      ],
    };
    const m = normalizeFieldMappings(raw);
    expect(m.extended).toHaveLength(2);
    expect(m.extended[0].key).toBe('ship_date');
    // Missing label falls back to key.
    expect(m.extended[0].label).toBe('ship_date');
    expect(m.extended[1].label).toBe('Route Code');
  });

  it('drops extended entries with invalid keys during normalization', () => {
    const raw = {
      version: 2,
      core: defaultFieldMappings().core,
      extended: [
        { key: '', source_labels: [] },
        { key: 'valid_field', source_labels: ['A'] },
      ],
    };
    const m = normalizeFieldMappings(raw);
    expect(m.extended).toHaveLength(1);
    expect(m.extended[0].key).toBe('valid_field');
  });
});

describe('validateFieldMappings', () => {
  it('accepts the default config', () => {
    const result = validateFieldMappings(defaultFieldMappings());
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('rejects a config where order_number is disabled', () => {
    const m = defaultFieldMappings();
    m.core.order_number.enabled = false;
    const result = validateFieldMappings(m);
    expect(result.ok).toBe(false);
    expect(result.errors.some(e => /order_number must be enabled/.test(e))).toBe(true);
  });

  it('rejects an extended key that is not snake_case', () => {
    const m = defaultFieldMappings();
    m.extended = [{ key: 'ShipDate', label: 'Ship Date', source_labels: [] }];
    const result = validateFieldMappings(m);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatch(/snake_case/);
  });

  it('rejects duplicate extended keys', () => {
    const m = defaultFieldMappings();
    m.extended = [
      { key: 'ship_date', label: 'Ship Date', source_labels: [] },
      { key: 'ship_date', label: 'Dup', source_labels: [] },
    ];
    const result = validateFieldMappings(m);
    expect(result.ok).toBe(false);
    expect(result.errors.some(e => /duplicated/.test(e))).toBe(true);
  });

  it('rejects an extended key that collides with a core field', () => {
    const m = defaultFieldMappings();
    m.extended = [{ key: 'order_number', label: 'Dup', source_labels: [] }];
    const result = validateFieldMappings(m);
    expect(result.ok).toBe(false);
    expect(result.errors.some(e => /collides with a core field/.test(e))).toBe(true);
  });
});

describe('buildAiFieldsSection', () => {
  it('lists every enabled core field with aliases + format hint', () => {
    const m = defaultFieldMappings();
    const section = buildAiFieldsSection(m);
    expect(section).toMatch(/Fields to extract:/);
    // Every enabled core key appears on a line.
    for (const key of CORE_FIELD_KEYS) {
      expect(section).toContain(`- ${key}`);
    }
    // Required marker on order_number.
    expect(section).toMatch(/order_number \[REQUIRED\]/);
  });

  it('omits disabled core fields from the output', () => {
    const m = defaultFieldMappings();
    m.core.product_code.enabled = false;
    m.core.lot_number.enabled = false;
    const section = buildAiFieldsSection(m);
    expect(section).not.toContain('- product_code');
    expect(section).not.toContain('- lot_number');
    expect(section).toContain('- order_number');
  });

  it('renders extended fields in their own block', () => {
    const m = defaultFieldMappings();
    m.extended = [
      { key: 'ship_date', label: 'Ship Date', source_labels: ['Ship Date'], format_hint: 'YYYY-MM-DD' },
      { key: 'route', label: 'Route', source_labels: ['Route Code'] },
    ];
    const section = buildAiFieldsSection(m);
    expect(section).toMatch(/Extended fields/);
    expect(section).toContain('ship_date');
    expect(section).toContain('YYYY-MM-DD');
    expect(section).toContain('route');
  });
});

describe('buildJsonShapeForPrompt', () => {
  it('emits a JSON shape with every enabled core field key', () => {
    const m = defaultFieldMappings();
    const shape = buildJsonShapeForPrompt(m);
    for (const key of CORE_FIELD_KEYS) {
      expect(shape).toContain(`"${key}"`);
    }
    // customers block still present.
    expect(shape).toContain('"customers"');
    expect(shape).toContain('"contacts"');
  });

  it('nests extended fields under extended_metadata', () => {
    const m = defaultFieldMappings();
    m.extended = [
      { key: 'ship_date', label: 'Ship Date', source_labels: [] },
      { key: 'route_code', label: 'Route', source_labels: [] },
    ];
    const shape = buildJsonShapeForPrompt(m);
    expect(shape).toContain('"extended_metadata"');
    expect(shape).toContain('"ship_date"');
    expect(shape).toContain('"route_code"');
  });
});
