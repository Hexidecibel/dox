/**
 * shared/pdfTextSerializer.ts — geometry-aware PDF text serialization, plus the
 * guard that makes it safe to ship.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS REPLACES
 * ---------------------------------------------------------------------------
 * The text a COA extraction sees used to be built like this:
 *
 *     unpdf.extractText(bytes, { mergePages: false })  ->  pages[]
 *     text = pages.join('\n').replace(/\s+/g, ' ').substring(0, 100000)
 *
 * pdfjs emits text items in CONTENT-STREAM order, and every item carries an
 * affine transform (x, y) plus a measured width. The join+collapse above throws
 * ALL of that geometry away. For a single-page document — 99% of the corpus —
 * the model is then fed `text.substring(0, 6000)`, i.e. THE ENTIRE PAGE AS ONE
 * CONTINUOUS LINE, with the column a value sat in and the row it belonged to
 * both erased. 7 of the 8 documents in the original serialization study reached
 * the model that way.
 *
 * This module rebuilds the page from the geometry instead:
 *
 *   1. items are grouped into visual ROWS by y-proximity (tolerance derived
 *      from the page's own median glyph height, so it scales with font size)
 *   2. within a row, items are ordered by x — this is the reading-order repair
 *   3. horizontal gaps wider than `colGap` line-heights become an explicit
 *      column delimiter, so a table reads as a table
 *   4. vertical gaps wider than `paraGap` line-heights become a blank line
 *
 * Measured (n=99 documents, 33 labelled, A/B against the same model on the same
 * box): +6.2pp [+2.6, +10.7] on the documents that have a text layer at all,
 * +4.8pp [+2.1, +8.5] over the whole labelled set. It beats a 3.5x-larger model
 * that costs 2.13x the wall time. The layout maths below is ~0.1 ms/document;
 * the caller's extra pdfjs pass to collect the items is ~11 ms/document, which
 * is 0.03% of a document's inference time. See SCALE-AB-REPORT.md /
 * SERIALIZATION-REPORT.md in the measurement scratchpad.
 *
 * ---------------------------------------------------------------------------
 * WHY THE GUARD IS NOT OPTIONAL
 * ---------------------------------------------------------------------------
 * Some PDFs carry a broken `ToUnicode` CMap and emit Private-Use-Area
 * codepoints (U+F0xx) instead of real characters. `unpdf.extractText()` maps
 * those to whitespace, so the old path produced an EMPTY string, which is
 * exactly what trips the pipeline's `text.trim().length === 0` OCR fallback —
 * tesseract then runs and reads the page correctly.
 *
 * `page.getTextContent()`, which this serializer consumes, returns the raw PUA
 * codepoints. Laid out faithfully they become ~800-1000 characters containing
 * ZERO letters. That is not empty, so the OCR fallback never fires and the
 * model is handed pure garbage. At scale this destroyed 6 of 99 sampled
 * documents outright: complete correct extractions (9-11 fields, 1 record) went
 * to `{}` with 0 records. One labelled case went 6.5/7 to 0.0/7. Unguarded, the
 * whole serialization gain measures +1.5pp [-6.8, +7.9] — not significant. The
 * benefit is entirely contingent on declining these.
 *
 * The guard therefore refuses serialized output that has essentially no
 * alphabetic content, and the caller falls back to the pre-existing text path —
 * which means the OCR routing decision is made on the OLD text exactly as
 * before. DECLINING IS ALWAYS THE STATUS QUO: a false positive costs only the
 * serialization improvement on that document, never a regression.
 *
 * Dependency rule: pure, imports nothing. It is bundled for plain Node by
 * `npm run build:worker-shared` into `bin/lib/shared/pdfTextSerializer.js`
 * (consumed by `bin/process-worker`) and is directly unit-testable.
 */

// ---------------------------------------------------------------------------
// Input shape
// ---------------------------------------------------------------------------

/**
 * The subset of pdfjs's `TextItem` this module needs. Declared structurally so
 * the module never has to import pdfjs/unpdf types (and so tests can build
 * items by hand).
 *
 * `transform` is the pdfjs affine matrix [a, b, c, d, e, f]: index 3 is the
 * vertical scale (glyph height), 4 is x, 5 is y. y grows UPWARD in PDF user
 * space, so a larger y means higher on the page.
 */
export interface PdfTextItem {
  str: string;
  transform: number[];
  width?: number;
  height?: number;
}

