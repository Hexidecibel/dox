/**
 * tests/fixtures/spec-corpus — the generated certificate corpus, driven through
 * the TypeScript spec engine.
 *
 * WHAT IS DIFFERENT ABOUT THESE TESTS. `specCheck.test.ts` beside this file is
 * unit-level: hand-built rows that pin one behaviour each. This suite starts
 * from DOCUMENTS. Each fixture is a certificate you can open and read
 * (`tests/fixtures/spec-corpus/html/`, rendered to PDF by
 * `bin/render-spec-corpus`), and the manifest states the verdicts the engine
 * must produce from a correct read of it — plus, and this is the half that
 * catches regressions, what it must NOT produce: no verdict from the buffer
 * control row, no result of 100,000 lifted out of the certification paragraph,
 * no reagent lot in a product field.
 *
 * Every defect encoded here was found by accident on production data. That is
 * the point of the corpus: to stop finding them that way.
 *
 * LAYER. This is the JUDGING layer — the engine consumes an already-extracted
 * `tables` structure and the manifest declares that structure. Whether a live
 * read of the PDF produces it is the extraction layer, which needs the worker
 * and a model; the corpus is shaped so the same fixtures answer that question
 * too. See `tests/fixtures/spec-corpus/README.md`.
 */

import { describe, it, expect } from 'vitest';
import * as engine from '../../shared/specCheck';
import { evaluateCorpus } from '../fixtures/spec-corpus/evaluate.mjs';
import corpus from '../fixtures/spec-corpus/corpus.json';

const result = evaluateCorpus(corpus, engine);

describe('spec corpus — generated certificates, judged', () => {
  it('has a fixture for every document in the manifest', () => {
    expect(result.documents.length).toBe(corpus.documents.length);
    expect(result.documents.length).toBeGreaterThan(0);
  });

  for (const doc of result.documents) {
    describe(doc.id, () => {
      for (const shape of doc.shapes) {
        for (const check of shape.checks) {
          it(`${shape.id}: ${check.name}`, () => {
            expect(check.ok, check.detail).toBe(true);
          });
        }
      }
      for (const check of doc.fieldChecks) {
        // Extraction-layer statement, checked against the declared shape. It
        // validates the fixture; the extractor is a separate harness.
        it(`fields: ${check.name}`, () => {
          expect(check.ok, check.detail).toBe(true);
        });
      }
    });
  }

  it('reports no failures overall', () => {
    expect(result.summary.fail).toBe(0);
    expect(result.summary.pass).toBeGreaterThan(50);
  });
});
