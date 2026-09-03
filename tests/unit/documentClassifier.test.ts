/**
 * The document-type classification pass — its prompt must not drift, and its
 * answer-validation must stay exact.
 *
 * WHY THE PASS EXISTS
 * `document_type` used to fall out of the extraction call. That made the type a
 * by-product of the very call that needs it most: the document-type instruction
 * layer (migration 0098) is KEYED on the type, so guidance could only ever be
 * applied by RE-extracting, and the pass that decided the type was by
 * definition the unguided one. Measured on tests/fixtures/doctype-corpus that
 * cost 21 of 40 documents — every organic, kosher, gluten-free and third-party
 * audit certificate came back "Certificate of Analysis", so the guidance missed
 * exactly the documents it was written for.
 *
 * WHY IT IS PINNED
 * The prompt is written out TWICE by hand: functions/lib/llm.ts (the Pages
 * surface, behind email ingest) and bin/process-worker (the surface that runs
 * the corpus). A prompt rule shipping on one copy and not the other has already
 * produced one live extraction defect, which is why
 * tests/unit/tableExtractionRules.test.ts exists; this file extends the same
 * discipline to the classifier and to the block that hands its answer to
 * extraction.
 */
import { describe, it, expect } from 'vitest';
import processWorkerSource from '../../bin/process-worker?raw';
import {
  CLASSIFIER_PROMPT,
  classifiedTypeBlock,
  matchCandidate,
  normalizeTypeName,
  CLASSIFIER_TEXT_BUDGET,
} from '../../functions/lib/llm';

/** The worker's copy of the classifier prompt, read out of its source. */
function workerClassifierPrompt(): string {
  const m = processWorkerSource.match(/\nconst CLASSIFIER_PROMPT = `([\s\S]*?)`;\n/);
  expect(m, 'CLASSIFIER_PROMPT not found in bin/process-worker').toBeTruthy();
  return m![1];
}

/**
 * The worker's own classifiedTypeBlock, compiled from its source and called.
 * Comparing the two functions' OUTPUT (rather than eyeballing two string
 * literals) is what makes this a real parity check: a stray space in either
 * copy fails it.
 */
function workerClassifiedTypeBlock(documentType: string): string {
  const m = processWorkerSource.match(/function classifiedTypeBlock\(documentType\) \{\n([\s\S]*?)\n\}\n/);
  expect(m, 'classifiedTypeBlock not found in bin/process-worker').toBeTruthy();
  return new Function('documentType', m![1])(documentType) as string;
}

describe('the classifier prompt stays in sync across prompt surfaces', () => {
  it('is byte-identical in bin/process-worker and functions/lib/llm.ts', () => {
    expect(workerClassifierPrompt()).toBe(CLASSIFIER_PROMPT);
  });

  it('keeps the four decision rules the 21/40 misclassification was traced to', () => {
    // Each of these is a measured defect class, not a stylistic preference.
    // A COA is the default a model falls back to, so the prompt has to say
    // what a COA actually is before it says anything else.
    expect(CLASSIFIER_PROMPT).toContain('MEASURED RESULTS for a specific lot or batch');
    // The word "certificate" appearing in a title was the single strongest
    // wrong signal: organic, kosher, gluten-free and audit certificates all
    // carry it, and all four collapsed onto Certificate of Analysis.
    expect(CLASSIFIER_PROMPT).toContain('however often the word "certificate" appears');
    // The letterhead on a certificate is the issuer — the same inversion
    // FIELD EXTRACTION rule 6 fixes for supplier_name.
    expect(CLASSIFIER_PROMPT).toContain('is usually the body that ISSUED it');
    // "none" must stay a first-class answer. A confident wrong type silently
    // selects the wrong instruction block for every future document like it.
    expect(CLASSIFIER_PROMPT).toContain('Answer "none"');
  });

  it('asks for the name VERBATIM, because the consumer is an exact match', () => {
    // fuzzyMatchDocType promotes document_type_id only on an exact hit, so an
    // answer that paraphrases a candidate is an answer that gets thrown away.
    expect(CLASSIFIER_PROMPT).toContain('Choose the name from the list VERBATIM');
  });

  it('reads only the head of the document', () => {
    // A document announces what it is in its title block. The budget is part
    // of the cost case for a separate pass and is mirrored in the worker.
    expect(CLASSIFIER_TEXT_BUDGET).toBe(3000);
    expect(processWorkerSource).toContain('const CLASSIFIER_TEXT_BUDGET = 3000;');
  });
});

describe('the classified-type block handed to extraction', () => {
  it('produces identical text on both surfaces', () => {
    for (const name of ['Kosher Certificate', 'Certificate of Insurance']) {
      expect(workerClassifiedTypeBlock(name)).toBe(classifiedTypeBlock(name));
    }
  });

  it('is context, not a licence to invent', () => {
    // Handing the model a document type is exactly the kind of hint that talks
    // a model into reporting the fields that KIND of document usually has. The
    // escape hatch and the pointer back to rule 7 are what keep it safe.
    const block = classifiedTypeBlock('Organic Certificate');
    expect(block).toContain('If the page is plainly not that kind of document');
    expect(block).toContain('never licenses a value the page does not print');
  });
});