/**
 * Tunables, all expressed in multiples of the page's median glyph height so
 * they are font-size independent.
 *
 * These are the `rc` variant from the study — the one that scored 44.5/47 at
 * n=8 and +6.2pp at n=99. Four other variants (wider/tighter columns, looser
 * rows, tab and space delimiters) were measured and none beat it, so the
 * numbers below are results, not guesses. Do not tune them without re-running
 * an arm.
 */
export interface PdfSerializerConfig {
  /** Horizontal gap (in line-heights) above which two items are separate columns. */
  colGap: number;
  /** Vertical gap (in line-heights) above which two rows are separate paragraphs. */
  paraGap: number;
  /** Inserted between columns. A visible delimiter is what makes an EMPTY cell visibly empty. */
  colDelim: string;
  /** Row grouping tolerance (in line-heights) for "these items share a baseline". */
  rowTol: number;
  /** Horizontal gap (in line-heights) above which two items get a space between them. */
  wordGap: number;
}

export const DEFAULT_PDF_SERIALIZER_CONFIG: PdfSerializerConfig = {
  colGap: 0.9,
  paraGap: 1.8,
  colDelim: ' | ',
  rowTol: 0.45,
  wordGap: 0.12,
};

// ---------------------------------------------------------------------------
// The guard
// ---------------------------------------------------------------------------

/**
 * Below this length there is not enough signal to judge, and declining would
 * cost nothing anyway (a page this short is already going to OCR or is a true
 * scan). Chosen so the 31 empty/1-char serializations in the 451-document
 * corpus are simply "empty" rather than "broken".
 */
export const SERIALIZED_MIN_CHARS_TO_JUDGE = 200;

/**
 * Minimum number of Unicode letters a serialization of >200 chars must contain
 * to be believed.
 *
 * WHERE 40 COMES FROM — measured over all 451 documents in the production
 * corpus, serialized with the config above:
 *
 *   - 7 documents (all Dairy Products LLC / West Point, i.e. 100% of that
 *     supplier) produced 769-1042 characters with **exactly 0 letters**. These
 *     are the broken-CMap documents; on every one of them OCR reads the page
 *     correctly and must be allowed to run.
 *   - Every other document longer than 200 characters had **at least 241
 *     letters** (median 983).
 *
 * So the real distribution has a hole between 0 and 241 with nothing in it. 40
 * sits inside that hole, ~6x below the smallest genuine value and comfortably
 * above the noise a stray mapped glyph could produce in an otherwise-broken
 * document. Any threshold in roughly [5, 200] classifies this corpus
 * identically; 40 is the value the scale study used and validated.
 *
 * Private-Use-Area codepoints are general category Co, not L, so `\p{L}` does
 * not count them — which is exactly the property being exploited.
 */
export const SERIALIZED_MIN_LETTERS = 40;

/** Count Unicode letters (any script). PUA codepoints are category Co and do not count. */
export function countLetters(text: string): number {
  if (!text) return 0;
  const m = text.match(/\p{L}/gu);
  return m ? m.length : 0;
}

/**
 * THE GUARD. True when a serialization is long enough to judge and yet has
 * essentially no letters in it — the broken-`ToUnicode` signature described in
 * the header.
 *
 * Kept as a named predicate on purpose: it is the single line standing between
 * this change and a 1.6%-of-corpus catastrophic regression, and it must be
 * greppable, testable and explainable on its own.
 */
export function looksLikeBrokenEncoding(text: string): boolean {
  const t = text || '';
  if (t.length <= SERIALIZED_MIN_CHARS_TO_JUDGE) return false;
  return countLetters(t) < SERIALIZED_MIN_LETTERS;
}

/**
 * Should the caller USE this serialization in place of its existing text layer?
 *
 * Declines when:
 *   - there is nothing there (all pages blank) — a true scan; the caller's
 *     existing empty-text OCR routing must be left to do its job, and
 *   - the joined text trips `looksLikeBrokenEncoding`.
 *
 * A decline means "behave exactly as before", never "fail".
 */
export function shouldUseSerializedPages(pages: string[] | null | undefined): boolean {
  if (!pages || pages.length === 0) return false;
  if (!pages.some((p) => typeof p === 'string' && p.trim().length > 0)) return false;
  return !looksLikeBrokenEncoding(pages.join('\n'));
}

// ---------------------------------------------------------------------------
// The serializer
// ---------------------------------------------------------------------------

