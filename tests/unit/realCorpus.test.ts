/**
 * tests/unit/realCorpus.test.ts — the real-document corpus, checked without a
 * model.
 *
 * `bin/eval-aj-docs` needs the extraction fleet. These assertions do not, and
 * they cover the two things that go wrong silently:
 *
 *  1. THE MANIFEST DRIFTING FROM THE FILES. A page range that runs off the end
 *     of the PDF, a `pdf` path that no longer exists, two parts claiming the
 *     same page — none of those fail loudly during a run, they just quietly
 *     score the wrong bytes.
 *  2. THE `document_type_expected_none` FLAG. It was added to score.mjs for
 *     this corpus, and it inverts the document-type verdict: `null` becomes
 *     correct and a confident answer becomes the failure. A regression there
 *     would flip eighteen documents' scores in one direction and look like a
 *     model change.
 *
 * The flag must also be INERT on the synthetic corpus, which is asserted here
 * directly rather than assumed: doctype-corpus's published numbers (92.8% value
 * accuracy, 38/40 document types) were measured before it existed.
 */
import { describe, it, expect } from 'vitest';
// Static imports: this suite runs in the Cloudflare Workers pool, which has no
// general filesystem. That also means the "does the PDF on disk exist" check
// cannot live here — it lives in `bin/eval-aj-docs --verify`, which opens every
// one of them and fails loudly on a missing file.
import corpusJson from '../fixtures/real-corpus/corpus.json';
import doctypeJson from '../fixtures/doctype-corpus/corpus.json';
import pack from '../../starter-packs/fsqa.json';
import * as scorer from '../fixtures/doctype-corpus/score.mjs';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const corpus = corpusJson as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const doctype = doctypeJson as any;