describe('matchCandidate — exact only, deliberately', () => {
  const candidates = [
    { id: 'dt1', name: 'Certificate of Insurance', slug: 'certificate-of-insurance' },
    { id: 'dt2', name: '3rd Party Audit Certificate', slug: null },
    { id: 'dt3', name: 'Safety Data Sheet', slug: 'safety-data-sheet' },
  ];

  it('matches a name regardless of case and punctuation', () => {
    expect(matchCandidate('certificate of insurance', candidates)?.id).toBe('dt1');
    expect(matchCandidate('Certificate  of  Insurance', candidates)?.id).toBe('dt1');
    expect(matchCandidate('3rd-Party Audit Certificate', candidates)?.id).toBe('dt2');
  });

  it('matches a slug', () => {
    expect(matchCandidate('safety-data-sheet', candidates)?.id).toBe('dt3');
  });

  it('refuses "none" and empty answers', () => {
    expect(matchCandidate('none', candidates)).toBeNull();
    expect(matchCandidate('None', candidates)).toBeNull();
    expect(matchCandidate('', candidates)).toBeNull();
    expect(matchCandidate(null, candidates)).toBeNull();
  });

  it('refuses a near miss rather than fuzzing it onto a candidate', () => {
    // This is the whole safety property. The list was supplied, so an answer
    // that is not on it is evidence the model went its own way; substring
    // matching it back would manufacture the confident wrong type this pass
    // exists to prevent. The raw answer is still surfaced to the reviewer as
    // processing_queue.document_type_guess.
    expect(matchCandidate('Insurance Certificate', candidates)).toBeNull();
    expect(matchCandidate('Certificate', candidates)).toBeNull();
    expect(matchCandidate('Audit Certificate', candidates)).toBeNull();
    expect(matchCandidate('Certificate of Analysis', candidates)).toBeNull();
  });

  it('normalizes the same way the worker\'s fuzzyMatchDocType does', () => {
    expect(normalizeTypeName('Gluten-Free Certificate')).toBe('gluten free certificate');
    expect(normalizeTypeName('  W-9  ')).toBe('w 9');
  });
});

describe('bin/process-worker wires classification AHEAD of extraction', () => {
  it('classifies before the guidance lookup, not after the extraction', () => {
    // The ordering IS the fix. Guidance is keyed on the document type, so the
    // classification has to complete before fetchReviewerInstructions runs.
    const classifyAt = processWorkerSource.indexOf('=== CLASSIFY FIRST, THEN EXTRACT ONCE ===');
    const guidanceAt = processWorkerSource.indexOf('let reviewerInstructions =');
    expect(classifyAt).toBeGreaterThan(-1);
    expect(guidanceAt).toBeGreaterThan(classifyAt);
  });

  it('keys the guidance, examples and learned hints on the classified type', () => {
    // Every one of these used to read item.document_type_id, which was null
    // until AFTER extraction on all but the doors that declare a type.
    expect(processWorkerSource).toContain('fetchExtractionExamples(item.tenant_id, effectiveDocTypeId, guessedSupplier)');
    expect(processWorkerSource).toMatch(
      /fetchReviewerInstructions\(\s*item\.tenant_id,\s*resolvedSupplierIdForLearning,\s*effectiveDocTypeId\s*\)/,
    );
    expect(processWorkerSource).toMatch(
      /fetchLearnedPreferences\(\s*item\.tenant_id,\s*resolvedSupplierIdForLearning,\s*effectiveDocTypeId\s*\)/,
    );
  });

  it('trusts a type the intake door already declared instead of re-classifying it', () => {
    // A human or a configured connector said what this is. Spending a model
    // call to second-guess them would be waste, and overriding them would be
    // worse than waste.
    expect(processWorkerSource).toContain('(declared at intake, not re-classified)');
  });

  it('never forces an unresolved answer onto the nearest type', () => {
    // The honest-unknown path: document_type_id stays NULL, the raw answer is
    // still recorded for the reviewer as document_type_guess (migration 0024).
    expect(processWorkerSource).toContain('tenant types fit');
    expect(processWorkerSource).toContain('extracting untyped, reviewer decides');
    expect(processWorkerSource).toContain(
      "const docTypeGuess = (classification && classification.rawGuess) || parsed.documentType || null;",
    );
  });

  it('treats classification as an optimisation, never a gate', () => {
    // A router hiccup must degrade to the pre-classifier behaviour (extract
    // untyped), never fail the document.
    expect(processWorkerSource).toContain('Classification skipped (non-critical)');
    expect(processWorkerSource).toContain('Classification failed (non-critical, extracting untyped)');
  });
});
