/**
 * shared/pdfPageOcr.ts — decide OCR ONE PAGE AT A TIME, and merge the result
 * without ever losing text that was already better.
 *
 * ---------------------------------------------------------------------------
 * THE DEFECT THIS EXISTS FOR
 * ---------------------------------------------------------------------------
 * The extraction pipeline routes to OCR on a WHOLE-DOCUMENT question: is the
 * text layer empty, or is it garbled (`isTextGarbled`)? `pdfTextSerializer`'s
 * guard adds a third: is it >200 characters with almost no letters (a broken
 * `ToUnicode` CMap)? None of the three catches the shape a real supplier packet
 * actually contains — a page that is a PASTED PICTURE of a certificate with a
 * typed caption, a confidentiality banner and a page number over it.
 *
 * Measured on `tests/fixtures/real-corpus/pdf/packet-fdlw-2026.pdf`, the
 * client's own 36-page annual packet:
 *
 *   page  document                             text layer   largest image   OCR reads
 *   ----  -----------------------------------  ----------   -------------   ---------
 *     6   SQF certificate, expires 2026-04-23    4 chars        53.8%         1097
 *    13   OU kosher letter, thru 6/30/2026      81 chars        38.6%         1505
 *    14   OU kosher letter, thru 6/30/2026      70 chars        40.7%         1587
 *    15   IFANCA halal certificate              68 chars        38.0%         1384
 *    16   IFANCA halal, valid until 2026-10-31  32 chars        34.8%         1409
 *
 * Four to eighty-one characters is neither empty nor garbled, so tesseract
 * never ran and the model was handed the caption. Those five pages are the five
 * documents in the packet that carry real expiry dates; they scored 0 of 25
 * graded fields and were 25 of the corpus's 34 value errors.
 *
 * ---------------------------------------------------------------------------
 * THE RULE, AND WHY IT IS NOT A CHARACTER COUNT
 * ---------------------------------------------------------------------------
 * A bare "fewer than N characters -> OCR" rule is wrong in both directions, and
 * the same 36-page file contains a live counter-example for each:
 *
 *   * page 36 is a near-blank back cover: 5 characters, no picture. OCR on it
 *     costs 4-6x a text read and returns nothing. A genuinely sparse page is
 *     not a broken page.
 *   * the Smith Brothers spec sheet's only page is drawn on a background image
 *     covering 100% of the page — and carries 1957 characters of real text.
 *     Rasterising it would replace a perfect text layer with a worse read of
 *     the same words.
 *
 * So the question is not "how much text is there" but "is there far less text
 * than this page's own content implies". The signal is therefore a PAIR, and a
 * page qualifies only when BOTH halves hold:
 *
 *   1. one drawn image covers at least PAGE_IMAGE_COVERAGE_MIN of the page, and
 *   2. the page's text layer is shorter than PAGE_TEXT_CHARS_MAX.
 *
 * The LARGEST SINGLE image is the measure, not the summed area: a pasted
 * certificate is one image, whereas summing double-counts overlapping logos and
 * can exceed the page. Both thresholds sit inside measured holes (see each
 * constant), and both are required, so neither counter-example above moves.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS MODULE DOES NOT DO
 * ---------------------------------------------------------------------------
 * It never replaces the document-level routing that already exists. An empty or
 * garbled text layer still sends the WHOLE document to OCR exactly as before —
 * this pass runs only on documents that kept a per-page text layer, so a
 * decline here is always the status quo. And it never overwrites: see
 * `mergePageText`, where OCR is appended to the page's own text and only when
 * it adds substantially more than the page already had.
 *
 * Dependency rule: pure, imports nothing. Bundled for plain Node by
 * `npm run build:worker-shared` into `bin/lib/shared/pdfPageOcr.js`, which
 * `bin/lib/pdfPageOcr.js` (the one Node-side implementation shared by
 * `bin/process-worker` and `bin/lib/corpusText.js`) consumes.
 */

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** What one page looks like before any OCR decision is made. */
export interface PdfPageFacts {
  /** 1-based page number, as a human counts pages. */
  page: number;
  /** Characters in this page's text layer, trimmed. */
  chars: number;
  /**
   * Area of the LARGEST single drawn image on the page, as a fraction of the
   * page's own area (0..1). Not the sum — see the header.
   */
  imageCoverage: number;
  /** How many image-painting operators the page issued. Diagnostic only. */
  imageCount: number;
}

