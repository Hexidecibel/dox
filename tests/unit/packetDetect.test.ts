/**
 * shared/packetDetect.ts — one file, or several documents in one file?
 *
 * WHAT IS BEING DEFENDED, in order of how expensive it is to get wrong:
 *
 *   1. A SINGLE DOCUMENT IS NEVER CALLED A PACKET. A wrong split turns one
 *      wrong document into twenty-five, so the negatives here matter more than
 *      the positives. The hardest one is real: the client packet's own
 *      eight-page HACCP master plan, one document with the same running header
 *      on every page — exactly the shape a header-counting detector breaks on.
 *   2. A MULTI-LOT COA IS NOT THIS MODULE'S JOB. produceCoaRecords already
 *      splits it, per lot, knowing the lots. Two engines proposing two splits
 *      of one file is worse than one.
 *   3. WHEN THE SIGNALS DISAGREE THE ANSWER IS COARSE AND SAYS SO. A
 *      precise-looking boundary list invented to look decisive is worse than
 *      three boundaries and a low-confidence band, because a reviewer can merge
 *      two parts in a second and cannot see that a boundary was a coin flip.
 *
 * The real-packet case runs on RECORDED page facts
 * (tests/fixtures/real-corpus/packet-pages.json, written by
 * `bin/packet-detect --emit-fixture` from the production text path), so this is
 * a no-model, no-PDF regression test for the detector against the 26 parts
 * recorded in corpus.json.
 */

import { describe, it, expect } from 'vitest';
import {
  detectPacket,
  parseIndexEntries,
  looksLikeTitleLine,
  validateRanges,
  pagesOfRange,
  MIN_PACKET_PAGES,
  MAX_PARTS_PER_SPLIT,
  type PacketPageInput,
} from '../../shared/packetDetect';
import packetPages from '../fixtures/real-corpus/packet-pages.json';
import realCorpus from '../fixtures/real-corpus/corpus.json';

// ---------------------------------------------------------------------------
// Builders — synthetic pages shaped like the real ones
// ---------------------------------------------------------------------------

const SIGNOFF = 'Sincerely,\nLouise Newswanger\nlouise.newswanger@example.com';

/** A statement page: banner, ALL-CAPS title, a date, body, the sign-off. */
function statementPage(page: number, title: string, body = 'We hereby certify the following.'): PacketPageInput {
  return {
    page,
    text: `C2\n${title}\nJanuary 2, 2026\n${body}\n${SIGNOFF}\n${page}`,
    imageCoverage: 0.036,
  };
}

/** A continuation page: no title, no sign-off, mid-prose. */
function continuationPage(page: number, body: string): PacketPageInput {
  return { page, text: `C2\n${body}\n${page}`, imageCoverage: 0.036 };
}

describe('a single document is never called a packet', () => {
  it('leaves a one-page specification sheet alone', () => {
    const r = detectPacket({ isPdf: true, pages: [statementPage(1, 'PRODUCT SPECIFICATION')] });
    expect(r.looksLikePacket).toBe(false);
    expect(r.declined).toBe('too_few_pages');
  });

  it('leaves a letter with a continuation page alone, and says why', () => {
    const r = detectPacket({
      isPdf: true,
      pages: [statementPage(1, 'ALLERGEN STATEMENT'), continuationPage(2, 'Below is a table of sensitivities.')],
    });
    expect(r.looksLikePacket).toBe(false);
    expect(r.declined).toBe('too_few_pages');
    // The reason is a sentence, not a code — "we did not look" and "we looked
    // and it is one document" must not read the same to a reviewer.
    expect(r.notes[0]).toMatch(/under 4/);
  });

  it('leaves an eight-page plan alone even though every page repeats the header', () => {
    const pages = [
      statementPage(1, 'FDLW HACCP/HARPC OVERVIEW', 'PURPOSE: this document provides an overview.'),
      ...Array.from({ length: 7 }, (_, i) =>
        continuationPage(i + 2, `Good Manufacturing Practices: section ${i + 2} continues from the previous page.`),
      ),
    ];
    const r = detectPacket({ isPdf: true, pages });
    expect(r.looksLikePacket).toBe(false);
    expect(r.declined).toBe('single_document');
  });

  it('declines anything that is not a PDF outright', () => {
    const r = detectPacket({ isPdf: false, pages: Array.from({ length: 10 }, (_, i) => statementPage(i + 1, `STATEMENT ${i + 1}`)) });
    expect(r.looksLikePacket).toBe(false);
    expect(r.declined).toBe('not_pdf');
  });

  it('MIN_PACKET_PAGES is the line, and it is 4', () => {
    expect(MIN_PACKET_PAGES).toBe(4);
  });
});

