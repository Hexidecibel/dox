/**
 * Regression tests for getDefaultParsingPrompt() in shared/orderPrompt.ts.
 * (Moved out of the deleted functions/lib/connectors/email.ts during the
 * Connectors → Sources refactor; the prompt + sanitizer helpers are pure
 * and now live in the shared module consumed by both Worker and worker.)
 *
 * The prompt is the single biggest lever on extraction quality. These tests
 * lock in the hard rules that fixed real hallucinations observed in the
 * end-to-end PDF test run on 2026-04-09:
 *
 *   - "Do not fabricate fields" rule: prevents po_number from being filled
 *     with values from adjacent columns when the source has no PO column.
 *   - "Customer names never end in digits" rule: prevents weight/count
 *     values from bleeding into customer_name when the PDF text extraction
 *     lacks column whitespace.
 */

import { describe, it, expect } from 'vitest';
import { getDefaultParsingPrompt, sanitizeCustomerName } from '../../shared/orderPrompt';
import { stripUnfilledPlaceholders, DEFAULT_DAIRY_CONTEXT } from '../../functions/lib/llm';

describe('getDefaultParsingPrompt — hard rules', () => {
  const prompt = getDefaultParsingPrompt();

  it('does NOT carry a /no_think directive (proven inert on the `best` chain)', () => {
    // Inverted 2026-08-05. The order path resolves the `best` tag, i.e.
    // Qwen3.6-35B-A3B, whose chat template defaults thinking OFF and IGNORES
    // `/no_think` — direct endpoint probing showed byte-identical output and
    // zero `reasoning_content` with and without the string. The real switch is
    // a request-body field, `chat_template_kwargs: { enable_thinking: true }`.
    // This assertion is now a TRAP GUARD: it fails if anyone re-adds the
    // string believing it suppresses reasoning here. (The connector
    // schema-discovery prompt legitimately keeps it — that path uses the
    // `fast` chain, which can fall back to Qwen3-8B, which does honour it.)
    expect(prompt).not.toContain('/no_think');
  });

  it('contains an explicit anti-hallucination rule for missing fields', () => {
    // Catches wording drift. The exact phrase "Do NOT infer or fabricate"
    // is load-bearing — an earlier softer version ("try not to guess") did
    // not stop the model.
    expect(prompt).toMatch(/Do NOT\s+infer or fabricate/);
    expect(prompt).toMatch(/adjacent columns/);
  });

  it('pins po_number to an explicit PO/P.O./Purchase Order label', () => {
    // Bug #5: the model was populating po_number from the route column
    // (705, 505, 600...) because the prompt did not explicitly gate it.
    expect(prompt).toMatch(/po_number/);
    expect(prompt).toMatch(/PO, P\.O\., or Purchase\s+Order/);
  });

  it('forbids customer_name values that end in numeric digits', () => {
    // Bug #6: weight values (247 lbs, 24 lbs) were being concatenated
    // onto customer_name (e.g. "HERITAGE 247", "HERITAGE 24") because the
    // PDF text extraction has no column whitespace.
    expect(prompt).toMatch(/Customer names never end in numeric digits/);
    expect(prompt).toMatch(/strip them/i);
  });

  it('still instructs the model to return valid JSON only', () => {
    // Sanity: the original JSON-only directive survives the edits.
    expect(prompt).toMatch(/Return valid JSON only/);
  });

  it('still specifies the expected JSON shape for orders and customers', () => {
    // Sanity: the JSON schema block with orders + customers is still present.
    expect(prompt).toMatch(/"orders"/);
    expect(prompt).toMatch(/"customers"/);
    expect(prompt).toMatch(/"customer_number"/);
    expect(prompt).toMatch(/"contacts"/);
  });

  it('forbids using customer_number as the order_number', () => {
    // Bug observed 2026-04-13: Qwen3-8B mapped customer-registry rows
    // like "(K13957) ACME ICE CREAM: emails..." into orders[] with
    // order_number = K13957. The rule below is the explicit guard.
    expect(prompt).toMatch(/Do NOT use customer_number as the order_number/);
    expect(prompt).toMatch(/return an empty "orders" array/);
  });

  it('has a Few-shot examples section header', () => {
    // Few-shot examples were added after end-to-end testing showed rules
    // alone were not enough to stop Qwen3-8B from confusing registry rows
    // with orders. The header anchors the section for future edits.
    expect(prompt).toMatch(/Few-shot examples/);
  });

  it('includes the Example A customer-registry fragment verbatim', () => {
    // Anchors the K13957 ACME registry example so refactors do not drop
    // the concrete shape the model needs.
    expect(prompt).toContain('(K13957) ACME ICE CREAM');
  });

  it('includes the Example B real-order fragment verbatim', () => {
    // Anchors the 1784767 / CHUCKANUT BAY FOODS real-order example.
    expect(prompt).toContain('1784767');
  });
});

