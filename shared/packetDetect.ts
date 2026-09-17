/**
 * shared/packetDetect.ts — is this ONE upload actually SEVERAL documents, and
 * if so, where does each one start?
 *
 * ---------------------------------------------------------------------------
 * THE DEFECT THIS EXISTS FOR
 * ---------------------------------------------------------------------------
 * dox treats one uploaded file as one document: one classification, one
 * `document_type_id`, one renewal date. A supplier's annual packet is not that
 * shape, and it is not a rarity — it is how a well-organised supplier answers a
 * customer questionnaire.
 *
 * Measured on `tests/fixtures/real-corpus/pdf/packet-fdlw-2026.pdf`, the
 * client's own 36-page packet holding 25 separately-dated documents:
 *
 *   as one upload   type "Letter of Guarantee" (page 3 answering for all 25),
 *                   document_expires_on 2027-01-02 -- a date printed NOWHERE
 *                   in the file, being page 3's "valid one year from the date
 *                   hereof" clause applied to a packet that holds an SQF
 *                   certificate lapsing 2026-04-23 and a kosher letter lapsing
 *                   2026-06-30
 *   split on its
 *   own index page  22 of 26 parts classify correctly and the five image
 *                   certificates yield their expiry dates
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS MODULE IS, AND WHAT IT IS NOT
 * ---------------------------------------------------------------------------
 * It PROPOSES. It never splits. A wrong split turns one wrong document into
 * twenty-five, each with its own type, its own renewal date and its own place
 * in a compliance file, so the split is a decision a person makes and this
 * module's whole job is to put a good proposal in front of them and be honest
 * about how sure it is.
 *
 * Honesty has a specific meaning here: when the signals disagree, the answer is
 * a LOW-confidence, COARSE proposal -- only the boundaries more than one signal
 * agrees on -- and never a precise-looking boundary list that was invented to
 * look decisive. A reviewer can merge two parts back together in a second; a
 * reviewer cannot see that a confident-looking boundary was a coin flip.
 *
 * PURE. Imports nothing, reads no PDF, renders no page. Its input is exactly
 * what the per-page OCR routing pass (shared/pdfPageOcr.ts) already computes
 * for every PDF queue item -- per-page text plus the page's largest drawn
 * image -- so detection costs no new work on the file. Bundled for plain Node
 * by `npm run build:worker-shared` into `bin/lib/shared/packetDetect.js`, which
 * `bin/process-worker` and `bin/packet-detect` consume.
 *
 * ---------------------------------------------------------------------------
 * THE SIGNALS, IN ORDER OF HOW MUCH THEY ARE TRUSTED
 * ---------------------------------------------------------------------------
 *   1. AN INDEX PAGE. The supplier's own table of contents, naming each item
 *      and its page range ("15. Allergen Control Statement | Page 17-18").
 *      This is not a guess about the document -- it is the document's own
 *      declaration of its structure, which is why it outranks everything else
 *      and why its ranges are used verbatim rather than being "corrected" by
 *      the layout signals. See `parseIndexEntries`.
 *   2. A REPEATED CLOSING BLOCK. The line a page ENDS with, when the same line
 *      ends many pages (a signature block, a contact e-mail, a sign-off). A
 *      page after one of those is the first page of something else.
 *   3. A TITLE-SHAPED OPENING LINE. The first real line of a page reading like
 *      a document title rather than like prose.
 *   4. A PICTURE PAGE. A page that is mostly one drawn image -- an inserted
 *      certificate -- is a document in its own right.
 *   5. A DATE LINE near the top, and a large text-density discontinuity. Both
 *      weak, both only ever used to corroborate.
 *
 * The index is parsed on its own; 2-5 are weighted and summed per candidate
 * boundary (see `SIGNAL_WEIGHT`). When an index exists the layout signals do
 * not move the ranges -- they move the CONFIDENCE, by agreeing or not.
 *
 * ---------------------------------------------------------------------------
 * WHERE THIS DELIBERATELY DOES NOTHING
 * ---------------------------------------------------------------------------
 *   * NOT A PDF. There is no page to carve.
 *   * FEWER THAN 4 PAGES. A two-page letter with a continuation page is the
 *     overwhelmingly common shape and asking about it would train reviewers to
 *     dismiss the question. The cost of missing a 3-page packet is one manual
 *     upload; the cost of asking on every 2-page spec sheet is the feature.
 *   * A MULTI-LOT COA. `produceCoaRecords` already turns one certificate
 *     covering several lots into several page-scoped documents, and it is
 *     better at it than this could be -- it knows the lots. Two engines
 *     proposing two different splits of the same file is worse than one.
 *     Guarded on `coaRecordCount`, which the caller passes.
 */

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** One page, as the text pass already has it. */
export interface PacketPageInput {
  /** 1-based page number, as a human counts pages. */
  page: number;
  /** The text the model would be given for this page. */
  text: string;
  /**
   * Area of the LARGEST single drawn image on the page as a fraction of the
   * page (0..1) — `PdfPageFacts.imageCoverage` from shared/pdfPageOcr.ts.
   * Optional: when the operator-list read failed there is no measurement, and
   * a missing measurement must weaken one signal rather than invent one.
   */
  imageCoverage?: number;
}

