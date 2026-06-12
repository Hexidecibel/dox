/**
 * Unit tests for extractRecordPdf — the page-scoped per-record PDF extractor
 * (COA Option B, P4). Each per-sublot document must carry only its own page(s),
 * extracted from the original multi-product PDF. The helper must NEVER throw and
 * must fall back to the whole binary on any non-extractable input.
 *
 * Runs in the Workers vitest pool (same runtime as Pages Functions), which also
 * proves pdf-lib loads and executes in that runtime.
 */

import { describe, it, expect } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { extractRecordPdf, isPdfSource } from '../../functions/lib/kinds/coaPageScope';

/** Build an N-page PDF and return its bytes as an ArrayBuffer. */
async function makePdf(pageCount: number): Promise<ArrayBuffer> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pageCount; i++) {
    const page = doc.addPage([300, 400]);
    page.drawText(`Page ${i + 1}`, { x: 20, y: 350, size: 24 });
  }
  const bytes = await doc.save();
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function pageCountOf(buf: ArrayBuffer): Promise<number> {
  const doc = await PDFDocument.load(buf);
  return doc.getPageCount();
}

describe('isPdfSource', () => {
  it('detects PDF by mime type', () => {
    expect(isPdfSource('application/pdf', 'x.bin')).toBe(true);
    expect(isPdfSource('application/x-pdf', null)).toBe(true);
  });
  it('detects PDF by .pdf extension', () => {
    expect(isPdfSource('application/octet-stream', 'coa.PDF')).toBe(true);
  });
  it('returns false for non-PDF', () => {
    expect(isPdfSource('image/png', 'scan.png')).toBe(false);
    expect(isPdfSource(null, 'doc.docx')).toBe(false);
  });
});

describe('extractRecordPdf', () => {
  it('extracts a single page into a 1-page PDF', async () => {
    const orig = await makePdf(5);
    const res = await extractRecordPdf(orig, [2], 'application/pdf', 'multi.pdf');

    expect(res.scoped).toBe(true);
    expect(res.reason).toBeNull();
    expect(res.includedPages).toEqual([2]);
    expect(res.bytes).not.toBe(orig); // a new, smaller PDF
    expect(await pageCountOf(res.bytes)).toBe(1);
    expect(res.bytes.byteLength).toBeLessThan(orig.byteLength);
  });

  it('extracts multiple pages preserving order, de-duping', async () => {
    const orig = await makePdf(5);
    const res = await extractRecordPdf(orig, [4, 2, 2], 'application/pdf', 'multi.pdf');

    expect(res.scoped).toBe(true);
    expect(res.includedPages).toEqual([4, 2]);
    expect(await pageCountOf(res.bytes)).toBe(2);
  });

  it('returns the original bytes for a non-PDF source', async () => {
    const orig = await makePdf(3);
    const res = await extractRecordPdf(orig, [1], 'image/png', 'scan.png');

    expect(res.scoped).toBe(false);
    expect(res.reason).toBe('not_pdf');
    expect(res.bytes).toBe(orig);
  });

  it('falls back to whole binary when source_pages is missing/empty', async () => {
    const orig = await makePdf(3);
    const a = await extractRecordPdf(orig, undefined, 'application/pdf', 'm.pdf');
    const b = await extractRecordPdf(orig, [], 'application/pdf', 'm.pdf');

    expect(a.scoped).toBe(false);
    expect(a.reason).toBe('no_pages');
    expect(a.bytes).toBe(orig);
    expect(b.reason).toBe('no_pages');
  });

  it('skips out-of-range pages and keeps the valid ones', async () => {
    const orig = await makePdf(3);
    const res = await extractRecordPdf(orig, [2, 99, 0], 'application/pdf', 'm.pdf');

    expect(res.scoped).toBe(true);
    expect(res.includedPages).toEqual([2]);
    expect(await pageCountOf(res.bytes)).toBe(1);
  });

  it('falls back to whole binary when EVERY page is out of range', async () => {
    const orig = await makePdf(2);
    const res = await extractRecordPdf(orig, [7, 8], 'application/pdf', 'm.pdf');

    expect(res.scoped).toBe(false);
    expect(res.reason).toBe('out_of_range');
    expect(res.bytes).toBe(orig);
    expect(res.includedPages).toEqual([]);
  });

  it('falls back (extract_failed) on a corrupt PDF rather than throwing', async () => {
    const garbage = new TextEncoder().encode('%PDF-1.4 not really a pdf').buffer as ArrayBuffer;
    const res = await extractRecordPdf(garbage, [1], 'application/pdf', 'bad.pdf');

    expect(res.scoped).toBe(false);
    expect(res.reason).toBe('extract_failed');
    expect(res.bytes).toBe(garbage);
  });
});
