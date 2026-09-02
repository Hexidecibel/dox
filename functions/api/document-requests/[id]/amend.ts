/**
 * POST /api/document-requests/:id/amend — change an issued request WITHOUT
 * destroying what was originally committed.
 *
 * A client requirement, and a general audit-trail rule in their programme:
 * amendments after issue are versioned, not overwritten. Both the original
 * packet and the amended one are preserved, and it applies to a hand-composed
 * request exactly as it does everywhere else.
 *
 * WHAT THIS RETURNS
 * -----------------
 * A NEW request id. The old one keeps working as a read: GET it and you get
 * the packet as it was committed, with `superseded_at` stamped so a reader can
 * tell it is history. `history` on either version lists the whole chain.
 *
 * Callers that hold the old id should follow `history` (or re-GET the root's
 * live version) rather than assuming their id is still current.
 *
 * WHAT SURVIVES THE AMENDMENT
 * ---------------------------
 * Per-line progress. A line already `under_review` in v1 is still
 * `under_review` in v2, matched by requirement (or, for a free-text line, by
 * name — one more small cost of the escape hatch). Otherwise correcting a due
 * date would reset the packet and tell a buyer to chase documents they already
 * have.
 *
 * NOT AN AMENDMENT: a renewal, or a new item under an approved vendor. Those
 * are :id/reissue — a new ask modelled on this one, on its own root. Reusing
 * this root for next year's packet would rewrite this year's record as though
 * it had always been about next year.
 */

import { getClientIp } from '../../../lib/db';
import { errorToResponse } from '../../../lib/permissions';
import {
  amendRequest,
  auditRequest,
  loadRequestDetail,
  requireComposer,
  resolveTenantForRequest,
} from '../../../lib/document-requests';
import type { AmendDocumentRequestRequest } from '../../../../shared/types';
import type { Env, User } from '../../../lib/types';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireComposer(user);

    const id = context.params.id as string;
    const tenantId = await resolveTenantForRequest(context.env.DB, user, id);

    const body = (await context.request.json()) as AmendDocumentRequestRequest;

    const newId = await amendRequest(context.env.DB, tenantId, id, user, body);
    const request = await loadRequestDetail(context.env.DB, tenantId, newId);

    await auditRequest(
      context.env.DB,
      user,
      tenantId,
      'document_request_amended',
      newId,
      {
        supersedes_id: id,
        root_request_id: request.root_request_id,
        version: request.version,
        amendment_reason: request.amendment_reason,
        line_count: request.counts.total,
      },
      getClientIp(context.request),
    );

    return json({ request, supersedes_id: id }, 201);
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Amend document request error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
};
