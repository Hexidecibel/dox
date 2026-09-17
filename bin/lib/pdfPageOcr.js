// bin/lib/pdfPageOcr.js — the Node half of per-page OCR routing.
//
// WHY THIS IS ITS OWN MODULE. The PDF text sequence exists in three places:
// `bin/process-worker`'s COA branch, the same file's `extractTextAndPages`
// (order/shipment), and `bin/lib/corpusText.js` (the measurement harness). Any
// new step written three times drifts three ways — which is exactly how
// `bin/process-worker`'s BASE_PROMPT and `functions/lib/llm.ts`'s came apart.
// So the whole per-page pass is ONE function, `applyPerPageOcr`, and all three
// call sites are one line each.
//
// The RULES it applies (which pages, and how a page's two reads are merged) are
// not here — they are pure and live in `shared/pdfPageOcr.ts`, bundled to
// `./shared/pdfPageOcr.js` by `npm run build:worker-shared` and unit-tested
// directly. This file only does the things a pure module cannot: read the PDF's
// operator list, and shell out to poppler and tesseract.
//
// COST. Only the qualifying pages are rasterised — `pdftoppm -f N -l N` renders
// one page — so a 36-page packet with five picture pages pays for five pages of
// OCR, not thirty-six. The operator-list pass that decides this is ~1 ms/page.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const {
  selectPagesForOcr,
  mergePageText,
  MAX_OCR_PAGES_PER_DOCUMENT,
} = require('./shared/pdfPageOcr');

/** Multiply two pdf.js 6-element affine matrices (a b c d e f). */
function mul(a, b) {
  return [
    a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}

/**
 * Per-page `{ page, imageCoverage, imageCount }` for a PDF.
 *
 * pdf.js paints every image into the unit square and lets the current
 * transformation matrix place it, so the drawn size of an image is read off the
 * CTM at the moment the paint operator is issued: width = |(a, b)|,
 * height = |(c, d)|. We walk the operator list maintaining the CTM through
 * save/restore/transform and through form XObjects (which carry their own
 * matrix), and keep the LARGEST single drawn image — a pasted certificate is
 * one image, and summing would double-count overlapping logos.
 *
 * Returns [] on any failure. A missing measurement must mean "no per-page pass",
 * never a wrong one: the caller's existing routing is then untouched.
 */
async function collectPageImageFacts(arrayBuffer) {
  try {
    const { getDocumentProxy, getResolvedPDFJS } = await import('unpdf');
    const { OPS } = await getResolvedPDFJS();
    const imageOps = new Set([
      OPS.paintImageXObject,
      OPS.paintInlineImageXObject,
      OPS.paintJpegXObject,
      OPS.paintImageMaskXObject,
      OPS.paintImageXObjectRepeat,
    ].filter((v) => typeof v === 'number'));

    const doc = await getDocumentProxy(new Uint8Array(arrayBuffer));
    const out = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const view = page.view || [0, 0, 612, 792];
      const pageArea = Math.abs(view[2] - view[0]) * Math.abs(view[3] - view[1]) || 1;
      const ol = await page.getOperatorList();
      let ctm = [1, 0, 0, 1, 0, 0];
      const stack = [];
      let maxImage = 0;
      let imageCount = 0;
      for (let i = 0; i < ol.fnArray.length; i++) {
        const fn = ol.fnArray[i];
        if (fn === OPS.save) {
          stack.push(ctm.slice());
        } else if (fn === OPS.restore) {
          ctm = stack.pop() || [1, 0, 0, 1, 0, 0];
        } else if (fn === OPS.transform) {
          ctm = mul(ctm, ol.argsArray[i]);
        } else if (fn === OPS.paintFormXObjectBegin) {
          stack.push(ctm.slice());
          const m = (ol.argsArray[i] || [])[0];
          if (Array.isArray(m) && m.length === 6) ctm = mul(ctm, m);
        } else if (fn === OPS.paintFormXObjectEnd) {
          ctm = stack.pop() || [1, 0, 0, 1, 0, 0];
        } else if (imageOps.has(fn)) {
          const w = Math.hypot(ctm[0], ctm[1]);
          const h = Math.hypot(ctm[2], ctm[3]);
          maxImage = Math.max(maxImage, w * h);
          imageCount++;
        }
      }
      out.push({ page: p, imageCoverage: Math.min(1, maxImage / pageArea), imageCount });
    }
    return out;
  } catch {
    return [];
  }
}

