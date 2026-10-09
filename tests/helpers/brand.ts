/**
 * Logo bytes for the tenant brand tests (migration 0140). Headers only: the
 * portal judges a logo by its magic bytes and the size in its header and never
 * decodes pixels, so these are the smallest files that are honestly that type.
 * No real logo, and nobody's.
 */

function fill(bytes: number[], total: number | undefined, seed: number): Uint8Array {
  const out = new Uint8Array(Math.max(total ?? 0, bytes.length + 8));
  out.set(bytes, 0);
  for (let i = bytes.length; i < out.length; i += 1) out[i] = (i * 31 + seed) & 0xff;
  return out;
}
const be32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const le24 = (n: number) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff];
const ascii = (s: string) => Array.from(s).map((c) => c.charCodeAt(0));

/**
 * A PNG of the given pixel size, exactly `total` bytes long: the signature, an
 * IHDR chunk, optionally an `acTL` chunk (which is what makes a PNG animated),
 * one IDAT chunk holding the padding, and IEND. Real chunk framing, so the
 * sniffer's chunk walk has something true to walk; the CRCs are zero because
 * nothing here (or in the portal) verifies them.
 */
export function pngBytes(
  width: number,
  height: number,
  total?: number,
  seed = 0,
  opts: { animated?: boolean; noData?: boolean } = {},
): Uint8Array {
  const chunk = (type: string, data: number[]) => [...be32(data.length), ...ascii(type), ...data, 0, 0, 0, 0];
  const head = [
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...chunk('IHDR', [...be32(width), ...be32(height), 8, 6, 0, 0, 0]),
    ...(opts.animated ? chunk('acTL', [...be32(2), ...be32(0)]) : []),
  ];
  if (opts.noData) return new Uint8Array([...head, ...chunk('IEND', [])]);
  const overhead = head.length + 12 + 12; // IDAT framing + IEND
  const dataLength = Math.max(8, (total ?? 0) - overhead);
  const out = new Uint8Array(overhead + dataLength);
  out.set(head, 0);
  out.set([...be32(dataLength), ...ascii('IDAT')], head.length);
  const dataAt = head.length + 8;
  for (let i = 0; i < dataLength; i += 1) out[dataAt + i] = (i * 31 + seed) & 0xff;
  out.set(chunk('IEND', []), dataAt + dataLength + 4);
  return out;
}

/** A JPEG: SOI, an APP0 segment, then a baseline start-of-frame with the size. */
export function jpegBytes(width: number, height: number, total?: number, seed = 0): Uint8Array {
  return fill(
    [
      0xff, 0xd8,
      0xff, 0xe0, 0x00, 0x10, ...ascii('JFIF'), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0,
      0xff, 0xc0, 0x00, 0x11, 8, (height >> 8) & 0xff, height & 0xff, (width >> 8) & 0xff, width & 0xff, 3,
    ],
    total,
    seed,
  );
}

/** A WebP container with one of the three first-chunk kinds. */
export function webpBytes(
  width: number,
  height: number,
  kind: 'VP8 ' | 'VP8L' | 'VP8X',
  opts: { animated?: boolean; total?: number; seed?: number } = {},
): Uint8Array {
  const head = [...ascii('RIFF'), 0, 0, 0, 0, ...ascii('WEBP'), ...ascii(kind), 0, 0, 0, 0];
  let body: number[];
  if (kind === 'VP8X') {
    body = [opts.animated ? 0x02 : 0x00, 0, 0, 0, ...le24(width - 1), ...le24(height - 1)];
  } else if (kind === 'VP8L') {
    const bits = ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14);
    body = [0x2f, bits & 0xff, (bits >>> 8) & 0xff, (bits >>> 16) & 0xff, (bits >>> 24) & 0xff, 0, 0, 0, 0, 0];
  } else {
    body = [0, 0, 0, 0x9d, 0x01, 0x2a, width & 0xff, (width >> 8) & 0x3f, height & 0xff, (height >> 8) & 0x3f];
  }
  return fill([...head, ...body], opts.total, opts.seed ?? 0);
}

export const SVG_BYTES = new TextEncoder().encode(
  '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="96"><script>alert(1)</script><rect width="320" height="96"/></svg>',
);