export interface PacketDetectInput {
  pages: PacketPageInput[];
  /** False for anything that is not a PDF. Detection declines outright. */
  isPdf: boolean;
  /**
   * How many records the COA path produced from this file. >= 2 means
   * `produceCoaRecords` owns this file's split; see the header.
   */
  coaRecordCount?: number;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

/** Which family of signal produced the ranges. Null when nothing was proposed. */
export type PacketMethod = 'index' | 'letterhead' | 'heuristic';

/** Why detection said no. Never null on a negative answer. */
export type PacketDecline =
  | 'not_pdf'
  | 'too_few_pages'
  | 'coa_records'
  | 'single_document';

export type PacketConfidenceBand = 'high' | 'medium' | 'low';

export interface PacketPart {
  /** Inclusive 1-based [from, to]. */
  pages: [number, number];
  /** The index's own words for this item, when there was an index. */
  label: string | null;
  /** Which signals put the boundary here, in words a reviewer can read. */
  evidence: string;
  /** The first line or two of the part's first page. */
  preview: string;
}

export interface PacketProposal {
  looksLikePacket: boolean;
  /** 0..1. Reported alongside the band because the band is what is shown. */
  confidence: number;
  confidence_band: PacketConfidenceBand;
  method: PacketMethod | null;
  parts: PacketPart[];
  /**
   * Pages no proposed part covers. NOT an error and NOT silently swallowed: a
   * near-blank back cover belongs to no document, and saying so is better than
   * bolting it onto the last one. The original file stays in R2 either way.
   */
  uncovered_pages: number[];
  page_count: number;
  declined: PacketDecline | null;
  /** Sentences for the reviewer: what was found, and what disagreed. */
  notes: string[];
}

// ---------------------------------------------------------------------------
// Thresholds — every one of them measured, none of them tuned by feel
// ---------------------------------------------------------------------------

/**
 * Below this many pages we never ask. See "WHERE THIS DELIBERATELY DOES
 * NOTHING": every one of the four real specification sheets in
 * tests/fixtures/real-corpus and all forty synthetic doctype fixtures are 1-2
 * pages, and so is nearly everything a supplier sends one at a time.
 */
export const MIN_PACKET_PAGES = 4;

/**
 * Fewer proposed parts than this is not a packet. Two parts is far more often
 * a letter with a continuation page than a file holding two documents, and the
 * packet shape this exists for holds twenty-five.
 */
export const MIN_PACKET_PARTS = 3;

/** How many leading pages are searched for a table of contents. */
export const INDEX_SCAN_PAGES = 3;

/** An index with fewer entries than this is a list of something else. */
export const MIN_INDEX_ENTRIES = 3;

/**
 * A normalized line appearing at the TOP of at least this share of pages is
 * page furniture — a confidentiality banner, a running header — not content.
 * The client's packet stamps "C2" on all 36 pages.
 *
 * ONLY THE TOP, and that is the whole point. A plain "appears on most pages"
 * rule also swallows the SIGN-OFF, which is the single most reliable boundary
 * signal there is: a supplier packet repeats one contact block at the foot of
 * every statement, and deleting it as furniture removes exactly the evidence
 * that the next page starts a new document.
 */
export const FURNITURE_PAGE_SHARE = 0.6;

/** How many leading lines of a page are candidates for running-header furniture. */
export const FURNITURE_HEAD_LINES = 2;

/** ...and on at least this many pages, so a 4-page file needs 3, not 2.4. */
export const FURNITURE_MIN_PAGES = 3;

/** A closing block must end at least this many pages to count as repeated. */
export const CLOSING_MIN_PAGES = 3;

/** Coverage at which a page is "mostly one picture". Mirrors PAGE_IMAGE_COVERAGE_MIN. */
export const PICTURE_COVERAGE_MIN = 0.25;

/** How much weight each layout signal carries toward a boundary. */
export const SIGNAL_WEIGHT = {
  /** The previous page ended with the block that ends many pages. */
  closing_block: 2,
  /** This page opens with a line shaped like a document title. */
  title_line: 2,
  /** This page is mostly one drawn image — an inserted certificate. */
  picture_page: 2,
  /** A date sits in the first lines, as a dated document's does. */
  date_line: 1,
  /** The page's text volume jumps. */
  density_jump: 1,
} as const;

/** A boundary needs this much weight. One strong signal, or two weak ones. */
export const BOUNDARY_SCORE_MIN = 2;

/** A COARSE boundary needs this much: more than one signal must agree. */
export const COARSE_BOUNDARY_SCORE_MIN = 3;

/**
 * Jaccard agreement between the index's starts and the layout signals' below
 * which the two are treated as telling different stories.
 */
export const AGREEMENT_LOW = 0.4;

/** ...and at or above which they are treated as corroborating each other. */
export const AGREEMENT_HIGH = 0.7;

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

/** Lines of a page, trimmed, with the empties dropped. */
function linesOf(text: string): string[] {
  return String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/**
 * A line reduced to what makes it the SAME line on another page: case folded,
 * every run of digits collapsed to `#` (page numbers, dates that increment)
 * and whitespace normalized.
 */
function normalizeLine(line: string): string {
  return String(line || '')
    .toLowerCase()
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim();
}

function countLetters(text: string): number {
  const m = String(text || '').match(/\p{L}/gu);
  return m ? m.length : 0;
}

/** Lines too short to be either content or a recognisable repeat. */
function isTrivialLine(line: string): boolean {
  return line.length < 3 || /^[\s\-_.|\\/]+$/.test(line);
}

const DATE_PATTERNS: RegExp[] = [
  /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4}\b/i,
  /\b\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{4}\b/i,
  /\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/,
  /\b\d{4}-\d{2}-\d{2}\b/,
];

function hasDate(line: string): boolean {
  return DATE_PATTERNS.some((re) => re.test(line));
}

/**
 * Words that make a short, capitalised line a DOCUMENT TITLE rather than a
 * product name or a heading inside a document. Deliberately a closed list: an
 * open one ("any capitalised short line") fires on every table header in an
 * eight-page HACCP plan, which is the false positive that matters most here
 * because that plan is ONE document and is the longest part of the packet.
 */
const TITLE_WORDS = [
  'statement', 'certificate', 'certification', 'certified', 'letter', 'guarantee',
  'guaranty', 'policy', 'program', 'plan', 'declaration', 'affidavit', 'attestation',
  'specification', 'spec sheet', 'information', 'report', 'analysis', 'agreement',
  'questionnaire', 'overview', 'disclosure', 'notice', 'license', 'registration',
  'insurance', 'audit', 'assessment', 'profile', 'form',
];

/**
 * Does this line read like the title of a document?
 *
 * Two shapes qualify, and BOTH need a title word — see TITLE_WORDS:
 *   * SHOUTED: mostly capital letters ("FDA BIOTERRORISM STATEMENT").
 *   * Title Case: most words start capitalised ("alouette Halal Certificate").
 *
 * A trailing full stop disqualifies: a sentence is not a title.
 */
export function looksLikeTitleLine(line: string): boolean {
  const l = String(line || '').trim();
  if (l.length < 4 || l.length > 90) return false;
  if (/[.!?;,]$/.test(l)) return false;
  if (/@/.test(l)) return false; // an e-mail address is a sign-off, not a title
  const words = l.split(/\s+/).filter(Boolean);
  if (words.length < 1 || words.length > 14) return false;

  const lower = l.toLowerCase();
  if (!TITLE_WORDS.some((w) => lower.includes(w))) return false;

  const letters = countLetters(l);
  if (letters < 4) return false;
  const upper = (l.match(/\p{Lu}/gu) || []).length;
  if (upper / letters >= 0.6) return true;

  const capitalised = words.filter((w) => /^[\p{Lu}(]/u.test(w)).length;
  return capitalised / words.length >= 0.5;
}

// ---------------------------------------------------------------------------
// Signal 1: the file's own index page
// ---------------------------------------------------------------------------

export interface IndexEntry {
  /** The entry's own number, as printed. */
  n: number;
  label: string;
  from: number;
  /** Explicit end when the entry printed a range, else null. */
  to: number | null;
}

/**
 * Three shapes of table-of-contents line, all anchored to a leading item
 * number so that a body-text line ending in a number cannot match:
 *
 *   `1. Letter of Guarantee | Page 3`           pipe + the word Page
 *   `25. HACCP Master Plan | Pages 28-35`       ...with a range
 *   `7. Allergen Statement .......... 17`       classic dot leaders
 *
 * The item number is required, and so is a separator: without one,
 * "3. Section 4 discusses 12 CFR" parses as an entry.
 */
const INDEX_LINE_PATTERNS: RegExp[] = [
  // number. label <sep> Page N[-M]  — the word "page" present
  /^(\d{1,3})\s*[.)\]]\s*(.{3,150}?)\s*(?:\||[.…·]{2,}|[-–—:]|\t)\s*pages?\s*(\d{1,4})(?:\s*(?:[-–—]|to|through)\s*(\d{1,4}))?\s*$/i,
  // number. label | N[-M]  — a pipe, no word
  /^(\d{1,3})\s*[.)\]]\s*(.{3,150}?)\s*\|\s*(\d{1,4})(?:\s*[-–—]\s*(\d{1,4}))?\s*$/,
  // number. label ....... N[-M]  — dot leaders, no word
  /^(\d{1,3})\s*[.)\]]\s*(.{3,150}?)\s*[.…·]{2,}\s*(\d{1,4})(?:\s*[-–—]\s*(\d{1,4}))?\s*$/,
];

