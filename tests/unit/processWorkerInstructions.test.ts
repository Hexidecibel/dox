/**
 * Unit tests for the reviewer-instructions wiring in bin/process-worker.
 *
 * process-worker is a standalone Node daemon that can't be imported directly
 * into the Workers test pool, so we load its source as a raw string and
 * assert on the prompt-injection helpers and control-flow wiring — the same
 * strategy processWorkerVlm.test.ts uses.
 *
 * This covers step 4 of the per-supplier extraction-instructions feature.
 */

import { describe, it, expect } from 'vitest';
// Vite's ?raw import — works inside the Workers test pool because Vite
// inlines the file contents at build time.
import processWorkerSource from '../../bin/process-worker?raw';

describe('process-worker — reviewer instructions wiring', () => {
  it('declares a fetchReviewerInstructions helper that hits /api/extraction-instructions', () => {
    expect(processWorkerSource).toMatch(/async function fetchReviewerInstructions\s*\(/);
    expect(processWorkerSource).toContain('/api/extraction-instructions');
  });

  it('declares a prependReviewerInstructions helper with the spec header', () => {
    // The header text is load-bearing — the worker prepends exactly this
    // block before the system prompt so reviewers see their guidance
    // surface first in the Qwen context.
    expect(processWorkerSource).toMatch(/function prependReviewerInstructions\s*\(/);
    expect(processWorkerSource).toContain('## Reviewer instructions');
    expect(processWorkerSource).toContain(
      'The following guidance comes from human reviewers of past documents from this supplier and document type. Follow it carefully:'
    );
  });

  it('short-circuits prependReviewerInstructions when instructions is empty', () => {
    // Empty/whitespace instructions must return the prompt unchanged so
    // first-time suppliers (no guidance yet) pay zero prompt cost.
    expect(processWorkerSource).toMatch(
      /if \(!instructions \|\| !instructions\.trim\(\)\) return prompt;/
    );
  });

  it('resolves supplier_id from item.supplier before fetching instructions', () => {
    // Must use the exact (case-insensitive) name match path — not a loose
    // LIKE hit — to avoid attaching another supplier's guidance.
    expect(processWorkerSource).toMatch(/async function resolveSupplierIdByName\s*\(/);
    expect(processWorkerSource).toContain("rows.find(s => (s.name || '').toLowerCase().trim() === lower)");
  });

  it('applies prependReviewerInstructions to the text-path system prompt', () => {
    // The text-path Qwen call must receive buildPrompt() wrapped in
    // prependReviewerInstructions() so reviewer guidance gets honored.
    expect(processWorkerSource).toMatch(
      /prependReviewerInstructions\(buildPrompt\(examples\), reviewerInstructions\)/
    );
  });

  it('applies prependReviewerInstructions to the VLM-path system prompt', () => {
    // Same requirement for the VLM path — dual mode sends the same doc to
    // both models and both need the guidance.
    expect(processWorkerSource).toMatch(
      /prependReviewerInstructions\(buildVlmPrompt\(examples\), reviewerInstructions\)/
    );
  });

  it('logs a single-line confirmation when instructions are loaded', () => {
    // Operators rely on this log line to confirm the lookup ran for a given
    // queue item; removing it would hide the feature in staging. Match the
    // exact format minus the interpolations.
    expect(processWorkerSource).toMatch(/Reviewer instructions loaded: \$\{reviewerInstructions\.length\} chars/);
  });

  it('treats the instructions fetch as best-effort (never throws)', () => {
    // The try/catch around the fetchReviewerInstructions call must swallow
    // errors so a guidance-table hiccup can't block legit extraction.
    expect(processWorkerSource).toMatch(
      /reviewerInstructions = await fetchReviewerInstructions\([\s\S]*?\n\s*\);/
    );
    // The inner helpers also have their own try/catch → return ''.
    const fnStart = processWorkerSource.indexOf('async function fetchReviewerInstructions');
    const fnSlice = processWorkerSource.slice(fnStart, fnStart + 1500);
    expect(fnSlice).toMatch(/return ''/);
  });
});
