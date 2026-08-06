/**
 * Unit tests for shared/pdfTextSerializer.ts — the geometry-aware PDF text
 * serializer and the broken-encoding guard that makes it shippable.
 *
 * THE TWO THINGS THAT MUST NEVER SILENTLY BREAK:
 *
 *  1. GEOMETRY. pdfjs emits text items in content-stream order, which on a real
 *     COA is frequently not reading order at all. The serializer regroups by
 *     y and reorders by x, and the newlines it emits are the entire point —
 *     the old path collapsed them and fed the model the whole page as ONE LINE.
 *     A regression that quietly re-flattens the output would be invisible in
 *     production and cost ~6pp of extraction accuracy.
 *
 *  2. THE GUARD. Documents with a broken `ToUnicode` CMap emit Private-Use-Area
 *     codepoints. unpdf's extractText renders them as whitespace, so the empty
 *     text triggers the OCR fallback and the page is read correctly.
 *     getTextContent returns them raw, and serializing them yields ~1000
 *     characters with ZERO letters — non-empty, so OCR would be suppressed and
 *     the model handed garbage. That destroyed 6 of 99 documents in the scale
 *     A/B (a complete 9-11 field extraction went to `{}`). The guard is the one
 *     line standing between this change and that regression.
 *
 * Pure functions — no PDF, no DB, no model.
 */

import { describe, it, expect } from 'vitest';
import {
  serializePageItems,
  serializePages,
  looksLikeBrokenEncoding,
  shouldUseSerializedPages,
  countLetters,
  SERIALIZED_MIN_CHARS_TO_JUDGE,
  SERIALIZED_MIN_LETTERS,
  DEFAULT_PDF_SERIALIZER_CONFIG,
  type PdfTextItem,
} from '../../shared/pdfTextSerializer';
import processWorkerSource from '../../bin/process-worker?raw';

/**
 * Build a pdfjs-shaped text item. `transform` is [a, b, c, d, e, f]; index 3 is
 * the glyph height, 4 is x, 5 is y (y grows UPWARD in PDF user space).
 */
function item(str: string, x: number, y: number, width: number, height = 10): PdfTextItem {
  return { str, transform: [height, 0, 0, height, x, y], width, height };
}

describe('serializePageItems — row grouping by y', () => {
  it('puts items that share a baseline on ONE line and higher rows FIRST', () => {
    // Deliberately supplied bottom-up and right-to-left, i.e. NOT reading order.
    const out = serializePageItems([
      item('WORLD', 95, 700, 40), // 5pt after HELLO ends at 90 — a word gap
      item('HELLO', 50, 700, 40),
      item('SECOND', 50, 688, 50),
    ]);
    expect(out).toBe('HELLO WORLD\nSECOND');
  });

  it('treats a sub-tolerance y wobble as the same row, not two rows', () => {
    // rowTol = medianHeight (10) * 0.45 = 4.5pt.
    const out = serializePageItems([
      item('LOT', 50, 700, 20),
      item('12345', 75, 697.5, 30), // 2.5pt below, 5pt right — same visual row
    ]);
    expect(out).toBe('LOT 12345');
  });

  it('splits rows once the y gap exceeds the tolerance', () => {
    const out = serializePageItems([
      item('LOT', 50, 700, 20),
      item('12345', 50, 693, 30), // 7pt below — a different row
    ]);
    expect(out).toBe('LOT\n12345');
  });

  it('scales the row tolerance with the page font size', () => {
    // Same 7pt wobble, but on a 30pt-tall heading font: tol = 30 * 0.45 = 13.5.
    const out = serializePageItems([
      item('BIG', 50, 700, 60, 30),
      item('HEADING', 130, 693, 90, 30),
    ]);
    expect(out).toBe('BIG HEADING');
  });
});

