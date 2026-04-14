/**
 * Regression tests for the XLSX path of the email connector.
 *
 * The fixture (weekly-master-customer-registry.xlsx) has 6 sheets:
 *   Monday, Tuesday, Wednesday, Thursday, Friday, INACTIVE CUST
 * INACTIVE is skipped. Each remaining sheet is ~12-15k chars which
 * exceeds XLSX_CHUNK_CHAR_LIMIT (5000), so the connector splits each
 * sheet into multiple chunks. For the committed fixture this currently
 * works out to 16 total AI calls (3 Monday + 4 Tuesday + 3 Wednesday +
 * 3 Thursday + 3 Friday). The count is verified by assertion so any
 * change in the fixture or chunk size is caught.
 *
 * XLSX_CHUNK_CHAR_LIMIT was introduced in pass 2 because the prior
 * CHUNK_CHAR_LIMIT of 28000 was fine for PDFs but caused per-sheet AI
 * calls to blow the 60s llama-swap gateway timeout in live runs.
 *
 * We mock Qwen so every call returns the same canned customer-registry
 * response, then merge-dedupe in the connector collapses them to a single
 * set of customers. Assertions lock in:
 *   - INACTIVE skip is surfaced as an info entry (not an error)
 *   - chunk count is consistent with the 5000-char limit
 *   - the MAX_CHUNKS_PER_ATTACHMENT cap (20) is not tripped
 *   - ParsedContact wiring populates multi-contact arrays on the output
 *   - every call includes max_tokens=8192
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execute } from '../../functions/lib/connectors/email';
import type { ConnectorContext, ConnectorInput, EmailAttachment } from '../../functions/lib/connectors/types';
import {
  installQwenMock,
  uninstallQwenMock,
  getQwenCallLog,
  MOCK_XLSX_REGISTRY_RESPONSE,
} from '../helpers/qwen-mock';
import { loadWeeklyMasterXlsx } from '../helpers/fixtures-binary';

const MAX_CHUNKS_PER_ATTACHMENT = 20;

function makeContext(overrides: Partial<ConnectorContext> = {}): ConnectorContext {
  return {
    db: {} as D1Database,
    tenantId: 'tenant-1',
    connectorId: 'conn-xlsx',
    config: {},
    fieldMappings: {},
    qwenUrl: 'https://qwen.test',
    qwenSecret: 'test-secret',
    ...overrides,
  };
}

function makeXlsxAttachment(): EmailAttachment {
  const content = loadWeeklyMasterXlsx();
  return {
    filename: 'weekly-master-customer-registry.xlsx',
    content,
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    size: content.byteLength,
  };
}

function makeEmailInput(att: EmailAttachment): ConnectorInput {
  return {
    type: 'email',
    body: '',
    subject: 'Weekly Customer Master',
    sender: 'erp@medosweet.test',
    attachments: [att],
  };
}

describe('email connector — XLSX extraction (Weekly Master)', () => {
  beforeEach(() => {
    installQwenMock();
  });

  afterEach(() => {
    uninstallQwenMock();
  });

  it('skips the INACTIVE_CUST sheet and logs an info entry', async () => {
    const result = await execute(makeContext(), makeEmailInput(makeXlsxAttachment()));
    // Bug #4 fix: the "Skipped sheet" notice is informational, not an
    // error — it now lives in output.info[] so the orchestrator's status
    // calc doesn't flag otherwise-clean runs as 'partial'.
    const info = result.info || [];
    const inactiveEntries = info.filter(msg => /skipped sheet.*inactive/i.test(msg));
    expect(inactiveEntries.length).toBeGreaterThanOrEqual(1);
    expect(inactiveEntries[0].toLowerCase()).toContain('inactive');
    // And it must NOT appear in errors[].
    const errorMatches = result.errors.filter(e => /skipped sheet.*inactive/i.test(e.message));
    expect(errorMatches).toHaveLength(0);
  });

  it('fires multiple chunks per sheet under XLSX_CHUNK_CHAR_LIMIT (5 sheets -> 16 calls)', async () => {
    await execute(makeContext(), makeEmailInput(makeXlsxAttachment()));
    const calls = getQwenCallLog();
    // With XLSX_CHUNK_CHAR_LIMIT=5000, the committed fixture splits into:
    //   Monday (12316) -> 3, Tuesday (15008) -> 4, Wednesday (14316) -> 3,
    //   Thursday (14325) -> 3, Friday (14810) -> 3 === 16 total.
    expect(calls).toHaveLength(16);
    // Sanity floor: the point of the 5000-char limit is that we split MORE
    // than the old one-call-per-sheet path (5 calls) — guards against an
    // accidental revert of XLSX_CHUNK_CHAR_LIMIT back to CHUNK_CHAR_LIMIT.
    expect(calls.length).toBeGreaterThanOrEqual(5);
  });

  it('does not exceed MAX_CHUNKS_PER_ATTACHMENT', async () => {
    await execute(makeContext(), makeEmailInput(makeXlsxAttachment()));
    const calls = getQwenCallLog();
    expect(calls.length).toBeLessThanOrEqual(MAX_CHUNKS_PER_ATTACHMENT);
  });

  it('sends max_tokens=8192 on every XLSX chunk request', async () => {
    // Pass-2 fix for mid-JSON truncation on long customer-registry chunks.
    // The request body must explicitly bump the output cap above the
    // llama-swap default (~2048).
    await execute(makeContext(), makeEmailInput(makeXlsxAttachment()));
    const calls = getQwenCallLog();
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      const raw = call.rawBody as { max_tokens?: number } | undefined;
      expect(raw).toBeDefined();
      expect(raw!.max_tokens).toBe(8192);
    }
  });

  it('extracts customers with multi-contact arrays', async () => {
    const result = await execute(makeContext(), makeEmailInput(makeXlsxAttachment()));

    // mergeOutputs dedupes by customer_number (first-wins), so the merged
    // list mirrors the canned response on a single-call basis.
    expect(result.customers.length).toBeGreaterThan(0);

    // At least one customer must expose a multi-entry contacts array —
    // this is the regression gate for the ParsedContact wiring landed in
    // email.ts / orchestrator.ts.
    const multi = result.customers.filter(c => (c.contacts?.length ?? 0) > 1);
    expect(multi.length).toBeGreaterThanOrEqual(1);
  });

  it('preserves per-customer primary email on single-contact entries', async () => {
    const result = await execute(makeContext(), makeEmailInput(makeXlsxAttachment()));

    // Every customer in the canned response has at least a top-level email
    // — verify the path through parseWithAI + mergeOutputs retains it.
    for (const c of result.customers) {
      expect(c.email).toBeTruthy();
    }
  });

  it('matches the canned customer count after dedupe', async () => {
    const result = await execute(makeContext(), makeEmailInput(makeXlsxAttachment()));
    // Every mock call returns the same set; dedupe collapses them.
    expect(result.customers).toHaveLength(MOCK_XLSX_REGISTRY_RESPONSE.customers.length);
  });

  it('emits a processing summary via info[] (regression guard for bug #4)', async () => {
    // Bug #4 fix: the per-attachment processing summary is informational
    // and must live in info[] so the orchestrator's status calc ignores it.
    const result = await execute(makeContext(), makeEmailInput(makeXlsxAttachment()));
    const info = result.info || [];
    const summaries = info.filter(msg => /processed.*sheet.*chunk/i.test(msg));
    expect(summaries).toHaveLength(1);
    // And it must NOT appear in errors[] — that was the bug.
    const errorMatches = result.errors.filter(e => /processed.*sheet.*chunk/i.test(e.message));
    expect(errorMatches).toHaveLength(0);
  });
});
