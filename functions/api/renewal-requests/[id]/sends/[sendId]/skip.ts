/**
 * POST /api/renewal-requests/:id/sends/:sendId/skip
 *
 * A person decides this stage should NOT go to the supplier ("they told me on
 * the phone it is coming"). Same authority as approving: the assigned
 * approver or an administrator. Nothing is sent and the cycle stays open, so
 * the next stage is still drafted when its day comes -- skipping one reminder
 * is not the same as ending the chase. Audited `renewal_request.skipped`.
 */

import { getClientIp } from '../../../../../lib/db';
import { errorToResponse } from '../../../../../lib/permissions';
import {
  listRenewalRequests,
  resolveTenantForRenewalRequest,
  skipRenewalSend,
} from '../../../../../lib/renewal-requests';
import type { Env, User } from '../../../../../lib/types';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const cycleId = context.params.id as string;
    const tenantId = await resolveTenantForRenewalRequest(context.env.DB, user, cycleId);

    await skipRenewalSend(context.env.DB, user, {
      tenantId,
      cycleId,
      sendId: context.params.sendId as string,
      ip: getClientIp(context.request),
    });

    const [request] = await listRenewalRequests(context.env.DB, tenantId, user, { id: cycleId });
    return json({ skipped: true, request });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Skip renewal request error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
};
