/**
 * POST /api/request-uploads/:id/decide — say what a supplier's file satisfies.
 *
 * Body: { decisions: [{ line_id, decision, document_id?, status_note?, attention_reason? }] }
 *
 * `line_id` is a line on the CURRENT version of the request; claims made
 * against an older version are matched by line identity. A line the supplier
 * did not tick may be decided too — that records a staff claim.
 *
 *   accepted          requires the file to be approved in the Review Queue
 *                     first (409 otherwise). Names the document it was accepted
 *                     from, and confirms the registry link for a typed line.
 *                     A human `rejected` link is never overridden (409, nothing
 *                     written).
 *   needs_attention   allowed at any stage. `attention_reason` is what the
 *                     supplier reads; `status_note` never leaves the portal.
 *
 * ROLE GATE: `requireLineWorker` — super_admin, org_admin, user. Moving a line
 * is the assigned buyer doing their job; a reader cannot. The same gate as
 * PUT /api/request-lines/:id, which stays available as the escape hatch.
 *
 * No email goes to the supplier from here. They see the outcome, and the
 * reason, the next time they open their link.
 *
 * All the logic lives in `decideArrival` (functions/lib/request-arrivals.ts).
 */

import { getClientIp } from '../../../lib/db';
import { errorToResponse } from '../../../lib/permissions';
import { requireLineWorker } from '../../../lib/document-requests';
import { decideArrival, resolveTenantForUpload } from '../../../lib/request-arrivals';
import type { DecideArrivalRequest } from '../../../../shared/types';
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
    requireLineWorker(user);

    const id = context.params.id as string;
    const tenantId = await resolveTenantForUpload(context.env.DB, user, id);

    let body: DecideArrivalRequest;
    try {
      body = (await context.request.json()) as DecideArrivalRequest;
    } catch {
      return json({ error: 'Invalid JSON body' }, 400);
    }

    const result = await decideArrival(
      context.env.DB,
      user,
      tenantId,
      id,
      body?.decisions,
      getClientIp(context.request),
    );
    return json(result);
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Decide request upload error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
};
