/**
 * functions/lib/packet-split.ts — carve a confirmed packet into one queue item
 * per document, and refuse to do anything a person did not confirm.
 *
 * ---------------------------------------------------------------------------
 * THE RULE THIS FILE IS BUILT AROUND
 * ---------------------------------------------------------------------------
 * A WRONG SPLIT TURNS ONE WRONG DOCUMENT INTO TWENTY-FIVE. Detection
 * (shared/packetDetect.ts) only ever proposes; this only ever runs from an
 * endpoint a person hit, with the ranges that person confirmed or edited. There
 * is no path from "looks like a packet" to a split, and there must never be one.
 *
 * ---------------------------------------------------------------------------
 * WHAT A SPLIT PRODUCES
 * ---------------------------------------------------------------------------
 *   * one CHILD queue item per range, `processing_status='queued'` so the
 *     extraction worker picks it up and classifies and extracts each part on
 *     its own -- which is the entire point: the packet's 25 parts want 25
 *     types, not one;
 *   * a carved PDF per child, cut with `extractRecordPdf` -- the SAME splitter
 *     the COA records path runs. It carved all 26 parts of the client's packet
 *     with no fallback, and a second carver would be a second set of bugs;
 *   * the PARENT left alone as a container: its file_r2_key still points at the
 *     whole original, which stays the source of record, and it is stamped
 *     `packet_split_at` so the approve path refuses it.
 *
 * A child is an ordinary queue item in every other respect. It can be
 * rejected, dismissed, re-extracted or approved with no effect whatsoever on
 * its siblings -- there is no parent-level transaction over their review,
 * because a packet's twenty-five documents are twenty-five decisions.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT DOES NOT DO
 * ---------------------------------------------------------------------------
 * It does not carry the parent's extraction down to the children. The parent's
 * ai_fields were read off a file that is 25 documents; inheriting them would
 * seed every child with page 3's answers, which is the original defect wearing
 * a different hat. Each child starts from nothing and is read on its own.
 *
 * It does not de-duplicate. `enqueueDocument`'s checksum check exists to stop
 * the same arrival being reviewed twice; a part of a packet is not a second
 * arrival, and a part that happens to be byte-identical to a document already
 * held is exactly the case a reviewer needs to SEE rather than have swallowed.
 * So children are inserted with the duplicate check skipped, and the fact is
 * recorded in the audit row.
 */

import { generateId, logAudit } from './db';
import { uploadFile, downloadFile, computeChecksum } from './r2';
import { extractRecordPdf, isPdfSource } from './kinds/coaPageScope';
import {
  validateRanges,
  pagesOfRange,
  type PacketRangeInput,
  type PacketRangeError,
} from '../../shared/packetDetect';

/** The queue row a split reads. */
export interface PacketParentItem {
  id: string;
  tenant_id: string;
  tenant_slug: string;
  file_r2_key: string;
  file_name: string;
  mime_type: string;
  document_type_id: string | null;
  supplier_id: string | null;
  source: string | null;
  source_detail: string | null;
  output_kind: string | null;
  source_id: string | null;
  connector_run_id: string | null;
  packet_split_at: string | null;
}

export interface PacketChildSummary {
  id: string;
  part_index: number;
  pages: [number, number];
  label: string | null;
  file_name: string;
  file_size: number;
  /** False when the carve fell back to the whole binary — see `reason`. */
  scoped: boolean;
  reason: string | null;
}

export type PacketSplitFailure =
  | { kind: 'already_split' }
  | { kind: 'not_pdf' }
  | { kind: 'file_missing' }
  | { kind: 'invalid_ranges'; error: PacketRangeError }
  | { kind: 'carve_failed'; index: number; reason: string };

export type PacketSplitResult =
  | { ok: true; children: PacketChildSummary[] }
  | { ok: false; failure: PacketSplitFailure };

/** A part's file name: the original, with the part number and range on it. */
export function partFileName(original: string, index: number, pages: [number, number]): string {
  const dot = original.lastIndexOf('.');
  const stem = dot > 0 ? original.slice(0, dot) : original;
  const ext = dot > 0 ? original.slice(dot) : '.pdf';
  const range = pages[0] === pages[1] ? `p${pages[0]}` : `p${pages[0]}-${pages[1]}`;
  return `${stem} (${index + 1} of ${range})${ext}`;
}

/**
 * Carve `ranges` out of the parent's file and create one queue item per range.
 *
 * `method` says where the ranges came from — the detector's method verbatim
 * when the reviewer confirmed the proposal, or 'adjusted' when they edited it.
 * A split nobody checked and a split somebody corrected are different evidence
 * about the detector, and collapsing them would erase the only feedback it gets.
 *
 * Returns the children it created. Never throws on a bad PDF: a carve that
 * falls back to the whole binary is reported as a failure BEFORE any row is
 * written, because a "part" that is secretly the whole 36-page packet is worse
 * than no split at all.
 */
