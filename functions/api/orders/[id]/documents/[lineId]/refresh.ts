/**
 * POST /api/orders/:id/documents/:lineId/refresh — resolve one document line
 * again (migration 0138).
 *
 * A line holds the document that was current when it was added. Nothing
 * re-resolves it behind the person's back: when a newer document arrives the
 * order page says so, and this is how they take it. If the answer is a
 * different document, whatever was decided about the old one (a release, a
 * refusal, a notice to QA) is cleared, because it was about that document.
 *
 * Any login of the organization, like adding and removing -- with the same
 * exception: a read-only account may not refresh a line that is waiting for
 * QA, being released, or released (403), because a refresh that lands on a
 * different document resets all of that.
 */
import { getClientIp } from '../../../../../lib/db';
import { errorToResponse } from '../../../../../lib/permissions';
import { loadOrderForLineWrite, refuseStaged, requireOrderAccess } from '../../../../../lib/order-items';
import { loadJudgedLinesById, refreshDocumentLine } from '../../../../../lib/order-documents';
import { exitActorForRequest } from '../../../../../lib/sharing-rule';
import type { Env, User } from '../../../../../lib/types';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const order = await loadOrderForLineWrite(context.env.DB, context.params.id as string);
    requireOrderAccess(user, order);
    refuseStaged(order);
    const lineId = context.params.lineId as string;
    const result = await refreshDocumentLine(
      context.env.DB,
      { order, userId: user.id, clientIp: getClientIp(context.request), role: user.role },
      lineId,
    );
    const actor = await exitActorForRequest(context.env.DB, context.data, user, order.tenant_id);
    const [line] = await loadJudgedLinesById(context.env.DB, order.tenant_id, order.id, [lineId], actor);
    return json({ changed: result.changed, document: line?.api ?? null });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Refresh order document error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
};
