/**
 * Pure order/customer extraction prompt-building + output-normalization helpers.
 *
 * Single source of truth shared between the Cloudflare Worker connector pipeline
 * (functions/lib/connectors/email.ts) and the standalone Node extraction worker
 * (bin/process-worker). Keep this file PURE — no DB access, no fetch, no Worker-only
 * globals — so the exact same code runs in a Worker and in plain Node.
 *
 * What lives here:
 *  - buildParsingPrompt / getDefaultParsingPrompt — compose the Qwen system prompt
 *    from a v2 field_mappings config.
 *  - prependConnectorInstructions — prepend per-connector reviewer guidance.
 *  - mergeOutputs — merge multi-chunk {orders[], customers[]} results
 *    (first-wins customer dedupe, order concat, info/errors concat).
 *  - normalizeAiOutput — validate + map raw parsed LLM JSON into {orders[], customers[]}.
 *  - sanitizeCustomerName / clampConfidence — post-parse safety nets.
 *
 * The fetch/LLM-call shell stays in email.ts (and the Node worker); this module
 * only owns the pure transforms those callers wrap.
 */

import {
  buildAiFieldsSection,
  buildJsonShapeForPrompt,
  type ConnectorFieldMappings,
  defaultFieldMappings,
} from './fieldMappings';
import type {
  ConnectorOutput,
  ParsedContact,
  ParsedCustomer,
  ParsedOrder,
} from './connectorOutput';

// =============================================================================
// Output merge
// =============================================================================

/**
 * Merge multiple ConnectorOutput results into one.
 * Dedupes customers by customer_number (keeps first occurrence).
 * Concatenates `info[]` across all outputs so per-attachment summaries
 * survive the merge step alongside errors.
 */
export function mergeOutputs(outputs: ConnectorOutput[]): ConnectorOutput {
  const orders: ParsedOrder[] = [];
  const customers: ParsedCustomer[] = [];
  const errors: ConnectorOutput['errors'] = [];
  const info: string[] = [];
  const seenCustomers = new Set<string>();

  for (const out of outputs) {
    for (const o of out.orders) orders.push(o);
    for (const c of out.customers) {
      if (!seenCustomers.has(c.customer_number)) {
        seenCustomers.add(c.customer_number);
        customers.push(c);
      }
    }
    for (const e of out.errors) errors.push(e);
    if (out.info) {
      for (const msg of out.info) info.push(msg);
    }
  }

  return { orders, customers, errors, info };
}

// =============================================================================
// Post-parse safety nets
// =============================================================================

/**
 * Coerce an LLM-emitted `_confidence` value into a clean [0, 1] number.
 *
 * The LLM is asked to emit a 0.0-1.0 float on every record. In practice it
 * sometimes emits the field as a string ("0.85"), a percentage ("85%"), or
 * omits it entirely. The orchestrator's stage-vs-commit logic depends on
 * this being a reliable number, so we normalize at parse time:
 *   - undefined / null / non-finite → undefined (orchestrator treats as 1.0)
 *   - >1 (e.g. 85, 0.85e2) → divided by 100 if that lands it in range
 *   - else clamped to [0, 1]
 */
export function clampConfidence(raw: unknown): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  let n = typeof raw === 'number' ? raw : parseFloat(String(raw).replace('%', ''));
  if (!Number.isFinite(n)) return undefined;
  if (n > 1 && n <= 100) n = n / 100;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/**
 * Strip trailing digit groups from a customer name.
 *
 * The Qwen3-8B prompt includes an explicit rule against trailing digits on
 * customer names, but the model ignores it on certain PDF layouts where the
 * text extraction has no whitespace between the name column and an adjacent
 * numeric column (weight, count, route, etc.), producing names like
 * "HERITAGE 247" or "HERITAGE 247 88". This helper is the belt-and-suspenders
 * safety net applied after JSON.parse.
 *
 * Rules:
 * - Only strip when there is WHITESPACE before the trailing digits.
 *   "HERITAGE 247" -> "HERITAGE" (stripped)
 *   "HERITAGE2024" -> "HERITAGE2024" (untouched — no whitespace boundary)
 *   "3M COMPANY"   -> "3M COMPANY" (leading digits preserved, only trailing stripped)
 * - Apply repeatedly so "HERITAGE 247 88" collapses to "HERITAGE".
 * - Empty / null / undefined inputs return an empty string (safe for callers
 *   that assign the result back onto a required field).
 * - Trailing whitespace / punctuation left behind after stripping is trimmed
 *   ("ACME, INC. 123" -> "ACME, INC.").
 *
 * Exported for direct unit testing.
 */
