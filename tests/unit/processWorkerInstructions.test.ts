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

  it('resolves supplier_id from item.supplier with normalized matching', () => {
    // Matching normalizes case, punctuation, and company suffixes so a queue
    // item carrying "Darigold Inc." resolves to a "Darigold" supplier row,
    // then falls back to a single unambiguous containment match. A loose
    // multi-hit LIKE result must NOT be attached (would pull another
    // supplier's guidance).
    expect(processWorkerSource).toMatch(/async function resolveSupplierIdByName\s*\(/);
    expect(processWorkerSource).toContain('const exact = rows.find(s => normalize(s.name) === target)');
    expect(processWorkerSource).toMatch(/inc\|llc\|co\|corp/);
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

describe('process-worker — two-pass post-extraction instruction application', () => {
  // The two-pass block lives in processCoaItem, AFTER the primary extraction
  // produces `parsed`. We slice from the supplier_name read to the end of the
  // re-extract guard so assertions target that region, not the unrelated
  // pass-1 wiring.
  const twoPass = (() => {
    const start = processWorkerSource.indexOf('Two-pass reviewer-instruction application');
    const end = processWorkerSource.indexOf('const supplier = parsed.fields?.supplier_name', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    return processWorkerSource.slice(start, end);
  })();

  it('only attempts pass 2 when pass 1 applied NO instructions', () => {
    // Gating on !reviewerInstructions means suppliers known upfront keep
    // today's single-call behavior; pass 2 is reserved for the late-resolved
    // case. This is the zero-extra-cost guard.
    expect(twoPass).toMatch(/if \(!reviewerInstructions\)/);
  });

  it('resolves the supplier from the post-extraction supplier_name', () => {
    // It must use the canonicalized parsed.fields.supplier_name (what the LLM
    // extracted) and resolve it via the same resolveSupplierIdByName helper
    // pass 1 uses.
    expect(twoPass).toContain('parsed.fields?.supplier_name');
    expect(twoPass).toMatch(/resolveSupplierIdByName\(item\.tenant_id,\s*lateSupplierName\)/);
  });

  it('fetches reviewer instructions for the late-resolved supplier', () => {
    // doctype may be null here — fetchReviewerInstructions falls back to
    // supplier-wide guidance, which is already supported.
    expect(twoPass).toMatch(
      /fetchReviewerInstructions\(\s*item\.tenant_id,\s*lateSupplierId,\s*item\.document_type_id\s*\)/
    );
  });

  it('only re-extracts when non-empty instructions come back', () => {
    // The re-extract is gated on instructions actually being found (and
    // non-whitespace) so docs with no guidance pay zero extra cost.
    expect(twoPass).toMatch(/if \(lateInstructions && lateInstructions\.trim\(\)\)/);
  });

  it('re-runs the SAME path that produced the primary parsed', () => {
    // Pass 2 reuses runVlmSafe() or runTextPath() depending on which path was
    // primary — multi-page chunking, VLM mode, confidence all unchanged.
    expect(twoPass).toMatch(/if \(primaryPath === 'vlm'\)/);
    expect(twoPass).toContain('await runVlmSafe()');
    expect(twoPass).toContain('await runTextPath()');
  });

  it('feeds the late instructions into the closed-over prompt builders', () => {
    // runTextPath()/runVlmSafe() read `reviewerInstructions` at call time, so
    // it must be reassigned before re-running for the guidance to take effect.
    expect(twoPass).toContain('reviewerInstructions = lateInstructions');
  });

  it('guards against re-extraction loops (at most one re-extract)', () => {
    // No while/for loop around the re-extract; the whole block runs once and
    // is gated on the pass-1 !reviewerInstructions condition that the
    // reassignment immediately invalidates.
    expect(twoPass).not.toMatch(/\bwhile\s*\(/);
    expect(twoPass).not.toMatch(/\bfor\s*\(/);
  });

  it('logs the post-extraction re-extract clearly', () => {
    expect(twoPass).toMatch(/Re-extracting with reviewer instructions for supplier/);
    expect(twoPass).toContain('(resolved post-extraction)');
  });

  it('treats the post-extraction re-extract as best-effort (never throws)', () => {
    // A failed re-extraction must fall back to the pass-1 parsed result, never
    // block posting.
    expect(twoPass).toMatch(/catch \(err\)[\s\S]*?Post-extraction instruction re-extract failed/);
    expect(twoPass).toContain('keeping pass-1 result');
  });
});