describe('the multi-lot COA stays produceCoaRecords\' job', () => {
  const pages = Array.from({ length: 8 }, (_, i) => statementPage(i + 1, 'CERTIFICATE OF ANALYSIS'));

  it('stands down when the COA path already produced records', () => {
    const r = detectPacket({ isPdf: true, pages, coaRecordCount: 4 });
    expect(r.looksLikePacket).toBe(false);
    expect(r.declined).toBe('coa_records');
  });

  it('one record is not a split, so the guard does not fire on it', () => {
    const r = detectPacket({ isPdf: true, pages, coaRecordCount: 1 });
    expect(r.declined).not.toBe('coa_records');
  });
});

describe('the index page is trusted above everything else', () => {
  it('parses the three table-of-contents shapes and no body text', () => {
    const entries = parseIndexEntries([
      '1. Letter of Guarantee | Page 3',
      '25. Food Safety/HACCP Master Plan | Pages 28-35',
      '7. Allergen Statement .......... 17',
      '2. Facility Contacts | 4',
      'Section 3 discusses 12 CFR 117 at length',
      'Total plate count 10,000',
    ]);
    expect(entries.map((e) => [e.n, e.from, e.to])).toEqual([
      [1, 3, null],
      [25, 28, 35],
      [7, 17, null],
      [2, 4, null],
    ]);
  });

  it('builds ranges from the index, with the pages before it as front matter', () => {
    const pages: PacketPageInput[] = [
      { page: 1, text: 'C2\nCOVER LETTER\nDear Valued Customer,\n1', imageCoverage: 0.2 },
      {
        page: 2,
        text: 'C2\n1. Letter of Guarantee | Page 3\n2. Allergen Statement | Page 4-5\n3. Kosher Certificate | Page 6\n2',
        imageCoverage: 0.03,
      },
      statementPage(3, 'LETTER OF GUARANTEE'),
      statementPage(4, 'ALLERGEN STATEMENT'),
      continuationPage(5, 'The table of sensitivities continues here.'),
      statementPage(6, 'KOSHER CERTIFICATE'),
    ];
    const r = detectPacket({ isPdf: true, pages });
    expect(r.looksLikePacket).toBe(true);
    expect(r.method).toBe('index');
    expect(r.parts.map((p) => p.pages)).toEqual([
      [1, 2],
      [3, 3],
      [4, 5],
      [6, 6],
    ]);
    // The index's own words travel as a HINT and nothing more.
    expect(r.parts[1].label).toBe('Letter of Guarantee');
    expect(r.parts[0].label).toBeNull();
  });

  it('refuses an index whose last entry points past the end of the file', () => {
    // A numbered list in a bound manual, not a table of contents for THIS file.
    const pages: PacketPageInput[] = [
      { page: 1, text: 'C2\nINDEX\n1. Part One | Page 3\n2. Part Two | Page 40\n3. Part Three | Page 88\n1', imageCoverage: 0.03 },
      continuationPage(2, 'Body text continues.'),
      continuationPage(3, 'Body text continues.'),
      continuationPage(4, 'Body text continues.'),
    ];
    const r = detectPacket({ isPdf: true, pages });
    expect(r.method).not.toBe('index');
  });
});

