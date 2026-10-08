/**
 * POST /api/orders/:id/send — mail an order's documents to the customer.
 *
 * WHY ATTACHMENTS HERE, WHEN THE SEARCH EXPORT MAILS A LINK. The search export
 * (../../document-exports/send.ts) hands an arbitrary selection to an
 * arbitrary address, and a link is what can be counted and withdrawn. This is
 * a different act: a customer's certificates for the lots they were shipped.
 * AJ's ruling is that the customer receives an exact copy ATTACHED -- a
 * certificate that stops opening after thirty days is not a certificate a
 * customer can file. Only a single file too large for any email goes as a
 * link, and that link does not expire.
 *
 * WHO. `user` and above -- any account except a read-only one (AJ: "any user
 * sends"). From "<Organization> via SupDox", reply-to the person who pressed
 * send; the portal's address never changes and nobody's domain is borrowed.
 *
 * WHAT IS SENT IS WHAT WAS REVIEWED. The plan is recomputed here and compared
 * with the `fingerprint` of the preview the sender read; if a line changed in
 * between, nothing is sent and the caller is told to review again (409).
 *
 * PARTIAL FAILURE IS A STATE, NOT AN ERROR. Each email succeeds or fails on
 * its own. The response is 200 with the full record whenever at least one
 * went; 502 only when none did. The order moves to `delivered` only when
 * every part was accepted.
 */
import { getClientIp } from '../../../lib/db';
import { requireRole, BadRequestError, ConflictError, errorToResponse } from '../../../lib/permissions';
import { checkRateLimit, recordAttempt } from '../../../lib/ratelimit';
import { validateEmail } from '../../../lib/validation';
import { EXPORT_MAX_RECIPIENTS } from '../../../lib/document-export';
import { loadOrderForLineWrite, refuseStaged, requireOrderAccess } from '../../../lib/order-items';
import {
  ORDER_SEND_MAX_MESSAGE_CHARS,
  ORDER_SEND_MAX_SUBJECT_CHARS,
  ORDER_SEND_RATE_LIMIT_PER_HOUR,
  ORDER_SEND_RATE_WINDOW_SECONDS,
  executeOrderSend,
  loadOrderSends,
  planOrderSend,
} from '../../../lib/order-send';
import type { OrderSendRequest, OrderSendResponse } from '../../../../shared/types';
import { exitActorForRequest } from '../../../lib/sharing-rule';
import type { Env, User } from '../../../lib/types';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

export function normalizeOrderRecipients(raw: unknown): { ok: string[]; bad: string[] } {
  const ok: string[] = [];
  const bad: string[] = [];
  const seen = new Set<string>();
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[,;\s]+/) : [];
  for (const v of list) {
    if (typeof v !== 'string') continue;
    const addr = v.trim();
    if (!addr) continue;
    const key = addr.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (validateEmail(addr)) ok.push(addr);
    else bad.push(addr);
  }
  return { ok, bad };
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    // A read-only account reads. Sending a customer their certificates is
    // publishing on the organization's behalf.
    requireRole(user, 'super_admin', 'org_admin', 'user');

    const order = await loadOrderForLineWrite(context.env.DB, context.params.id as string);
    requireOrderAccess(user, order);
    refuseStaged(order);

    let body: OrderSendRequest;
    try {
      body = (await context.request.json()) as OrderSendRequest;
    } catch {
      throw new BadRequestError('Invalid JSON body');
    }

    const tenant = await context.env.DB.prepare('SELECT name FROM tenants WHERE id = ?')
      .bind(order.tenant_id)
      .first<{ name: string }>();
    const tenantName = tenant?.name ?? 'Documents';

    const subject =
      typeof body.subject === 'string' && body.subject.trim()
        ? body.subject.replace(/[\r\n]+/g, ' ').trim().slice(0, ORDER_SEND_MAX_SUBJECT_CHARS)
        : null;
    const message =
      typeof body.message === 'string' && body.message.trim()
        ? body.message.trim().slice(0, ORDER_SEND_MAX_MESSAGE_CHARS)
        : null;

    const actor = await exitActorForRequest(context.env.DB, context.data, user, order.tenant_id);
    const plan = await planOrderSend(context.env.DB, context.env.FILES, {
      order,
      tenantName,
      sender: user,
      actor,
      emailConfigured: Boolean(context.env.RESEND_API_KEY),
      subject,
    });
    if (plan.preview.blocked) {
      // Too many parts is a size refusal with the number in it; anything else
      // is "this order is not ready to send".
      const status = plan.preview.blocked.code === 'too_many_parts' ? 413 : 400;
      return json({ error: plan.preview.blocked.message, code: plan.preview.blocked.code }, status);
    }
    if (typeof body.fingerprint === 'string' && body.fingerprint && body.fingerprint !== plan.preview.fingerprint) {
      throw new ConflictError(
        'This order changed after you reviewed it, so nothing was sent. Review it again and send.',
      );
    }

    // The addresses the sender left on the review screen. With none sent, the
    // same default the review screen was pre-filled with: the customer's COA
    // contacts (migration 0135), else the customer's address on record.
    const asked = normalizeOrderRecipients(body.recipients);
    if (asked.bad.length > 0) throw new BadRequestError(`Not a valid email address: ${asked.bad.join(', ')}`);
    const fallback = normalizeOrderRecipients(plan.preview.recipients);
    const recipients = asked.ok.length > 0 ? asked.ok : fallback.ok;
    if (recipients.length === 0) {
      throw new BadRequestError(
        'There is no address to send to. Enter one, or add an email address to the customer.',
      );
    }
    if (recipients.length > EXPORT_MAX_RECIPIENTS) {
      throw new BadRequestError(`One send reaches at most ${EXPORT_MAX_RECIPIENTS} addresses.`);
    }

    if (!context.env.RESEND_API_KEY) {
      return json(
        {
          error:
            'Email is not configured for this portal, so nothing was sent. ' +
            'Ask an administrator to set up email.',
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
          error:
            `That is ${ORDER_SEND_RATE_LIMIT_PER_HOUR} sends in an hour, which is the limit. ` +
            `Try again a little later.`,
          code: 'rate_limited',
        },
        429,
      );
    }
    await recordAttempt(context.env.DB, rlKey, ORDER_SEND_RATE_WINDOW_SECONDS);

    const result = await executeOrderSend(
      {
        db: context.env.DB,
        files: context.env.FILES,
        apiKey: context.env.RESEND_API_KEY,
        origin: new URL(context.request.url).origin,
        tenantName,
        sender: user,
        order,
        actor,
        actorUserId: user.id,
      },
      {
        order,
        plan,
        recipients,
        subject: subject ?? plan.preview.default_subject,
        message,
        clientIp: getClientIp(context.request),
      },
    );

    const sends = await loadOrderSends(context.env.DB, user, { tenantId: order.tenant_id, orderId: order.id });
    const send = sends.find((s) => s.id === result.sendId)!;
    const response: OrderSendResponse = {
      send,
      sent: send.status === 'sent',
      order_status: result.orderStatus,
    };
    if (send.status === 'failed') {
      return json(
        {
          error: 'None of the emails could be sent. Nothing reached the customer.',
          code: 'email_send_failed',
          ...response,
        },
        502,
      );
    }
    return json(response);
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Order send error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
};
