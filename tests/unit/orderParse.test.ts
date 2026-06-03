/**
 * Unit tests for the pure CSV field-mapping parser in shared/orderParse.ts.
 *
 * Connectors → Sources refactor: the synchronous connector engine
 * (functions/lib/connectors/{email,fileWatch}.ts) was deleted. The
 * deterministic CSV transforms it used to drive moved here, into a pure
 * shared module consumed by both the Cloudflare Worker doors and the Node
 * extraction worker (bin/process-worker).
 *
 * These assertions are PORTED from the old tests/unit/email-parser.test.ts and
 * tests/unit/fileWatch.test.ts CSV-branch coverage so the parse parity isn't
 * lost when those orchestrator-driven tests were removed. Unlike the old
 * engine, parseCSVAttachment requires an explicit v2 field_mappings config
 * (no implicit header auto-detect), so the tests build mappings via
 * normalizeFieldMappings / defaultFieldMappings.
 */

import { describe, it, expect } from 'vitest';
import {
  parseCSVAttachment,
  parseCSVText,
  normalizeLabel,
  labelMatches,
} from '../../shared/orderParse';
import {
  normalizeFieldMappings,
  defaultFieldMappings,
} from '../../shared/fieldMappings';

function csvBuffer(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer as ArrayBuffer;
}

/** v2 config claiming the headers our test CSVs use. */
function mappings() {
  return normalizeFieldMappings({
    version: 2,
    core: {
      order_number: { enabled: true, required: true, source_labels: ['Order #', 'order_number'] },
      customer_number: { enabled: true, source_labels: ['Cust #', 'customer_number'] },
      customer_name: { enabled: true, source_labels: ['Customer Name', 'customer_name'] },
      po_number: { enabled: true, source_labels: ['PO Number', 'po_number'] },
    },
    extended: [],
  });
}

describe('normalizeLabel / labelMatches', () => {
  it('collapses punctuation + whitespace for fuzzy header matching', () => {
    expect(normalizeLabel('Order #')).toBe('order');
    expect(normalizeLabel('Order No.')).toBe('orderno');
    expect(normalizeLabel('order_number')).toBe('ordernumber');
  });

  it('matches a header against any candidate alias', () => {
    expect(labelMatches('Order #', ['order_number', 'order #'])).toBe(true);
    expect(labelMatches('Customer Name', ['customer_name'])).toBe(true);
    expect(labelMatches('Unrelated', ['order_number'])).toBe(false);
  });
});

describe('parseCSVText', () => {
  it('auto-detects the tab delimiter for TSV content', () => {
    const { headers, rows } = parseCSVText('Order #\tCust #\nA-1\tK-1');
    expect(headers).toEqual(['Order #', 'Cust #']);
    expect(rows).toEqual([{ 'Order #': 'A-1', 'Cust #': 'K-1' }]);
  });

  it('returns empty for blank input', () => {
    expect(parseCSVText('')).toEqual({ headers: [], rows: [] });
  });
});

describe('parseCSVAttachment — field-mapped CSV', () => {
  it('maps headers onto orders + dedupes customers', () => {
    const csv = `Order #,Cust #,Customer Name,PO Number
SO-1,K-1,Acme Foods,PO-100
SO-2,K-1,Acme Foods,PO-101
SO-3,K-2,Beta Ice,PO-200`;
    const out = parseCSVAttachment({ fieldMappings: mappings() }, { content: csvBuffer(csv) });

    expect(out.errors).toEqual([]);
    expect(out.orders.map((o) => o.order_number)).toEqual(['SO-1', 'SO-2', 'SO-3']);
    expect(out.orders[0].customer_number).toBe('K-1');
    expect(out.orders[0].customer_name).toBe('Acme Foods');
    expect(out.orders[0].po_number).toBe('PO-100');

    // Two unique customers (K-1 dedup across SO-1/SO-2).
    expect(out.customers.map((c) => c.customer_number)).toEqual(['K-1', 'K-2']);
    expect(out.customers[0].name).toBe('Acme Foods');
  });

  it('routes a TSV attachment through the same parser (tab auto-detected)', () => {
    const tsv = `Order #\tCust #\tCustomer Name\nSO-T1\tK-T1\tTSV Customer`;
    const out = parseCSVAttachment({ fieldMappings: mappings() }, { content: csvBuffer(tsv) });
    expect(out.errors).toEqual([]);
    expect(out.orders.map((o) => o.order_number)).toEqual(['SO-T1']);
    expect(out.orders[0].customer_number).toBe('K-T1');
  });

  it('skips rows missing order_number but keeps valid ones', () => {
    const csv = `Order #,Cust #,Customer Name
SO-1,K-1,Acme
,K-2,Skip Me
SO-3,K-3,Gamma`;
    const out = parseCSVAttachment({ fieldMappings: mappings() }, { content: csvBuffer(csv) });
    expect(out.orders.map((o) => o.order_number)).toEqual(['SO-1', 'SO-3']);
    expect(out.errors.length).toBeGreaterThanOrEqual(1);
    expect(out.errors[0].message).toBe('Missing order number');
  });

  it('errors when the CSV has headers but no data rows', () => {
    const out = parseCSVAttachment(
      { fieldMappings: mappings() },
      { content: csvBuffer('Order #,Cust #') },
    );
    expect(out.orders).toEqual([]);
    expect(out.errors).toHaveLength(1);
    expect(out.errors[0].message).toBe('CSV has no data rows');
  });

  it('carries unmapped columns through source_data while mapping declared ones', () => {
    const csv = `Order #,Cust #,Mystery Col
SO-1,K-1,keep-me`;
    const out = parseCSVAttachment({ fieldMappings: mappings() }, { content: csvBuffer(csv) });
    expect(out.orders[0].order_number).toBe('SO-1');
    // The unmapped header is retained verbatim in source_data for audit.
    expect(out.orders[0].source_data?.['Mystery Col']).toBe('keep-me');
  });

  it('routes extended-field mappings into extended_metadata', () => {
    const fm = normalizeFieldMappings({
      version: 2,
      core: {
        order_number: { enabled: true, required: true, source_labels: ['Order #'] },
      },
      extended: [{ key: 'ship_date', label: 'Ship Date', source_labels: ['Ship Date'] }],
    });
    const csv = `Order #,Ship Date
SO-1,2026-06-01`;
    const out = parseCSVAttachment({ fieldMappings: fm }, { content: csvBuffer(csv) });
    expect(out.orders[0].order_number).toBe('SO-1');
    expect(out.orders[0].extended_metadata?.ship_date).toBe('2026-06-01');
  });

  it('defaultFieldMappings recognizes common header aliases out of the box', () => {
    const csv = `order_number,customer_number,customer_name
SO-D1,K-D1,Default Co`;
    const out = parseCSVAttachment(
      { fieldMappings: defaultFieldMappings() },
      { content: csvBuffer(csv) },
    );
    expect(out.orders.map((o) => o.order_number)).toEqual(['SO-D1']);
    expect(out.orders[0].customer_number).toBe('K-D1');
    expect(out.orders[0].customer_name).toBe('Default Co');
  });
});