describe('serializePageItems — column ordering and delimiters by x', () => {
  it('orders items within a row by x regardless of content-stream order', () => {
    const out = serializePageItems([
      item('THIRD', 300, 700, 40),
      item('FIRST', 50, 700, 40),
      item('SECOND', 150, 700, 40),
    ]);
    // Every gap here is wide, so each is its own column, but the ORDER is the point.
    expect(out.split(' | ')).toEqual(['FIRST', 'SECOND', 'THIRD']);
  });

  it('marks a wide horizontal gap as a column boundary', () => {
    // colGap = medianHeight (10) * 0.9 = 9pt of clear space.
    const out = serializePageItems([
      item('LOT #:', 50, 700, 30),
      item('196161', 200, 700, 40), // 120pt of white space away
    ]);
    expect(out).toBe('LOT #: | 196161');
  });

  it('uses a plain space for a word-sized gap and no separator for a tight one', () => {
    // wordGap = 10 * 0.12 = 1.2pt; colGap = 9pt.
    const spaced = serializePageItems([
      item('CODE', 50, 700, 30),
      item('DATE', 84, 700, 30), // 4pt gap: a word break, not a column
    ]);
    expect(spaced).toBe('CODE DATE');

    const joined = serializePageItems([
      item('19', 50, 700, 10),
      item('6161', 60.5, 700, 20), // 0.5pt gap: the same word split by pdfjs
    ]);
    expect(joined).toBe('196161');
  });

  it('keeps an EMPTY table cell visible as an empty column', () => {
    // The blank `CMF ITEM #` cell is why serialization stops the model
    // fabricating a product code: the delimiters show the cell is empty.
    const out = serializePageItems([
      item('CMF ITEM #:', 50, 700, 60),
      item('LOT:', 300, 700, 25),
      item('061626', 400, 700, 40),
    ]);
    expect(out).toBe('CMF ITEM #: | LOT: | 061626');
  });
});

describe('serializePageItems — newline preservation', () => {
  it('emits one newline per row and a BLANK line across a paragraph gap', () => {
    // paraGap = 10 * 1.8 = 18pt.
    const out = serializePageItems([
      item('CERTIFICATE OF ANALYSIS', 50, 740, 150),
      item('SUPPLIER: ACME', 50, 726, 90), // 14pt — normal line spacing
      item('RESULTS', 50, 690, 50), // 36pt — a section break
    ]);
    expect(out).toBe('CERTIFICATE OF ANALYSIS\nSUPPLIER: ACME\n\nRESULTS');
  });

  it('does NOT flatten the page the way the old collapse did', () => {
    // The pre-port path was pages.join('\n').replace(/\s+/g,' '), which turned
    // every document below into a single line. This is the regression test for
    // exactly that: the serializer's value IS the newlines.
    const rows = [0, 1, 2, 3, 4].map((n) => item(`ROW ${n}`, 50, 700 - n * 12, 40));
    const out = serializePageItems(rows);
    expect(out.split('\n')).toHaveLength(5);
    expect(out).toContain('\n');
    expect(out.replace(/\s+/g, ' ')).toBe('ROW 0 ROW 1 ROW 2 ROW 3 ROW 4');
  });
});

describe('serializePageItems — empty and degenerate input', () => {
  it('returns EMPTY for a page with no text items, so OCR routing still fires', () => {
    // An image-only (scanned) page. The caller must see "" here, decline the
    // override, and let the existing empty-text OCR fallback do its job.
    expect(serializePageItems([])).toBe('');
  });

  it('returns EMPTY for a page whose only items are whitespace', () => {
    expect(serializePageItems([item('   ', 50, 700, 10), item('\n', 60, 700, 10)])).toBe('');
  });

  it('survives a degenerate transform without collapsing every tolerance to zero', () => {
    // A zero vertical scale would make rowTol/colGap 0 and shatter the page
    // into one row per item; the height fallback chain prevents that.
    const out = serializePageItems([
      { str: 'A', transform: [0, 0, 0, 0, 50, 700] },
      { str: 'B', transform: [0, 0, 0, 0, 51, 700] },
    ]);
    expect(out).toBe('AB');
  });

  it('serializePages preserves page count, blanks included', () => {
    expect(serializePages([[item('PAGE ONE', 50, 700, 60)], [], []])).toEqual([
      'PAGE ONE',
      '',
      '',
    ]);
    expect(serializePages([])).toEqual([]);
  });
});

