/**
 * POST /api/queue/:id/packet/split
 *
 * The reviewer said yes. Carve the file into the ranges they confirmed — or the
 * ranges they edited — and make one queue item per part.
 *
 * CONFIRM AND ADJUST ARE THE SAME ENDPOINT, deliberately. "Split into 26
 * documents" is this call with the proposal's own ranges; "Adjust" is this call
 * with the reviewer's. There is no second code path for the edited case,
 * because a second path is how the checked ranges and the unchecked ranges end
 * up validated differently. What separates them is one recorded fact: `method`
 * is the detector's when the ranges match the proposal and 'adjusted' when they
 * do not, and that is the only feedback the detector ever gets.
 *
 * NOTHING RUNS WITHOUT A PROPOSAL. A split needs to know how many pages the
 * file has, and the honest source of that is the detection pass that read it.
 * Splitting a file nothing was ever proposed for would mean validating ranges
 * against a page count nobody measured, and `extractRecordPdf` silently drops
 * out-of-range pages — so a "part" could come out holding fewer pages than the
 * reviewer asked for, with nothing to say so.
 */

import { getClientIp } from '../../../../lib/db';
import {
  requireRole,
  requireTenantAccess,
  NotFoundError,
  BadRequestError,
  errorToResponse,
} from '../../../../lib/permissions';
import type { Env, User } from '../../../../lib/types';
import { splitPacket, type PacketParentItem } from '../../../../lib/packet-split';
import { parseProposal } from '../packet';
import type { PacketRangeInput } from '../../../../../shared/packetDetect';

interface Body {
  /** The ranges to carve. Omit to confirm the proposal exactly as it stands. */
  parts?: { pages: [number, number]; label?: string | null }[];
}

function sameAsProposal(
  parts: PacketRangeInput[],
  proposed: { pages: [number, number] }[],
): boolean {
  if (parts.length !== proposed.length) return false;
  return parts.every((p, i) => p.pages[0] === proposed[i].pages[0] && p.pages[1] === proposed[i].pages[1]);
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const queueId = context.params.id as string;
    // A reader may SEE that a file is a packet (GET /packet) and may not change
    // what it is. Splitting creates queue items and spends extraction time.
    requireRole(user, 'super_admin', 'org_admin', 'user');

    const item = await context.env.DB.prepare(
      `SELECT pq.id, pq.tenant_id, pq.file_r2_key, pq.file_name, pq.mime_type, pq.document_type_id,
              pq.supplier_id, pq.source, pq.source_detail, pq.output_kind, pq.source_id,
              pq.connector_run_id, pq.status, pq.packet_proposal, pq.packet_split_at,
              pq.packet_parent_id, t.slug AS tenant_slug
         FROM processing_queue pq
         JOIN tenants t ON t.id = pq.tenant_id
        WHERE pq.id = ?`,
    )
      .bind(queueId)
      .first<PacketParentItem & { status: string; packet_proposal: string | null; packet_parent_id: string | null }>();

    if (!item) throw new NotFoundError('Queue item not found');
    requireTenantAccess(user, item.tenant_id);

    if (item.status !== 'pending') {
      throw new BadRequestError(`This item is already ${item.status} — a decided item is not split.`);
    }
    if (item.packet_split_at) {
      throw new BadRequestError('This file has already been split into parts.');
    }
    // A part of a packet is not itself split further. One level is what the
    // proposal shape and the review card describe, and a tree of containers
    // would give a document two parents to be approved under.
    if (item.packet_parent_id) {
      throw new BadRequestError('This item is already one part of a split file.');
    }

    const proposal = parseProposal(item.packet_proposal);
    if (!proposal || !proposal.looksLikePacket) {
      throw new BadRequestError('Nothing proposed a split for this file.');
    }

    const body = (await context.request.json().catch(() => ({}))) as Body;
    const ranges: PacketRangeInput[] = Array.isArray(body.parts) && body.parts.length
      ? body.parts.map((p) => ({ pages: p.pages, label: p.label ?? null }))
      : proposal.parts.map((p) => ({ pages: p.pages, label: p.label }));

    const method = sameAsProposal(ranges, proposal.parts) ? (proposal.method || 'heuristic') : 'adjusted';

    const result = await splitPacket(context.env.DB, context.env.FILES, item, ranges, {
      userId: user.id,
      method,
      pageCount: proposal.page_count,
      clientIp: getClientIp(context.request),
    });

    if (!result.ok) {
      const f = result.failure;
      const message =
        f.kind === 'invalid_ranges'
          ? `Those page ranges do not work: ${describeRangeError(f.error)}`
          : f.kind === 'carve_failed'
            ? `Part ${f.index + 1} could not be cut out of the PDF (${f.reason}). Nothing was split.`
            : f.kind === 'file_missing'
              ? 'The original file is no longer in storage.'
              : f.kind === 'not_pdf'
                ? 'Only a PDF can be split into page ranges.'
                : 'This file has already been split into parts.';
      throw new BadRequestError(message);
    }

    return new Response(
      JSON.stringify({ parent_id: item.id, method, children: result.children }),
      { status: 201, headers: { 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Packet split error:', err);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

function describeRangeError(e: { kind: string; index?: number; pageCount?: number; count?: number; max?: number }): string {
  switch (e.kind) {
    case 'no_parts': return 'there are no parts';
    case 'bad_range': return `part ${(e.index ?? 0) + 1} ends before it starts`;
    case 'out_of_range': return `part ${(e.index ?? 0) + 1} is outside the file's ${e.pageCount} pages`;
    case 'overlap': return `part ${(e.index ?? 0) + 1} overlaps the part before it`;
    case 'too_many': return `${e.count} parts, over the ${e.max} a single split may produce`;
    default: return e.kind;
  }
}