/** Every index entry a page's lines yield, in the order printed. */
export function parseIndexEntries(lines: string[]): IndexEntry[] {
  const out: IndexEntry[] = [];
  for (const raw of lines) {
    for (const re of INDEX_LINE_PATTERNS) {
      const m = re.exec(raw);
      if (!m) continue;
      const n = parseInt(m[1], 10);
      const label = m[2].replace(/\s*[.…·|\-–—]+\s*$/, '').trim();
      const from = parseInt(m[3], 10);
      const to = m[4] ? parseInt(m[4], 10) : null;
      if (!Number.isFinite(n) || !Number.isFinite(from) || from < 1) break;
      if (to !== null && (!Number.isFinite(to) || to < from)) break;
      out.push({ n, label, from, to });
      break;
    }
  }
  return out;
}

/**
 * The best index found in the leading pages, or null.
 *
 * Accepted only when the entries are numbered roughly consecutively AND their
 * page numbers never go backwards. A list of ingredients with weights, a table
 * of test results, a numbered policy section list — all of them can match a
 * line or two; none of them counts up in both columns at once.
 */
function findIndex(pages: PacketPageInput[], pageCount: number): { page: number; entries: IndexEntry[] } | null {
  let best: { page: number; entries: IndexEntry[] } | null = null;
  for (const p of pages.slice(0, INDEX_SCAN_PAGES)) {
    const entries = parseIndexEntries(linesOf(p.text));
    if (entries.length < MIN_INDEX_ENTRIES) continue;
    // Numbering counts up, page numbers never go backwards.
    let ok = true;
    for (let i = 1; i < entries.length; i++) {
      if (entries[i].n <= entries[i - 1].n) ok = false;
      if (entries[i].from < entries[i - 1].from) ok = false;
    }
    // Every declared page has to exist. An index whose last entry points past
    // the end of the file is an index of something else (a bound manual, a
    // printed catalogue) and is NOT quietly clamped into range.
    const last = entries[entries.length - 1];
    if ((last.to ?? last.from) > pageCount) ok = false;
    if (entries[0].from > pageCount) ok = false;
    if (!ok) continue;
    if (!best || entries.length > best.entries.length) best = { page: p.page, entries };
  }
  return best;
}

