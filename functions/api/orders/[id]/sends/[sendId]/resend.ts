/**
 * POST /api/orders/:id/sends/:sendId/resend — send again the parts that failed.
 *
 * A send split into several emails can end `partial`: two went, one did not.
 * This sends EXACTLY the ones that did not, rebuilt from the stored record --
 * the same files under the same names, the same recipients, subject and
 * message -- rather than re-planning from an order that may have changed
 * since. Emails that already went are never sent twice.
 *
 * The person who sent it, or an admin; never a read-only account. Counted
 * against the same hourly limit as a send.
 */
import { getClientIp } from '../../../../../lib/db';
import {
  requireRole,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  errorToResponse,
} from '../../../../../lib/permissions';
import { checkRateLimit, recordAttempt } from '../../../../../lib/ratelimit';
import { loadOrderForLineWrite, requireOrderAccess } from '../../../../../lib/order-items';
import {
  ORDER_SEND_RATE_LIMIT_PER_HOUR,
  ORDER_SEND_RATE_WINDOW_SECONDS,
  loadOrderSends,
  resendFailedParts,
} from '../../../../../lib/order-send';
import type { OrderSendResponse } from '../../../../../../shared/types';
import { exitActorForRequest } from '../../../../../lib/sharing-rule';
import type { Env, User } from '../../../../../lib/types';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireRole(user, 'super_admin', 'org_admin', 'user');

    const order = await loadOrderForLineWrite(context.env.DB, context.params.id as string);
    requireOrderAccess(user, order);
    const sendId = context.params.sendId as string;

    const before = (
      await loadOrderSends(context.env.DB, user, { tenantId: order.tenant_id, orderId: order.id })
    ).find((s) => s.id === sendId);
    if (!before) throw new NotFoundError('Send not found');
    if (before.kind === 'qa_release') {
      // A release that failed gave its documents back to the waiting list.
      // The retry is a release, with the rule asked again, not a resend.
      throw new ConflictError(
        'This was a QA release, and it is not resent from here. The documents are waiting for QA again: release them from there.',
      );
    }
    if (before.status === 'sent') {
      throw new ConflictError('Every email of this send already went. There is nothing to resend.');
    }
    if (before.outcome === 'withdrawn' || before.outcome === 'sent_rest_withdrawn') {
      throw new ConflictError(
        'Nothing is left to resend. What did not go was withdrawn: the documents were refused, removed or changed since this send was reviewed.',
      );
    }
    if (!before.can_resend) {
      throw new ForbiddenError('Only the person who sent this, or an administrator, can resend it.');
    }

    if (!context.env.RESEND_API_KEY) {
      return json(
        {
          error: 'Email is not configured for this portal, so nothing was sent.',
          code: 'email_not_configured',
        },
        503,
      );
    }

    const rlKey = `order_send:${user.id}`;
    const rl = await checkRateLimit(
      context.env.DB,
      rlKey,
      ORDER_SEND_RATE_LIMIT_PER_HOUR,
      ORDER_SEND_RATE_WINDOW_SECONDS,
    );
    if (!rl.allowed) {
      return json(
        {
          error: `That is ${ORDER_SEND_RATE_LIMIT_PER_HOUR} sends in an hour, which is the limit. Try again a little later.`,
          code: 'rate_limited',
        },
        429,
      );
    }
    await recordAttempt(context.env.DB, rlKey, ORDER_SEND_RATE_WINDOW_SECONDS);

    const tenant = await context.env.DB.prepare('SELECT name FROM tenants WHERE id = ?')
      .bind(order.tenant_id)
      .first<{ name: string }>();

    // The reply-to stays the ORIGINAL sender's: the customer was told who
    // answers for these documents, and an admin pressing resend does not
    // change that.
    const originalSender = await context.env.DB.prepare('SELECT id, name, email FROM users WHERE id = ?')
      .bind(before.sent_by_id)
      .first<{ id: string; name: string; email: string }>();

    const result = await resendFailedParts(
      {
        db: context.env.DB,
        files: context.env.FILES,
        apiKey: context.env.RESEND_API_KEY,
        origin: new URL(context.request.url).origin,
        tenantName: tenant?.name ?? 'Documents',
        sender: originalSender ?? user,
        order,
        // The rule is asked of whoever is pressing resend, not of the
        // original sender (migration 0137).
        actor: await exitActorForRequest(context.env.DB, context.data, user, order.tenant_id),
        actorUserId: user.id,
      },
      { sendId, tenantId: order.tenant_id, actorId: user.id, clientIp: getClientIp(context.request) },
    );
    if (!result) throw new NotFoundError('Send not found');

    const after = (
      await loadOrderSends(context.env.DB, user, { tenantId: order.tenant_id, orderId: order.id })
    ).find((s) => s.id === sendId)!;
    const response: OrderSendResponse = {
      send: after,
      sent: after.status === 'sent',
      order_status: result.orderStatus ?? order.status,
      // Files left out because the document line they came from no longer
      // asks for them (refused, removed, re-pointed, expired). Said, per file.
      ...(result.notResent.length > 0 ? { not_resent: result.notResent } : {}),
    };
    return json(response);
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Order resend error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
};
