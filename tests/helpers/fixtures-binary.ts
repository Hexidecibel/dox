/**
 * Binary fixture loader for the Cloudflare Workers test pool.
 *
 * Fixtures are committed as base64-encoded strings in `tests/fixtures/binary-data.ts`
 * so they can be imported cleanly from inside the Workers runtime (no Node fs,
 * no vite asset pipeline quirks). This module wraps decoding them into
 * ArrayBuffers of the shape the `EmailAttachment` type expects.
 */

import { COA_ORDERS_PDF_BASE64, WEEKLY_MASTER_XLSX_BASE64 } from '../fixtures/binary-data';

/** Decode a base64 string into an ArrayBuffer. */
export function decodeBase64(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return bytes.buffer;
}

/** Load the committed COA PDF fixture as an ArrayBuffer. */
export function loadCoaOrdersPdf(): ArrayBuffer {
  return decodeBase64(COA_ORDERS_PDF_BASE64);
}

/** Load the committed Weekly Master XLSX fixture as an ArrayBuffer. */
export function loadWeeklyMasterXlsx(): ArrayBuffer {
  return decodeBase64(WEEKLY_MASTER_XLSX_BASE64);
}