describe('sanitizeCustomerName — post-parse safety net', () => {
  // This is the belt-and-suspenders backstop for the prompt rule above:
  // Qwen3-8B ignored the "no trailing digits" rule on certain PDF layouts
  // ("HERITAGE 247" leaked through), so parseWithAI scrubs the names after
  // JSON.parse. These tests document the exact contract.

  it('strips a single trailing digit group preceded by whitespace', () => {
    expect(sanitizeCustomerName('HERITAGE 247')).toBe('HERITAGE');
  });

  it('strips multiple trailing digit groups repeatedly', () => {
    expect(sanitizeCustomerName('HERITAGE 247 88')).toBe('HERITAGE');
    expect(sanitizeCustomerName('MERITAGE SOUPS 39 88 7')).toBe('MERITAGE SOUPS');
  });

  it('is a no-op when there are no trailing digits', () => {
    expect(sanitizeCustomerName('HERITAGE')).toBe('HERITAGE');
    expect(sanitizeCustomerName('CHUCKANUT BAY FOODS')).toBe('CHUCKANUT BAY FOODS');
  });

  it('preserves leading digits — only trailing digits are stripped', () => {
    expect(sanitizeCustomerName('3M COMPANY')).toBe('3M COMPANY');
    expect(sanitizeCustomerName('24/7 FOODS')).toBe('24/7 FOODS');
  });

  it('requires a whitespace boundary before the trailing digits', () => {
    // Documented decision: "HERITAGE2024" could be a real brand-year
    // concat (e.g. "HERITAGE2024 EDITION"). Without a whitespace separator
    // we can't tell that apart from a column-spill, so we leave it alone.
    // Only `\s+\d+$` is stripped.
    expect(sanitizeCustomerName('HERITAGE2024')).toBe('HERITAGE2024');
    expect(sanitizeCustomerName('BRAND-247')).toBe('BRAND-247');
  });

  it('strips trailing digits after punctuation-terminated names', () => {
    expect(sanitizeCustomerName('ACME, INC. 123')).toBe('ACME, INC.');
    expect(sanitizeCustomerName("MERITAGE'S BAKERY 99")).toBe("MERITAGE'S BAKERY");
  });

  it('returns empty string for empty / null / undefined input', () => {
    expect(sanitizeCustomerName('')).toBe('');
    expect(sanitizeCustomerName(null)).toBe('');
    expect(sanitizeCustomerName(undefined)).toBe('');
  });

  it('trims extra whitespace left behind after stripping', () => {
    expect(sanitizeCustomerName('HERITAGE   247')).toBe('HERITAGE');
    expect(sanitizeCustomerName('  HERITAGE 247  ')).toBe('HERITAGE');
  });

  it('leaves year-like trailing digits alone when there is no column evidence', () => {
    // Per the contract above, whitespace-separated trailing digits ARE
    // stripped regardless of whether they look like a year. This test
    // documents that behavior as intentional, not a bug. If the model
    // ever needs to preserve a trailing year it must be attached without
    // whitespace ("BRAND2024").
    expect(sanitizeCustomerName('HERITAGE BRAND 2024')).toBe('HERITAGE BRAND');
  });
});

describe('stripUnfilledPlaceholders — industry-context sanitizer', () => {
  // The tenant "extraction context" (migration 0072) is a WHOLE editable block
  // that replaces DEFAULT_DAIRY_CONTEXT; there is no per-tenant org-description
  // field that fills a slot. `ORG CONTEXT:` + its `[Describe your organization
  // … edit this]` line is an instruction to the human EDITING that template
  // (served as `default_template` so the editor UI can seed itself) — and,
  // unedited, it shipped verbatim to the model on every extraction call.
  // These tests lock in: gone from the wire, still present in the template.

  const stripped = stripUnfilledPlaceholders(DEFAULT_DAIRY_CONTEXT);

  it('removes the unfilled ORG CONTEXT block from the assembled context', () => {
    expect(DEFAULT_DAIRY_CONTEXT).toContain('ORG CONTEXT:');
    expect(stripped).not.toContain('ORG CONTEXT:');
    expect(stripped).not.toContain('[Describe your organization');
  });

  it('leaves the template itself intact (the editor affordance survives)', () => {
    // Only the assembled prompt is sanitized. The seed the UI shows must still
    // prompt the tenant to describe their org.
    expect(DEFAULT_DAIRY_CONTEXT).toContain('[Describe your organization');
  });

  it('does NOT eat JSON rows from the worked example', () => {
    // REGRESSION: the first implementation stripped any whole line matching
    // /^\s*\[[^\]]*\]\s*$/, which also matched this row of the example
    // extraction's `tables[].rows` and silently deleted it. Caught only by
    // diffing real DUMP_PROMPT_DIR bytes. Never remove this assertion.
    expect(stripped).toContain('["Standard Plate Count", "AOAC 989.10", "<20,000", "4,500", "CFU/g", "Pass"]');
    expect(stripped).toContain('["Fat Content", "SMEDP 15.122", ">80%", "81.2", "%", "Pass"]');
  });

  it('keeps every substantive block of the dairy context', () => {
    expect(stripped).toContain('INDUSTRY CONTEXT — Dairy & Food:');
    expect(stripped).toContain('DAIRY COA DOMAIN RULES');
    expect(stripped).toContain('EXAMPLE — Dairy COA extraction:');
  });

  it('drops only the placeholder paragraph, nothing else', () => {
    const removed = DEFAULT_DAIRY_CONTEXT.length - stripped.length;
    // heading + placeholder line + the blank line that separated them
    expect(removed).toBeGreaterThan(200);
    expect(removed).toBeLessThan(320);
  });

  it('preserves a block the tenant actually filled in', () => {
    const filled = 'ORG CONTEXT:\nWe are a dairy distributor.\n\nOTHER:\n- rule';
    expect(stripUnfilledPlaceholders(filled)).toBe(filled);
  });

  it('preserves a paragraph that mixes real prose with a leftover placeholder', () => {
    // Conservative by design: if the tenant wrote anything real in the block we
    // keep the whole block rather than guess which line they meant.
    const mixed = 'ORG CONTEXT:\n[Describe your organization here please]\nWe are a dairy distributor.';
    expect(stripUnfilledPlaceholders(mixed)).toBe(mixed);
  });

  it('is a no-op on empty / whitespace input', () => {
    expect(stripUnfilledPlaceholders('')).toBe('');
    expect(stripUnfilledPlaceholders('   ')).toBe('   ');
  });
});
