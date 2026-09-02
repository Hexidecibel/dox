/**
 * GET /api/alerts/public/:token
 *
 * The unauthenticated read behind /alert/:token — the landing page an alert
 * email points at, for recipients who are not portal users.
 *
 * SHAPE FOLLOWS /api/workflow-approvals/public/:token, which is the closest
 * precedent in this codebase:
 *
 *   - The token is the only gate. 32 bytes of entropy, minted per alert event.
 *   - 404 covers EVERY non-servable case (unknown token, expired, revoked,
 *     document deleted, tenant gone) so a token cannot be probed for existence
 *     and an expired link cannot be distinguished from a fabricated one.
 *   - Rate limited per (link, IP).
 *   - Read only. There is no POST. Nothing on this route changes state except
 *     the view counter and the audit row.
 *
 * The response body is an explicit allow-list built in
 * `functions/lib/alert-links.ts`; see the note there for what is deliberately
 * absent and why.
 */
import { logAudit, getClientIp } from '../../../lib/db';
import { checkRateLimit, recordAttempt } from '../../../lib/ratelimit';
import {
  loadUsableAlertLink,
  buildAlertLandingView,
  recordAlertLinkView,
} from '../../../lib/alert-links';
import type { Env } from '../../../lib/types';

/** Generous for a human refreshing a page; tight enough to stop a scraper. */
const RATE_LIMIT_PER_HOUR = 30;
const RATE_LIMIT_WINDOW_SECONDS = 60 * 60;

function notFound(): Response {
  return new Response(JSON.stringify({ error: 'Alert not found' }), {
    status: 404,
    headers: { 'Content-Type': 'application/json' },
  });
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const token = context.params.token as string;
    if (!token) return notFound();

    const ip = getClientIp(context.request) ?? 'unknown';

    const link = await loadUsableAlertLink(context.env.DB, token);
    if (!link) return notFound();

    // Keyed on the link, not the raw token, so the key never carries the
    // secret and one leaked link cannot be used to exhaust another's budget.
    const rlKey = `alert_link_view:${link.id}:${ip}`;
    const rl = await checkRateLimit(
      context.env.DB,
      rlKey,
      RATE_LIMIT_PER_HOUR,
      RATE_LIMIT_WINDOW_SECONDS
    );
    if (!rl.allowed) {
      return new Response(JSON.stringify({ error: 'Rate limit exceeded. Try again later.' }), {
        status: 429,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    await recordAttempt(context.env.DB, rlKey, RATE_LIMIT_WINDOW_SECONDS);

    const view = await buildAlertLandingView(context.env.DB, link);
    if (!view) return notFound();

    await recordAlertLinkView(context.env.DB, link.id);

    // An unauthenticated read of a compliance record is exactly the event an
    // auditor asks about, so it is logged before the bytes go out. No user id
    // — there is no user — but the tenant, the link, the kind, the subject and
    // the IP are all recorded.
    await logAudit(
      context.env.DB,
      null,
      link.tenant_id,
      'alert_link.view',
      'alert_link',
      link.id,
      JSON.stringify({
        kind: link.kind,
        document_id: link.document_id,
        subject_count: view.renewals.length || (view.document ? 1 : 0),
        ip,
      }),
      ip
    );

    return new Response(JSON.stringify(view), {
      headers: {
        'Content-Type': 'application/json',
        // Never let a shared cache hold a compliance record keyed by a URL
        // that arrived in an email.
        'Cache-Control': 'no-store',
      },
    });
  } catch (err) {
    console.error('Alert link fetch error:', err);
    return notFound();
  }
};