/**
 * Minimum share of the page one drawn image must cover for the page to be
 * treated as picture-shaped.
 *
 * WHERE 0.25 COMES FROM — every page of the real-document corpus, measured:
 *
 *   - the five inserted certificates cover 0.348, 0.380, 0.386, 0.407, 0.538
 *   - every other packet page's largest image is the letterhead logo, 0.036
 *   - the two Country Morning spec sheets' product photo is 0.124
 *   - the Andersen sheet draws no image at all, 0.000
 *
 * The distribution has a hole between 0.124 and 0.348 with nothing in it. 0.25
 * sits inside it, twice the largest innocent value and well below the smallest
 * real one. The Smith Brothers sheet's full-page background (1.000) is above
 * the line and is held back by the character half of the rule, which is the
 * point of requiring both.
 */
export const PAGE_IMAGE_COVERAGE_MIN = 0.25;

/**
 * Maximum characters a picture-shaped page may carry and still be treated as
 * unread — the length of a caption, a banner and a page number, not of a page.
 *
 * WHERE 300 COMES FROM — the same measurement:
 *
 *   - the five inserted certificates carry 4, 32, 68, 70 and 81 characters
 *   - the next-shortest page in the whole corpus that is not a blank cover is
 *     396 characters, and every page that passes the coverage gate above and is
 *     genuinely text carries 1957 or more
 *
 * 300 sits in the 81..396 hole. Raising it toward 1000 would start rasterising
 * short but real pages; lowering it below ~90 would lose the two kosher letters.
 */
export const PAGE_TEXT_CHARS_MAX = 300;

/**
 * How many pages of ONE document may be sent to OCR by this pass.
 *
 * OCR is 4-6x slower per page than a text read, and a pathological file — a
 * 300-page scan where every page happens to carry a stamped page number — would
 * otherwise turn one queue item into an hour of tesseract. Exhausting the
 * budget is NEVER silent: the pages that did not get OCR'd are recorded with
 * `ocr_budget_exhausted` in their provenance, so a reviewer sees that the file
 * has more unread pages than the pass was willing to pay for.
 */
export const MAX_OCR_PAGES_PER_DOCUMENT = 25;

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

export interface PageOcrDecision {
  page: number;
  ocr: boolean;
  /** Machine-readable, and the same string that lands in the stored provenance. */
  reason:
    | 'image_page_unread'
    | 'no_large_image'
    | 'text_present'
    | 'ocr_budget_exhausted';
}

/**
 * THE per-page routing decision. Both halves of the rule must hold; see the
 * header for why either alone is wrong.
 *
 * `no_large_image` is reported ahead of `text_present` deliberately: a page
 * with neither a picture nor text (a blank cover) is not a page OCR can help,
 * and saying so is more useful than saying it has no text.
 */
export function decidePageOcr(facts: PdfPageFacts): PageOcrDecision {
  const coverage = Number.isFinite(facts.imageCoverage) ? facts.imageCoverage : 0;
  const chars = Number.isFinite(facts.chars) ? facts.chars : 0;
  if (coverage < PAGE_IMAGE_COVERAGE_MIN) {
    return { page: facts.page, ocr: false, reason: 'no_large_image' };
  }
  if (chars >= PAGE_TEXT_CHARS_MAX) {
    return { page: facts.page, ocr: false, reason: 'text_present' };
  }
  return { page: facts.page, ocr: true, reason: 'image_page_unread' };
}

/**
 * Decide every page of a document, applying the per-document OCR budget in page
 * order. Returns one decision per input page, in page order.
 */
export function selectPagesForOcr(
  pages: PdfPageFacts[],
  budget: number = MAX_OCR_PAGES_PER_DOCUMENT,
): PageOcrDecision[] {
  let spent = 0;
  return (pages || []).map((f) => {
    const d = decidePageOcr(f);
    if (!d.ocr) return d;
    if (spent >= budget) return { page: d.page, ocr: false, reason: 'ocr_budget_exhausted' };
    spent++;
    return d;
  });
}

// ---------------------------------------------------------------------------
// The merge
// ---------------------------------------------------------------------------

/** Which read produced the text the model was given for one page. */
export type PageTextSource = 'text-layer' | 'ocr' | 'text-layer+ocr';

export interface PageMergeResult {
  text: string;
  source: PageTextSource;
  /** Why the merge went the way it did. Stored with the provenance. */
  reason: 'no_embedded_text' | 'ocr_adds_text' | 'ocr_added_nothing' | 'ocr_empty';
}