function ocrAvailable() {
  try {
    execFileSync('which', ['pdftoppm'], { stdio: 'pipe' });
    execFileSync('which', ['tesseract'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * OCR exactly the named 1-based pages. `--psm 1` is tesseract's auto page
 * segmentation WITH orientation detection, so a sideways inserted scan is read
 * the right way up without a separate OSD+rotate round trip.
 *
 * Returns a Map<pageNumber, string>. A page tesseract could not read is simply
 * absent, and the caller keeps that page's text layer.
 */
function ocrPageTexts(pdfBuffer, pageNumbers, log) {
  const result = new Map();
  if (!pageNumbers.length || !ocrAvailable()) {
    if (pageNumbers.length && log) log('  per-page OCR unavailable: pdftoppm or tesseract not installed');
    return result;
  }
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dox-pageocr-'));
  try {
    const pdfPath = path.join(tmpDir, 'input.pdf');
    fs.writeFileSync(pdfPath, Buffer.from(pdfBuffer));
    for (const p of pageNumbers) {
      try {
        const prefix = path.join(tmpDir, `p${p}`);
        execFileSync('pdftoppm', ['-gray', '-r', '300', '-f', String(p), '-l', String(p), pdfPath, prefix], {
          timeout: 60_000, stdio: 'pipe',
        });
        const img = fs.readdirSync(tmpDir)
          .filter((f) => f.startsWith(`p${p}-`) && (f.endsWith('.pgm') || f.endsWith('.ppm')))
          .sort()[0];
        if (!img) continue;
        const text = execFileSync('tesseract', [path.join(tmpDir, img), 'stdout', '--psm', '1'], {
          timeout: 120_000, stdio: ['pipe', 'pipe', 'pipe'],
        }).toString('utf-8').trim();
        if (text) result.set(p, text);
      } catch (err) {
        if (log) log(`  per-page OCR failed on page ${p}: ${err.message}`);
      }
    }
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  return result;
}

/**
 * THE per-page pass, as the callers use it.
 *
 * `pages` must be the per-page text array the document currently holds, one
 * entry per PDF page. When it is not — the document already went to OCR whole,
 * so its "pages" are one blob — this returns `applied: false` and changes
 * nothing, which is also what happens when the operator-list read fails, when
 * no page qualifies, or when poppler/tesseract are absent. A no-op here is
 * always the pre-existing behaviour.
 *
 * Returns `{ applied, pages, text, provenance, ocrPages, ms, facts }`;
 * `provenance` is one row per page (`PageTextProvenance`) and is what a
 * reviewer is eventually shown, so a text page is as provable as an OCR'd one.
 * `facts` is the per-page `{ page, chars, imageCoverage, imageCount }` this
 * pass routes on, handed back so packet detection can reuse the measurement
 * rather than read the operator list a second time; null only when the read
 * failed or there was no per-page text array to read against.
 *
 * NOTE on `text`: it is the pages joined with newlines and NOT re-collapsed,
 * matching what the geometry pass produces rather than the legacy
 * `replace(/\s+/g, ' ')` shape. That only ever reaches a document where a page
 * was actually OCR'd — i.e. a document whose text was wrong before — so no
 * document that was reading correctly changes shape.
 */
async function applyPerPageOcr({ pdfBuffer, factsBuffer, pages, log }) {
  const started = Date.now();
  const noop = { applied: false, pages, text: null, provenance: null, ocrPages: [], ms: 0, facts: null };
  if (!Array.isArray(pages) || pages.length === 0) return noop;

  const facts = await collectPageImageFacts(factsBuffer);
  // One entry per page, or we are not looking at a per-page text array.
  if (facts.length !== pages.length) return noop;

  const withText = facts.map((f) => ({ ...f, chars: String(pages[f.page - 1] || '').trim().length }));
  // The facts ride out on EVERY return from here on, applied or not. They cost
  // an operator-list read the caller has already paid for, and packet
  // detection (shared/packetDetect.ts) wants the same per-page image coverage
  // this pass routes on — recomputing it there would be the second read of the
  // same thing, which is how two answers to one question get made.
  const decisions = selectPagesForOcr(withText, MAX_OCR_PAGES_PER_DOCUMENT);
  const wanted = decisions.filter((d) => d.ocr).map((d) => d.page);
  if (!wanted.length) return { ...noop, facts: withText };

  if (log) log(`  per-page OCR: ${wanted.length} of ${pages.length} page(s) look like an unread image (page ${wanted.join(', ')})`);
  const ocrTexts = ocrPageTexts(pdfBuffer, wanted, log);

  const nextPages = pages.slice();
  const provenance = [];
  const ocrPages = [];
  for (let i = 0; i < decisions.length; i++) {
    const d = decisions[i];
    const f = withText[i];
    const embedded = String(pages[i] || '');
    if (!d.ocr) {
      provenance.push({
        page: d.page,
        source: 'text-layer',
        chars: embedded.trim().length,
        text_layer_chars: f.chars,
        ocr_chars: null,
        image_coverage: Math.round(f.imageCoverage * 1000) / 1000,
        reason: d.reason,
      });
      continue;
    }
    const ocr = ocrTexts.get(d.page) || '';
    const merged = mergePageText(embedded, ocr);
    nextPages[i] = merged.text;
    if (merged.source !== 'text-layer') ocrPages.push(d.page);
    provenance.push({
      page: d.page,
      source: merged.source,
      chars: merged.text.trim().length,
      text_layer_chars: f.chars,
      ocr_chars: ocr.trim().length,
      image_coverage: Math.round(f.imageCoverage * 1000) / 1000,
      reason: merged.reason,
    });
  }

  const ms = Date.now() - started;
  if (log) {
    log(`  per-page OCR: read ${ocrPages.length} page(s) (page ${ocrPages.join(', ') || '—'}) in ${(ms / 1000).toFixed(1)}s`);
  }
  return {
    applied: ocrPages.length > 0,
    pages: nextPages,
    text: nextPages.join('\n').substring(0, 100000),
    provenance,
    ocrPages,
    ms,
    facts: withText,
  };
}

module.exports = { applyPerPageOcr, collectPageImageFacts, ocrPageTexts };
