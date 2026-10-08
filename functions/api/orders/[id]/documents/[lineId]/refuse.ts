/**
 * POST /api/orders/:id/documents/:lineId/refuse { note } — QA says no to one
 * held document (migration 0138).
 *
 * A NOTE IS REQUIRED: the person who ordered the document reads it on the
 * order, and "refused" with no reason sends them back to QA to ask. The line
 * stays on the order, marked; nothing leaves and nothing is deleted.
 *
 * A QA releaser signed in to the portal. Never an API key, never a read-only
 * account.
 */
import { getClientIp } from '../../../../../lib/db';
import { BadRequestError, errorToResponse } from '../../../../../lib/permissions';
import { loadOrderForLineWrite, requireOrderAccess } from '../../../../../lib/order-items';
import { refuseOrderDocument, requireQaReleaser } from '../../../../../lib/order-document-release';
import type { OrderDocumentRefuseRequest } from '../../../../../../shared/types';
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

    let body: OrderDocumentRefuseRequest;
    try {
      body = (await context.request.json()) as OrderDocumentRefuseRequest;
    } catch {
      throw new BadRequestError('Invalid JSON body');
    }
    await refuseOrderDocument(context.env.DB, {
      order,
      lineId: context.params.lineId as string,
      user,
      note: body?.note,
      clientIp: getClientIp(context.request),
    });
    return json({ success: true });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Refuse order document error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
};