/**
 * Minimum letters an OCR read must contribute before it is worth appending to a
 * page that already had text. Below this it is a page number and a watermark
 * read twice.
 */
export const OCR_MIN_LETTERS_TO_APPEND = 200;

/**
 * ...and it must also be this many times richer than what the page already had.
 * The five corpus certificates clear both by an order of magnitude (1 letter ->
 * 1097, 68 -> 1505); a logo caption re-read would clear neither.
 */
export const OCR_LETTERS_MULTIPLE = 3;

function countLetters(text: string): number {
  const m = (text || '').match(/\p{L}/gu);
  return m ? m.length : 0;
}

/**
 * Merge one page's embedded text with what OCR read off the same page.
 *
 * THE RULE: OCR NEVER OVERWRITES. The page's own text layer is authoritative
 * wherever it exists, because it is the document's own characters rather than a
 * guess at their shapes — an OCR read of a clean page is strictly worse. So:
 *
 *   * page had no usable text  -> take the OCR read outright (nothing is lost)
 *   * OCR adds substantially   -> embedded text FIRST, then the OCR read
 *                                 appended. The caption ("alouette Halal
 *                                 Certificate") is often the most reliable
 *                                 sentence on such a page and is kept at the top
 *   * anything else            -> keep the embedded text alone
 *
 * No marker is written into the returned text. The model must not be told which
 * half of a page came from where — that is a fact about our pipeline, not about
 * the document — so provenance travels beside the text, never inside it.
 */
export function mergePageText(embedded: string | null | undefined, ocr: string | null | undefined): PageMergeResult {
  const emb = (embedded || '').trim();
  const oc = (ocr || '').trim();
  if (!oc) {
    return { text: emb, source: 'text-layer', reason: 'ocr_empty' };
  }
  if (!emb) {
    return { text: oc, source: 'ocr', reason: 'no_embedded_text' };
  }
  const embLetters = countLetters(emb);
  const ocrLetters = countLetters(oc);
  if (ocrLetters >= OCR_MIN_LETTERS_TO_APPEND && ocrLetters >= embLetters * OCR_LETTERS_MULTIPLE) {
    return { text: `${emb}\n${oc}`, source: 'text-layer+ocr', reason: 'ocr_adds_text' };
  }
  return { text: emb, source: 'text-layer', reason: 'ocr_added_nothing' };
}

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

/**
 * What is recorded per page and shown to a reviewer. One row per page of the
 * document, so "page 7 is a text page" is as provable as "page 6 was OCR'd".
 */
export interface PageTextProvenance {
  page: number;
  source: PageTextSource;
  /** Characters the model was ultimately given for this page. */
  chars: number;
  /** Characters the page's own text layer held. */
  text_layer_chars: number;
  /** Characters OCR read, or null when OCR was not run on this page. */
  ocr_chars: number | null;
  /** Largest single drawn image as a fraction of the page, rounded to 3dp. */
  image_coverage: number;
  /** The routing reason, then the merge reason once OCR ran. */
  reason: string;
}

/** Contiguous page numbers as "6, 13-16" — how a person says which pages. */
export function formatPageRanges(pages: number[]): string {
  const sorted = [...new Set(pages)].sort((a, b) => a - b);
  const out: string[] = [];
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    out.push(i === j ? `${sorted[i]}` : `${sorted[i]}–${sorted[j]}`);
    i = j + 1;
  }
  return out.join(', ');
}

/**
 * One sentence a reviewer can read without expanding anything. Returns null
 * when every page came from its own text layer, because "nothing unusual
 * happened" does not need a line on the card.
 */
export function summarizePageSources(rows: PageTextProvenance[] | null | undefined): string | null {
  const list = rows || [];
  if (!list.length) return null;
  const ocrPages = list.filter((r) => r.source === 'ocr' || r.source === 'text-layer+ocr').map((r) => r.page);
  const skipped = list.filter((r) => r.reason === 'ocr_budget_exhausted').map((r) => r.page);
  if (!ocrPages.length) {
    if (skipped.length) return `${skipped.length} unread image page(s) left unread (page ${formatPageRanges(skipped)}) — OCR budget reached`;
    return null;
  }
  const head = `${ocrPages.length} of ${list.length} page${list.length === 1 ? '' : 's'} read by OCR (page ${formatPageRanges(ocrPages)})`;
  return skipped.length ? `${head}; ${skipped.length} more left unread — OCR budget reached` : head;
}
