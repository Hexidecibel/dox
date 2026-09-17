/**
 * Unit tests for shared/pdfPageOcr.ts — the per-page OCR routing decision, the
 * merge that keeps OCR from overwriting better text, and the mirror assertions
 * that keep the three text paths in step.
 *
 * WHAT MUST NEVER SILENTLY BREAK:
 *
 *  1. THE PAIR. The rule is "a large drawn image AND almost no text", and both
 *     halves are load-bearing. Drop the image half and a blank back cover
 *     becomes an OCR bill; drop the text half and a spec sheet drawn on a
 *     full-page background image gets its perfect text layer replaced by a
 *     worse read of the same words. The corpus contains one of each, so both
 *     regressions are testable against real numbers rather than invented ones.
 *
 *  2. OCR NEVER OVERWRITES. A page's own text layer is the document's own
 *     characters; OCR is a guess at their shapes. The merge may APPEND, never
 *     replace — except on a page that had no usable text, where there is
 *     nothing to lose.
 *
 *  3. THE THREE CALL SITES. The PDF text sequence exists in bin/process-worker
 *     twice and bin/lib/corpusText.js once. A pass written three times drifts
 *     three ways, and a harness measuring a text path the product does not have
 *     reports a routing bug as an accuracy number.
 *
 * Pure functions plus source-text mirrors — no PDF, no tesseract, no model.
 */

import { describe, it, expect } from 'vitest';
import {
  decidePageOcr,
  selectPagesForOcr,
  mergePageText,
  formatPageRanges,
  summarizePageSources,
  PAGE_IMAGE_COVERAGE_MIN,
  PAGE_TEXT_CHARS_MAX,
  MAX_OCR_PAGES_PER_DOCUMENT,
  OCR_MIN_LETTERS_TO_APPEND,
  type PdfPageFacts,
  type PageTextProvenance,
} from '../../shared/pdfPageOcr';
import processWorkerSource from '../../bin/process-worker?raw';
import corpusTextSource from '../../bin/lib/corpusText.js?raw';
import pageOcrNodeSource from '../../bin/lib/pdfPageOcr.js?raw';

function page(partial: Partial<PdfPageFacts> & { page: number }): PdfPageFacts {
  return { chars: 0, imageCoverage: 0, imageCount: 0, ...partial };
}

// The five inserted certificates in tests/fixtures/real-corpus/pdf/packet-fdlw-2026.pdf,
// measured. These are the pages the whole change exists for.
const CERTIFICATE_PAGES: PdfPageFacts[] = [
  { page: 6, chars: 4, imageCoverage: 0.538, imageCount: 9 },
  { page: 13, chars: 81, imageCoverage: 0.386, imageCount: 9 },
  { page: 14, chars: 70, imageCoverage: 0.407, imageCount: 9 },
  { page: 15, chars: 68, imageCoverage: 0.380, imageCount: 9 },
  { page: 16, chars: 32, imageCoverage: 0.348, imageCount: 9 },
];

describe('decidePageOcr — a picture with a caption over it', () => {
  it('routes every one of the packet\'s five certificate pages to OCR', () => {
    for (const p of CERTIFICATE_PAGES) {
      const d = decidePageOcr(p);
      expect(d.ocr, `page ${p.page}`).toBe(true);
      expect(d.reason).toBe('image_page_unread');
    }
  });

  it('leaves a genuinely sparse page alone — a near-blank back cover is not a broken page', () => {
    // packet page 36: 5 characters, largest image is the 0.036 letterhead logo.
    // A bare character threshold would rasterise it for nothing.
    const d = decidePageOcr(page({ page: 36, chars: 5, imageCoverage: 0.036, imageCount: 8 }));
    expect(d.ocr).toBe(false);
    expect(d.reason).toBe('no_large_image');
  });

  it('leaves a TEXT page alone even when one image covers the whole sheet', () => {
    // The Smith Brothers spec sheet: a background image over 100% of the page,
    // and 1957 characters of real text on top of it. Replacing that with OCR
    // would be a strictly worse read of the same words.
    const d = decidePageOcr(page({ page: 1, chars: 1957, imageCoverage: 1, imageCount: 2 }));
    expect(d.ocr).toBe(false);
    expect(d.reason).toBe('text_present');
  });

  it('leaves an ordinary letterhead page alone', () => {
    // Every other packet page: logo at 0.036, 583-2743 characters.
    const d = decidePageOcr(page({ page: 7, chars: 1184, imageCoverage: 0.036, imageCount: 9 }));
    expect(d.ocr).toBe(false);
  });

  it('needs BOTH halves of the rule — neither alone flips a page', () => {
    // Enough image, too much text.
    expect(decidePageOcr(page({ page: 1, chars: PAGE_TEXT_CHARS_MAX, imageCoverage: 0.9 })).ocr).toBe(false);
    // Little enough text, not enough image.
    expect(decidePageOcr(page({ page: 1, chars: 0, imageCoverage: PAGE_IMAGE_COVERAGE_MIN - 0.001 })).ocr).toBe(false);
    // Both, by one character and one thousandth.
    expect(decidePageOcr(page({ page: 1, chars: PAGE_TEXT_CHARS_MAX - 1, imageCoverage: PAGE_IMAGE_COVERAGE_MIN })).ocr).toBe(true);
  });

  it('the thresholds still sit inside the measured holes', () => {
    // 0.124 (a spec sheet's product photo) .. 0.348 (the smallest certificate),
    // and 81 (the largest certificate caption) .. 396 (the shortest genuine
    // page in the corpus). A change that walks either threshold out of its hole
    // starts reclassifying real pages and must be a deliberate, measured one.
    expect(PAGE_IMAGE_COVERAGE_MIN).toBeGreaterThan(0.124);
    expect(PAGE_IMAGE_COVERAGE_MIN).toBeLessThan(0.348);
    expect(PAGE_TEXT_CHARS_MAX).toBeGreaterThan(81);
    expect(PAGE_TEXT_CHARS_MAX).toBeLessThan(396);
  });

  it('survives a NaN / missing measurement by declining', () => {
    expect(decidePageOcr({ page: 1, chars: NaN, imageCoverage: NaN, imageCount: 0 }).ocr).toBe(false);
  });
});

