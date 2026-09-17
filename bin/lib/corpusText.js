// bin/lib/corpusText.js — the production text path, as a harness can run it.
//
// WHY THIS IS ITS OWN MODULE. bin/measure-doctype-extraction reproduced
// bin/process-worker's PDF text sequence inline, and bin/eval-aj-docs needs the
// SAME sequence over a different corpus. A second copy is how process-worker's
// BASE_PROMPT and llm.ts's drifted apart in the first place; two harnesses
// measuring two different text paths would be worse, because the difference
// would show up as an accuracy delta and be blamed on the model.
//
// The sequence, in the worker's order (bin/process-worker#extractTextAndPages):
//
//   unpdf.extractText (collapsed, content-stream order)
//     -> isTextGarbled guard
//     -> tesseract OCR fallback when the text layer is empty or garbled
//     -> geometry-aware re-serialization LAST, so the OCR routing decision is
//        still made on the OLD text, byte for byte
//
// The geometry pass is a no-op when shouldUseSerializedPages declines — see
// shared/pdfTextSerializer.ts for why declining is always the status quo.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const {
  serializePages: serializePdfPages,
  shouldUseSerializedPages,
  looksLikeBrokenEncoding,
  countLetters,
} = require('./shared/pdfTextSerializer');

/** bin/process-worker#isTextGarbled, verbatim. */
function isTextGarbled(text) {
  if (!text || text.length < 100) return false;
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0) return false;
  const avgWordLen = words.reduce((s, w) => s + w.length, 0) / words.length;
  const whitespaceRatio = (text.match(/\s/g) || []).length / text.length;
  return avgWordLen > 15 || whitespaceRatio < 0.08;
}

/** bin/process-worker#ocrPdf, minus the temp-dir bookkeeping. */
function ocrPdf(pdfPath) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dox-corpus-ocr-'));
  try {
    execFileSync('pdftoppm', ['-gray', '-r', '300', pdfPath, path.join(tmpDir, 'page')], { timeout: 120_000, stdio: 'pipe' });
    const pages = fs.readdirSync(tmpDir).filter((f) => /^page.*\.(pgm|ppm)$/.test(f)).sort();
    const texts = [];
    for (const p of pages) {
      const res = execFileSync('tesseract', [path.join(tmpDir, p), 'stdout', '--psm', '1'], { timeout: 180_000, stdio: ['pipe', 'pipe', 'pipe'] });
      texts.push(res.toString('utf-8'));
    }
    const combined = texts.join('\n\n').trim();
    return combined.length > 0 ? combined : null;
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

/**
 * `{ text, pages, route }` for one PDF on disk. `route` is one of `text-layer`,
 * `geometry` or `ocr` and is reported beside every score, because a clean
 * document and a scanned one are not the same measurement.
 *
 * `opts.forceOcr` SKIPS the text layer entirely and goes straight to tesseract.
 * That is NOT what production does and must never be the default — it exists
 * for one measurement: a page that is an inserted certificate IMAGE sitting
 * under a few characters of real text (a watermark, a caption, a page number)
 * is not empty, so the empty-text OCR fallback never fires and the certificate
 * is never read. `--force-ocr` is how you see what is on such a page, and the
 * gap between the two routes is the size of the problem.
 */
async function extractPdfText(pdfPath, opts = {}) {
  const buf = fs.readFileSync(pdfPath);
  const geomBuffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  let text = null;
  let pages = [];
  let route = 'text-layer';

  if (opts.forceOcr) {
    const ocr = ocrPdf(pdfPath);
    return { text: (ocr || '').substring(0, 100000), pages: ocr ? [ocr] : [], route: 'ocr (forced)' };
  }

  try {
    const { extractText } = await import('unpdf');
    const result = await extractText(new Uint8Array(buf), { mergePages: false });
    const rawPages = Array.isArray(result.text) ? result.text.map((p) => (p == null ? '' : String(p))) : (result.text ? [String(result.text)] : []);
    if (rawPages.length && rawPages.some((p) => p.trim().length > 0)) {
      pages = rawPages;
      text = rawPages.join('\n').replace(/\s+/g, ' ').substring(0, 100000);
    }
  } catch { /* falls through to OCR */ }

  if (text && isTextGarbled(text)) { text = null; pages = []; }
  if (!text || !text.trim()) {
    route = 'ocr';
    const ocr = ocrPdf(pdfPath);
    if (ocr) { text = ocr.substring(0, 100000); pages = [text]; }
  }

  // Geometry pass LAST, exactly as in the worker: the OCR routing above is
  // decided on the original text, and this is a no-op when the guard declines.
  try {
    const { getDocumentProxy } = await import('unpdf');
    const doc = await getDocumentProxy(new Uint8Array(geomBuffer));
    const items = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const tc = await page.getTextContent();
      items.push((tc && tc.items) || []);
    }
    const serialized = serializePdfPages(items);
    if (shouldUseSerializedPages(serialized)) {
      pages = serialized;
      text = serialized.join('\n').substring(0, 100000);
      route = route === 'ocr' ? 'ocr' : 'geometry';
    } else if (route !== 'ocr') {
      const joined = serialized.join('\n');
      route = looksLikeBrokenEncoding(joined) ? `text-layer (serializer declined: broken encoding, ${countLetters(joined)} letters)` : route;
    }
  } catch { /* keep what we have */ }

  return { text: text || '', pages, route };
}

module.exports = { extractPdfText, ocrPdf, isTextGarbled };