describe('the broken-encoding guard', () => {
  /** ~900 chars of Private-Use-Area codepoints — the real West Point signature. */
  const puaGarbage = Array.from({ length: 900 }, (_, i) =>
    String.fromCharCode(0xf020 + (i % 90)),
  ).join('');

  it('counts Unicode letters and does NOT count PUA codepoints as letters', () => {
    expect(countLetters('abc DEF')).toBe(6);
    expect(countLetters('123 456 -/.')).toBe(0);
    expect(countLetters(puaGarbage)).toBe(0);
    // Non-Latin scripts are real text and must count.
    expect(countLetters('Ürünler')).toBe(7);
  });

  it('FIRES on a long, no-alpha serialization (the PUA regression)', () => {
    expect(puaGarbage.length).toBeGreaterThan(SERIALIZED_MIN_CHARS_TO_JUDGE);
    expect(looksLikeBrokenEncoding(puaGarbage)).toBe(true);
    expect(shouldUseSerializedPages([puaGarbage])).toBe(false);
  });

  it('fires on PUA text that has actually been through the serializer', () => {
    // End-to-end: broken glyphs laid out as rows are still zero-letter garbage.
    const items: PdfTextItem[] = [];
    for (let row = 0; row < 30; row++) {
      for (let col = 0; col < 4; col++) {
        const s = Array.from({ length: 8 }, (_, k) =>
          String.fromCharCode(0xf030 + ((row + col + k) % 60)),
        ).join('');
        items.push(item(s, 50 + col * 120, 700 - row * 12, 40));
      }
    }
    const page = serializePageItems(items);
    expect(page.length).toBeGreaterThan(SERIALIZED_MIN_CHARS_TO_JUDGE);
    expect(countLetters(page)).toBe(0);
    expect(shouldUseSerializedPages([page])).toBe(false);
  });

  it('does NOT fire on ordinary serialized COA text', () => {
    const page = serializePageItems([
      item('CERTIFICATE OF ANALYSIS', 50, 740, 150),
      item('Supplier: Country Morning Farms', 50, 726, 160),
      item('Product: Half and Half 5 Gallon', 50, 714, 160),
      item('LOT:', 50, 700, 25),
      item('061626WHO', 200, 700, 60),
      item('Standard Plate Count', 50, 688, 110),
      item('<10,000 cfu/g', 300, 688, 70),
    ]);
    expect(looksLikeBrokenEncoding(page)).toBe(false);
    expect(shouldUseSerializedPages([page])).toBe(true);
    // And the geometry survived.
    expect(page).toContain('LOT: | 061626WHO');
    expect(page.split('\n').length).toBeGreaterThan(1);
  });

  it('does not fire on short output — too little to judge, and declining buys nothing', () => {
    const short = '1'.repeat(SERIALIZED_MIN_CHARS_TO_JUDGE);
    expect(countLetters(short)).toBe(0);
    expect(looksLikeBrokenEncoding(short)).toBe(false);
  });

  it('sits at the documented threshold, exclusive on both sides', () => {
    const pad = '0'.repeat(SERIALIZED_MIN_CHARS_TO_JUDGE + 1);
    const justUnder = 'a'.repeat(SERIALIZED_MIN_LETTERS - 1) + pad;
    const justAt = 'a'.repeat(SERIALIZED_MIN_LETTERS) + pad;
    expect(looksLikeBrokenEncoding(justUnder)).toBe(true);
    expect(looksLikeBrokenEncoding(justAt)).toBe(false);
    // The real corpus has NOTHING between 0 and 241 letters, so the exact
    // boundary is a documentation detail, not a tuning knob.
    expect(SERIALIZED_MIN_LETTERS).toBe(40);
    expect(SERIALIZED_MIN_CHARS_TO_JUDGE).toBe(200);
  });
});

describe('shouldUseSerializedPages — the caller-facing decision', () => {
  it('declines an all-blank document so the existing OCR fallback keeps working', () => {
    expect(shouldUseSerializedPages([])).toBe(false);
    expect(shouldUseSerializedPages([''])).toBe(false);
    expect(shouldUseSerializedPages(['', '', ''])).toBe(false);
    expect(shouldUseSerializedPages(['   \n  '])).toBe(false);
    expect(shouldUseSerializedPages(null)).toBe(false);
    expect(shouldUseSerializedPages(undefined)).toBe(false);
  });

  it('accepts a multi-page document where only some pages carry text', () => {
    expect(shouldUseSerializedPages(['', 'LOT: 196161\nPRODUCT: BUTTER', ''])).toBe(true);
  });

  it('judges the pages JOINED, not one at a time', () => {
    // A short blank-ish first page must not rescue a broken document, and a
    // broken page must not condemn a document that is mostly real text.
    const pua = String.fromCharCode(0xf041).repeat(900);
    expect(shouldUseSerializedPages(['', pua])).toBe(false);
    expect(shouldUseSerializedPages(['Certificate of Analysis for lot 196161 butter', pua])).toBe(
      false,
    );
    const realPage = 'Certificate of Analysis '.repeat(20);
    expect(countLetters(realPage)).toBeGreaterThan(SERIALIZED_MIN_LETTERS);
    expect(shouldUseSerializedPages([realPage, pua])).toBe(true);
  });
});

describe('config', () => {
  it('exposes the measured `rc` variant as the default', () => {
    // These are results from an A/B, not preferences. Changing one invalidates
    // the +6.2pp measurement.
    expect(DEFAULT_PDF_SERIALIZER_CONFIG).toEqual({
      colGap: 0.9,
      paraGap: 1.8,
      colDelim: ' | ',
      rowTol: 0.45,
      wordGap: 0.12,
    });
  });
});