describe('layout signals, when there is no index', () => {
  it('a repeated closing block plus title lines reads as a packet, at medium confidence', () => {
    const pages = [
      statementPage(1, 'LETTER OF GUARANTEE'),
      statementPage(2, 'FDA BIOTERRORISM STATEMENT'),
      statementPage(3, 'rBST STATEMENT'),
      statementPage(4, 'IRRADIATION STATEMENT'),
      statementPage(5, 'ALLERGEN STATEMENT'),
    ];
    const r = detectPacket({ isPdf: true, pages });
    expect(r.looksLikePacket).toBe(true);
    expect(r.method).toBe('letterhead');
    expect(r.confidence_band).toBe('medium');
    expect(r.parts.map((p) => p.pages)).toEqual([[1, 1], [2, 2], [3, 3], [4, 4], [5, 5]]);
    // Every part says WHY the boundary is there, in a sentence.
    expect(r.parts[1].evidence).toMatch(/title line|ends with/);
  });

  it('disagreeing signals produce a COARSE proposal at low confidence, not precise ones', () => {
    // Title lines start pages 2 and 3; the repeated sign-off ends pages 4-7, so
    // the closing signal points at 5, 6 and 7. The two sets are disjoint —
    // exactly when a precise-looking boundary list would be invented.
    const pages: PacketPageInput[] = [
      { page: 1, text: 'C2\nOpening prose that is not a title and simply runs on.\n1', imageCoverage: 0.03 },
      { page: 2, text: 'C2\nALLERGEN STATEMENT\nJanuary 2, 2026\nBody prose here.\n2', imageCoverage: 0.03 },
      { page: 3, text: 'C2\nKOSHER CERTIFICATE\nJanuary 2, 2026\nBody prose here.\n3', imageCoverage: 0.03 },
      { page: 4, text: `C2\nContinuing prose with no heading.\n${SIGNOFF}\n4`, imageCoverage: 0.03 },
      { page: 5, text: `C2\nContinuing prose with no heading.\n${SIGNOFF}\n5`, imageCoverage: 0.03 },
      { page: 6, text: `C2\nContinuing prose with no heading.\n${SIGNOFF}\n6`, imageCoverage: 0.03 },
      { page: 7, text: `C2\nContinuing prose with no heading.\n${SIGNOFF}\n7`, imageCoverage: 0.03 },
      { page: 8, text: 'C2\nContinuing prose with no heading.\n8', imageCoverage: 0.03 },
    ];
    const permissive = new Set([2, 3, 5, 6, 7, 8]);
    const r = detectPacket({ isPdf: true, pages });
    expect(r.looksLikePacket).toBe(true);
    expect(r.confidence_band).toBe('low');
    expect(r.notes.join(' ')).toMatch(/disagree/);
    // COARSE: strictly fewer boundaries than the permissive read, and every one
    // that survives had more than one signal behind it.
    const starts = r.parts.slice(1).map((p) => p.pages[0]);
    expect(starts.length).toBeLessThan(permissive.size);
    for (const s of starts) expect(permissive.has(s)).toBe(true);
  });

  it('an inserted full-page certificate image is a boundary on its own', () => {
    const pages: PacketPageInput[] = [
      statementPage(1, 'LETTER OF GUARANTEE'),
      { page: 2, text: 'C2\n2', imageCoverage: 0.54 },
      { page: 3, text: 'C2\n3', imageCoverage: 0.39 },
      statementPage(4, 'ALLERGEN STATEMENT'),
    ];
    const r = detectPacket({ isPdf: true, pages });
    expect(r.looksLikePacket).toBe(true);
    expect(r.parts.map((p) => p.pages[0])).toContain(2);
    expect(r.parts.map((p) => p.pages[0])).toContain(3);
  });

  it('a missing image measurement weakens one signal and invents nothing', () => {
    const pages = [
      statementPage(1, 'LETTER OF GUARANTEE'),
      statementPage(2, 'rBST STATEMENT'),
      statementPage(3, 'IRRADIATION STATEMENT'),
      statementPage(4, 'ALLERGEN STATEMENT'),
    ].map((p) => ({ page: p.page, text: p.text })); // no imageCoverage at all
    const r = detectPacket({ isPdf: true, pages });
    expect(r.looksLikePacket).toBe(true);
    expect(r.parts).toHaveLength(4);
  });
});

