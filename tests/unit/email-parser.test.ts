import { describe, it, expect } from 'vitest';

/**
 * The email connector's `execute` function needs a ConnectorContext with db, qwenUrl, etc.
 * The CSV parsing path is fully synchronous and doesn't need AI.
 * The AI path requires a real Qwen endpoint so we test the CSV path and the stripHtml logic.
 *
 * We import `execute` and build minimal contexts/inputs.
 */
import { execute } from '../../functions/lib/connectors/email';
import type { ConnectorContext, ConnectorInput, EmailAttachment } from '../../functions/lib/connectors/types';

function makeContext(overrides: Partial<ConnectorContext> = {}): ConnectorContext {
  return {
    db: {} as D1Database,
    tenantId: 'tenant-1',
    connectorId: 'conn-1',
    config: {},
    fieldMappings: {},
    ...overrides,
  };
}

function csvToArrayBuffer(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer as ArrayBuffer;
}

function makeEmailInput(overrides: Partial<Extract<ConnectorInput, { type: 'email' }>> = {}): ConnectorInput {
  return {
    type: 'email' as const,
    body: '',
    subject: 'Test',
    sender: 'test@example.com',
    ...overrides,
  };
}

describe('email connector — CSV parsing', () => {
  it('parses a simple CSV with standard headers', async () => {
    const csv = `order_number,customer_number,customer_name,po_number
ORD-001,C100,Acme Corp,PO-500
ORD-002,C200,Beta Inc,PO-600`;

    const input = makeEmailInput({
      attachments: [
        { filename: 'orders.csv', content: csvToArrayBuffer(csv), contentType: 'text/csv', size: csv.length },
      ],
    });

    const result = await execute(makeContext(), input);
    expect(result.orders).toHaveLength(2);
    expect(result.orders[0].order_number).toBe('ORD-001');
    expect(result.orders[0].customer_number).toBe('C100');
    expect(result.orders[0].customer_name).toBe('Acme Corp');
    expect(result.orders[0].po_number).toBe('PO-500');
    expect(result.orders[1].order_number).toBe('ORD-002');

    // Unique customers extracted
    expect(result.customers).toHaveLength(2);
    expect(result.customers[0].customer_number).toBe('C100');
    expect(result.customers[0].name).toBe('Acme Corp');
  });

  it('handles alternate column names (order, customer, po)', async () => {
    const csv = `order,customer,name,po
ORD-A,CA,Customer A,PA`;

    const input = makeEmailInput({
      attachments: [
        { filename: 'data.csv', content: csvToArrayBuffer(csv), contentType: 'text/csv', size: csv.length },
      ],
    });

    const result = await execute(makeContext(), input);
    expect(result.orders).toHaveLength(1);
    expect(result.orders[0].order_number).toBe('ORD-A');
    expect(result.orders[0].customer_number).toBe('CA');
  });

  it('applies field mappings', async () => {
    const csv = `ref,cust,nm
ORD-X,CX,NameX`;

    const input = makeEmailInput({
      attachments: [
        { filename: 'mapped.csv', content: csvToArrayBuffer(csv), contentType: 'text/csv', size: csv.length },
      ],
    });

    const result = await execute(
      makeContext({
        fieldMappings: {
          ref: 'order_number',
          cust: 'customer_number',
          nm: 'customer_name',
        },
      }),
      input
    );

    expect(result.orders).toHaveLength(1);
    expect(result.orders[0].order_number).toBe('ORD-X');
    expect(result.orders[0].customer_number).toBe('CX');
    expect(result.orders[0].customer_name).toBe('NameX');
  });

  it('reports error for rows missing order number', async () => {
    const csv = `order_number,customer_number
,C100
ORD-002,C200`;

    const input = makeEmailInput({
      attachments: [
        { filename: 'partial.csv', content: csvToArrayBuffer(csv), contentType: 'text/csv', size: csv.length },
      ],
    });

    const result = await execute(makeContext(), input);
    expect(result.orders).toHaveLength(1);
    expect(result.orders[0].order_number).toBe('ORD-002');
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toBe('Missing order number');
  });

  it('handles TSV (tab-separated) files', async () => {
    const tsv = `order_number\tcustomer_number\tcustomer_name
ORD-T1\tCT1\tTSV Customer`;

    const input = makeEmailInput({
      attachments: [
        { filename: 'data.tsv', content: csvToArrayBuffer(tsv), contentType: 'text/tab-separated-values', size: tsv.length },
      ],
    });

    const result = await execute(makeContext(), input);
    expect(result.orders).toHaveLength(1);
    expect(result.orders[0].order_number).toBe('ORD-T1');
  });

  it('returns error for CSV with no data rows', async () => {
    const csv = `order_number,customer_number`;

    const input = makeEmailInput({
      attachments: [
        { filename: 'empty.csv', content: csvToArrayBuffer(csv), contentType: 'text/csv', size: csv.length },
      ],
    });

    const result = await execute(makeContext(), input);
    expect(result.orders).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toBe('CSV has no data rows');
  });

  it('deduplicates customers across rows', async () => {
    const csv = `order_number,customer_number,customer_name
ORD-1,C100,Same Customer
ORD-2,C100,Same Customer
ORD-3,C200,Other Customer`;

    const input = makeEmailInput({
      attachments: [
        { filename: 'dupes.csv', content: csvToArrayBuffer(csv), contentType: 'text/csv', size: csv.length },
      ],
    });

    const result = await execute(makeContext(), input);
    expect(result.orders).toHaveLength(3);
    expect(result.customers).toHaveLength(2);
  });
});

describe('email connector — non-email input', () => {
  it('returns error for non-email input type', async () => {
    const input = { type: 'webhook' as const, payload: {}, headers: {} };
    const result = await execute(makeContext(), input);
    expect(result.orders).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toBe('Expected email input');
  });
});

describe('email connector — empty body without attachments', () => {
  it('returns error for empty email body', async () => {
    const input = makeEmailInput({ body: '', html: '' });
    const result = await execute(makeContext(), input);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toBe('Empty email body');
  });

  it('returns error for whitespace-only body', async () => {
    const input = makeEmailInput({ body: '   ', html: '' });
    const result = await execute(makeContext(), input);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toBe('Empty email body');
  });
});

describe('email connector — AI fallback without QWEN_URL', () => {
  it('returns error when qwenUrl is not configured', async () => {
    const input = makeEmailInput({ body: 'Order ORD-123 for customer C100' });
    const result = await execute(makeContext({ qwenUrl: undefined }), input);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toContain('AI extraction not configured');
  });
});