/**
 * bin/process-worker is a standalone CJS daemon that cannot be imported into
 * the Workers test pool, so we assert on its source text — the same `?raw`
 * strategy as processWorkerDispatch/Vlm/Instructions.
 *
 * There are TWO PDF branches in that file: `extractTextAndPages` (order and
 * shipment kinds) and the inline extractor in `processCoaItem`, which is kept
 * deliberately separate so the COA path is never disturbed. They must not
 * drift: a port that wired only one of them would leave half the pipeline on
 * the old flattened text with nothing to say so.
 */
describe('bin/process-worker wiring', () => {
  it('wires the serializer into BOTH PDF branches', () => {
    expect(processWorkerSource).toMatch(/require\('\.\/lib\/shared\/pdfTextSerializer'\)/);
    const calls = processWorkerSource.match(/await serializePdfGeometry\(geomBuffer, item\.file_name\)/g);
    expect(calls).toHaveLength(2);
    // Both branches must copy the bytes first — unpdf detaches the ArrayBuffer
    // it is handed, so a shared buffer would make the geometry pass see nothing.
    expect(processWorkerSource.match(/const geomBuffer = fileBuffer\.slice\(0\)/g)).toHaveLength(2);
  });

  it('applies the serialization AFTER the OCR fallback in both branches', () => {
    // Order is load-bearing: OCR routing must stay a decision about the OLD
    // text. Applying serialization first would suppress OCR on exactly the
    // broken-encoding documents the guard exists to protect.
    for (const branch of processWorkerSource.split('const geomBuffer = fileBuffer.slice(0)').slice(1)) {
      const ocr = branch.indexOf('ocrPdf(fileBufferCopy)');
      const geom = branch.indexOf('await serializePdfGeometry(');
      expect(ocr).toBeGreaterThan(-1);
      expect(geom).toBeGreaterThan(ocr);
    }
  });

  it('does NOT re-collapse the serialized text', () => {
    // `pages.join('\n').replace(/\s+/g,' ')` is the exact thing being removed;
    // reintroducing it anywhere near the serializer would silently undo the
    // whole change while every other signal still looked healthy.
    expect(processWorkerSource).toMatch(
      /return \{ pages, text: pages\.join\('\\n'\)\.substring\(0, 100000\) \};/
    );
    expect(processWorkerSource).not.toMatch(
      /serializePdfPages[\s\S]{0,400}replace\(\/\\s\+\/g, ' '\)/
    );
  });
});

describe('word gap scales with LOCAL type size, not the page median', () => {
  // THE FALSE-JOIN DEFECT. wordGap was measured against the PAGE's median glyph
  // height, so every run of text SMALLER than the page's typical type got
  // under-spaced: a genuine inter-word space in 6pt legal print is narrower than
  // 0.12 x the median of a page whose body is 10pt. Production output showed
  // `WITHOUT PRIOR WRITTEN APPROVAL` -> `WRITTENAPPROVAL` and
  // `IS REPRESENTATIVE OF` -> `REPRESENTATIVEOF` — a new failure mode in the
  // OPPOSITE direction from the smashing this module exists to fix, and one that
  // degrades what the MODEL reads, not just the search index.

  it('keeps small-print words apart on a page whose median type is larger', () => {
    // Page median is driven to 20 by the body rows; the footer is 5pt.
    // Footer word gap is 0.5pt = 0.10 x local height (spaced, > 0.12? no —
    // use a gap that is clearly a word space locally but far below page-median
    // scaling, which is exactly the failing case).
    const page = serializePageItems([
      item('BODY', 50, 700, 80, 20),
      item('TEXT', 140, 700, 80, 20),
      item('WRITTEN', 50, 600, 20, 5),
      item('APPROVAL', 71.5, 600, 22, 5), // 1.5pt gap = 0.30 x 5pt local height
    ]);
    expect(page).toContain('WRITTEN APPROVAL');
    expect(page).not.toContain('WRITTENAPPROVAL');
  });

  it('still joins genuine intra-word fragments in small print', () => {
    // Kerning splits inside one word produce near-zero gaps; those must NOT
    // become spaces or the fix would trade one smashing defect for another.
    const page = serializePageItems([
      item('BODY', 50, 700, 80, 20),
      item('APPRO', 50, 600, 15, 5),
      item('VAL', 65.1, 600, 9, 5), // 0.1pt gap = 0.02 x local height
    ]);
    expect(page).toContain('APPROVAL');
  });

  it('leaves COLUMN detection on the page median', () => {
    // Whether two runs are separate columns is a property of the page layout,
    // not of either run's type size — a small-print cell in a wide table is
    // still its own column.
    const page = serializePageItems([
      item('BODY', 50, 700, 80, 20),
      item('LEFT', 50, 600, 20, 5),
      item('RIGHT', 100, 600, 20, 5), // 30pt gap: >> 0.9 x page median (20)
    ]);
    expect(page).toContain('|');
  });
});