export function sanitizeCustomerName(name: string | null | undefined): string {
  if (!name) return '';
  // Trim first so the regex `$` anchor sees the real end of the name even
  // when the source had trailing whitespace.
  let out = name.trim();
  // Repeatedly strip `<whitespace><digits>` suffixes so multiple trailing
  // groups collapse in a single call.
  while (true) {
    const next = out.replace(/\s+\d+$/, '').trimEnd();
    if (next === out) break;
    out = next;
  }
  return out;
}

// =============================================================================
// Raw AI output normalization
// =============================================================================

/**
 * Shape of the raw JSON the LLM is asked to emit (before validation/mapping).
 * Mirrors the response_format contract in buildJsonShapeForPrompt().
 */
export interface RawAiParseResult {
  orders?: Array<{
    order_number: string;
    po_number?: string;
    customer_number?: string;
    customer_name?: string;
    items?: Array<{
      product_name?: string;
      product_code?: string;
      quantity?: number;
      lot_number?: string;
      _confidence?: number;
    }>;
    primary_metadata?: Record<string, unknown>;
    extended_metadata?: Record<string, unknown>;
    _confidence?: number;
  }>;
  customers?: Array<{
    customer_number?: string;
    name?: string;
    email?: string;
    emails?: string[];
    contacts?: Array<{
      name?: string;
      email?: string;
      role?: string;
      is_primary?: boolean;
    }>;
    _confidence?: number;
  }>;
}

/**
 * Validate + map a raw parsed LLM JSON object into {orders[], customers[]}.
 *
 * Pure transform — takes the already-parsed JSON and applies every
 * deterministic rule the connector relies on:
 *   - drop orders with empty/missing order_number (fabrication guard)
 *   - scrub trailing digit groups off customer names (sanitizeCustomerName)
 *   - nest line items under each order
 *   - normalize confidence values (clampConfidence)
 *   - collect unique customers from the standalone customers[] array first,
 *     then backfill from orders so nothing referenced is missed (first-wins)
 *
 * Contains NO fetch / LLM call / DB access — callers own the network shell.
 */
