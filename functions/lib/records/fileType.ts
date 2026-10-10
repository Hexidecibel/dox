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

/** Declared types that are markup or script: a browser may run them. */
function isActiveType(mime: string): boolean {
  return (
    mime.includes('svg') ||
    mime.includes('html') ||
    mime.includes('xml') ||
    mime.includes('javascript') ||
    mime.includes('ecmascript') ||
    mime === 'text/css'
  );
}

/**
 * The type to STORE for an upload from outside, or null to refuse it.
 *
 *   - the bytes are one of the five known types: that type, whatever was
 *     declared (a JPEG declared `image/png` is stored as a JPEG);
 *   - the declaration is one of the five and the bytes are not: refused -- it
 *     is not what it says it is;
 *   - the declaration is markup or script (SVG, HTML, XML ...): refused;
 *   - anything else (a HEIC photo, a spreadsheet, a text file) keeps its
 *     declared type. It is never served inline, so the declaration can only
 *     ever name a download.
 */
export function storedTypeForUpload(declared: string, head: Uint8Array): string | null {
  const mime = (declared || 'application/octet-stream').toLowerCase().split(';')[0].trim() || 'application/octet-stream';
  const sniffed = sniffFileType(head);
  if (sniffed) return sniffed;
  if (INLINE_TYPES.includes(mime)) return null;
  if (isActiveType(mime)) return null;
  return mime;
}

/** May a file stored with this type be drawn in the browser, on our origin? */
export function mayServeInline(storedMime: string | null | undefined): boolean {
  return INLINE_TYPES.includes((storedMime || '').toLowerCase().split(';')[0].trim());
}
