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
    //
    // Since migration 0098 the block can carry TWO layers (document-type and
    // supplier), so the header names both and no longer claims everything in
    // it came from "this supplier and document type". The byte-for-byte
    // agreement with functions/lib/llm.ts is pinned separately, in
    // tests/unit/extractionGuidanceBlock.test.ts.
    expect(processWorkerSource).toMatch(/function prependReviewerInstructions\s*\(/);
    expect(processWorkerSource).toContain('## Reviewer instructions');
    expect(processWorkerSource).toContain(
      'The following guidance was authored by the people who review these documents.'
    );
    // The rule-14 guard: authored guidance can never become licence to invent a
    // unit, because a result carrying an invented unit is dropped from spec
    // checking silently.
    expect(processWorkerSource).toContain(
      'never licenses you to supply a unit, specification or verdict the document did not print'
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
    // buildPrompt now also takes the tenant-level extraction context as its
    // 2nd arg (the editable per-tenant industry layer); combo reviewer
    // instructions still stack on top.
    // Third arg (2026-09-03): the type the pre-extraction classification pass
    // settled on. It is what lets the prompt say what the document IS on the
    // FIRST call instead of after a re-extract.
    expect(processWorkerSource).toMatch(
      /prependReviewerInstructions\(buildPrompt\(examples, tenantContext, classifiedTypeName\), reviewerInstructions\)/
    );
  });

  it('applies prependReviewerInstructions to the VLM-path system prompt', () => {
    // Same requirement for the VLM path — dual mode sends the same doc to
    // both models and both need the guidance.
    expect(processWorkerSource).toMatch(
      /prependReviewerInstructions\(buildVlmPrompt\(examples, tenantContext, classifiedTypeName\), reviewerInstructions\)/
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

describe('process-worker — late supplier resolution and re-extraction', () => {
  // This block lives in processCoaItem, AFTER the primary extraction produces
  // `parsed`. We slice from its heading to the supplier_name read so assertions
  // target that region, not the unrelated first-pass wiring.
  //
  // It used to rescue the DOCUMENT TYPE as well. Since 2026-09-03 the type is
  // decided by its own pass BEFORE extraction, so the type half survives here
  // only as a fallback for an item the classifier could not settle; what this
  // block is really for now is the supplier, which is genuinely a fact of the
  // document body and cannot be known any earlier.
  const twoPass = (() => {
    const start = processWorkerSource.indexOf('Late supplier resolution');
    const end = processWorkerSource.indexOf('const supplier = parsed.fields?.supplier_name', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    return processWorkerSource.slice(start, end);
  })();

  it('only attempts pass 2 when pass 1 learned something it did not have', () => {
    // The zero-extra-cost guard. Pass 1 may already have had the supplier, the
    // document type, both or neither; pass 2 fetches again only when one of
    // them was resolved late, and re-extracts only when the guidance that comes
    // back actually differs from what pass 1 already sent.
    expect(twoPass).toContain('const learnedSomethingNew');
    expect(twoPass).toMatch(/if \(learnedSomethingNew && \(lateSupplierId \|\| lateDocTypeId\)\)/);
  });

  it('resolves the supplier from the post-extraction supplier_name', () => {
    // It must use the canonicalized parsed.fields.supplier_name (what the LLM
    // extracted) and resolve it via the same resolveSupplierIdByName helper
    // pass 1 uses.
    expect(twoPass).toContain('parsed.fields?.supplier_name');
    expect(twoPass).toMatch(/resolveSupplierIdByName\(item\.tenant_id,\s*lateSupplierName\)/);
  });

  it('fetches guidance for BOTH the late-resolved supplier and the late-resolved type', () => {
    // Either may still be null; the endpoint answers on whichever key it gets.
    expect(twoPass).toMatch(
      /fetchReviewerInstructions\(\s*item\.tenant_id,\s*lateSupplierId,\s*lateDocTypeId\s*\)/
    );
  });

  it('resolves the document type from the model\'s own guess, EXACT matches only', () => {
    // The document type is promoted only AFTER extraction, so the 0098 type
    // layer usually has nothing to key on in pass 1 — for a mixed corpus of
    // certificates that is the normal case. A substring / acronym hit is
    // deliberately not good enough: guidance steers what the model reads, and
    // "Certificate" must not pull an insurance certificate's instructions onto
    // a COA. This mirrors the promotion rule, which is also exact-only.
    expect(twoPass).toContain('fuzzyMatchDocType(parsed.documentType, item.tenant_id, docTypeCatalog)');
    expect(twoPass).toMatch(/dtMatch\.matchType === 'exact'/);
  });

  it('only re-extracts when non-empty, DIFFERENT instructions come back', () => {
    // Gated on the guidance actually being found (and non-whitespace) so docs
    // with none pay zero extra cost — and on it differing from what pass 1
    // used, so re-resolving to the same text never costs a second Qwen call.
    expect(twoPass).toContain('lateInstructions.trim()');
    expect(twoPass).toMatch(
      /lateInstructions\.trim\(\) !== \(reviewerInstructions \|\| ''\)\.trim\(\)/
    );
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
    expect(twoPass).toMatch(/Re-extracting with guidance resolved post-extraction/);
    // Both resolved keys are named in the line: an operator reading it has to
    // be able to tell WHICH layer arrived late.
    expect(twoPass).toContain('doctype=');
    expect(twoPass).toContain('supplier=');
  });

  it('treats the post-extraction re-extract as best-effort (never throws)', () => {
    // A failed re-extraction must fall back to the pass-1 parsed result, never
    // block posting.
    expect(twoPass).toMatch(/catch \(err\)[\s\S]*?Post-extraction instruction re-extract failed/);
    expect(twoPass).toContain('keeping pass-1 result');
  });
});
