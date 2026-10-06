/**
 * The pure half of sending an order's documents (migration 0134): how a lot
 * row's production date is WORDED, and how a set of files is PACKED into
 * emails. No database, no storage, no clock -- so the review screen, the send
 * and the tests all get the same answer from the same function.
 */

import type { OrderLineDateState, OrderSendDelivery } from './types';

// ---------------------------------------------------------------------------
// A lot row's production date, with its doubt
// ---------------------------------------------------------------------------
//
// AJ's ruling for the manual tier: each line shows product, lot and production
// date "so a wrong pick is visible before it goes". That only works if the
// date shown is as sure as it looks. The lot register already records how each
// date was come by (0106 status, 0110 source); this is the one place those two
// columns become words, so a decoded or ambiguous date can never be printed as
// though the certificate stated it.

export interface LotDateFacts {
  production_date?: string | null;
  production_date_raw?: string | null;
  production_date_status?: string | null;
  production_date_source?: string | null;
}

export interface LotDateDisplay {
  state: OrderLineDateState;
  /** What to print in the date cell. Null when there is nothing to print. */
  label: string | null;
  /** The doubt, in words. Null only for a stated date (or none at all). */
  note: string | null;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Jul 22, 2026" from an ISO day. Anything else comes back as it was given. */
export function humanDay(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  const month = MONTHS[Number(m[2]) - 1];
  if (!month) return iso;
  return `${month} ${Number(m[3])}, ${m[1]}`;
}

export function describeLotDate(lot: LotDateFacts | null | undefined): LotDateDisplay {
  if (!lot) return { state: 'none', label: null, note: null };
  const status = lot.production_date_status ?? (lot.production_date ? 'resolved' : null);
  const raw = (lot.production_date_raw ?? '').trim() || null;

  if (status === 'conflict') {
    return {
      state: 'conflict',
      label: raw ?? 'In conflict',
      note: 'Certificates for this lot state different production dates. None is shown as fact.',
    };
  }
  if (status === 'ambiguous') {
    return {
      state: 'ambiguous',
      label: raw ?? 'Unclear',
      note: 'The date as printed reads more than one way, so no day is claimed.',
    };
  }
  if (status === 'unparseable') {
    return {
      state: 'unparseable',
      label: raw ?? 'Unreadable',
      note: 'A production date is printed but could not be read as a day.',
    };
  }
  if (!lot.production_date) return { state: 'none', label: null, note: null };

  const day = humanDay(lot.production_date);
  if (lot.production_date_source === 'lot_decode') {
    return {
      state: 'decoded',
      label: `${day} (from the lot code)`,
      note: "Decoded from the lot code using the supplier's declared lot format. The certificate does not state it.",
    };
  }
  if (lot.production_date_source === 'extracted_code_date_legacy') {
    return {
      state: 'legacy',
      label: `${day} (confirm)`,
      note: "Read from the document's code date field by an older extraction. Confirm it against the certificate.",
    };
  }
  return { state: 'stated', label: day, note: null };
}

/** "10426203 / 03" -- the lot register's own label shape (document-export.ts). */
export function lotRowLabel(lotNumber: string | null | undefined, subLot: string | null | undefined): string | null {
  const lot = (lotNumber ?? '').trim();
  if (!lot) return null;
  const sub = (subLot ?? '').trim();
  return sub ? `${lot} / ${sub}` : lot;
}

// ---------------------------------------------------------------------------
// Packing files into emails
// ---------------------------------------------------------------------------
//
// AJ: the customer gets the certificates ATTACHED, and when they do not fit in
// one email they go in numbered emails ("1 of N") that the sender sees before
// sending. Nothing is dropped; past the cap the send is refused with the
// number.
//
// The ceiling is the mail provider's 40 MB per message AFTER base64, and the
// Function's 128 MB of memory. 15 MB of files is about 20 MB encoded: one part
// held in memory (bytes + base64 + the JSON body) stays well inside both.

/** Raw file bytes one email may carry. */
export const ORDER_SEND_MAX_PART_BYTES = 15 * 1024 * 1024;
/** Emails one send may be split into. Beyond this the send is refused. */
export const ORDER_SEND_MAX_PARTS = 10;

export interface PackInput {
  key: string;
  bytes: number;
}

export interface PackedFile {
  key: string;
  bytes: number;
  delivery: OrderSendDelivery;
  part_number: number;
}

export interface PackResult {
  files: PackedFile[];
  part_count: number;
  /** Bytes attached to each part, index 0 = part 1. */
  part_bytes: number[];
  /** Set when the send needs more emails than the cap allows. */
  refusal: string | null;
}

/**
 * Assign each file to an email, in the order given.
 *
 * NEXT-FIT, deliberately: files stay in the order's line order, so "2 of 3"
 * holds the lines after the ones in "1 of 3" and a reader can follow it. A
 * tighter bin-packing would save an email now and then and scatter the order.
 *
 * A single file over the limit cannot ride in any email. It is not dropped: it
 * leaves as a LINK, announced in part 1, and counts no bytes against a part.
 */
export function packOrderSendFiles(
  inputs: PackInput[],
  opts: { maxPartBytes?: number; maxParts?: number } = {},
): PackResult {
  const maxPartBytes = opts.maxPartBytes ?? ORDER_SEND_MAX_PART_BYTES;
  const maxParts = opts.maxParts ?? ORDER_SEND_MAX_PARTS;

  const files: PackedFile[] = [];
  const partBytes: number[] = [0];
  for (const f of inputs) {
    const bytes = Math.max(0, Number(f.bytes) || 0);
    if (bytes > maxPartBytes) {
      files.push({ key: f.key, bytes, delivery: 'link', part_number: 1 });
      continue;
    }
    let part = partBytes.length;
    if (partBytes[part - 1] + bytes > maxPartBytes) {
      partBytes.push(0);
      part += 1;
    }
    partBytes[part - 1] += bytes;
    files.push({ key: f.key, bytes, delivery: 'attachment', part_number: part });
  }

  const partCount = partBytes.length;
  const refusal =
    partCount > maxParts
      ? `These files need ${partCount} emails, and one send is split into at most ${maxParts}. ` +
        `Send the order in two goes, or take some lines off it.`
      : null;
  return { files, part_count: partCount, part_bytes: partBytes, refusal };
}

/** "<subject> (2 of 3)" -- a single-email send keeps its subject untouched. */
export function partSubject(subject: string, part: number, partCount: number): string {
  return partCount > 1 ? `${subject} (${part} of ${partCount})` : subject;
}

/** "1.4 MB" / "312 KB" for the review screen and the refusal messages. */
export function humanBytes(bytes: number): string {
  const n = Math.max(0, Number(bytes) || 0);
  if (n >= 1024 * 1024) return `${Math.round((n / (1024 * 1024)) * 10) / 10} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}
