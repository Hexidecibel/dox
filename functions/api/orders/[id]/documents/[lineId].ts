/**
 * DELETE /api/orders/:id/documents/:lineId — take one document line off an
 * order (migration 0138).
 *
 * Any login of the organization, a read-only account included: it is the
 * other half of building the order, and a person who added a line for the
 * wrong supplier must be able to take it back. EXCEPT that a read-only
 * account may not remove a line that is waiting for QA, being released, or
 * released (403): that would pull a document out from under QA's review, or
 * erase a release from the order. Anybody who may send still can. The whole line goes into the
 * audit record. A line of another order, or of another organization, is a 404.
 */
import { getClientIp } from '../../../../lib/db';
import { errorToResponse } from '../../../../lib/permissions';
import { loadOrderForLineWrite, refuseStaged, requireOrderAccess } from '../../../../lib/order-items';
import { removeDocumentLine } from '../../../../lib/order-documents';
import type { Env, User } from '../../../../lib/types';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

export const onRequestDelete: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const order = await loadOrderForLineWrite(context.env.DB, context.params.id as string);
    requireOrderAccess(user, order);
    refuseStaged(order);
    await removeDocumentLine(
      context.env.DB,
      { order, userId: user.id, clientIp: getClientIp(context.request), role: user.role },
      context.params.lineId as string,
    );
    return json({ success: true });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Remove order document error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
};
