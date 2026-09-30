/**
 * Packet provenance at approval (rules table H1, AJ ruled 2026-09-20).
 *
 *   "Packet splitting is human-confirmed. The original packet stays on record
 *    as received, and each split part cites the packet it came from and its
 *    page range. A reviewer must be able to walk from any single document back
 *    to what the supplier actually sent."
 *
 * 0118 built the split and kept the packet (the parent queue item keeps its
 * file and cannot be approved). What was missing was the second half: an
 * approved part became a document with no citation at all. This module writes
 * it -- `document_versions.source_packet_queue_id` + a frozen `source_packet`
 * (migration 0126) -- for every document an approval of a packet PART
 * produced, whichever approve path produced it.
 *
 * It also answers WHEN a part arrived. A part's queue row is created at SPLIT
 * time, which can be days after the packet reached us; `documents.arrived_at`
 * (0121, G4) must be the packet's arrival or a certificate that lapsed while
 * the packet waited in OUR queue is blamed on the supplier -- the exact case
 * 0121 exists to prevent. `arrivalForQueueItem` returns the packet's day.
 *
 * NEVER THROWS UPWARD. The approval has happened and stands; a citation that
 * cannot be written is logged, not raised.
 */

import { logAudit } from './db';
import type { PacketCitation } from '../../shared/types';

export type { PacketCitation };

interface PacketChildRow {
  id: string;
  tenant_id: string;
  packet_parent_id?: string | null;
  packet_pages?: string | null;
  packet_part_index?: number | null;
  packet_part_label?: string | null;
  created_at?: string | null;
}

interface PacketParentRow {
  id: string;
  file_name: string;
  created_at: string | null;
  checksum: string | null;
  packet_split_at: string | null;
  packet_split_by: string | null;
  packet_split_method: string | null;
  packet_part_count: number | null;
  packet_proposal: string | null;
}

function parsePages(raw: string | null | undefined): [number, number] | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    if (Array.isArray(v) && v.length === 2 && v.every((n) => Number.isInteger(n))) {
      return [Number(v[0]), Number(v[1])];
    }
  } catch {
    /* fall through */
  }
  return null;
}

function proposalPageCount(raw: string | null): number | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as { page_count?: unknown };
    return typeof v.page_count === 'number' ? v.page_count : null;
  } catch {
    return null;
  }
}

async function loadParent(db: D1Database, child: PacketChildRow): Promise<PacketParentRow | null> {
  if (!child.packet_parent_id) return null;
  return db
    .prepare(
      `SELECT id, file_name, created_at, checksum, packet_split_at, packet_split_by,
              packet_split_method, packet_part_count, packet_proposal
         FROM processing_queue
        WHERE id = ? AND tenant_id = ?`
    )
    .bind(child.packet_parent_id, child.tenant_id)
    .first<PacketParentRow>();
}

/** Pure: the citation for one part, from the child row and its packet. */
export function buildPacketCitation(child: PacketChildRow, parent: PacketParentRow): PacketCitation {
  return {
    queue_id: parent.id,
    file_name: parent.file_name,
    received_at: parent.created_at ?? null,
    checksum: parent.checksum ?? null,
    page_count: proposalPageCount(parent.packet_proposal),
    pages: parsePages(child.packet_pages),
    part_number: typeof child.packet_part_index === 'number' ? child.packet_part_index + 1 : null,
    part_count: parent.packet_part_count ?? null,
    part_label: child.packet_part_label ?? null,
    split_at: parent.packet_split_at ?? null,
    split_by: parent.packet_split_by ?? null,
    split_method: parent.packet_split_method ?? null,
  };
}

/**
 * The day a queue item's file reached us. For a packet PART that is the
 * packet's day, not the split's; for everything else, the item's own.
 */
export async function arrivalForQueueItem(db: D1Database, item: PacketChildRow): Promise<string | null> {
  if (!item.packet_parent_id) return item.created_at ?? null;
  try {
    const parent = await loadParent(db, item);
    return parent?.created_at ?? item.created_at ?? null;
  } catch (err) {
    console.error('[packet-provenance] arrival lookup failed:', err instanceof Error ? err.message : String(err));
    return item.created_at ?? null;
  }
}

/**
 * Stamp the citation onto the CURRENT version of each document an approval of
 * a packet part produced. Only versions with no citation yet are touched, so
 * a re-run is a no-op and nothing already cited is rewritten.
 */
export async function recordPacketProvenance(
  db: D1Database,
  item: PacketChildRow,
  documentIds: string[],
  actorUserId: string
): Promise<PacketCitation | null> {
  if (!item.packet_parent_id || documentIds.length === 0) return null;
  try {
    const parent = await loadParent(db, item);
    if (!parent) return null;
    const citation = buildPacketCitation(item, parent);
    const json = JSON.stringify(citation);
    await db.batch(
      documentIds.map((docId) =>
        db
          .prepare(
            `UPDATE document_versions
                SET source_packet_queue_id = ?, source_packet = ?
              WHERE document_id = ?
                AND source_packet IS NULL
                AND version_number = (SELECT current_version FROM documents WHERE id = ? AND tenant_id = ?)`
          )
          .bind(parent.id, json, docId, docId, item.tenant_id)
      )
    );
    for (const docId of documentIds) {
      await logAudit(
        db,
        actorUserId,
        item.tenant_id,
        'document.packet_source_recorded',
        'document',
        docId,
        JSON.stringify({ queue_item_id: item.id, ...citation }),
        null
      );
    }
    return citation;
  } catch (err) {
    console.error('[packet-provenance] citation not written:', err instanceof Error ? err.message : String(err));
    return null;
  }
}
