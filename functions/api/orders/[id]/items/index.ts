/**
 * POST /api/orders/:id/items — put lines on an order by hand.
 *
 * Two bodies, and a request may carry both:
 *
 *   { document_ids: [...] }  pick approved documents; one line per lot row of
 *                            each, written the way an accepted suggestion is
 *                            (see functions/lib/order-items.ts).
 *   { item: {...} }          one typed line with no document yet -- a product
 *                            and/or a lot number. A typed lot is resolved and
 *                            the matcher is asked for certificates, which come
 *                            back as suggestions like any other.
 *
 * `user` and above: a read-only account does not build orders. A document
 * that may not go on the order (another organization's, archived, deleted, no
 * file) is REPORTED in `refused` and the rest still land -- one bad id in a
 * selection of twelve must not lose the other eleven, and must not be silent.
 */
import { getClientIp } from '../../../../lib/db';
import { requireRole, BadRequestError, errorToResponse } from '../../../../lib/permissions';
import {
  addTypedLine,
  loadOrderForLineWrite,
  pickDocumentsOntoOrder,
  refuseStaged,
  requireOrderAccess,
} from '../../../../lib/order-items';
import type { OrderItemsAddRequest, OrderItemsAddResponse } from '../../../../../shared/types';
import type { Env, User } from '../../../../lib/types';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireRole(user, 'super_admin', 'org_admin', 'user');

    const order = await loadOrderForLineWrite(context.env.DB, context.params.id as string);
    requireOrderAccess(user, order);
    refuseStaged(order);

    let body: OrderItemsAddRequest;
    try {
      body = (await context.request.json()) as OrderItemsAddRequest;
    } catch {
      throw new BadRequestError('Invalid JSON body');
    }
    const hasPicks = Array.isArray(body.document_ids) && body.document_ids.length > 0;
    const hasItem = !!body.item && typeof body.item === 'object';
    if (!hasPicks && !hasItem) {
      throw new BadRequestError('Send document_ids to pick documents, or item to type a line.');
    }

    const ctx = { order, userId: user.id, clientIp: getClientIp(context.request) };
    const response: OrderItemsAddResponse = { results: [], refused: [] };
    if (hasItem) response.item_id = await addTypedLine(context.env.DB, ctx, body.item!);
    if (hasPicks) {
      const picked = await pickDocumentsOntoOrder(context.env.DB, ctx, body.document_ids);
      response.results = picked.results;
      response.refused = picked.refused;
    }

    // Every pick refused and nothing typed: nothing was written, and that is
    // an error the caller must see rather than a 201 with an empty list.
    if (!hasItem && response.results.length === 0) {
      return json({ error: response.refused[0]?.reason ?? 'Nothing was added.', ...response }, 400);
    }
    return json(response, 201);
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Add order items error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
};
