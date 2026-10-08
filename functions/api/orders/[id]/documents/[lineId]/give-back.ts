/**
 * POST /api/orders/:id/documents/:lineId/give-back — put a release that DID
 * NOT FINISH back in the waiting list (migration 0138, decision C-063).
 *
 * A release is claimed (`releasing`) before its mail is sent and becomes
 * `released` only once the mail went and the record was written. If the Worker
 * died in between, the line stays `releasing`: it is shown as "release did not
 * finish", never as sent. This withdraws whatever link that attempt minted,
 * marks its record as not finished, and returns the line to `pending_qa`.
 * (Pressing Release on such a line does the same and then releases it.)
 *
 * Only a line that has been `releasing` for longer than a release takes; one
 * in progress answers 409. A QA releaser signed in, never an API key.
 */
import { getClientIp } from '../../../../../lib/db';
import { errorToResponse } from '../../../../../lib/permissions';
import { loadOrderForLineWrite, requireOrderAccess } from '../../../../../lib/order-items';
import { giveBackUnfinishedRelease, requireQaReleaser } from '../../../../../lib/order-document-release';
import type { Env, User } from '../../../../../lib/types';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const order = await loadOrderForLineWrite(context.env.DB, context.params.id as string);
    requireOrderAccess(user, order);
    await requireQaReleaser(context.env.DB, context.data, user, order.tenant_id);
    await giveBackUnfinishedRelease(context.env.DB, {
      order,
      lineId: context.params.lineId as string,
      user,
      clientIp: getClientIp(context.request),
    });
    return json({ success: true });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Give back order document error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
};
