/**
 * Regression tests for the PDF path of the email connector.
 *
 * `parsePDFAttachment` is not exported, so we drive it end-to-end through
 * the public `execute()` entry point with a synthesized EmailAttachment.
 * The Qwen HTTP call is mocked via installQwenMock so the run is hermetic.
 *
 * Ground truth comes from the committed fixture
 * tests/fixtures/coa-orders-medosweet-2026-04-09.pdf — the Medosweet Farms
 * "Summary Order Status" report containing 11 orders across 9 unique
 * customers. Assertions encode the POST-FIX expectations; where current
 * behavior deviates from ideal, the deviation is documented inline and
 * marked with `it.fails` so a future patch flips the test to green.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execute } from '../../functions/lib/connectors/email';
import type { ConnectorContext, ConnectorInput, EmailAttachment } from '../../functions/lib/connectors/types';
import {
  installQwenMock,
  uninstallQwenMock,
  getQwenCallLog,
  MOCK_PDF_ORDERS_RESPONSE,
} from '../helpers/qwen-mock';
import { loadCoaOrdersPdf } from '../helpers/fixtures-binary';

function makeContext(overrides: Partial<ConnectorContext> = {}): ConnectorContext {
  return {
    db: {} as D1Database,
    tenantId: 'tenant-1',
    connectorId: 'conn-pdf',
    config: {},
    fieldMappings: {},
    qwenUrl: 'https://qwen.test',
    qwenSecret: 'test-secret',
    ...overrides,
  };
}

function makePdfAttachment(): EmailAttachment {
  const content = loadCoaOrdersPdf();
  return {
    filename: 'coa-orders-medosweet-2026-04-09.pdf',
    content,
    contentType: 'application/pdf',
    size: content.byteLength,
  };
}

function makeEmailInput(att: EmailAttachment): ConnectorInput {
  return {
    type: 'email',
    body: '',
    subject: 'Daily COA Order Status',
    sender: 'erp@medosweet.test',
    attachments: [att],
  };
}

describe('email connector — PDF extraction (COA Orders)', () => {
  beforeEach(() => {
    installQwenMock();
  });

  afterEach(() => {
    uninstallQwenMock();
  });

  it('extracts all 11 orders with the 9 expected customer numbers', async () => {
    const result = await execute(makeContext(), makeEmailInput(makePdfAttachment()));

    expect(result.orders).toHaveLength(11);

    const expectedCustomerNumbers = new Set([
      'K00166', 'K11522', 'K11829', 'K13110', 'K13643',
      'K14364', 'K14534', 'P1865', 'P2264',
    ]);
    const foundCustomerNumbers = new Set(result.orders.map(o => o.customer_number));
    expect(foundCustomerNumbers).toEqual(expectedCustomerNumbers);
  });

  it('dedupes customers so there are exactly 9 unique entries', async () => {
    const result = await execute(makeContext(), makeEmailInput(makePdfAttachment()));

    expect(result.customers).toHaveLength(9);
    const nums = new Set(result.customers.map(c => c.customer_number));
    expect(nums.size).toBe(9);
  });

  it('produces clean customer_name values (no trailing digits)', async () => {
    const result = await execute(makeContext(), makeEmailInput(makePdfAttachment()));

    for (const order of result.orders) {
      expect(order.customer_name).toBeDefined();
      // e.g. "MERITAGE SOUPS39" is a previously-seen bug — names must not
      // end in a digit run.
      expect(order.customer_name).not.toMatch(/\d+$/);
    }
  });

  it('does not fabricate po_number when the source row has none', async () => {
    const result = await execute(makeContext(), makeEmailInput(makePdfAttachment()));

    // The Medosweet report has no PO column at all. Any non-empty po_number
    // is a hallucination by the AI / prompt. Empty string or undefined are
    // both acceptable; a non-empty string is not.
    for (const order of result.orders) {
      const po = order.po_number;
      expect(po === undefined || po === '' || po === null).toBe(true);
    }
  });

  it('chunks the small PDF into exactly 1 AI call', async () => {
    await execute(makeContext(), makeEmailInput(makePdfAttachment()));
    const calls = getQwenCallLog();
    expect(calls).toHaveLength(1);
  });

  it('sends the real PDF content (not filename alone) to the AI', async () => {
    await execute(makeContext(), makeEmailInput(makePdfAttachment()));
    const calls = getQwenCallLog();
    expect(calls[0].body).toContain('Summary Order Status');
  });

  it('processing-summary line is informational, not an error (regression guard)', async () => {
    // Bug #4 fix: the PDF path now emits its "processed N pages in M chunks"
    // summary via output.info[], NOT output.errors[]. The orchestrator's
    // status calc ignores info[] so a clean run is no longer mislabeled
    // 'partial'.
    const result = await execute(makeContext(), makeEmailInput(makePdfAttachment()));
    const errorSummaries = result.errors.filter(e => /processed.*pages.*chunk/i.test(e.message));
    expect(errorSummaries).toHaveLength(0);
  });

  it('emits the processing summary via info[] instead of errors[]', async () => {
    // Companion to the regression guard above — the same summary MUST
    // appear in info[], so removing it without moving it elsewhere is
    // visible in a test diff.
    const result = await execute(makeContext(), makeEmailInput(makePdfAttachment()));
    const info = result.info || [];
    const summaries = info.filter(msg => /processed.*pages.*chunk/i.test(msg));
    expect(summaries.length).toBeGreaterThanOrEqual(1);
    expect(summaries[0]).toContain('1 chunk');
  });

  it('sends model "Qwen3-8B" in the request body (not the bogus "qwen" id)', async () => {
    // Bug #2 fix: the model field was `qwen` which the llama-swap gateway
    // does not recognize. It must be `Qwen3-8B`.
    await execute(makeContext(), makeEmailInput(makePdfAttachment()));
    const calls = getQwenCallLog();
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.model).toBe('Qwen3-8B');
    }
  });

  it('prepends /no_think to the system message to suppress reasoning tokens', async () => {
    // Bug #3 fix: Qwen3-8B is a reasoning model and will burn ~1k thinking
    // tokens before answering, blowing the 60s gateway timeout. The
    // `/no_think` directive disables the reasoning preamble.
    await execute(makeContext(), makeEmailInput(makePdfAttachment()));
    const calls = getQwenCallLog();
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.systemMessage).toBeDefined();
      expect(call.systemMessage!.startsWith('/no_think')).toBe(true);
    }
  });

  it('sets max_tokens=8192 on every Qwen request to avoid mid-JSON truncation', async () => {
    // Pass-2 fix: llama-swap defaults to ~2048 output tokens, which truncated
    // long XLSX outputs mid-JSON ("Unterminated string at position 4296").
    // Assert the request body explicitly requests 8192.
    await execute(makeContext(), makeEmailInput(makePdfAttachment()));
    const calls = getQwenCallLog();
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      const raw = call.rawBody as { max_tokens?: number } | undefined;
      expect(raw).toBeDefined();
      expect(raw!.max_tokens).toBe(8192);
    }
  });

  it('sanitizes trailing digit groups on customer_name even if the mock leaks them', async () => {
    // Belt-and-suspenders: the sanitizer is the safety net for when the
    // Qwen3-8B prompt rule fails ("HERITAGE 247" leaked through on real
    // runs). Feed a mock that deliberately returns a dirty customer_name
    // and assert the output has been scrubbed.
    uninstallQwenMock();
    installQwenMock(() => ({
      orders: [
        { order_number: 'ORD-1', customer_number: 'P1865', customer_name: 'HERITAGE 247', items: [] },
        { order_number: 'ORD-2', customer_number: 'K11522', customer_name: 'MERITAGE SOUPS 39 88', items: [] },
      ],
      customers: [
        { customer_number: 'P1865', name: 'HERITAGE 247' },
        { customer_number: 'K11522', name: 'MERITAGE SOUPS 39 88' },
      ],
    }));

    const result = await execute(makeContext(), makeEmailInput(makePdfAttachment()));

    const heritageOrder = result.orders.find(o => o.customer_number === 'P1865');
    const meritageOrder = result.orders.find(o => o.customer_number === 'K11522');
    expect(heritageOrder?.customer_name).toBe('HERITAGE');
    expect(meritageOrder?.customer_name).toBe('MERITAGE SOUPS');

    const heritageCust = result.customers.find(c => c.customer_number === 'P1865');
    const meritageCust = result.customers.find(c => c.customer_number === 'K11522');
    expect(heritageCust?.name).toBe('HERITAGE');
    expect(meritageCust?.name).toBe('MERITAGE SOUPS');
  });

  it('mock-round-trips the expected orders count from the canned response', async () => {
    // Sanity check: the canned mock has 11 orders — if this ever drifts,
    // the assertions above go stale.
    expect(MOCK_PDF_ORDERS_RESPONSE.orders).toHaveLength(11);
  });
});