describe('selectPagesForOcr — a mixed document OCRs only the pages that qualify', () => {
  it('picks 6, 13, 14, 15 and 16 out of a 36-page packet and nothing else', () => {
    const facts: PdfPageFacts[] = [];
    for (let p = 1; p <= 36; p++) {
      const cert = CERTIFICATE_PAGES.find((c) => c.page === p);
      if (cert) facts.push(cert);
      else if (p === 36) facts.push(page({ page: 36, chars: 5, imageCoverage: 0.036 }));
      else facts.push(page({ page: p, chars: 900, imageCoverage: 0.057 }));
    }
    const chosen = selectPagesForOcr(facts).filter((d) => d.ocr).map((d) => d.page);
    expect(chosen).toEqual([6, 13, 14, 15, 16]);
  });

  it('returns one decision per page, in page order', () => {
    const facts = [page({ page: 1, chars: 900 }), ...CERTIFICATE_PAGES];
    const out = selectPagesForOcr(facts);
    expect(out.map((d) => d.page)).toEqual([1, 6, 13, 14, 15, 16]);
  });

  it('stops at the per-document OCR budget and SAYS SO rather than going quiet', () => {
    const facts = Array.from({ length: MAX_OCR_PAGES_PER_DOCUMENT + 3 }, (_, i) =>
      page({ page: i + 1, chars: 10, imageCoverage: 0.8 }));
    const out = selectPagesForOcr(facts);
    expect(out.filter((d) => d.ocr)).toHaveLength(MAX_OCR_PAGES_PER_DOCUMENT);
    const skipped = out.filter((d) => d.reason === 'ocr_budget_exhausted');
    expect(skipped).toHaveLength(3);
    // The budget is spent in page order, so it is the LAST pages that are left.
    expect(skipped.map((d) => d.page)).toEqual([26, 27, 28]);
  });
});

