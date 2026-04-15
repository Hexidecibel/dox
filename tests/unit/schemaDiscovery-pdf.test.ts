/**
 * Unit tests for discoverFromPDF — uses the real COA PDF fixture and a Qwen
 * mock that returns a schema-shaped response.
 *
 * The mock claims requests whose user message contains "Summary Order Status"
 * and returns a canned detected_fields array so the discovery function's
 * normalization path gets fully exercised.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  discoverFromPDF,
  getSchemaDiscoveryPrompt,
} from '../../functions/lib/connectors/schemaDiscovery';
import { loadCoaOrdersPdf } from '../helpers/fixtures-binary';
import {
  installQwenMock,
  uninstallQwenMock,
  getQwenCallLog,
} from '../helpers/qwen-mock';

const CANNED_DISCOVERY_RESPONSE = {
  detected_fields: [
    {
      name: 'Order #',
      inferred_type: 'id',
      sample_values: ['1784767', '1783966', '1784964'],
      inferred_aliases: ['Order No', 'order_number', 'Sales Order'],
      candidate_target: 'order_number',
      confidence: 0.95,
    },
    {
      name: 'Customer #',
      inferred_type: 'id',
      sample_values: ['K00166', 'K14534', 'P2264'],
      inferred_aliases: ['Cust #', 'K#'],
      candidate_target: 'customer_number',
      confidence: 0.93,
    },
    {
      name: 'Customer',
      inferred_type: 'string',
      sample_values: ['CHUCKANUT BAY FOODS', 'MERITAGE SOUPS'],
      inferred_aliases: ['Customer Name'],
      candidate_target: 'customer_name',
      confidence: 0.88,
    },
    {
      name: 'Ship Date',
      inferred_type: 'date',
      sample_values: ['4/10/2026', '4/11/2026'],
      inferred_aliases: [],
      candidate_target: null,
      confidence: 0.7,
    },
  ],
  layout_hint: 'tabular',
  warnings: [],
};

describe('discoverFromPDF', () => {
  beforeEach(() => {
    // Route any PDF-body fetch to the canned schema-discovery response.
    // The mock JSON-stringifies whatever the handler returns and puts it
    // under choices[0].message.content, so we can return a schema payload
    // (with detected_fields/layout_hint/warnings) alongside the required
    // orders/customers keys the ParsedAIResponse type asks for.
    installQwenMock(((bodyText: string) => {
      if (/Summary Order Status/i.test(bodyText) || /Source kind: pdf/i.test(bodyText)) {
        return {
          orders: [],
          customers: [],
          ...CANNED_DISCOVERY_RESPONSE,
        };
      }
      return undefined;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any);
  });

  afterEach(() => {
    uninstallQwenMock();
  });

  it('extracts text and returns detected_fields from the Qwen response', async () => {
    const buffer = loadCoaOrdersPdf();
    const result = await discoverFromPDF(buffer, {
      url: 'https://qwen.test',
      secret: 'test-secret',
    });

    expect(result.detected_fields.length).toBeGreaterThan(0);
    const byName = Object.fromEntries(result.detected_fields.map((f) => [f.name, f]));
    expect(byName['Order #']?.candidate_target).toBe('order_number');
    expect(byName['Customer #']?.candidate_target).toBe('customer_number');
    expect(byName['Ship Date']?.candidate_target).toBeUndefined();

    // Layout hint passed through.
    expect(result.layout_hint).toBe('tabular');

    // Qwen was actually called.
    const log = getQwenCallLog();
    expect(log.length).toBeGreaterThanOrEqual(1);
    // System prompt was the schema-discovery one.
    expect(log[0].systemMessage).toContain('data schema analyzer');
  });

  it('returns a warning when Qwen is not configured', async () => {
    const buffer = loadCoaOrdersPdf();
    const result = await discoverFromPDF(buffer, { url: undefined });
    expect(result.detected_fields).toEqual([]);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('returns a scanned-PDF warning when text is too short', async () => {
    // Synthesize a PDF that yields <50 chars from unpdf. Easiest way is to
    // feed an almost-empty buffer and let unpdf fail or return nothing —
    // either way the function should return the "no extractable text" path.
    const bogus = new TextEncoder().encode('%PDF-1.4\n%%EOF').buffer;
    const result = await discoverFromPDF(bogus, {
      url: 'https://qwen.test',
      secret: 'test-secret',
    });
    expect(result.detected_fields).toEqual([]);
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});

describe('getSchemaDiscoveryPrompt', () => {
  it('includes the /no_think directive and JSON shape instructions', () => {
    const prompt = getSchemaDiscoveryPrompt();
    expect(prompt).toContain('/no_think');
    expect(prompt).toContain('detected_fields');
    expect(prompt).toContain('candidate_target');
    expect(prompt).toContain('block_per_customer');
  });
});
