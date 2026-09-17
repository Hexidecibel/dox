/**
 * GET /api/queue/:id/packet
 *
 * What detection thinks this file is, what a person has decided about it, and —
 * once split — the parts it became.
 *
 * The proposal itself is computed by the extraction worker (it already holds
 * the per-page text and the per-page image measurement the detector wants, so
 * detection costs no extra read of the file) and stored on the queue row. This
 * endpoint only reads it back, which keeps a review-screen render off the PDF
 * parsing path entirely.
 *
 * Reading is open to every role that can see the queue, INCLUDING `reader`:
 * knowing that a file holds twenty-five documents is not a privileged fact, and
 * a reader who can see the card should not be told less about it than the
 * person next to them. Acting on it is not — see packet/split.ts.
 */

import {
  requireRole,
  requireTenantAccess,
  NotFoundError,
  errorToResponse,
} from '../../../lib/permissions';
import type { Env, User } from '../../../lib/types';
import type { PacketProposal } from '../../../../shared/packetDetect';
import type { QueuePacketView, QueuePacketChild } from '../../../../shared/types';

interface PacketRow {
  id: string;
  tenant_id: string;
  file_name: string;
  packet_proposal: string | null;
  packet_dismissed_at: string | null;
  packet_dismissed_by: string | null;
  packet_split_at: string | null;
  packet_split_by: string | null;
  packet_split_method: string | null;
  packet_part_count: number | null;
  packet_parent_id: string | null;
  packet_pages: string | null;
  packet_part_index: number | null;
  packet_part_label: string | null;
}

export const PACKET_COLUMNS =
  'packet_proposal, packet_dismissed_at, packet_dismissed_by, packet_split_at, packet_split_by, ' +
  'packet_split_method, packet_part_count, packet_parent_id, packet_pages, packet_part_index, packet_part_label';

/** The stored proposal, or null when it is absent or unreadable. */
export function parseProposal(raw: string | null | undefined): PacketProposal | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as PacketProposal;
    return parsed && Array.isArray(parsed.parts) ? parsed : null;
  } catch {
    // A column that will not parse is a column that says nothing. It must not
    // take the review card down with it.
    return null;
  }
}

/** `[from, to]` from the child's stored range, or null. */
export function parsePages(raw: string | null | undefined): [number, number] | null {
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as number[];
    if (Array.isArray(p) && p.length === 2 && Number.isInteger(p[0]) && Number.isInteger(p[1])) {
      return [p[0], p[1]];
    }
  } catch { /* fall through */ }
  return null;
}

export async function loadPacketView(db: D1Database, row: PacketRow): Promise<QueuePacketView> {
  const children = row.packet_split_at
    ? await db
        .prepare(
          `SELECT pq.id, pq.file_name, pq.packet_pages, pq.packet_part_index, pq.packet_part_label,
                  pq.status, pq.processing_status, pq.document_type_id, dt.name AS document_type_name
             FROM processing_queue pq
             LEFT JOIN document_types dt ON dt.id = pq.document_type_id
            WHERE pq.packet_parent_id = ?
            ORDER BY pq.packet_part_index ASC`,
        )
        .bind(row.id)
        .all<{
          id: string;
          file_name: string;
          packet_pages: string | null;
          packet_part_index: number | null;
          packet_part_label: string | null;
          status: string;
          processing_status: string;
          document_type_id: string | null;
          document_type_name: string | null;
        }>()
    : { results: [] as never[] };

  const parent = row.packet_parent_id
    ? await db
        .prepare('SELECT id, file_name FROM processing_queue WHERE id = ?')
        .bind(row.packet_parent_id)
        .first<{ id: string; file_name: string }>()
    : null;

  return {
    queue_id: row.id,
    proposal: parseProposal(row.packet_proposal),
    dismissed_at: row.packet_dismissed_at,
    split_at: row.packet_split_at,
    split_method: row.packet_split_method,
    part_count: row.packet_part_count,
    parent: parent ? { id: parent.id, file_name: parent.file_name } : null,
    part_of_pages: parsePages(row.packet_pages),
    part_index: row.packet_part_index,
    part_label: row.packet_part_label,
    children: (children.results ?? []).map(
      (c): QueuePacketChild => ({
        id: c.id,
        file_name: c.file_name,
        pages: parsePages(c.packet_pages),
        part_index: c.packet_part_index,
        label: c.packet_part_label,
        status: c.status,
        processing_status: c.processing_status,
        document_type_id: c.document_type_id,
        document_type_name: c.document_type_name,
      }),
    ),
  };
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const queueId = context.params.id as string;
    requireRole(user, 'super_admin', 'org_admin', 'user', 'reader');

    const row = await context.env.DB.prepare(
      `SELECT id, tenant_id, file_name, ${PACKET_COLUMNS} FROM processing_queue WHERE id = ?`,
    )
      .bind(queueId)
      .first<PacketRow>();
    if (!row) throw new NotFoundError('Queue item not found');
    requireTenantAccess(user, row.tenant_id);

    const view = await loadPacketView(context.env.DB, row);
    return new Response(JSON.stringify(view), { headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Packet view error:', err);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
