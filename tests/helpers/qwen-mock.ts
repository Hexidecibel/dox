/**
 * Hermetic Qwen mock for the extraction pipeline tests.
 *
 * The email connector reaches Qwen by calling `fetch(`${qwenUrl}/v1/chat/completions`, ...)`.
 * We monkey-patch the global `fetch` so any request whose URL ends in
 * `/v1/chat/completions` is intercepted and routed through a keyword matcher
 * against the POST body's user-message content. Unmatched requests fall
 * through to the original `fetch` (tests that use SELF.fetch against the
 * worker stay working).
 *
 * Each handler returns a *parsed* ConnectorOutput-shaped payload — the mock
 * wraps it in the OpenAI chat-completion envelope the real parser expects:
 *   { choices: [ { message: { content: JSON.stringify(parsed) } } ] }
 *
 * ---
 * Why keyword matching and not URL matching?
 * The connector fires one Qwen call per PDF chunk / XLSX sheet. We want
 * different canned responses for "the COA orders PDF" vs "the weekly
 * registry sheet" vs "the INACTIVE sheet" without the test needing to pin
 * down the exact subject-line suffix the parser generates. Matching on a
 * distinctive token that only appears in the corresponding raw text is
 * robust against future subject-line tweaks.
 */

import { vi, type MockInstance } from 'vitest';

// -----------------------------------------------------------------------------
// Public types
// -----------------------------------------------------------------------------

export interface ParsedAIOrder {
  order_number: string;
  po_number?: string | null;
  customer_number?: string;
  customer_name?: string;
  items?: Array<{
    product_name?: string;
    product_code?: string;
    quantity?: number;
    lot_number?: string;
  }>;
}

export interface ParsedAIContact {
  name?: string;
  email: string;
  role?: string;
  is_primary?: boolean;
}

export interface ParsedAICustomer {
  customer_number: string;
  name: string;
  email?: string;
  emails?: string[];
  contacts?: ParsedAIContact[];
}

export interface ParsedAIResponse {
  orders: ParsedAIOrder[];
  customers: ParsedAICustomer[];
}

/**
 * A handler decides whether to claim a Qwen call based on the stringified
 * request body (the user-message text the connector built from the attachment).
 * Return `undefined` to decline, or a ParsedAIResponse to respond.
 */
export type QwenHandler = (requestBodyText: string) => ParsedAIResponse | undefined;

// -----------------------------------------------------------------------------
// Canned responses
// -----------------------------------------------------------------------------
//
// These are the EXPECTED post-fix outputs — i.e. what the pipeline SHOULD
// produce once the known bugs are squashed. Test assertions are written
// against these values so the regression suite locks in the target
// behavior, not the buggy current behavior.

/**
 * The expected clean output of the COA PDF (Summary Order Status, Apr 9 2026).
 * Ground truth: 11 orders across 9 unique customers. Customer names are
 * cleaned (no trailing digits), po_number is empty/absent when no source PO
 * is present on the row.
 */
export const MOCK_PDF_ORDERS_RESPONSE: ParsedAIResponse = {
  orders: [
    { order_number: '1784767', po_number: '', customer_number: 'K00166', customer_name: 'CHUCKANUT BAY FOODS', items: [] },
    { order_number: '1783966', po_number: '', customer_number: 'K14534', customer_name: 'COUGAR MOUNTAIN BAKING COMPANY', items: [] },
    { order_number: '1784964', po_number: '', customer_number: 'P2264',  customer_name: 'GRAND CENTRAL FREMONT PRODUCTION', items: [] },
    { order_number: '1783067', po_number: '', customer_number: 'P1865',  customer_name: 'HERITAGE', items: [] },
    { order_number: '1783069', po_number: '', customer_number: 'P1865',  customer_name: 'HERITAGE', items: [] },
    { order_number: '1782706', po_number: '', customer_number: 'K11522', customer_name: 'MERITAGE SOUPS', items: [] },
    { order_number: '1784029', po_number: '', customer_number: 'K11522', customer_name: 'MERITAGE SOUPS', items: [] },
    { order_number: '1782744', po_number: '', customer_number: 'K13110', customer_name: 'NORTHWEST GOURMET FOODS', items: [] },
    { order_number: '1785088', po_number: '', customer_number: 'K14364', customer_name: 'RIKKI USA', items: [] },
    { order_number: '1783767', po_number: '', customer_number: 'K13643', customer_name: 'SCHWARTZ BROTHERS BAKERY', items: [] },
    { order_number: '1784715', po_number: '', customer_number: 'K11829', customer_name: 'TAYLOR FARMS REAL FOODS', items: [] },
  ],
  customers: [
    { customer_number: 'K00166', name: 'CHUCKANUT BAY FOODS' },
    { customer_number: 'K14534', name: 'COUGAR MOUNTAIN BAKING COMPANY' },
    { customer_number: 'P2264',  name: 'GRAND CENTRAL FREMONT PRODUCTION' },
    { customer_number: 'P1865',  name: 'HERITAGE' },
    { customer_number: 'K11522', name: 'MERITAGE SOUPS' },
    { customer_number: 'K13110', name: 'NORTHWEST GOURMET FOODS' },
    { customer_number: 'K14364', name: 'RIKKI USA' },
    { customer_number: 'K13643', name: 'SCHWARTZ BROTHERS BAKERY' },
    { customer_number: 'K11829', name: 'TAYLOR FARMS REAL FOODS' },
  ],
};

