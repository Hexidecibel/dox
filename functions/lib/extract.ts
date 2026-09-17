import { extractText as extractPdfText } from 'unpdf';

/**
 * Extract searchable text content from uploaded files.
 * Supports: JSON, CSV, TXT, PDF, and plain text formats.
 */
export async function extractText(
  file: ArrayBuffer | Uint8Array,
  mimeType: string,
  fileName: string
): Promise<string | null> {
  const decoder = new TextDecoder('utf-8', { fatal: false });

  try {
    // Text-based formats we can extract directly
    if (
      mimeType === 'text/plain' ||
      mimeType === 'text/csv' ||
      mimeType === 'application/json' ||
      fileName.endsWith('.txt') ||
      fileName.endsWith('.csv') ||
      fileName.endsWith('.json')
    ) {
      const text = decoder.decode(file instanceof ArrayBuffer ? new Uint8Array(file) : file);
      // Truncate to 100KB of text for storage/search efficiency
      return text.substring(0, 100_000);
    }

    // For XML-based Office formats, extract what we can
    // (DOCX/XLSX are ZIP files with XML inside — basic extraction)
    if (
      mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
      fileName.endsWith('.docx')
    ) {
      // DOCX is a ZIP — we'd need to decompress and parse XML
      // Skip for v1, return null
      return null;
    }

    // PDF — extract text using unpdf
    // Note: Scanned/image-based PDFs will return null here since OCR (tesseract)
    // can't run in the Cloudflare Workers edge runtime. The local process-worker
    // (bin/process-worker) has an OCR fallback for these cases.
    //
    // This is also why the PER-PAGE OCR routing (shared/pdfPageOcr.ts) is not
    // applied here: a page that is a pasted certificate image with a caption
    // over it returns the caption, and at the edge there is nothing better to
    // return. What this function feeds is the search index and the
    // extracted_text column, not the extraction prompt — the model's text comes
    // from the worker, which does run the per-page pass. Adding the DECISION
    // here without the OCR that answers it would only let us report a gap we
    // cannot close.
    if (mimeType === 'application/pdf') {
      try {
        const buffer = file instanceof ArrayBuffer ? file : file.buffer;
        const { text } = await extractPdfText(buffer, { mergePages: true });
        const trimmed = text.trim();
        if (!trimmed) return null;
        return trimmed.substring(0, 100_000);
      } catch (err) {
        console.warn('PDF text extraction failed:', err);
        return null;
      }
    }

    return null;
  } catch {
    return null;
  }
}
