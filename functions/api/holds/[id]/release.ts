/**
 * POST /api/holds/:id/release -- release a hold: `{ reason }`.
 *
 * Decision C-005, migration 0139. THE ONLY WAY A HOLD ENDS. A QA releaser
 * (`canReleaseQa`, the sharing rule's ladder) or an administrator, signed in,
 * with a written reason. Never an API key, never a read-only account.
 *
 * Sending a held certificate does not release it, a QA release of an order
 * line does not release it, and replacing the file does not release it.
 *
 * A hold of another organization is a 404 before any other check. A hold
 * already released is a 409: it is stamped once.
 */
import { NotFoundError, errorToResponse } from '../../../lib/permissions';
import { getClientIp } from '../../../lib/db';
import { releaseHold } from '../../../lib/holds';
import type { ReleaseHoldRequest } from '../../../../shared/types';
import type { Env, User } from '../../../lib/types';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const holdId = context.params.id as string;
    const row = await context.env.DB
      .prepare('SELECT tenant_id FROM document_holds WHERE id = ?')
      .bind(holdId)
      .first<{ tenant_id: string }>();
    if (!row || (user.role !== 'super_admin' && user.tenant_id !== row.tenant_id)) {
      throw new NotFoundError('Hold not found');
    }
    let body: ReleaseHoldRequest;
    try {
      body = (await context.request.json()) as ReleaseHoldRequest;
    } catch {
      return json({ error: 'Send a JSON body with a reason.' }, 400);
    }
    const hold = await releaseHold(context.env.DB, {
      tenantId: row.tenant_id,
      holdId,
      reason: body?.reason,
      user,
      data: context.data,
      clientIp: getClientIp(context.request),
    });
    return json({ hold });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Release hold error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
};