export function normalizeAiOutput(parsed: RawAiParseResult): {
  orders: ParsedOrder[];
  customers: ParsedCustomer[];
} {
  const orders: ParsedOrder[] = (parsed.orders || [])
    // Validate that order_number is present on every row — fabricated
    // order records with empty/missing order_numbers are dropped with an
    // error surfaced upstream.
    .filter(o => {
      if (!o.order_number || typeof o.order_number !== 'string' || !o.order_number.trim()) {
        return false;
      }
      return true;
    })
    .map(o => ({
      order_number: o.order_number,
      po_number: o.po_number,
      customer_number: o.customer_number,
      // Safety net: scrub trailing digit groups even if the prompt rule
      // slipped through. See sanitizeCustomerName() for the full contract.
      customer_name: o.customer_name ? sanitizeCustomerName(o.customer_name) : o.customer_name,
      items: (o.items || []).map(item => ({
        product_name: item.product_name,
        product_code: item.product_code,
        quantity: item.quantity,
        lot_number: item.lot_number,
        _confidence: clampConfidence(item._confidence),
      })),
      source_data: o as Record<string, unknown>,
      // Open-ended metadata — whatever the model populated under
      // primary_metadata / extended_metadata comes through verbatim. The
      // prompt schema describes exactly these keys so the model doesn't
      // have to guess.
      primary_metadata: o.primary_metadata && typeof o.primary_metadata === 'object'
        ? o.primary_metadata
        : undefined,
      extended_metadata: o.extended_metadata && typeof o.extended_metadata === 'object'
        ? o.extended_metadata
        : undefined,
      _confidence: clampConfidence(o._confidence),
    }));

  // Collect unique customers: first from the standalone `customers` array
  // the AI may return (customer-registry payloads like the weekly XLSX),
  // then backfill from orders so nothing referenced in an order is missed.
  const seenCustomers = new Set<string>();
  const customers: ParsedCustomer[] = [];

  for (const c of parsed.customers || []) {
    const num = c.customer_number?.trim();
    if (!num || seenCustomers.has(num)) continue;

    // Normalize contacts: prefer the explicit `contacts` array the model
    // should emit for registry rows, fall back to `emails[]`, then to the
    // single `email` field. Deduped case-insensitively per customer.
    const contacts: ParsedContact[] = [];
    const seenEmails = new Set<string>();
    const pushContact = (raw: { name?: string; email?: string; role?: string; is_primary?: boolean }) => {
      const email = raw.email?.trim();
      if (!email) return;
      const key = email.toLowerCase();
      if (seenEmails.has(key)) return;
      seenEmails.add(key);
      contacts.push({
        name: raw.name?.trim() || undefined,
        email,
        role: raw.role?.trim() || undefined,
        is_primary: raw.is_primary,
      });
    };

    if (Array.isArray(c.contacts)) {
      for (const contact of c.contacts) pushContact(contact);
    }
    if (Array.isArray(c.emails)) {
      for (const e of c.emails) pushContact({ email: e });
    }
    if (c.email) pushContact({ email: c.email });

    const primaryEmail = c.email?.trim() || contacts[0]?.email || undefined;

    // Same safety net as orders — strip trailing digit groups the prompt
    // rule may have missed. Preserve customer_number fallback when the
    // name collapses to empty after scrubbing.
    const rawName = c.name?.trim() || num;
    const cleanName = sanitizeCustomerName(rawName) || num;

    seenCustomers.add(num);
    customers.push({
      customer_number: num,
      name: cleanName,
      email: primaryEmail,
      contacts: contacts.length > 0 ? contacts : undefined,
      _confidence: clampConfidence(c._confidence),
    });
  }

  for (const o of orders) {
    if (o.customer_number && !seenCustomers.has(o.customer_number)) {
      seenCustomers.add(o.customer_number);
      // Customer was implied by an order — inherit the order's confidence
      // since we have no standalone signal.
      customers.push({
        customer_number: o.customer_number,
        name: o.customer_name || o.customer_number,
        _confidence: o._confidence,
      });
    }
  }

  return { orders, customers };
}

// =============================================================================
// Prompt composition
// =============================================================================

/**
 * Static body shared by every prompt variant: rules block, customer-name
 * digit-strip rule, fabrication guard, few-shot examples A/B/C. The dynamic
 * fields section and JSON shape block are prepended by buildParsingPrompt().
 */
