/**
 * GET /api/orders/:id/send-preview — exactly what Send would do. Sends nothing.
 *
 * The review screen is built from this: who it goes to, every file under the
 * name it will travel under, which email each rides in when they do not fit in
 * one ("1 of N"), which certificates go whole and which only as a per-lot page
 * (and why), which lines will NOT be sent, and whether the order can be sent
 * at all. It is the same plan POST ./send executes (functions/lib/order-send.ts)
 * and it carries a `fingerprint` that Send echoes back, so a person never
 * approves one split and gets another.
 *
 * `user` and above, matching Send: a read-only account cannot send, so it has
 * no review to make.
 */
import { requireRole, errorToResponse } from '../../../lib/permissions';
import { loadOrderForLineWrite, requireOrderAccess } from '../../../lib/order-items';
import { planOrderSend } from '../../../lib/order-send';
import { exitActorForRequest } from '../../../lib/sharing-rule';
import type { Env, User } from '../../../lib/types';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireRole(user, 'super_admin', 'org_admin', 'user');
    const order = await loadOrderForLineWrite(context.env.DB, context.params.id as string);
    requireOrderAccess(user, order);

    const tenant = await context.env.DB.prepare('SELECT name FROM tenants WHERE id = ?')
      .bind(order.tenant_id)
      .first<{ name: string }>();

    const plan = await planOrderSend(context.env.DB, context.env.FILES, {
      order,
      tenantName: tenant?.name ?? 'Documents',
      sender: user,
      actor: await exitActorForRequest(context.env.DB, context.data, user, order.tenant_id),
      emailConfigured: Boolean(context.env.RESEND_API_KEY),
    });
    if (order.staged_at && !plan.preview.blocked) {
      plan.preview.blocked = {
        code: 'order_staged',
        message: 'This order is still waiting for review of what the connector read. Approve it before sending.',
      };
    }
    return json(plan.preview);
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Order send preview error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
};
