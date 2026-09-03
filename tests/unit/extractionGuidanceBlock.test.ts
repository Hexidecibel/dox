/**
 * The authored-guidance block must not drift between prompt surfaces.
 *
 * WHY THIS TEST EXISTS
 * The header that introduces reviewer-authored guidance is written out TWICE by
 * hand — once in bin/process-worker (the surface that runs the corpus) and once
 * in functions/lib/llm.ts (the Pages surface behind email ingest). Migration
 * 0098 added a second layer of guidance (document-type instructions) into that
 * block, which meant editing the header on both surfaces. The last time a
 * prompt rule shipped on one copy and not the other it produced a live
 * extraction defect, so the two are pinned here — modelled on
 * tests/unit/tableExtractionRules.test.ts, which pins the BASE_PROMPT copies.
 *
 * WHAT ELSE IS ASSERTED
 * The header carries a rule-14 guard: a sentence saying that guidance can never
 * license the model to supply a unit, specification or verdict the document did
 * not print. That guard is the reason the block is safe to widen at all.
 * Authored guidance is free text; without the guard, a reviewer sentence like
 * "results on this COA are in CFU/g" reads as permission to stamp a unit onto
 * rows that printed none, and a result carrying an invented unit is dropped
 * from spec checking silently. The guard is asserted separately from the
 * byte-equality check so that deleting it fails with the reason attached.
 */

import { describe, it, expect } from 'vitest';
import processWorkerSource from '../../bin/process-worker?raw';
import { GUIDANCE_BLOCK_HEADER, prependGuidance } from '../../functions/lib/llm';

/**
 * Pull the worker's GUIDANCE_BLOCK_HEADER lines out of its source. The constant
 * is an array of single-quoted strings joined with newlines, exactly as in
 * llm.ts, so the two can be compared line for line.
 */
function workerHeaderLines(): string[] {
  const m = processWorkerSource.match(
    /const GUIDANCE_BLOCK_HEADER = \[\n([\s\S]*?)\n\]\.join\('\\n'\);/,
  );
  expect(m, 'GUIDANCE_BLOCK_HEADER not found in bin/process-worker').toBeTruthy();
  return m![1]
    .split('\n')
    .map((l) => l.trim().replace(/,$/, ''))
    .filter((l) => l.length > 0)
    .map((l) => {
      const q = l.match(/^'([\s\S]*)'$/);
      expect(q, `unexpected literal form in GUIDANCE_BLOCK_HEADER: ${l}`).toBeTruthy();
      // The only escape the header uses is \' for an apostrophe.
      return q![1].replace(/\\'/g, "'");
    });
}

describe('the authored-guidance block stays in sync across prompt surfaces', () => {
  it('declares a byte-identical header in the worker and in functions/lib/llm.ts', () => {
    expect(workerHeaderLines().join('\n')).toBe(GUIDANCE_BLOCK_HEADER);
  });

  it('keeps the rule-14 guard, on both copies', () => {
    // An invented unit cannot be matched against a configured limit, so it is
    // dropped from spec checking with nobody told. Guidance may say where to
    // look; it may never say what the page said.
    for (const [name, text] of [
      ['functions/lib/llm.ts', GUIDANCE_BLOCK_HEADER],
      ['bin/process-worker', workerHeaderLines().join('\n')],
    ] as const) {
      expect(text, `${name}: guard sentence missing`).toContain(
        'never licenses you to supply a unit, specification or verdict the document did not print',
      );
      expect(text, `${name}: the rules must still outrank guidance`).toContain(
        'never overrides the extraction rules below',
      );
    }
  });

  it('names both layers, so the model knows which text refines which', () => {
    expect(GUIDANCE_BLOCK_HEADER).toContain('KIND of document from any supplier');
    expect(GUIDANCE_BLOCK_HEADER).toContain('supplier-specific text wins');
  });
});

describe('prependGuidance', () => {
  it('is a no-op on empty guidance, so an unconfigured tenant sees no prompt change', () => {
    const base = 'BASE PROMPT';
    expect(prependGuidance(base, '')).toBe(base);
    expect(prependGuidance(base, null)).toBe(base);
    expect(prependGuidance(base, '   ')).toBe(base);
  });

  it('composes rather than substitutes — the base prompt survives underneath', () => {
    const out = prependGuidance('BASE PROMPT', 'read the top-right box');
    expect(out).toContain('BASE PROMPT');
    expect(out).toContain('read the top-right box');
    // Guidance first, base rules after: the same position reviewer instructions
    // have always occupied in the worker's assembled prompt.
    expect(out.indexOf('read the top-right box')).toBeLessThan(out.indexOf('BASE PROMPT'));
  });

  it('produces the same text the worker would', () => {
    // The worker builds `${HEADER}\n\n${instructions}\n\n---\n\n${prompt}`.
    // Pinning the exact shape here keeps the two prepend helpers comparable by
    // eye when either is edited.
    expect(prependGuidance('P', 'G')).toBe(`${GUIDANCE_BLOCK_HEADER}\n\nG\n\n---\n\nP`);
  });
});
