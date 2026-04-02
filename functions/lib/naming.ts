/**
 * Apply a naming template to document metadata.
 *
 * Accepts a generic metadata record. Any key in the record can be used as a
 * placeholder via {key_name}. Special keys:
 *   - {date} — today's date (auto-generated)
 *   - {ext} — file extension
 *   - {title}, {doc_type}, {product} — common keys
 *
 * All other placeholders are pulled from the metadata by key name, so
 * {lot_number}, {po_number}, {supplier}, etc. all work if present.
 *
 * Unknown placeholders are removed. Output is sanitized for filesystem safety.
 */
export function applyNamingTemplate(
  template: string,
  metadata: Record<string, string | undefined>
): string {
  let result = template;

  // Always provide a {date} placeholder
  const fields: Record<string, string | undefined> = {
    date: new Date().toISOString().split('T')[0],
    ...metadata,
  };

  for (const [key, value] of Object.entries(fields)) {
    result = result.replace(new RegExp(`\\{${key}\\}`, 'g'), value || '');
  }

  // Remove any remaining unknown placeholders
  result = result.replace(/\{[^}]+\}/g, '');

  // Sanitize for filesystem: remove dangerous chars, collapse separators
  result = result.replace(/[<>:"/\\|?*\x00-\x1f]/g, '');
  result = result.replace(/[_\-\.]{2,}/g, (match) => match[0]); // collapse repeated separators
  result = result.replace(/^[_\-\.]+|[_\-\.]+$/g, ''); // trim leading/trailing separators

  // If result is empty after sanitization, use a fallback
  if (!result || result === metadata.ext) {
    result = metadata.title || 'document';
    if (metadata.ext) result += `.${metadata.ext}`;
  }

  return result;
}