/**
 * Canned response for a Weekly Master customer-registry sheet. Multi-contact
 * entries exercise the ParsedContact wiring in parseWithAI + resolveContacts.
 * Seven customers, three of which have >1 contact.
 */
export const MOCK_XLSX_REGISTRY_RESPONSE: ParsedAIResponse = {
  orders: [],
  customers: [
    {
      customer_number: 'K00166',
      name: 'CHUCKANUT BAY FOODS',
      email: 'orders@chuckanut.test',
      contacts: [
        { name: 'Alice Anders', email: 'alice@chuckanut.test', role: 'AP' },
        { name: 'Bob Brown',    email: 'bob@chuckanut.test',   role: 'Receiving' },
        { name: 'Orders Desk',  email: 'orders@chuckanut.test', role: 'Orders', is_primary: true },
      ],
    },
    {
      customer_number: 'K11522',
      name: 'SUNSHINE GROCERS',
      email: 'ap@sunshine.test',
      contacts: [
        { email: 'ap@sunshine.test',   role: 'AP' },
        { email: 'docs@sunshine.test', role: 'QA' },
      ],
    },
    {
      customer_number: 'K11829',
      name: 'HARBOR MARKET',
      email: 'receiving@harbor.test',
      contacts: [
        { email: 'receiving@harbor.test', role: 'Receiving' },
      ],
    },
    {
      customer_number: 'K13110',
      name: 'GREENLEAF NATURALS',
      email: 'coa@greenleaf.test',
      contacts: [
        { name: 'Carla Chen', email: 'carla@greenleaf.test', role: 'QA' },
        { email: 'coa@greenleaf.test', role: 'Orders' },
      ],
    },
    {
      customer_number: 'K13643',
      name: 'PACIFIC PROVISIONS',
      email: 'ap@pacificprov.test',
      contacts: [
        { email: 'ap@pacificprov.test', role: 'AP' },
      ],
    },
    {
      customer_number: 'K14364',
      name: 'CASCADE CREAMERY',
      email: 'orders@cascade.test',
      contacts: [
        { email: 'orders@cascade.test', role: 'Orders' },
      ],
    },
    {
      customer_number: 'P1865',
      name: 'NORTHWEST FOODS',
      email: 'docs@nwfoods.test',
      contacts: [
        { email: 'docs@nwfoods.test', role: 'QA' },
      ],
    },
  ],
};

/** An empty response with no data — useful as a fallback default. */
export const MOCK_EMPTY_RESPONSE: ParsedAIResponse = { orders: [], customers: [] };

// -----------------------------------------------------------------------------
// Mock install / uninstall
// -----------------------------------------------------------------------------

/**
 * One entry per intercepted Qwen call. `body` is the concatenated user-message
 * text (what the keyword matcher sees). `model` is the `model` field from the
 * outgoing POST body. `systemMessage` is the full system-role content, used by
 * tests that assert on the `/no_think` directive and other prompt guarantees.
 * `rawBody` is the full JSON-parsed request body for callers that need
 * anything else.
 */
export interface QwenCallLogEntry {
  url: string;
  body: string;
  model?: string;
  systemMessage?: string;
  rawBody?: unknown;
}

let originalFetch: typeof fetch | null = null;
let currentHandler: QwenHandler | null = null;
let callLog: QwenCallLogEntry[] = [];
let fetchSpy: MockInstance | null = null;