export async function splitPacket(
  db: D1Database,
  files: R2Bucket,
  item: PacketParentItem,
  ranges: PacketRangeInput[],
  opts: { userId: string; method: string; pageCount: number; clientIp?: string | null },
): Promise<PacketSplitResult> {
  if (item.packet_split_at) return { ok: false, failure: { kind: 'already_split' } };
  if (!isPdfSource(item.mime_type, item.file_name)) return { ok: false, failure: { kind: 'not_pdf' } };

  const bad = validateRanges(ranges, opts.pageCount);
  if (bad) return { ok: false, failure: { kind: 'invalid_ranges', error: bad } };

  const file = await downloadFile(files, item.file_r2_key);
  if (!file) return { ok: false, failure: { kind: 'file_missing' } };
  const original = await file.arrayBuffer();

  // CARVE EVERYTHING FIRST, WRITE NOTHING YET. D1 has no transaction across
  // an R2 write, so the only way a half-done split is avoided is to find out
  // that a range cannot be carved before the first row exists.
  const carved: { range: PacketRangeInput; bytes: ArrayBuffer; checksum: string }[] = [];
  for (let i = 0; i < ranges.length; i++) {
    const scope = await extractRecordPdf(original, pagesOfRange(ranges[i]), item.mime_type, item.file_name);
    if (!scope.scoped) {
      return { ok: false, failure: { kind: 'carve_failed', index: i, reason: scope.reason || 'unknown' } };
    }
    carved.push({ range: ranges[i], bytes: scope.bytes, checksum: await computeChecksum(scope.bytes) });
  }

  const children: PacketChildSummary[] = [];
  for (let i = 0; i < carved.length; i++) {
    const { range, bytes, checksum } = carved[i];
    const childId = generateId();
    const fileName = partFileName(item.file_name, i, range.pages);
    // Same staging-key shape as every other intake door
    // (functions/api/documents/process.ts), so the approve path moves a part's
    // bytes exactly as it moves any other queue item's.
    const r2Key = `pending/${item.tenant_slug}/${childId}/${fileName}`;
    await uploadFile(files, r2Key, bytes, 'application/pdf');

    await db
      .prepare(
        `INSERT INTO processing_queue
           (id, tenant_id, document_type_id, file_r2_key, file_name, file_size, mime_type,
            status, processing_status, checksum, created_by, source, source_detail,
            output_kind, source_id, supplier_id, connector_run_id,
            packet_parent_id, packet_pages, packet_part_index, packet_part_label)
         VALUES (?, ?, ?, ?, ?, ?, 'application/pdf', 'pending', 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        childId,
        item.tenant_id,
        // The type is NOT inherited. The parent's type was decided by reading a
        // file that is many documents; handing it down is the defect this
        // whole feature exists to undo. Each part is classified on its own.
        null,
        r2Key,
        fileName,
        bytes.byteLength,
        checksum,
        opts.userId,
        item.source || 'import',
        item.source_detail,
        item.output_kind,
        item.source_id,
        // The SUPPLIER is inherited, and that is deliberate: a packet comes
        // from one supplier and every document in it is theirs. It is the one
        // fact the whole file genuinely answers.
        item.supplier_id,
        item.connector_run_id,
        item.id,
        JSON.stringify(range.pages),
        i,
        range.label ?? null,
      )
      .run();

    children.push({
      id: childId,
      part_index: i,
      pages: range.pages,
      label: range.label ?? null,
      file_name: fileName,
      file_size: bytes.byteLength,
      scoped: true,
      reason: null,
    });
  }

  const now = new Date().toISOString().replace('T', ' ').substring(0, 19);
  await db
    .prepare(
      `UPDATE processing_queue
          SET packet_split_at = ?, packet_split_by = ?, packet_split_method = ?, packet_part_count = ?
        WHERE id = ?`,
    )
    .bind(now, opts.userId, opts.method, children.length, item.id)
    .run();

  await logAudit(
    db,
    opts.userId,
    item.tenant_id,
    'queue.packet_split',
    'processing_queue',
    item.id,
    JSON.stringify({
      file_name: item.file_name,
      method: opts.method,
      page_count: opts.pageCount,
      parts: children.map((c) => ({ id: c.id, pages: c.pages, label: c.label })),
      duplicate_check: 'skipped',
    }),
    opts.clientIp ?? null,
  );

  return { ok: true, children };
}

/**
 * "Not a packet." Stamped on the item so the card stops asking, and audited so
 * a dismissal is as recoverable a fact as a split: if the detector is wrong
 * often, this is the row that says so.
 */
export async function dismissPacket(
  db: D1Database,
  item: { id: string; tenant_id: string; file_name: string },
  opts: { userId: string; clientIp?: string | null },
): Promise<void> {
  const now = new Date().toISOString().replace('T', ' ').substring(0, 19);
  await db
    .prepare('UPDATE processing_queue SET packet_dismissed_at = ?, packet_dismissed_by = ? WHERE id = ?')
    .bind(now, opts.userId, item.id)
    .run();
  await logAudit(
    db,
    opts.userId,
    item.tenant_id,
    'queue.packet_dismissed',
    'processing_queue',
    item.id,
    JSON.stringify({ file_name: item.file_name }),
    opts.clientIp ?? null,
  );
}
