/**
 * GET / POST /api/orders/:id/documents — the document lines of an order
 * (migration 0138).
 *
 * POST { items: [{ product_id, supplier_id }], document_type_ids, dry_run? }
 * puts one line on the order per (item, supplier, type), each resolved to the
 * supplier's current approved document of that type. `dry_run: true` writes
 * nothing and answers what WOULD resolve, which is what the "Add documents for
 * items" dialog shows before the person commits.
 *
 * ANY LOGIN, A READ-ONLY ACCOUNT INCLUDED (AJ: "any user with a portal login
 * can build the order"). Building moves nothing out of the portal; sending
 * keeps its own bar (POST ./send, `user` and above), and the sharing rule is
 * asked there, live.
 *
 * APPROVED PAIRS ONLY. A pair that is pending or not approved is not added,
 * and is named in `refused` with the reason; the rest still land.
 */
import { getClientIp } from '../../../../lib/db';
import { BadRequestError, errorToResponse } from '../../../../lib/permissions';
import { loadOrderForLineWrite, refuseStaged, requireOrderAccess } from '../../../../lib/order-items';
import { addDocumentLines, loadOrderDocuments } from '../../../../lib/order-documents';
import { exitActorForRequest } from '../../../../lib/sharing-rule';
import type { OrderDocumentsAddRequest } from '../../../../../shared/types';
import type { Env, User } from '../../../../lib/types';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const order = await loadOrderForLineWrite(context.env.DB, context.params.id as string);
    requireOrderAccess(user, order);
    const actor = await exitActorForRequest(context.env.DB, context.data, user, order.tenant_id);
    return json({ documents: await loadOrderDocuments(context.env.DB, order.tenant_id, order.id, actor) });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('List order documents error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
};

export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const order = await loadOrderForLineWrite(context.env.DB, context.params.id as string);
    requireOrderAccess(user, order);
    refuseStaged(order);

    let body: OrderDocumentsAddRequest;
    try {
      body = (await context.request.json()) as OrderDocumentsAddRequest;
    } catch {
      throw new BadRequestError('Invalid JSON body');
    }
    if (!body || typeof body !== 'object') throw new BadRequestError('Invalid JSON body');

    const response = await addDocumentLines(
      context.env.DB,
      { order, userId: user.id, clientIp: getClientIp(context.request) },
      body,
    );

    if (response.dry_run) return json(response);
    // Everything asked for was refused: nothing was written, and that is an
    // error the caller must see rather than a 201 with an empty list.
    if (response.lines.length === 0) {
      return json({ error: response.refused[0]?.reason ?? 'Nothing was added.', ...response }, 400);
    }
    const wrote = response.lines.some((l) => l.outcome === 'added');
    return json(response, wrote ? 201 : 200);
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Add order documents error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
};
