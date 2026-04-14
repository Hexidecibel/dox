/**
 * Tests for the chunking / merging / classification helpers inside
 * functions/lib/connectors/email.ts.
 *
 * These helpers are NOT exported, so every test drives them through the
 * public `execute()` entry point using small synthetic attachments
 * (CSV + in-memory XLSX). The assertions verify observable behavior:
 *   - chunkByRows: split on newlines only, cap enforcement
 *   - mergeOutputs: first-wins customer dedupe
 *   - classifyAttachment: content-type vs filename-extension routing
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as XLSX from 'xlsx';
import { execute } from '../../functions/lib/connectors/email';
import type { ConnectorContext, ConnectorInput, EmailAttachment } from '../../functions/lib/connectors/types';
import { installQwenMock, uninstallQwenMock, getQwenCallLog, buildKeywordHandler } from '../helpers/qwen-mock';

function makeContext(overrides: Partial<ConnectorContext> = {}): ConnectorContext {
  return {
    db: {} as D1Database,
    tenantId: 'tenant-1',
    connectorId: 'conn-chunk',
    config: {},
    fieldMappings: {},
    qwenUrl: 'https://qwen.test',
    qwenSecret: 'test-secret',
    ...overrides,
  };
}

function textToBuffer(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer as ArrayBuffer;
}

function makeEmailInput(attachments: EmailAttachment[]): ConnectorInput {
  return {
    type: 'email',
    body: '',
    subject: 'Chunk Test',
    sender: 'test@example.com',
    attachments,
  };
}

// -----------------------------------------------------------------------------
// classifyAttachment — exercised via execute() and observed outputs
// -----------------------------------------------------------------------------
describe('classifyAttachment (via execute)', () => {
  it('routes text/csv contentType to the CSV parser', async () => {
    const csv = 'order_number,customer_number\nORD-1,C1';
    const result = await execute(
      makeContext(),
      makeEmailInput([{ filename: 'x.csv', content: textToBuffer(csv), contentType: 'text/csv', size: csv.length }]),
    );
    expect(result.orders).toHaveLength(1);
    expect(result.orders[0].order_number).toBe('ORD-1');
  });

  it('routes .csv filename (wrong contentType) to the CSV parser', async () => {
    const csv = 'order_number,customer_number\nORD-2,C2';
    const result = await execute(
      makeContext(),
      makeEmailInput([{ filename: 'mislabeled.csv', content: textToBuffer(csv), contentType: 'application/octet-stream', size: csv.length }]),
    );
    expect(result.orders).toHaveLength(1);
    expect(result.orders[0].order_number).toBe('ORD-2');
  });

  it('routes .tsv filename to the CSV parser with tab delimiter', async () => {
    const tsv = 'order_number\tcustomer_number\nORD-3\tC3';
    const result = await execute(
      makeContext(),
      makeEmailInput([{ filename: 'data.tsv', content: textToBuffer(tsv), contentType: 'application/octet-stream', size: tsv.length }]),
    );
    expect(result.orders).toHaveLength(1);
    expect(result.orders[0].order_number).toBe('ORD-3');
    expect(result.orders[0].customer_number).toBe('C3');
  });

  it('surfaces an error for an unknown content type / extension', async () => {
    const bin = new TextEncoder().encode('hello').buffer as ArrayBuffer;
    const result = await execute(
      makeContext(),
      makeEmailInput([{ filename: 'blob.bin', content: bin, contentType: 'application/octet-stream', size: 5 }]),
    );
    expect(result.orders).toHaveLength(0);
    expect(result.errors.some(e => /skipped unsupported/i.test(e.message))).toBe(true);
  });

  it('classifies a PDF by .pdf extension even without application/pdf contentType', async () => {
    // We don't need real PDF parsing to work — the classification routes
    // the call into parsePDFAttachment, which will fail to extract text
    // from a stub and return the "no text" error. That's enough to prove
    // classification hit the PDF branch.
    installQwenMock();
    try {
      const bytes = new TextEncoder().encode('not a real pdf').buffer as ArrayBuffer;
      const result = await execute(
        makeContext(),
        makeEmailInput([{ filename: 'stub.pdf', content: bytes, contentType: 'application/octet-stream', size: 14 }]),
      );
      // Either parse error or empty-text error — both prove we hit the PDF branch.
      expect(result.errors.length).toBeGreaterThan(0);
      expect(
        result.errors.some(e => /pdf/i.test(e.message)),
      ).toBe(true);
    } finally {
      uninstallQwenMock();
    }
  });
});

// -----------------------------------------------------------------------------
// chunkByRows — exercised via parseXLSXAttachment, because csv path doesn't chunk
// -----------------------------------------------------------------------------
describe('chunkByRows & MAX_CHUNKS_PER_ATTACHMENT cap', () => {
  beforeEach(() => {
    installQwenMock();
  });

  afterEach(() => {
    uninstallQwenMock();
  });

  it('triggers the too-large error when a synthetic XLSX needs > 20 AI calls', async () => {
    // Build a 21-sheet workbook. Each sheet is small enough to stay under
    // CHUNK_CHAR_LIMIT (28_000) so each sheet is exactly one unit — 21
    // units > 20-cap => hard error without any AI calls.
    const wb = XLSX.utils.book_new();
    for (let i = 0; i < 21; i++) {
      const rows = [
        ['customer_number', 'name', 'email'],
        [`K${String(i).padStart(5, '0')}`, `Customer ${i}`, `c${i}@t.test`],
      ];
      const ws = XLSX.utils.aoa_to_sheet(rows);
      XLSX.utils.book_append_sheet(wb, ws, `Sheet${i + 1}`);
    }
    // xlsx `type: 'array'` returns an ArrayBuffer directly (not a typed array).
    const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;

    const result = await execute(
      makeContext(),
      makeEmailInput([{
        filename: 'too-big.xlsx',
        content: buf,
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        size: buf.byteLength,
      }]),
    );

    expect(result.orders).toHaveLength(0);
    expect(result.customers).toHaveLength(0);
    expect(result.errors.some(e => /too large/i.test(e.message))).toBe(true);
    // No AI calls should have been issued when the cap is tripped.
    expect(getQwenCallLog()).toHaveLength(0);
  });

  it('splits a single long sheet across multiple AI calls without mid-row breaks', async () => {
    // Build ONE sheet whose CSV is well over CHUNK_CHAR_LIMIT (28_000).
    // Each row is the same width (~80 chars), so the chunker must emit
    // multiple sub-chunks, each one aligned to row boundaries.
    const rows: string[][] = [['customer_number', 'name', 'email']];
    for (let i = 0; i < 600; i++) {
      rows.push([
        `K${String(i).padStart(5, '0')}`,
        `Customer Name Number ${i} With Padding`,
        `customer${i}@test.test`,
      ]);
    }
    const ws = XLSX.utils.aoa_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Big');
    const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;

    const result = await execute(
      makeContext(),
      makeEmailInput([{
        filename: 'big-sheet.xlsx',
        content: buf,
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        size: buf.byteLength,
      }]),
    );

    // Multiple chunks expected, but still ≤ MAX_CHUNKS_PER_ATTACHMENT.
    const calls = getQwenCallLog();
    expect(calls.length).toBeGreaterThan(1);
    expect(calls.length).toBeLessThanOrEqual(20);

    // No chunk body should be truncated in the middle of a row — the
    // chunker rejoins on '\n'. Every body should end cleanly on a row
    // boundary (no partial cell trailing).
    for (const call of calls) {
      // The user message is "Subject: ...\n\n<csv body>". Verify the
      // body does not end mid-row: the trailing line must either be the
      // full last row or a non-empty pipe-delimited row.
      const lines = call.body.split('\n').filter(Boolean);
      const last = lines[lines.length - 1] || '';
      expect(last.length).toBeGreaterThan(0);
      // Each row carries the three columns separated by " | ", so every
      // emitted row must contain at least one " | " separator.
      expect(last).toContain(' | ');
    }

    // Output is produced successfully (no fatal error).
    expect(result.errors.some(e => /too large/i.test(e.message))).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// mergeOutputs — exercised via two CSV attachments in one email
// -----------------------------------------------------------------------------
describe('mergeOutputs first-wins customer dedupe', () => {
  it('keeps the first occurrence of a customer_number across attachments', async () => {
    const csv1 = `order_number,customer_number,customer_name
ORD-1,C100,First Name`;
    const csv2 = `order_number,customer_number,customer_name
ORD-2,C100,Second Name`;

    const result = await execute(
      makeContext(),
      makeEmailInput([
        { filename: 'a.csv', content: textToBuffer(csv1), contentType: 'text/csv', size: csv1.length },
        { filename: 'b.csv', content: textToBuffer(csv2), contentType: 'text/csv', size: csv2.length },
      ]),
    );

    expect(result.orders).toHaveLength(2);
    expect(result.customers).toHaveLength(1);
    expect(result.customers[0].customer_number).toBe('C100');
    // First-wins: the name from csv1 must survive.
    expect(result.customers[0].name).toBe('First Name');
  });

  it('dedupes customer_number case-sensitively — "C100" and "c100" are distinct', async () => {
    const csv = `order_number,customer_number,customer_name
ORD-1,C100,Upper
ORD-2,c100,Lower`;
    const result = await execute(
      makeContext(),
      makeEmailInput([
        { filename: 'mixed.csv', content: textToBuffer(csv), contentType: 'text/csv', size: csv.length },
      ]),
    );
    // Both orders land; both customers land too since the Set is exact-match.
    expect(result.orders).toHaveLength(2);
    expect(result.customers).toHaveLength(2);
    const nums = result.customers.map(c => c.customer_number).sort();
    expect(nums).toEqual(['C100', 'c100']);
  });
});

// -----------------------------------------------------------------------------
// Keyword handler sanity
// -----------------------------------------------------------------------------
describe('qwen mock handler', () => {
  it('buildKeywordHandler returns the fallback for unmatched content', () => {
    const handler = buildKeywordHandler({
      coaOrders: { orders: [], customers: [] },
      xlsxRegistry: { orders: [], customers: [] },
      defaultResponse: { orders: [], customers: [] },
    });
    expect(handler('totally unrelated text')).toEqual({ orders: [], customers: [] });
  });
});