const STATIC_PROMPT_BODY = `Rules:
- If a field is not clearly present in the source text, leave it null. Do NOT
  infer or fabricate values from adjacent columns. po_number must only be
  populated if the source explicitly labels a column as PO, P.O., or Purchase
  Order. If the source has no such label, every order's po_number MUST be null.
- Customer names never end in numeric digits. If a customer name appears to
  end in digits, the digits are from an adjacent column (weight, count, etc.)
  — strip them. Customer names are alphabetic words, possibly with punctuation
  like commas, ampersands, or apostrophes.
- Extract ALL orders from the input. If there are no orders (e.g. a customer
  registry), return an empty "orders" array.
- GROUP rows that share an order_number into ONE order with multiple items[].
  Audit-trail and shipping-detail exports list one row per product line, all
  referencing the same order_number — those are line items of a single order,
  NOT separate orders. Emit one order object with that order_number and put
  each product/qty/lot row under "items". Do NOT emit duplicate order objects
  with the same order_number.
- An order_number is a multi-digit invoice/order/sale identifier (e.g. 1784767),
  DISTINCT from the K#####/P###### customer_number. If you cannot find a clear
  order_number column or value in the source, return an empty "orders" array.
  Do NOT use customer_number as the order_number. Never fabricate an order
  entry just because you found a customer row.
- A line of the form "(Kxxxxx) NAME: emails..." or "(Pxxxxxx) NAME: emails..."
  introduces a CUSTOMER, not an order. The K#####/P###### in parentheses is
  the customer_number, NEVER an order_number. Such a line must produce a
  "customers" entry with NO corresponding "orders" entry unless a real
  multi-digit order_number is present elsewhere for that block.
- ALWAYS extract every distinct customer you can identify into the "customers"
  array, even when no order is attached to them. This includes standalone
  customer-registry rows like "(K00166) CHUCKANUT BAY FOODS:" followed by
  contact emails.
- customer_number formats: K##### or P###### (preserve exact format, including
  any leading zeros).
- For each customer, populate "contacts" with EVERY email address found for
  that customer. Each entry must have "email"; include "name" and "role" when
  they can be inferred from adjacent text (e.g. "Alice Smith (AP):
  alice@acme.com" -> {"name":"Alice Smith","email":"alice@acme.com","role":"AP"}).
- If only one email is found, still emit it as a single "contacts" entry AND
  set the customer's top-level "email" field to that same address.
- For customers with multiple emails, also pick one representative address
  for the top-level "email" field — prefer AP/receiving/orders addresses over
  personal names when obvious, otherwise pick the first contact.
- Example: a customer-registry row "(K00166) CHUCKANUT BAY FOODS:
  alice@chuckanut.com; bob@chuckanut.com; orders@chuckanut.com" becomes:
  {"customer_number":"K00166","name":"CHUCKANUT BAY FOODS",
   "email":"orders@chuckanut.com",
   "contacts":[{"email":"alice@chuckanut.com"},{"email":"bob@chuckanut.com"},
               {"email":"orders@chuckanut.com","role":"Orders"}]}
- If no line items are visible for an order, return an empty items array.
- If a field is not present, omit it or set to null.
- ALWAYS emit \`_confidence\` on every order, customer, and line item — a single
  number between 0.0 and 1.0 reflecting how sure you are about that record.
  Calibration:
    1.0  — every required field was unambiguously present in the source.
    0.9  — minor uncertainty (one optional field guessed).
    0.7  — the threshold below which a human will review. Use this when a
           required field was inferred rather than read directly (e.g. you
           split a composite cell), or a label was non-standard, or the
           source format was unusual.
    0.5  — a required field was guessed from limited context.
    0.0  — you fabricated a value; the source did not actually contain this.
  Be honest. A low confidence flag a human can investigate is FAR better
  than fabricating a high-confidence record.
- Return valid JSON only, no explanation.

Few-shot examples:

Example A — Customer registry block (no orders).
A line of the form \`(Kxxxxx) NAME: emails...\` introduces a CUSTOMER, not an
order. The K#####/P###### in parens is the \`customer_number\`, NOT an
\`order_number\`.
Input:
=== Sheet: Monday ===
(K13957) ACME ICE CREAM: alice@acme.com; bob@acme.com; orders@acme.com
PO# | DELIVERY DATE | SKU # | DESCRIPTION | LOT CODE | NOTES | COA SENT
Invoice:
Output:
{
  "orders": [],
  "customers": [
    {
      "customer_number": "K13957",
      "name": "ACME ICE CREAM",
      "contacts": [
        {"email": "alice@acme.com"},
        {"email": "bob@acme.com"},
        {"email": "orders@acme.com"}
      ],
      "_confidence": 0.95
    }
  ]
}

Example B — Real order with line items.
An order_number is a multi-digit invoice/order ID, distinct from the K/P
customer_number. The 1905.80 here is a weight value — strip trailing weight
numbers from customer_name (it's CHUCKANUT BAY FOODS, NOT
CHUCKANUT BAY FOODS 1905).
Input:
Order: 1784767  Customer: K00166 - CHUCKANUT BAY FOODS  Ship Date: 4/10/2026  Weight: 1905.80
Output:
{
  "orders": [
    {
      "order_number": "1784767",
      "customer_number": "K00166",
      "customer_name": "CHUCKANUT BAY FOODS",
      "po_number": null,
      "_confidence": 1.0
    }
  ],
  "customers": [
    {"customer_number": "K00166", "name": "CHUCKANUT BAY FOODS", "_confidence": 1.0}
  ]
}

Example C — Mixed: registry block followed by per-customer rows.
If the block is part of a customer-tracking spreadsheet (no clear order_number
column), treat the rows as customer expectations, not orders. Only emit
\`orders[]\` when the source clearly contains order_numbers (multi-digit
invoice/sale identifiers).
Input:
(K00166) CHUCKANUT BAY FOODS: alice@chuckanut.com
PO# | DATE | SKU | DESCRIPTION | LOT
PO123 | 4/10/2026 | SKU001 | WIDGET | LOT-456
Output:
{
  "orders": [],
  "customers": [
    {
      "customer_number": "K00166",
      "name": "CHUCKANUT BAY FOODS",
      "contacts": [{"email": "alice@chuckanut.com"}],
      "_confidence": 0.9
    }
  ]
}

Example D — Audit-trail-style export (multiple rows per order).
Three source rows ALL reference order_number 1790512 but list different
products / quantities / lot codes. These are line items of ONE order, not
three separate orders. Merge them into a single order with three items[].
Input:
Date     | Product | Description           | Qty | Lot       | Order No.
5/4/2026 | 0406    | WHOLE MILK GAL        | -30 | 052126    | 1790512
5/4/2026 | 10012   | CAGE FREE LIQUID EGGS | -14 | 051926    | 1790512
5/4/2026 | 2235    | DG BTR BULK U/S       |  -2 | 103261021 | 1790512
Output:
{
  "orders": [
    {
      "order_number": "1790512",
      "items": [
        {"product_code": "0406",  "product_name": "WHOLE MILK GAL",        "quantity": -30, "lot_number": "052126",    "_confidence": 1.0},
        {"product_code": "10012", "product_name": "CAGE FREE LIQUID EGGS", "quantity": -14, "lot_number": "051926",    "_confidence": 1.0},
        {"product_code": "2235",  "product_name": "DG BTR BULK U/S",       "quantity": -2,  "lot_number": "103261021", "_confidence": 1.0}
      ],
      "_confidence": 1.0
    }
  ],
  "customers": []
}`;