/**
 * The canonical keyword-matching handler. Ordering matters — more specific
 * matches must come before broader ones.
 *
 * Tests that need a different matcher can pass their own handler to
 * installQwenMock() directly.
 */
export function buildKeywordHandler(overrides: Partial<{
  coaOrders: ParsedAIResponse;
  xlsxRegistry: ParsedAIResponse;
  defaultResponse: ParsedAIResponse;
}> = {}): QwenHandler {
  const coa = overrides.coaOrders ?? MOCK_PDF_ORDERS_RESPONSE;
  const xlsx = overrides.xlsxRegistry ?? MOCK_XLSX_REGISTRY_RESPONSE;
  const fallback = overrides.defaultResponse ?? MOCK_EMPTY_RESPONSE;

  return (body: string) => {
    // The COA Orders PDF has the distinctive "Summary Order Status" header
    // emitted by the upstream ERP on every page. No registry rows carry it.
    if (/Summary Order Status/i.test(body)) {
      return coa;
    }
    // The weekly master XLSX is a customer registry — pipe-delimited cells
    // with email addresses. Match on the sheet subject suffix the connector
    // appends ("weekly-master-customer-registry.xlsx :: <sheet>"). Fall back
    // to any content that mentions at-signs in an email-registry shape.
    if (/weekly-master-customer-registry/i.test(body) || /@.+\.(com|test|org)/i.test(body)) {
      return xlsx;
    }
    return fallback;
  };
}

/**
 * Install the Qwen mock. If called with no handler, the keyword-matching
 * handler is used with the default canned responses.
 */
export function installQwenMock(handler: QwenHandler = buildKeywordHandler()): void {
  if (originalFetch) {
    // Already installed — replace handler.
    currentHandler = handler;
    return;
  }

  originalFetch = globalThis.fetch;
  currentHandler = handler;
  callLog = [];

  const mocked: typeof fetch = async (input, init) => {
    const url = typeof input === 'string'
      ? input
      : (input instanceof URL ? input.toString() : (input as Request).url);

    if (url.includes('/v1/chat/completions')) {
      // Extract the body text for matching. It's always a JSON string with
      // a messages array; we join the user messages together. Capture the
      // model field and the system message too so tests can assert on the
      // model name and on the presence of the /no_think directive.
      let bodyText = '';
      let modelName: string | undefined;
      let systemMessage: string | undefined;
      let parsedBody: unknown = undefined;
      try {
        const rawBody = typeof init?.body === 'string'
          ? init!.body
          : (init?.body instanceof ArrayBuffer
            ? new TextDecoder().decode(init.body)
            : '');
        const parsed = JSON.parse(rawBody || '{}') as {
          model?: string;
          messages?: Array<{ role: string; content: string }>;
        };
        parsedBody = parsed;
        modelName = parsed.model;
        bodyText = (parsed.messages || [])
          .filter(m => m.role === 'user')
          .map(m => m.content || '')
          .join('\n');
        systemMessage = (parsed.messages || [])
          .filter(m => m.role === 'system')
          .map(m => m.content || '')
          .join('\n') || undefined;
      } catch {
        bodyText = '';
      }

      callLog.push({
        url,
        body: bodyText,
        model: modelName,
        systemMessage,
        rawBody: parsedBody,
      });

      const response = currentHandler ? currentHandler(bodyText) : undefined;
      if (response) {
        const envelope = {
          choices: [{ message: { content: JSON.stringify(response) } }],
        };
        return new Response(JSON.stringify(envelope), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // Unmatched call — surface a deterministic error the test can catch.
      return new Response(
        JSON.stringify({ error: 'Qwen mock: no handler matched request' }),
        { status: 500, headers: { 'Content-Type': 'application/json' } },
      );
    }

    // Pass through for anything that isn't a Qwen call.
    return originalFetch!(input as RequestInfo, init);
  };

  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(mocked as typeof fetch);
}

/** Remove the mock and restore the original `fetch`. */
export function uninstallQwenMock(): void {
  if (fetchSpy) {
    fetchSpy.mockRestore();
    fetchSpy = null;
  }
  originalFetch = null;
  currentHandler = null;
  callLog = [];
}

/**
 * Return a copy of the call log so tests can inspect how many Qwen calls
 * fired, which content/model they saw, and what system prompt was shipped.
 */
export function getQwenCallLog(): ReadonlyArray<QwenCallLogEntry> {
  return [...callLog];
}

/** Clear the call log without uninstalling the mock. */
export function resetQwenCallLog(): void {
  callLog = [];
}