function median(values: number[]): number {
  if (!values.length) return 10;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

interface Placed {
  s: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Serialize ONE page's text items into geometry-faithful text.
 *
 * Returns '' for a page with no usable items (image-only page), which is what
 * lets `shouldUseSerializedPages` recognise a true scan and stand aside.
 */
export function serializePageItems(
  items: PdfTextItem[],
  config: PdfSerializerConfig = DEFAULT_PDF_SERIALIZER_CONFIG,
): string {
  const cfg = config;
  const placed: Placed[] = (items || [])
    .filter((i) => i && typeof i.str === 'string' && i.str.length > 0 && i.str.trim().length > 0)
    .map((i) => {
      const t = i.transform || [];
      // Glyph height: vertical scale, then horizontal scale, then the reported
      // height, then a sane default. Rotated/degenerate matrices otherwise
      // yield 0 and collapse every tolerance to 0.
      const h = Math.abs(t[3]) || Math.abs(t[0]) || Math.abs(i.height || 0) || 10;
      // pdfjs measures width for us; when it doesn't, approximate from the
      // glyph count so column-gap detection still has an end-of-item x.
      const w = typeof i.width === 'number' && i.width > 0 ? i.width : i.str.length * h * 0.5;
      return { s: i.str.trim(), x: t[4], y: t[5], w, h };
    });

  if (!placed.length) return '';

  const mh = median(placed.map((i) => i.h));
  const rowTol = mh * cfg.rowTol;

  // ---- 1. group into visual ROWS by y (top of page first) ----
  const byY = [...placed].sort((a, b) => b.y - a.y || a.x - b.x);
  const rows: { y: number; items: Placed[] }[] = [];
  for (const it of byY) {
    const last = rows[rows.length - 1];
    if (last && Math.abs(last.y - it.y) <= rowTol) {
      last.items.push(it);
      // Running MEAN anchor: a long row whose items drift a fraction of a point
      // each would otherwise walk out of tolerance and split in the middle.
      last.y = (last.y * (last.items.length - 1) + it.y) / last.items.length;
    } else {
      rows.push({ y: it.y, items: [it] });
    }
  }

  // ---- 2/3. order within a row by x; wide gaps become column delimiters ----
  const lines: { y: number; text: string }[] = [];
  for (const r of rows) {
    r.items.sort((a, b) => a.x - b.x);
    let line = '';
    let prevEnd: number | null = null;
    let prevH = 0;
    for (const it of r.items) {
      if (prevEnd === null) {
        line = it.s;
        prevEnd = it.x + it.w;
        prevH = it.h;
        continue;
      }
      const gap = it.x - prevEnd;
      // COLUMN detection stays on the PAGE median: whether two runs of text are
      // separate columns is a property of the page's layout, not of the type
      // size of either run.
      //
      // WORD spacing is the opposite — it is entirely local. Scaling it by the
      // page median silently under-spaces every run of text SMALLER than the
      // page's typical glyph, because a genuine inter-word space in 6pt legal
      // print is narrower than 0.12 x the median of a page whose body text is
      // 10pt. That produced real false joins in production output:
      // `WITHOUT PRIOR WRITTEN APPROVAL` -> `WRITTENAPPROVAL`,
      // `IS REPRESENTATIVE OF` -> `REPRESENTATIVEOF` — a NEW failure mode in the
      // opposite direction from the smashing this serializer exists to fix, and
      // one that degrades what the MODEL reads, not just the search index.
      //
      // So measure the word gap against the LOCAL type size: the smaller of the
      // two adjacent glyph heights, which is the one whose spaces are narrower.
      // Falls back to the page median for degenerate/rotated matrices, where
      // the per-item height is already unreliable.
      const localH = Math.min(prevH || mh, it.h || mh) || mh;
      if (gap > mh * cfg.colGap) line += cfg.colDelim + it.s;
      else if (gap > localH * cfg.wordGap) line += ' ' + it.s;
      else line += it.s;
      prevEnd = it.x + it.w;
      prevH = it.h;
    }
    lines.push({ y: r.y, text: line.trim() });
  }

  // ---- 4. vertical gaps become a blank line ----
  let out = '';
  for (let k = 0; k < lines.length; k++) {
    if (k > 0) {
      const dy = lines[k - 1].y - lines[k].y;
      out += dy > mh * cfg.paraGap ? '\n\n' : '\n';
    }
    out += lines[k].text;
  }
  return out;
}

/** Serialize a whole document, one string per page, preserving page count. */
export function serializePages(
  pagesItems: PdfTextItem[][],
  config: PdfSerializerConfig = DEFAULT_PDF_SERIALIZER_CONFIG,
): string[] {
  return (pagesItems || []).map((items) => serializePageItems(items, config));
}