// ---------------------------------------------------------------------------
// Signals 2-5: what the pages themselves look like
// ---------------------------------------------------------------------------

interface PageShape {
  page: number;
  /** Content lines, page furniture removed. */
  content: string[];
  chars: number;
  imageCoverage: number;
}

/**
 * Per-page content lines with the running furniture stripped, plus the set of
 * normalized lines that repeatedly END a page.
 */
function shapePages(pages: PacketPageInput[]): { shapes: PageShape[]; closings: Set<string> } {
  const pageCount = pages.length;
  const seen = new Map<string, number>();
  const perPageLines = pages.map((p) => linesOf(p.text));
  for (const lines of perPageLines) {
    // Only the HEAD of each page can be running furniture. See
    // FURNITURE_PAGE_SHARE for why a whole-page rule is wrong.
    for (const key of new Set(lines.slice(0, FURNITURE_HEAD_LINES).map(normalizeLine))) {
      seen.set(key, (seen.get(key) || 0) + 1);
    }
  }
  const furnitureAt = Math.max(FURNITURE_MIN_PAGES, Math.ceil(pageCount * FURNITURE_PAGE_SHARE));
  const furniture = new Set<string>();
  for (const [key, n] of seen) if (n >= furnitureAt) furniture.add(key);

  const shapes: PageShape[] = pages.map((p, i) => {
    const content = perPageLines[i].filter(
      (l) => !isTrivialLine(l) && !furniture.has(normalizeLine(l)) && !/^\d{1,4}$/.test(l),
    );
    return {
      page: p.page,
      content,
      chars: String(p.text || '').trim().length,
      imageCoverage: Number.isFinite(p.imageCoverage as number) ? (p.imageCoverage as number) : 0,
    };
  });

  // A closing block is what a page ENDS with, counted over pages. Furniture is
  // already gone, so this is the sign-off itself, not the page number under it.
  const endings = new Map<string, number>();
  for (const s of shapes) {
    const lastTwo = s.content.slice(-2);
    for (const key of new Set(lastTwo.map(normalizeLine))) {
      endings.set(key, (endings.get(key) || 0) + 1);
    }
  }
  const closings = new Set<string>();
  for (const [key, n] of endings) if (n >= CLOSING_MIN_PAGES) closings.add(key);

  return { shapes, closings };
}

