/**
 * Page-scoped per-record PDF extraction (COA Option B, P4).
 *
 * Given the original document binary and a record's 1-based `source_pages`,
 * produce a new PDF containing ONLY those pages. The per-sublot, page-scoped
 * document is the customer deliverable, so each per-record document must carry
 * only its own page(s) rather than the whole multi-product binary.
 *
 * Pure (modulo pdf-lib's async API) and resilient: it NEVER throws. Anything
 * that can't be safely page-split returns the original bytes plus a reason so
 * the approve flow can fall back to uploading the whole binary unchanged.
 *
 * pdf-lib is pure-JS and runs in the Cloudflare Workers / Pages Functions
 * runtime (verified by the coaPageScope unit test, which executes in the
 * Workers vitest pool).
 */

import { PDFDocument } from 'pdf-lib';

/**
 * Why a page-scope attempt fell back to the whole binary. `null` reason means
 * the split succeeded and `bytes` is the per-record PDF.
 */
export type PageScopeFallbackReason =
  | 'not_pdf' // source is an image/docx/etc — can't page-split
  | 'no_pages' // source_pages missing/empty
  | 'out_of_range' // every requested page was outside the doc
  | 'extract_failed'; // pdf-lib threw (corrupt PDF, etc.)

export interface PageScopeResult {
  /** The bytes to upload: the per-record PDF on success, else the original. */
  bytes: ArrayBuffer;
  /** Whether `bytes` is a page-scoped subset (true) or the whole binary (false). */
  scoped: boolean;
  /** Set when we fell back to the whole binary; null on success. */
  reason: PageScopeFallbackReason | null;
  /** The 1-based pages actually included (in-range, de-duped, ordered). */
  includedPages: number[];
}

/** True when the mime type / file name indicates a PDF we can page-split. */
export function isPdfSource(mimeType: string | null | undefined, fileName: string | null | undefined): boolean {
  const mt = (mimeType ?? '').toLowerCase();
  if (mt.includes('application/pdf') || mt === 'application/x-pdf') return true;
  const fn = (fileName ?? '').toLowerCase();
  return fn.endsWith('.pdf');
}

/**
 * Extract `sourcePages` (1-based) from `original` into a new single/multi-page
 * PDF. Returns the original bytes (with a fallback reason) when extraction is
 * not possible or not warranted — see PageScopeFallbackReason.
 *
 * Duplicate page numbers across records are fine; each call independently
 * copies whatever pages it's given.
 */
export async function extractRecordPdf(
  original: ArrayBuffer,
  sourcePages: number[] | null | undefined,
  mimeType: string | null | undefined,
  fileName: string | null | undefined
): Promise<PageScopeResult> {
  const fallback = (reason: PageScopeFallbackReason): PageScopeResult => ({
    bytes: original,
    scoped: false,
    reason,
    includedPages: [],
  });

  if (!isPdfSource(mimeType, fileName)) return fallback('not_pdf');
  if (!sourcePages || sourcePages.length === 0) return fallback('no_pages');

  try {
    const srcDoc = await PDFDocument.load(original);
    const total = srcDoc.getPageCount();

    // Clamp/skip invalid page numbers; preserve request order, drop dups.
    const seen = new Set<number>();
    const validOneBased: number[] = [];
    for (const p of sourcePages) {
      if (!Number.isInteger(p)) continue;
      if (p < 1 || p > total) continue; // out of range → skip
      if (seen.has(p)) continue;
      seen.add(p);
      validOneBased.push(p);
    }

    if (validOneBased.length === 0) return fallback('out_of_range');

    const newDoc = await PDFDocument.create();
    const zeroBased = validOneBased.map((p) => p - 1);
    const copied = await newDoc.copyPages(srcDoc, zeroBased);
    for (const page of copied) newDoc.addPage(page);

    const out = await newDoc.save();
    // pdf-lib returns a Uint8Array; hand back a tight ArrayBuffer slice.
    const buf = out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;

    return {
      bytes: buf,
      scoped: true,
      reason: null,
      includedPages: validOneBased,
    };
  } catch {
    // Corrupt/encrypted PDF, pdf-lib parse error, etc. — never break approve.
    return fallback('extract_failed');
  }
}
