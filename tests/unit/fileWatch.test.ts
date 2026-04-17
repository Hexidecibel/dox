/**
 * Unit tests for the file_watch connector executor.
 *
 * The executor routes an uploaded file by extension / content-type to the
 * right parser (CSV direct, XLSX / PDF via the email connector's attachment
 * path). These tests exercise the CSV branch and the "unsupported type"
 * branch without touching D1 — we pass a synthetic ConnectorContext with
 * stub db/r2 and assert on the parsed ConnectorOutput.
 */

import { describe, it, expect } from 'vitest';
import { execute as fileWatchExecute } from '../../functions/lib/connectors/fileWatch';
import type { ConnectorContext, ConnectorInput } from '../../functions/lib/connectors/types';
import { normalizeFieldMappings } from '../../shared/fieldMappings';

function makeCtx(): ConnectorContext {
  return {
    db: {} as never,
    r2: undefined,
    tenantId: 'tenant-unit',
    connectorId: 'conn-unit',
    config: {},
    fieldMappings: normalizeFieldMappings({
      version: 2,
      core: {
        order_number: { enabled: true, required: true, source_labels: ['Order #'] },
        customer_number: { enabled: true, source_labels: ['Cust #'] },
        customer_name: { enabled: true, source_labels: ['Customer Name'] },
      },
      extended: [],
    }),
  };
}

function csvInput(text: string, fileName = 'orders.csv', contentType = 'text/csv'): ConnectorInput {
  const buffer = new TextEncoder().encode(text).buffer;
  return {
    type: 'file_watch',
    fileName,
    contentType,
    content: buffer,
  };
}

describe('fileWatch executor — CSV branch', () => {
  it('parses a well-formed CSV and emits orders + customers', async () => {
    const csv = `Order #,Cust #,Customer Name
A-1,K-1,Acme
A-2,K-2,Beta`;
    const out = await fileWatchExecute(makeCtx(), csvInput(csv));
    expect(out.orders.map((o) => o.order_number)).toEqual(['A-1', 'A-2']);
    expect(out.customers.map((c) => c.customer_number)).toEqual(['K-1', 'K-2']);
    expect(out.errors).toEqual([]);
  });

  it('returns an error (not throw) when the input type is wrong', async () => {
    const wrongInput: ConnectorInput = {
      type: 'email',
      body: 'nope',
      subject: 'nope',
      sender: 'nope@example.com',
    };
    const out = await fileWatchExecute(makeCtx(), wrongInput);
    expect(out.errors.length).toBeGreaterThan(0);
    expect(out.errors[0].message).toMatch(/Expected file_watch/i);
  });

  it('returns an error for unsupported extensions instead of crashing', async () => {
    const buffer = new TextEncoder().encode('garbage').buffer;
    const out = await fileWatchExecute(makeCtx(), {
      type: 'file_watch',
      fileName: 'thing.docx',
      contentType: 'application/msword',
      content: buffer,
    });
    expect(out.errors.length).toBeGreaterThan(0);
    expect(out.errors[0].message).toMatch(/Unsupported file type/i);
    expect(out.orders).toEqual([]);
    expect(out.customers).toEqual([]);
  });

  it('returns an error when no content or r2Key is supplied', async () => {
    const out = await fileWatchExecute(makeCtx(), {
      type: 'file_watch',
      fileName: 'ghost.csv',
    });
    expect(out.errors.length).toBeGreaterThan(0);
    expect(out.errors[0].message).toMatch(/neither content nor/i);
  });

  it('skips rows missing order_number but keeps valid ones', async () => {
    const csv = `Order #,Cust #,Customer Name
A-1,K-1,Acme
,K-2,Skip Me
A-3,K-3,Gamma`;
    const out = await fileWatchExecute(makeCtx(), csvInput(csv));
    expect(out.orders.map((o) => o.order_number)).toEqual(['A-1', 'A-3']);
    expect(out.errors.length).toBeGreaterThanOrEqual(1);
  });

  it('routes .tsv files to the CSV parser (tab delimiter auto-detected)', async () => {
    const tsv = `Order #\tCust #\tCustomer Name\nA-1\tK-1\tAcme`;
    const out = await fileWatchExecute(
      makeCtx(),
      csvInput(tsv, 'orders.tsv', 'text/tsv'),
    );
    expect(out.orders.map((o) => o.order_number)).toEqual(['A-1']);
  });
});