interface BoundaryScore {
  page: number;
  score: number;
  signals: string[];
}

/** Score every page 2..N as "this page starts a new document". */
function scoreBoundaries(shapes: PageShape[], closings: Set<string>): BoundaryScore[] {
  const maxChars = Math.max(1, ...shapes.map((s) => s.chars));
  const out: BoundaryScore[] = [];
  for (let i = 1; i < shapes.length; i++) {
    const s = shapes[i];
    const prev = shapes[i - 1];
    const signals: string[] = [];
    let score = 0;

    const prevEnd = prev.content.slice(-2).map(normalizeLine);
    if (prevEnd.some((k) => closings.has(k))) {
      score += SIGNAL_WEIGHT.closing_block;
      signals.push('the page before it ends with the block that closes every document in this file');
    }
    if (s.content.length > 0 && looksLikeTitleLine(s.content[0])) {
      score += SIGNAL_WEIGHT.title_line;
      signals.push(`it opens with a title line ("${s.content[0].slice(0, 60)}")`);
    }
    if (s.imageCoverage >= PICTURE_COVERAGE_MIN) {
      score += SIGNAL_WEIGHT.picture_page;
      signals.push('the page is mostly one inserted image');
    }
    if (s.content.slice(0, 3).some(hasDate)) {
      score += SIGNAL_WEIGHT.date_line;
      signals.push('a date sits at the top of the page');
    }
    if (Math.abs(s.chars - prev.chars) > 0.6 * maxChars) {
      score += SIGNAL_WEIGHT.density_jump;
      signals.push('the amount of text jumps');
    }

    if (score > 0) out.push({ page: s.page, score, signals });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

function previewOf(shape: PageShape | undefined): string {
  if (!shape) return '';
  return shape.content.slice(0, 2).join(' — ').slice(0, 160);
}

function jaccard(a: Set<number>, b: Set<number>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let hit = 0;
  for (const v of a) if (b.has(v)) hit++;
  const union = a.size + b.size - hit;
  return union === 0 ? 1 : hit / union;
}

function band(confidence: number): PacketConfidenceBand {
  if (confidence >= 0.75) return 'high';
  if (confidence >= 0.5) return 'medium';
  return 'low';
}

function declineWith(
  declined: PacketDecline,
  pageCount: number,
  note: string,
): PacketProposal {
  return {
    looksLikePacket: false,
    confidence: 0,
    confidence_band: 'low',
    method: null,
    parts: [],
    uncovered_pages: [],
    page_count: pageCount,
    declined,
    notes: [note],
  };
}

/**
 * THE decision. Never throws, never splits, never renders.
 *
 * A false answer always carries a `declined` reason, because "we did not look"
 * and "we looked and it is one document" are different facts and a reviewer
 * who is told neither will assume the first.
 */
export function detectPacket(input: PacketDetectInput): PacketProposal {
  const pages = (input.pages || []).filter((p) => p && Number.isFinite(p.page));
  const pageCount = pages.length;

  if (!input.isPdf) {
    return declineWith('not_pdf', pageCount, 'Only a PDF can be split into page ranges.');
  }
  if (pageCount < MIN_PACKET_PAGES) {
    return declineWith(
      'too_few_pages',
      pageCount,
      `${pageCount} page${pageCount === 1 ? '' : 's'} — under ${MIN_PACKET_PAGES}, which is a letter with a continuation page far more often than it is a packet.`,
    );
  }
  if ((input.coaRecordCount ?? 0) >= 2) {
    return declineWith(
      'coa_records',
      pageCount,
      'This certificate already splits per lot, which is a better split than a page-range one because it knows the lots.',
    );
  }

  const { shapes, closings } = shapePages(pages);
  const byPage = new Map(shapes.map((s) => [s.page, s]));
  const scored = scoreBoundaries(shapes, closings);
  const layoutBoundaries = new Set(scored.filter((b) => b.score >= BOUNDARY_SCORE_MIN).map((b) => b.page));
  const coarseBoundaries = new Set(scored.filter((b) => b.score >= COARSE_BOUNDARY_SCORE_MIN).map((b) => b.page));
  const signalsAt = new Map(scored.map((b) => [b.page, b.signals]));

  const notes: string[] = [];
  const index = findIndex(pages, pageCount);

  // --- the index path ------------------------------------------------------
  if (index) {
    const entries = index.entries;
    const starts = new Set(entries.map((e) => e.from));
    const agreement = jaccard(starts, layoutBoundaries);

    let confidence = 0.75;
    if (entries.length >= MIN_INDEX_ENTRIES * 2) confidence += 0.05;
    if (agreement >= AGREEMENT_HIGH) confidence += 0.15;
    else if (agreement < AGREEMENT_LOW) confidence -= 0.35;
    // NOTE: the index's ranges are NOT coarsened when the layout disagrees.
    // They are the supplier's own declaration of the file's structure, not a
    // guess of ours; disagreement moves the CONFIDENCE and puts a sentence in
    // front of the reviewer, and the ranges still say what the file says.
    confidence = Math.max(0.2, Math.min(0.95, confidence));

    notes.push(
      `Page ${index.page} lists ${entries.length} document${entries.length === 1 ? '' : 's'} with page numbers — the file says what is in it.`,
    );
    if (agreement < AGREEMENT_LOW) {
      notes.push(
        'The page layout does not start new documents where the index says it does. The index is still used, because it is the supplier\'s own declaration — but check the ranges before confirming.',
      );
    } else if (agreement >= AGREEMENT_HIGH) {
      notes.push('The pages themselves start new documents where the index says they do.');
    }

    const parts: PacketPart[] = [];
    const firstStart = Math.max(1, Math.min(...entries.map((e) => e.from)));
    if (firstStart > 1) {
      parts.push({
        pages: [1, firstStart - 1],
        label: null,
        evidence: 'before the first item in the index — a cover letter and the index itself',
        preview: previewOf(byPage.get(1)),
      });
    }
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      const next = entries[i + 1];
      // An explicit end wins; otherwise the item runs to the page before the
      // next one starts. The LAST item without an explicit end runs to the end
      // of the file, which is the only place this guesses.
      let to = e.to ?? (next ? next.from - 1 : pageCount);
      if (next && to >= next.from) to = next.from - 1;
      if (to < e.from) to = e.from;
      if (to > pageCount) to = pageCount;
      const extra = signalsAt.get(e.from);
      parts.push({
        pages: [e.from, to],
        // The label is the INDEX's words, and they can be wrong: this packet's
        // index calls page 6 a "Global Standard for Food Safety Certificate"
        // and the page is an SQF certificate from NSF. It is a hint for the
        // reviewer, never an input to classification.
        label: e.label || null,
        evidence: `index entry ${e.n}${extra && extra.length ? `; ${extra[0]}` : ''}`,
        preview: previewOf(byPage.get(e.from)),
      });
    }

    return finish(parts, pageCount, confidence, 'index', notes);
  }

  // --- the layout-only path ------------------------------------------------
  const closingCount = scored.filter(
    (b) => b.score >= BOUNDARY_SCORE_MIN && b.signals.some((s) => s.startsWith('the page before it ends')),
  ).length;
  const titleBoundaries = new Set(
    scored.filter((b) => b.signals.some((s) => s.startsWith('it opens with a title line'))).map((b) => b.page),
  );
  const closingBoundaries = new Set(
    scored.filter((b) => b.signals.some((s) => s.startsWith('the page before it ends'))).map((b) => b.page),
  );

  // TWO SIGNALS CAN ONLY DISAGREE IF THERE ARE TWO. When a file carries no
  // repeated closing block at all — a run of inserted certificate images, say —
  // there is one signal, not a conflict, and treating an empty set as
  // "disagreement" would discard the only evidence the file offers. A
  // single-signal read is honestly reported as low confidence instead.
  const bothPresent = titleBoundaries.size > 0 && closingBoundaries.size > 0;
  const agreement = bothPresent ? jaccard(titleBoundaries, closingBoundaries) : null;

  // COARSE WHEN THE SIGNALS DISAGREE. This is the whole honesty rule: rather
  // than publishing a precise-looking boundary list that one weak signal
  // produced on its own, fall back to the boundaries more than one signal
  // agrees on and say the confidence is low.
  const disagree = agreement !== null && agreement < AGREEMENT_LOW;
  const chosen = disagree ? coarseBoundaries : layoutBoundaries;
  const method: PacketMethod = closingCount >= CLOSING_MIN_PAGES && !disagree ? 'letterhead' : 'heuristic';
  let confidence = method === 'letterhead' ? 0.55 : 0.35;
  if (!disagree && agreement !== null && agreement >= AGREEMENT_HIGH) confidence += 0.1;
  if (disagree) confidence = 0.3;

  notes.push(
    disagree
      ? 'No index page, and the layout signals disagree — only the boundaries more than one signal agrees on are proposed, and they are coarse.'
      : `No index page. Boundaries come from the page layout: ${method === 'letterhead' ? 'a repeated closing block and title lines' : 'title lines and page shape'}.`,
  );

  const cut = [...chosen].sort((a, b) => a - b);
  const parts: PacketPart[] = [];
  let from = 1;
  for (const b of cut) {
    parts.push({
      pages: [from, b - 1],
      label: null,
      evidence: (signalsAt.get(b) || []).join('; ') || 'page layout',
      preview: previewOf(byPage.get(from)),
    });
    from = b;
  }
  parts.push({
    pages: [from, pageCount],
    label: null,
    evidence: 'runs to the end of the file',
    preview: previewOf(byPage.get(from)),
  });

  return finish(parts, pageCount, confidence, method, notes);
}

/** Validate, drop empties, compute what is not covered, and decide. */
function finish(
  parts: PacketPart[],
  pageCount: number,
  confidence: number,
  method: PacketMethod,
  notes: string[],
): PacketProposal {
  const clean = parts
    .map((p) => ({ ...p, pages: [Math.max(1, p.pages[0]), Math.min(pageCount, p.pages[1])] as [number, number] }))
    .filter((p) => p.pages[0] <= p.pages[1]);

  if (clean.length < MIN_PACKET_PARTS) {
    return declineWith(
      'single_document',
      pageCount,
      clean.length <= 1
        ? 'Nothing in this file starts a second document — it reads as one.'
        : `Only ${clean.length} part${clean.length === 1 ? '' : 's'} proposed, under the ${MIN_PACKET_PARTS} it takes to call a file a packet.`,
    );
  }

  const covered = new Set<number>();
  for (const p of clean) for (let i = p.pages[0]; i <= p.pages[1]; i++) covered.add(i);
  const uncovered: number[] = [];
  for (let i = 1; i <= pageCount; i++) if (!covered.has(i)) uncovered.push(i);
  if (uncovered.length) {
    notes.push(
      `Page${uncovered.length === 1 ? '' : 's'} ${formatPages(uncovered)} ${uncovered.length === 1 ? 'is' : 'are'} in no part. The original file keeps them.`,
    );
  }

  return {
    looksLikePacket: true,
    confidence,
    confidence_band: band(confidence),
    method,
    parts: clean,
    uncovered_pages: uncovered,
    page_count: pageCount,
    declined: null,
    notes,
  };
}

/** "6, 13-16" — how a person says which pages. */
export function formatPages(pages: number[]): string {
  const sorted = [...new Set(pages)].sort((a, b) => a - b);
  const out: string[] = [];
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    out.push(i === j ? `${sorted[i]}` : `${sorted[i]}-${sorted[j]}`);
    i = j + 1;
  }
  return out.join(', ');
}

