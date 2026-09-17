/**
 * POST /api/queue/:id/packet/dismiss
 *
 * "Not a packet." The third action on the card, and the one that has to exist
 * for the other two to be trustworthy: a question a reviewer cannot answer NO
 * to is a question they learn to scroll past, and a detector whose false alarms
 * cannot be recorded is a detector nobody can measure.
 *
 * Remembered on the item, so the card never asks about this file again. It does
 * NOT reject the item, does not touch its extraction and does not change what a
 * reviewer can do next — the ordinary single-document flow continues exactly as
 * if nothing had been proposed.
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
import { dismissPacket } from '../../../../lib/packet-split';

export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const queueId = context.params.id as string;
    requireRole(user, 'super_admin', 'org_admin', 'user');

    const item = await context.env.DB.prepare(
      'SELECT id, tenant_id, file_name, packet_split_at, packet_dismissed_at FROM processing_queue WHERE id = ?',
    )
      .bind(queueId)
      .first<{
        id: string;
        tenant_id: string;
        file_name: string;
        packet_split_at: string | null;
        packet_dismissed_at: string | null;
      }>();

    if (!item) throw new NotFoundError('Queue item not found');
    requireTenantAccess(user, item.tenant_id);
    if (item.packet_split_at) {
      throw new BadRequestError('This file has already been split into parts.');
    }
    // Dismissing twice is not an error — the second one changes nothing and
    // saying so would only make a double-click look like a failure.
    if (!item.packet_dismissed_at) {
      await dismissPacket(context.env.DB, item, { userId: user.id, clientIp: getClientIp(context.request) });
    }

    return new Response(JSON.stringify({ dismissed: true }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Packet dismiss error:', err);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
