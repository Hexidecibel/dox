// === Shared connector file-type catalog ===
// Single source of truth for the file extensions a file_watch connector
// will accept on manual run and scheduled R2 polls. Imported by both the
// frontend drop zone (src/pages/admin/ConnectorDetail.tsx) and the
// backend run handler (functions/api/connectors/[id]/run.ts) so the two
// can never drift out of sync.
//
// shared/types.ts is reserved for type definitions; this module holds the
// runtime constant + the small classifier used by the run endpoint.

/**
 * File extensions the file_watch connector accepts. Keep lowercased,
 * leading-dot form. Add new ones here and the drop zone + the server
 * classifier both pick them up automatically.
 */
export const ACCEPTED_CONNECTOR_FILE_EXTENSIONS = [
  '.csv',
  '.tsv',
  '.txt',
  '.xlsx',
  '.xls',
  '.pdf',
] as const;

export type AcceptedConnectorFileExtension =
  typeof ACCEPTED_CONNECTOR_FILE_EXTENSIONS[number];

/**
 * Extensions the server treats as plain-text (parsed as UTF-8 strings).
 * The remaining accepted extensions are treated as binary.
 */
export const TEXT_CONNECTOR_FILE_EXTENSIONS: readonly AcceptedConnectorFileExtension[] = [
  '.csv',
  '.tsv',
  '.txt',
];

/**
 * MIME types the server recognises in addition to the extension list.
 * Some clients upload xlsx/pdf with a generic Content-Type, so we do a
 * belt-and-braces check against both.
 */
export const TEXT_CONNECTOR_MIME_TYPES = ['text/csv', 'text/tsv', 'text/plain'] as const;
export const BINARY_CONNECTOR_MIME_TYPES = [
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'application/pdf',
] as const;

export interface ConnectorFileClassification {
  kind: 'text' | 'binary' | 'unknown';
}

/**
 * Classify a file by name + content-type. The caller decides what size
 * limits / parsing path to apply to each kind.
 */
export function classifyConnectorFile(
  fileName: string,
  contentType: string,
): ConnectorFileClassification {
  const ct = (contentType || '').toLowerCase();
  const name = (fileName || '').toLowerCase();

  if (
    (TEXT_CONNECTOR_MIME_TYPES as readonly string[]).includes(ct) ||
    TEXT_CONNECTOR_FILE_EXTENSIONS.some((ext) => name.endsWith(ext))
  ) {
    return { kind: 'text' };
  }

  if (
    (BINARY_CONNECTOR_MIME_TYPES as readonly string[]).includes(ct) ||
    ACCEPTED_CONNECTOR_FILE_EXTENSIONS.some(
      (ext) => !TEXT_CONNECTOR_FILE_EXTENSIONS.includes(ext) && name.endsWith(ext),
    )
  ) {
    return { kind: 'binary' };
  }

  return { kind: 'unknown' };
}