/**
 * Static preamble — describes the task without enumerating fields. The
 * dynamic field section is slotted in between this and STATIC_PROMPT_BODY.
 */
const STATIC_PROMPT_PREAMBLE = `/no_think
You are an ERP report parser. Extract order AND customer data from the input.
The input may be an order email, a PDF order confirmation, or a customer-registry
spreadsheet (one customer per block, followed by that customer's expected products).
`;

/**
 * Prepend reviewer-authored connector-level guidance to a Qwen system prompt.
 * No-op when `instructions` is empty/whitespace. Header format mirrors the
 * DOCUMENT-path prepend in `bin/process-worker:482` (`prependReviewerInstructions`)
 * so the two surfaces stay shape-symmetric — important since reviewers see
 * the same "## Reviewer instructions" cue in both review queues.
 *
 * Exported for unit tests on the prompt-construction path.
 */
export function prependConnectorInstructions(
  prompt: string,
  instructions: string | undefined,
): string {
  if (!instructions || !instructions.trim()) return prompt;
  const header = [
    '## Reviewer instructions',
    'The following guidance comes from human reviewers of past runs of this connector. Follow it carefully:',
    '',
    instructions.trim(),
    '',
    '---',
    '',
  ].join('\n');
  return header + prompt;
}

/**
 * Compose a full Qwen system prompt from a v2 field-mappings config.
 *
 * Structure:
 *   /no_think header + preamble
 *   -> dynamic "Fields to extract" section (per-field with aliases + hints)
 *   -> dynamic "Return JSON in this exact format" block
 *   -> static rules block + few-shot examples A/B/C
 *
 * The static tail preserves every hard rule the regression tests assert on:
 *   - fabrication guard / PO label gate
 *   - customer-name digit-strip rule
 *   - "Do NOT use customer_number as the order_number"
 *   - Few-shot anchors (K13957 ACME, 1784767 CHUCKANUT)
 */
export function buildParsingPrompt(
  mappings: ConnectorFieldMappings,
  options?: { customPreamble?: string },
): string {
  const preamble = options?.customPreamble ?? STATIC_PROMPT_PREAMBLE;
  const fieldsSection = buildAiFieldsSection(mappings);
  const jsonShape = buildJsonShapeForPrompt(mappings);
  return `${preamble}
${fieldsSection}

${jsonShape}

${STATIC_PROMPT_BODY}`;
}

/**
 * Back-compat wrapper returning the prompt for the default field-mapping
 * config. The regression tests in tests/unit/extraction-prompt.test.ts target
 * this signature.
 */
export function getDefaultParsingPrompt(): string {
  return buildParsingPrompt(defaultFieldMappings());
}