describe('looksLikeTitleLine — the line that keeps a HACCP plan in one piece', () => {
  it('accepts a shouted or title-cased document title', () => {
    expect(looksLikeTitleLine('FDA BIOTERRORISM STATEMENT')).toBe(true);
    expect(looksLikeTitleLine('alouette Halal Certificate')).toBe(true);
    expect(looksLikeTitleLine('Letter of Guarantee')).toBe(true);
  });

  it('rejects prose, table headers, sign-offs and product names', () => {
    expect(looksLikeTitleLine('Below is a table of sensitivities and these are not regulated.')).toBe(false);
    expect(looksLikeTitleLine('COMPONENT | PRESENT IN | PRESENT IN OTHER')).toBe(false);
    expect(looksLikeTitleLine('louise.newswanger@example.com')).toBe(false);
    // No document word: a capitalised product line is not a new document.
    expect(looksLikeTitleLine('Regular Cream Cheese, Neufchatel')).toBe(false);
  });
});

describe('what a reviewer hands back is validated', () => {
  it('accepts ordered, non-overlapping ranges inside the file', () => {
    expect(validateRanges([{ pages: [1, 2] }, { pages: [3, 3] }, { pages: [5, 8] }], 10)).toBeNull();
  });

  it('a GAP is allowed — dropping a part is the Adjust flow working', () => {
    expect(validateRanges([{ pages: [1, 2] }, { pages: [6, 8] }], 10)).toBeNull();
  });

  it('rejects overlap, inversion, out-of-range and an empty set', () => {
    expect(validateRanges([{ pages: [1, 4] }, { pages: [3, 6] }], 10)?.kind).toBe('overlap');
    expect(validateRanges([{ pages: [5, 2] }], 10)?.kind).toBe('bad_range');
    expect(validateRanges([{ pages: [1, 40] }], 10)?.kind).toBe('out_of_range');
    expect(validateRanges([], 10)?.kind).toBe('no_parts');
  });

  it('caps how many parts one split may produce', () => {
    const many = Array.from({ length: MAX_PARTS_PER_SPLIT + 1 }, (_, i) => ({ pages: [i + 1, i + 1] as [number, number] }));
    expect(validateRanges(many, 500)?.kind).toBe('too_many');
  });

  it('pagesOfRange enumerates the pages extractRecordPdf wants', () => {
    expect(pagesOfRange({ pages: [17, 19] })).toEqual([17, 18, 19]);
  });
});

// ---------------------------------------------------------------------------
// The real thing
// ---------------------------------------------------------------------------

describe('the client packet, against the page ranges recorded in corpus.json', () => {
  const pages: PacketPageInput[] = (packetPages.pages as { page: number; text: string; imageCoverage: number }[]).map(
    (p) => ({ page: p.page, text: p.text, imageCoverage: p.imageCoverage }),
  );
  const truth = (realCorpus.documents as { id: string; part_of?: string; pages?: number[] }[])
    .filter((d) => d.part_of === 'packet-fdlw-2026' && Array.isArray(d.pages) && d.pages.length)
    .map((d) => [Math.min(...(d.pages as number[])), Math.max(...(d.pages as number[]))])
    .sort((a, b) => a[0] - b[0]);

  it('finds all 26 documents, on their exact page ranges', () => {
    const r = detectPacket({ isPdf: true, pages });
    expect(r.looksLikePacket).toBe(true);
    expect(r.method).toBe('index');
    expect(r.confidence_band).toBe('high');
    expect(r.parts.map((p) => [p.pages[0], p.pages[1]])).toEqual(truth);
  });

  it('says which page is in no part rather than bolting it onto the last document', () => {
    const r = detectPacket({ isPdf: true, pages });
    // Page 36 is a near-blank back cover. Attaching it to the eight-page HACCP
    // plan would be a silent lie about that document's extent; leaving it out
    // silently would be a page nobody is told about.
    expect(r.uncovered_pages).toEqual([36]);
    expect(r.notes.join(' ')).toMatch(/36/);
  });

  it('each of the packet\'s own multi-page parts reads as ONE document', () => {
    for (const [from, to] of truth.filter(([a, b]) => b > a)) {
      const slice = pages.filter((p) => p.page >= from && p.page <= to).map((p, i) => ({ ...p, page: i + 1 }));
      const r = detectPacket({ isPdf: true, pages: slice });
      expect(r.looksLikePacket, `pages ${from}-${to} should read as one document`).toBe(false);
    }
  });
});
