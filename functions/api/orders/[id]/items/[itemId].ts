/**
 * PUT / DELETE /api/orders/:id/items/:itemId — change or remove one line.
 *
 * PUT edits the line's plain facts (product, code, quantity, lot number) and,
 * through `coa_document_id`, the pick: a document id puts that approved
 * document on the line, `null` takes it off. Both are a person's decision and
 * are recorded as one (functions/lib/order-items.ts).
 *
 * `user` and above, like every other write on an order. Deleting a LINE is not
 * the admin-only act deleting an ORDER is: a person building an order by hand
 * adds a wrong line and must be able to take it back, and the whole row goes
 * into the audit record when they do.
 */
import { getClientIp } from '../../../../lib/db';
import { requireRole, BadRequestError, errorToResponse } from '../../../../lib/permissions';
import {
  loadOrderForLineWrite,
  refuseStaged,
  requireOrderAccess,
  removeLine,
  updateLine,
} from '../../../../lib/order-items';
import type { OrderItemUpdateRequest } from '../../../../../shared/types';
import type { Env, User } from '../../../../lib/types';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

async function writeContext(context: Parameters<PagesFunction<Env>>[0]) {
  const user = context.data.user as User;
  requireRole(user, 'super_admin', 'org_admin', 'user');
  const order = await loadOrderForLineWrite(context.env.DB, context.params.id as string);
  requireOrderAccess(user, order);
  refuseStaged(order);
  return { order, userId: user.id, clientIp: getClientIp(context.request) };
}

export const onRequestPut: PagesFunction<Env> = async (context) => {
  try {
    const ctx = await writeContext(context);
    let body: OrderItemUpdateRequest;
    try {
      body = (await context.request.json()) as OrderItemUpdateRequest;
    } catch {
      throw new BadRequestError('Invalid JSON body');
    }
    if (!body || typeof body !== 'object' || Object.keys(body).length === 0) {
      throw new BadRequestError('No fields to update');
    }
    await updateLine(context.env.DB, ctx, context.params.itemId as string, body);
    return json({ success: true });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Update order item error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
};

export const onRequestDelete: PagesFunction<Env> = async (context) => {
  try {
    const ctx = await writeContext(context);
    await removeLine(context.env.DB, ctx, context.params.itemId as string);
    return json({ success: true });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Delete order item error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
};
