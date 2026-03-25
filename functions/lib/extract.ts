/**
 * Extract searchable text content from uploaded files.
 * Supports: JSON, CSV, TXT, and plain text formats.
 * PDF extraction is complex (needs a library) — skip for v1, add later.
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

    // PDF — would need pdf-parse or similar, skip for v1
    if (mimeType === 'application/pdf') {
      return null;
    }

    return null;
  } catch {
    return null;
  }
}
