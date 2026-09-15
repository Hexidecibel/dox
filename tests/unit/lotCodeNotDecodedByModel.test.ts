/**
 * The extraction model does not decode lot codes (Any-Field COA Retrieval,
 * Phase 4; AJ §6).
 *
 * Every copy of the extraction prompt used to say: `Julian dates (e.g., "6094")
 * mean day 094 of 2026 — convert when identifiable`. That is a GLOBAL, silent,
 * authoritative decode — exactly what AJ forbids: "Build it as a per-supplier
 * parser with a declared pattern, registered against the supplier record. Do not
 * write a global regex." A model converting a code into a production date also
 * erases the one thing the declared-format validator needs to catch a disagreement
 * (a decoded date filed as if the page printed it).
 *
 * Decoding now belongs to shared/lotScheme.ts, per supplier, labelled 'lot_decode'.
 * The three prompt copies (functions/lib/llm.ts BASE_PROMPT, the worker's text
 * and VLM prompts) and the two industry-context copies are pinned here:
 * identical, and without the instruction. A copy left behind would decode on
 * one surface only, silently.
 *
 * The process-worker needs a restart to pick the change up.
 */
import { describe, it, expect } from 'vitest';
import processWorkerSource from '../../bin/process-worker?raw';
import llmSource from '../../functions/lib/llm.ts?raw';
import { DEFAULT_DAIRY_CONTEXT } from '../../functions/lib/llm';

const dateRules = (src: string) => src.split('\n').filter((l) => l.startsWith('2. For dates:'));
const julianHints = (src: string) => src.split('\n').filter((l) => l.startsWith('- Code dates may'));

describe('no prompt copy tells the model to decode a lot or Julian code', () => {
  it('finds the date rule in the text path, the VLM path and the Pages copy — identical', () => {
    const rules = [...dateRules(processWorkerSource), ...dateRules(llmSource)];
    expect(rules).toHaveLength(3);
    for (const r of rules.slice(1)) expect(r).toBe(rules[0]);
    expect(rules[0]).toContain('never decode or convert it');
    expect(rules[0]).toContain('Copy the code exactly as printed');
    expect(rules[0]).toContain("supplier's declared lot format");
  });

  it('carries the old conversion instruction nowhere', () => {
    for (const src of [processWorkerSource, llmSource]) {
      expect(src).not.toMatch(/convert when identifiable/i);
      expect(src).not.toMatch(/Julian dates \(e\.g\., "6094"\) mean/);
    }
  });

  it('keeps the industry-context hint identical in both copies, and it forbids converting', () => {
    const hints = [...julianHints(processWorkerSource), ...julianHints(llmSource)];
    expect(hints.length).toBeGreaterThanOrEqual(2);
    for (const h of hints.slice(1)) expect(h).toBe(hints[0]);
    expect(hints[0]).toContain('never convert one to a calendar date');
    expect(DEFAULT_DAIRY_CONTEXT).toContain('never convert one to a calendar date');
  });
});
