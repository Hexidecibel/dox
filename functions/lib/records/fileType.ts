/**
 * What a Records attachment IS, decided from its bytes, and which types the
 * portal will ever draw inline on its own origin (C-140).
 *
 * WHY. A public form accepts `image/*` by default and used to store whatever
 * `Content-Type` the browser declared. The signed-in download route then
 * served the file back with that type, `inline` on `?preview=true`, and the
 * grid opens that URL in a new tab. So somebody with no account could upload
 * an SVG (a document that runs script) declared `image/svg+xml`, or HTML
 * declared as an image, and it would run in the session of the first signed-in
 * person who clicked the thumbnail: stored script on the portal's own origin.
 *
 * Two rules close it, one at each end:
 *
 *   1. ON THE WAY IN (the public upload): the type stored is the type the
 *      BYTES say. A file that claims to be a PNG / JPEG / GIF / WebP / PDF and
 *      is not is refused, and a type that is markup is refused whatever the
 *      form's allow-list says.
 *   2. ON THE WAY OUT (the download route, for every attachment however it
 *      got there): only `INLINE_TYPES` is ever served inline; everything else
 *      is a download. Every response says `nosniff`.
 *
 * This is NOT the brand logo's `judgeLogo` (`shared/tenantBrand.ts`). That one
 * also bounds pixel dimensions and file size and refuses animation, because a
 * logo is drawn on every outside page; an attachment is a photo off a phone or
 * a scanned PDF, and only its TYPE matters here.
 */

export type SniffedType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | 'application/pdf';

/** The only types ever served `inline`. All are inert in a browser tab. */
export const INLINE_TYPES: readonly string[] = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf'];

/** How many leading bytes `sniffFileType` needs. */
export const SNIFF_BYTES = 16;

function startsWith(bytes: Uint8Array, signature: number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;
  return signature.every((b, i) => bytes[offset + i] === b);
}

/** The type the leading bytes declare, or null when it is none of the five. */
export function sniffFileType(head: Uint8Array): SniffedType | null {
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(head, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(head, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) || startsWith(head, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])) {
    return 'image/gif';
  }
  if (startsWith(head, [0x52, 0x49, 0x46, 0x46]) && startsWith(head, [0x57, 0x45, 0x42, 0x50], 8)) return 'image/webp';
  if (startsWith(head, [0x25, 0x50, 0x44, 0x46, 0x2d])) return 'application/pdf';
  return null;
}

/**
 * Declared types that are markup or script: a browser may run them.
 *
 * AN EXPLICIT LIST, NOT A SUBSTRING (C-143). The first version asked whether
 * the type "includes xml", which also matched every modern Office type
 * (`application/vnd.openxmlformats-officedocument...`), so a .docx or .xlsx
 * was refused on a form whose own builder preset allowed it. An XML DOCUMENT
 * type is one of the names below or ends in `+xml` (SVG, XHTML, Atom, MathML);
 * an Office file is a ZIP whose type merely has "xml" in its vendor name.
 */
const ACTIVE_TYPES: ReadonlySet<string> = new Set([
  'text/html',
  'application/xhtml',
  'text/xml',
  'application/xml',
  'text/xsl',
  'text/xslt',
  'application/xslt',
  'image/svg',
  'text/javascript',
  'application/javascript',
  'application/x-javascript',
  'text/ecmascript',
  'application/ecmascript',
  'text/jscript',
  'text/vbscript',
  'text/css',
  'application/x-shockwave-flash',
  'application/hta',
  'message/rfc822',
  'multipart/related',
  'application/x-mimearchive',
]);

function isActiveType(mime: string): boolean {
  return ACTIVE_TYPES.has(mime) || mime.endsWith('+xml');
}

/**
 * The modern Office types (OOXML). Each is a ZIP container, so a file that
 * declares one must start like a ZIP; that is decided from the bytes like the
 * five inline types, not taken on the browser's word.
 */
const OOXML_PREFIX = 'application/vnd.openxmlformats-officedocument.';
const ZIP_SIGNATURES = [
  [0x50, 0x4b, 0x03, 0x04],
  [0x50, 0x4b, 0x05, 0x06],
  [0x50, 0x4b, 0x07, 0x08],
];

function isZip(head: Uint8Array): boolean {
  return ZIP_SIGNATURES.some((sig) => startsWith(head, sig));
}

/**
 * The type to STORE for an upload from outside, or null to refuse it.
 *
 *   - the bytes are one of the five known types: that type, whatever was
 *     declared (a JPEG declared `image/png` is stored as a JPEG);
 *   - the declaration is one of the five and the bytes are not: refused -- it
 *     is not what it says it is;
 *   - the declaration is markup or script (SVG, HTML, XML ...): refused;
 *   - the declaration is a modern Office type (.docx / .xlsx / .pptx): kept
 *     when the bytes are a ZIP container, which is what such a file is, and
 *     refused when they are not;
 *   - anything else (a HEIC photo, an old .doc / .xls, a CSV, a text file)
 *     keeps its declared type. It is never served inline, so the declaration
 *     can only ever name a download.
 *
 * `tests/api/records-public-adversarial.test.ts` uploads every type every
 * form-builder preset offers (`shared/formAttachmentPresets.ts`), so a preset
 * cannot offer a type this function refuses.
 */
export function storedTypeForUpload(declared: string, head: Uint8Array): string | null {
  const mime = (declared || 'application/octet-stream').toLowerCase().split(';')[0].trim() || 'application/octet-stream';
  const sniffed = sniffFileType(head);
  if (sniffed) return sniffed;
  if (INLINE_TYPES.includes(mime)) return null;
  if (isActiveType(mime)) return null;
  if (mime.startsWith(OOXML_PREFIX)) return isZip(head) ? mime : null;
  return mime;
}

/** May a file stored with this type be drawn in the browser, on our origin? */
export function mayServeInline(storedMime: string | null | undefined): boolean {
  return INLINE_TYPES.includes((storedMime || '').toLowerCase().split(';')[0].trim());
}

/**
 * `attachment; filename="<ascii fallback>"; filename*=UTF-8''<percent-encoded>`
 * (RFC 6266 / 5987), for a file name somebody typed or uploaded.
 *
 * A header value must be Latin-1: a name in any other script made the
 * download route throw. The fallback keeps letters, digits, space and
 * `. _ -` and turns everything else (quotes, control characters, any
 * non-ASCII) into `_`, so nothing in a file name can break out of the quoted
 * string or the header; the real name travels percent-encoded beside it.
 */
export function attachmentDisposition(fileName: string | null | undefined): string {
  const name = (fileName || '').replace(/[\u0000-\u001f\u007f]/g, '').trim() || 'download';
  const ascii = name.replace(/[^A-Za-z0-9._ -]/g, '_').slice(0, 150) || 'download';
  const encoded = encodeURIComponent(name.slice(0, 150)).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