describe('real-corpus manifest', () => {
  it('every document declares a pdf and a stable id', () => {
    for (const d of corpus.documents) {
      expect(typeof d.pdf, d.id).toBe('string');
      expect(d.pdf.startsWith('pdf/'), `${d.id} -> ${d.pdf}`).toBe(true);
    }
  });

  it('document ids are unique', () => {
    const ids = corpus.documents.map((d: { id: string }) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('no two packet parts claim the same page', () => {
    const seen = new Map<number, string>();
    for (const d of corpus.documents) {
      if (d.part_of !== 'packet-fdlw-2026') continue;
      for (const p of d.pages) {
        expect(seen.has(p), `page ${p} claimed by both ${seen.get(p)} and ${d.id}`).toBe(false);
        seen.set(p, d.id);
      }
    }
    // 36 pages, page 36 blank and deliberately unclaimed.
    expect(seen.size).toBe(35);
  });

  it('page numbers are 1-based and inside the packet', () => {
    for (const d of corpus.documents) {
      if (!d.pages) continue;
      for (const p of d.pages) {
        expect(Number.isInteger(p)).toBe(true);
        expect(p).toBeGreaterThanOrEqual(1);
        expect(p).toBeLessThanOrEqual(36);
      }
    }
  });

  it('every graded field resolves to a key group', () => {
    const groups = { ...doctype.key_groups, ...corpus.key_groups };
    for (const d of corpus.documents) {
      for (const f of d.fields || []) {
        if (!f.keys_ref) {
          expect(Array.isArray(f.keys), `${d.id}.${f.name} has neither keys_ref nor keys`).toBe(true);
          continue;
        }
        expect(groups[f.keys_ref], `${d.id}.${f.name} -> unknown key group ${f.keys_ref}`).toBeDefined();
      }
    }
  });

  it('a null-truth field declares distractors or null_equivalents, so a fabrication is arguable', () => {
    for (const d of corpus.documents) {
      for (const f of d.fields || []) {
        if (f.truth !== null && f.truth !== undefined) continue;
        const declared = (f.distractors && f.distractors.length) || (f.null_equivalents && f.null_equivalents.length);
        // An empty `distractors: []` is a deliberate statement that the page
        // offers nothing to misfile — it must still be present.
        expect(f.distractors !== undefined || declared, `${d.id}.${f.name}`).toBeTruthy();
      }
    }
  });

  it('the image-only pages record how little the production text path reads', () => {
    const imageOnly = corpus.documents.filter((d: { image_only?: boolean }) => d.image_only);
    expect(imageOnly).toHaveLength(5);
    for (const d of imageOnly) {
      // The finding: not zero (which would route to OCR) and not enough to read.
      expect(d.text_layer_chars).toBeGreaterThan(0);
      expect(d.text_layer_chars).toBeLessThan(200);
      expect(d.pdf_text_must_contain_ocr.length).toBeGreaterThan(0);
    }
  });
});

describe('document_type_expected_none', () => {
  const score = (doc: unknown, guess: string | null) =>
    scorer.scoreDocument(doc, corpus.key_groups, { fields: {}, documentType: guess }, '').document_type;

  it('makes an unresolved type CORRECT when nothing in the catalog fits', () => {
    const doc = { id: 'x', fields: [], document_type_accept: [], document_type_expected_none: true };
    expect(score(doc, null).ok).toBe(true);
    expect(score(doc, 'Allergen Statement').ok).toBe(false);
  });

  it('still accepts a listed type when one is declared alongside the flag', () => {
    const doc = {
      id: 'x', fields: [],
      document_type_accept: ['non-gmo certificate'],
      document_type_expected_none: true,
    };
    expect(score(doc, null).ok).toBe(true);
    expect(score(doc, 'Non-GMO Certificate').ok).toBe(true);
    expect(score(doc, 'Kosher Certificate').ok).toBe(false);
  });

  it('is INERT without the flag — an unresolved type stays a miss', () => {
    const doc = { id: 'x', fields: [], document_type_accept: ['kosher certificate'] };
    expect(score(doc, null).ok).toBe(false);
    expect(score(doc, 'Kosher Certificate').ok).toBe(true);
    expect(score(doc, 'Halal Certificate').ok).toBe(false);
  });

  it('no synthetic doctype-corpus fixture carries the flag, so its numbers are unchanged', () => {
    for (const d of doctype.documents) {
      expect(d.document_type_expected_none, d.id).toBeUndefined();
    }
  });
});

describe('the packet finding, as data', () => {
  it('the whole file is registered alongside its parts', () => {
    const whole = corpus.documents.find((d: { id: string }) => d.id === 'packet-fdlw-2026');
    const parts = corpus.documents.filter((d: { part_of?: string }) => d.part_of === 'packet-fdlw-2026');
    expect(whole).toBeDefined();
    expect(whole.multi_document).toBe(true);
    // 25 indexed documents plus the cover. Dropping the whole-file entry would
    // delete the only case that measures what dox actually ingests today.
    expect(whole.contains).toBe(25);
    expect(parts).toHaveLength(26);
    expect(parts.every((p: { pdf: string }) => p.pdf === whole.pdf)).toBe(true);
  });

  it('seventeen of the twenty-six parts have no type in the FSQA starter pack', () => {
    expect(pack.document_types).toHaveLength(27);
    const none = corpus.documents.filter(
      (d: { document_type_expected_none?: boolean; part_of?: string }) =>
        d.document_type_expected_none && d.part_of === 'packet-fdlw-2026'
    );
    expect(none).toHaveLength(17);
    // Plus the whole-packet entry, whose correct answer is also "none" — for a
    // different reason: there, a type DOES fit twenty-five times over.
    expect(
      corpus.documents.filter((d: { document_type_expected_none?: boolean }) => d.document_type_expected_none)
    ).toHaveLength(18);

    // Exactly two carry the flag AND an accept list, where the pack holds an
    // adjacent-but-not-equal type. Keeping that number pinned is the point: the
    // combination makes a document un-failable on type, so it must stay rare
    // and deliberate rather than becoming the way awkward cases get silenced.
    const bothWays = none.filter((d: { document_type_accept: string[] }) => d.document_type_accept.length > 0);
    expect(bothWays.map((d: { id: string }) => d.id).sort()).toEqual([
      'packet-p09-bioengineered',
      'packet-p20-food-defense',
    ]);

    // Every one of them explains itself. A bare flag with no reason is how a
    // configuration gap gets mistaken for a fixture someone gave up on.
    for (const d of none) expect(d.document_type_note, d.id).toBeTruthy();
  });

  it('all four spec sheets carry printed limits, and Andersen carries them unitless', () => {
    const specs = corpus.documents.filter((d: { id: string }) => d.id.startsWith('spec-'));
    expect(specs).toHaveLength(4);
    for (const s of specs) expect(s.spec_limits_printed.length).toBeGreaterThan(0);
    const andersen = specs.find((s: { id: string }) => s.id.includes('andersen'));
    // Four limits, two scopes, no units — the shape spec_limits cannot express.
    expect(andersen.spec_limits_printed).toHaveLength(4);
    expect(andersen.spec_limits_printed.every((l: { unit: string | null }) => l.unit === null)).toBe(true);
    expect(new Set(andersen.spec_limits_printed.map((l: { scope: string }) => l.scope)).size).toBe(2);
  });
});