// ---------------------------------------------------------------------------
// Validating what a REVIEWER hands back
// ---------------------------------------------------------------------------

export interface PacketRangeInput {
  pages: [number, number];
  label?: string | null;
}

export type PacketRangeError =
  | { kind: 'no_parts' }
  | { kind: 'bad_range'; index: number }
  | { kind: 'out_of_range'; index: number; pageCount: number }
  | { kind: 'overlap'; index: number }
  | { kind: 'too_many'; count: number; max: number };

/**
 * Upper bound on parts one split may produce. A carve writes one queue row,
 * one R2 object and one extraction per part; a 500-page file split per page
 * would be an afternoon of GPU time nobody asked for. The client's packet
 * produces 26.
 */
export const MAX_PARTS_PER_SPLIT = 100;

/**
 * Check the ranges a reviewer confirmed or edited. Ordered, non-overlapping,
 * inside the file. Gaps ARE allowed — a reviewer dropping a blank separator
 * page is the "Adjust" flow working, not an error.
 */
export function validateRanges(
  ranges: PacketRangeInput[],
  pageCount: number,
): PacketRangeError | null {
  if (!Array.isArray(ranges) || ranges.length === 0) return { kind: 'no_parts' };
  if (ranges.length > MAX_PARTS_PER_SPLIT) {
    return { kind: 'too_many', count: ranges.length, max: MAX_PARTS_PER_SPLIT };
  }
  let prevEnd = 0;
  for (let i = 0; i < ranges.length; i++) {
    const r = ranges[i];
    const from = Array.isArray(r?.pages) ? r.pages[0] : NaN;
    const to = Array.isArray(r?.pages) ? r.pages[1] : NaN;
    if (!Number.isInteger(from) || !Number.isInteger(to) || to < from) return { kind: 'bad_range', index: i };
    if (from < 1 || to > pageCount) return { kind: 'out_of_range', index: i, pageCount };
    if (from <= prevEnd) return { kind: 'overlap', index: i };
    prevEnd = to;
  }
  return null;
}

/** Every 1-based page in a range, as `extractRecordPdf` wants them. */
export function pagesOfRange(range: PacketRangeInput): number[] {
  const out: number[] = [];
  for (let p = range.pages[0]; p <= range.pages[1]; p++) out.push(p);
  return out;
}
