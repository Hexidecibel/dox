/**
 * POST /api/intake-duplicates/:id/review — "Review anyway" (migration 0108).
 *
 * Puts a file that was recorded as received again in front of a reviewer
 * after all: the exact enqueue call its door made is replayed with the
 * duplicate check skipped, the record is stamped with who sent it and when,
 * and the action is audited (`intake_duplicate.review_anyway`). Logic and the
 * supplier-portal handling: functions/lib/intake/duplicate-ledger.ts.
 *
 * 409 if it was already sent for review; 410 if the stored file is gone.
 * ROLE GATE: the Review Queue's own — super_admin, org_admin, user.
 */

import { getClientIp } from '../../../lib/db';
import { errorToResponse, requireRole } from '../../../lib/permissions';
import { GoneError, reviewIntakeDuplicateAnyway } from '../../../lib/intake/duplicate-ledger';
import type { IntakeDuplicateReviewResponse } from '../../../../shared/types';
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
    requireRole(user, 'super_admin', 'org_admin', 'user');
    const tenantId = user.role === 'super_admin' ? null : user.tenant_id;
    if (user.role !== 'super_admin' && !tenantId) return json({ error: 'Forbidden' }, 403);

    const { duplicate, queueId } = await reviewIntakeDuplicateAnyway(context.env.DB, context.env.FILES, {
      id: context.params.id as string,
      tenantId,
      userId: user.id,
      ip: getClientIp(context.request),
    });
    const body: IntakeDuplicateReviewResponse = { duplicate, queue_id: queueId };
    return json(body);
  } catch (err) {
    if (err instanceof GoneError) return json({ error: err.message }, 410);
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Review intake duplicate error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
};
