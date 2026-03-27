/**
 * Apply a naming template to document metadata.
 *
 * Supported placeholders: {title}, {lot_number}, {po_number}, {code_date},
 * {expiration_date}, {doc_type}, {product}, {date}, {ext}
 *
 * Unknown placeholders are removed. Output is sanitized for filesystem safety.
 */
export function applyNamingTemplate(
  template: string,
  metadata: {
    title?: string;
    lot_number?: string;
    po_number?: string;
    code_date?: string;
    expiration_date?: string;
    doc_type?: string;
    product?: string;
    ext?: string;
  }
): string {
  let result = template;

  // Replace known placeholders
  const fields: Record<string, string | undefined> = {
    title: metadata.title,
    lot_number: metadata.lot_number,
    po_number: metadata.po_number,
    code_date: metadata.code_date,
    expiration_date: metadata.expiration_date,
    doc_type: metadata.doc_type,
    product: metadata.product,
    date: new Date().toISOString().split('T')[0], // today's date as fallback
    ext: metadata.ext,
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