describe('mergePageText — OCR never overwrites better text', () => {
  const longOcr = `${'Certificate of Conformance '.repeat(30)}`;

  it('takes the OCR read outright when the page had no text at all', () => {
    const m = mergePageText('   ', longOcr);
    expect(m.source).toBe('ocr');
    expect(m.reason).toBe('no_embedded_text');
    expect(m.text).toBe(longOcr.trim());
  });

  it('keeps the caption FIRST and appends the OCR read when OCR adds substantially', () => {
    const m = mergePageText('alouette Halal Certificate', longOcr);
    expect(m.source).toBe('text-layer+ocr');
    expect(m.reason).toBe('ocr_adds_text');
    expect(m.text.startsWith('alouette Halal Certificate\n')).toBe(true);
    expect(m.text).toContain('Certificate of Conformance');
  });

  it('keeps the embedded text ALONE when OCR added nothing worth having', () => {
    // A re-read of the same short caption: above nothing, below the bar.
    const m = mergePageText('Page 3 of 36  C2', 'Page 3 of 36 C2');
    expect(m.source).toBe('text-layer');
    expect(m.reason).toBe('ocr_added_nothing');
    expect(m.text).toBe('Page 3 of 36  C2');
  });

  it('never replaces a rich text layer with a long OCR read of the same page', () => {
    // 3x richer is required, so a page with real text is never swapped out
    // wholesale — the worst case is that the OCR read is appended, and the
    // document's own characters still come first.
    const embedded = 'a'.repeat(5000);
    const m = mergePageText(embedded, longOcr);
    expect(m.source).toBe('text-layer');
    expect(m.text).toBe(embedded);
  });

  it('keeps the page unchanged when OCR returned nothing', () => {
    const m = mergePageText('some text', '');
    expect(m.source).toBe('text-layer');
    expect(m.reason).toBe('ocr_empty');
    expect(m.text).toBe('some text');
  });

  it('requires a real number of letters, not just characters', () => {
    const noise = '0123456789 '.repeat(60); // long, but almost no letters
    const m = mergePageText('caption', noise);
    expect(m.source).toBe('text-layer');
    expect(OCR_MIN_LETTERS_TO_APPEND).toBeGreaterThan(0);
  });

  it('writes NO marker into the text the model reads', () => {
    // Provenance travels beside the text, never inside it: which half of a page
    // came from where is a fact about our pipeline, not about the document.
    const m = mergePageText('caption', longOcr);
    expect(m.text).not.toMatch(/OCR|\[page|tesseract/i);
  });
});

describe('provenance, as a reviewer reads it', () => {
  const rows = (over: Partial<PageTextProvenance>[]): PageTextProvenance[] =>
    over.map((o, i) => ({
      page: i + 1, source: 'text-layer', chars: 900, text_layer_chars: 900,
      ocr_chars: null, image_coverage: 0.03, reason: 'no_large_image', ...o,
    }));

  it('collapses contiguous pages the way a person says them', () => {
    expect(formatPageRanges([6, 13, 14, 15, 16])).toBe('6, 13–16');
    expect(formatPageRanges([2])).toBe('2');
    expect(formatPageRanges([])).toBe('');
  });

  it('says nothing at all when every page came from its own text layer', () => {
    expect(summarizePageSources(rows([{}, {}, {}]))).toBeNull();
    expect(summarizePageSources([])).toBeNull();
    expect(summarizePageSources(null)).toBeNull();
  });

  it('names the OCR pages when some were read from an image', () => {
    const list = rows(Array.from({ length: 16 }, (_, i) =>
      [6, 13, 14, 15, 16].includes(i + 1) ? { source: 'text-layer+ocr' as const } : {}));
    expect(summarizePageSources(list)).toBe('5 of 16 pages read by OCR (page 6, 13–16)');
  });

  it('reports an exhausted budget even when nothing was OCR\'d', () => {
    const list = rows([{ reason: 'ocr_budget_exhausted' }, {}]);
    expect(summarizePageSources(list)).toMatch(/OCR budget reached/);
  });
});

describe('the three text paths stay in step', () => {
  it('bin/process-worker runs the per-page pass in BOTH pdf branches', () => {
    expect(processWorkerSource).toMatch(/require\('\.\/lib\/pdfPageOcr'\)/);
    expect(processWorkerSource.match(/await applyPdfPerPageOcr\(\{/g)).toHaveLength(2);
    // Each branch needs its OWN buffer: unpdf detaches the ArrayBuffer it is
    // handed, so the operator-list read cannot share the geometry pass's copy.
    expect(processWorkerSource.match(/const factsBuffer = fileBuffer\.slice\(0\)/g)).toHaveLength(2);
  });

  it('runs it AFTER the document-level OCR fallback and after the geometry pass', () => {
    // Order is load-bearing for the same reason the geometry pass runs last:
    // the whole-document routing must stay a decision about the ORIGINAL text.
    for (const branch of processWorkerSource.split('const factsBuffer = fileBuffer.slice(0)').slice(1)) {
      const ocr = branch.indexOf('ocrPdf(fileBufferCopy)');
      const geom = branch.indexOf('await serializePdfGeometry(');
      const perPage = branch.indexOf('await applyPdfPerPageOcr(');
      expect(ocr).toBeGreaterThan(-1);
      expect(perPage).toBeGreaterThan(ocr);
      expect(perPage).toBeGreaterThan(geom);
    }
  });

  it('never runs the per-page pass on a document that already went to OCR whole', () => {
    // `pages` is then a single blob with no page boundaries, so a per-page
    // decision would be made against the wrong thing.
    expect(processWorkerSource.match(/wentToOcrWhole = true;/g)).toHaveLength(2);
    expect(processWorkerSource).toMatch(/if \(wentToOcrWhole \|\| !Array\.isArray\(pages\)/);
  });

  it('the measurement harness runs the SAME module, not a copy of the rule', () => {
    // A second implementation in bin/lib/corpusText.js would make every future
    // measurement a measurement of the harness.
    expect(corpusTextSource).toMatch(/require\('\.\/pdfPageOcr'\)/);
    expect(corpusTextSource).toMatch(/applyPerPageOcr\(\{/);
    expect(corpusTextSource).not.toMatch(/PAGE_IMAGE_COVERAGE_MIN\s*=/);
  });

  it('the Node half holds no thresholds of its own', () => {
    // The rule is pure and lives in shared/pdfPageOcr.ts so it is testable and
    // has ONE definition. A number re-typed into the Node half is how two
    // callers start disagreeing about which pages are unread.
    expect(pageOcrNodeSource).toMatch(/require\('\.\/shared\/pdfPageOcr'\)/);
    expect(pageOcrNodeSource).not.toMatch(/(imageCoverage|chars)\s*[<>]=?\s*0?\.?\d/);
  });

  it('OCRs single pages, not the whole file, when one page qualifies', () => {
    // pdftoppm -f N -l N is the difference between paying for five pages and
    // paying for thirty-six.
    expect(pageOcrNodeSource).toMatch(/'-f', String\(p\), '-l', String\(p\)/);
  });
});
