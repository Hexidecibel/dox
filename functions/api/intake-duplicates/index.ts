/**
 * GET /api/intake-duplicates — files that arrived again (migration 0108).
 *
 * An arrival byte-identical to a file already approved, or to one still
 * waiting in the Review Queue, is recorded here instead of becoming a second
 * review card. This is where those records are read:
 *
 *   ?state=open|reviewed|all   open = not sent for review (default all)
 *   ?document_id=<id>          everything received again that is this document
 *                              (the document page's "Received again" list)
 *   ?matched_queue_id=<id>     arrivals recorded against one waiting item
 *   ?tenant_id=<id>            super_admin only; omitted = every tenant
 *   ?limit= (max 200) ?offset=
 *
 * READING IS OPEN TO EVERY ROLE IN THE TENANT (a reader can see the document
 * page this feeds). Sending one for review is not — see ./[id]/review.ts.
 * The file itself is never served from here and `file_r2_key` is never
 * selected.
 */

import { errorToResponse, requireTenantAccess } from '../../lib/permissions';
import { listIntakeDuplicates } from '../../lib/intake/duplicate-ledger';
import type { IntakeDuplicateListResponse } from '../../../shared/types';
import type { Env, User } from '../../lib/types';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const url = new URL(context.request.url);

    let tenantId: string | null = url.searchParams.get('tenant_id');
    if (user.role !== 'super_admin') {
      tenantId = user.tenant_id;
      if (!tenantId) return json({ error: 'Forbidden' }, 403);
    } else if (tenantId) {
      requireTenantAccess(user, tenantId);
    }

    const stateParam = url.searchParams.get('state');
    const state = stateParam === 'open' || stateParam === 'reviewed' ? stateParam : 'all';
    const limitRaw = parseInt(url.searchParams.get('limit') || '50', 10);
    const offsetRaw = parseInt(url.searchParams.get('offset') || '0', 10);
    const limit = Math.min(Math.max(Number.isFinite(limitRaw) ? limitRaw : 50, 1), 200);
    const offset = Math.max(Number.isFinite(offsetRaw) ? offsetRaw : 0, 0);

    const result = await listIntakeDuplicates(context.env.DB, {
      tenantId,
      documentId: url.searchParams.get('document_id'),
      matchedQueueId: url.searchParams.get('matched_queue_id'),
      state,
      limit,
      offset,
    });

    const body: IntakeDuplicateListResponse = { ...result, limit, offset };
    return json(body);
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('List intake duplicates error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
};
