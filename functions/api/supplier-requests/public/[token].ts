/**
 * GET /api/supplier-requests/public/:token
 *
 * The unauthenticated read behind /r/:token — the page a supplier opens when we
 * ask them for documents. No account, no password, no portal.
 *
 * SHAPE FOLLOWS /api/alerts/public/:token, which is the closest precedent:
 *
 *   - The token is the only gate. 32 bytes of entropy, minted at issue.
 *   - 404 covers EVERY non-servable case (unknown token, expired, revoked,
 *     ask withdrawn, supplier or tenant gone) so a token cannot be probed for
 *     existence and an expired link is indistinguishable from a fabricated one.
 *   - Rate limited per (link, IP).
 *   - The body is an ALLOW-LIST built by `buildSupplierRequestView`, the same
 *     function the authenticated preview serves. There is one projection.
 *
 * WHAT THIS ROUTE MUST NEVER LEAK, restated because this is the file someone
 * will edit in a hurry: our configured spec limits, the internal routing
 * record, classification or judgement reasoning, condition/override language,
 * SOP citations and internal section numbers, any other supplier's data, and
 * any Medosweet-internal document. None of those is filtered out here — none of
 * them is ever put in. If you are adding a field to the response, add it to the
 * projection and to the allow-list test, or do not add it.
 */
import { getClientIp, logAudit } from '../../../lib/db';
import { checkRateLimit, recordAttempt } from '../../../lib/ratelimit';
import { assembleSupplierView } from '../../../lib/document-requests';
import {
  loadCurrentRequestForLink,
  loadUsableRequestLink,
  recordRequestLinkView,
} from '../../../lib/request-links';
import type { Env } from '../../../lib/types';

/** Generous for a person reloading on a train; tight enough to stop a scraper. */
const RATE_LIMIT_PER_HOUR = 60;
const RATE_LIMIT_WINDOW_SECONDS = 60 * 60;

function notFound(): Response {
  return new Response(JSON.stringify({ error: 'This request is no longer available' }), {
    status: 404,
    headers: { 'Content-Type': 'application/json' },
  });
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const token = context.params.token as string;
    if (!token) return notFound();

    const ip = getClientIp(context.request) ?? 'unknown';

    const link = await loadUsableRequestLink(context.env.DB, token);
    if (!link) return notFound();

    // Keyed on the link, not the raw token, so the rate-limit key never carries
    // the secret and one leaked link cannot exhaust another's budget.
    const rlKey = `request_link_view:${link.id}:${ip}`;
    const rl = await checkRateLimit(
      context.env.DB,
      rlKey,
      RATE_LIMIT_PER_HOUR,
      RATE_LIMIT_WINDOW_SECONDS,
    );
    if (!rl.allowed) {
      return new Response(JSON.stringify({ error: 'Too many requests. Try again shortly.' }), {
        status: 429,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    await recordAttempt(context.env.DB, rlKey, RATE_LIMIT_WINDOW_SECONDS);

    const request = await loadCurrentRequestForLink(context.env.DB, link);
    if (!request) return notFound();

    const view = await assembleSupplierView(context.env.DB, {
      tenantId: link.tenant_id,
      token,
      request,
      rootRequestId: link.root_request_id,
      supplierId: link.supplier_id,
      linkId: link.id,
      linkExpiresAt: link.expires_at,
      // The door takes files for as long as the ask is live. It stays READABLE
      // afterwards either way — a supplier losing sight of what they sent the
      // moment we close the ask is how the "did you get it?" call gets made.
      acceptingUploads: request.status === 'issued',
    });
    if (!view) return notFound();

    await recordRequestLinkView(context.env.DB, link.id);

    // An unauthenticated read of a compliance record is exactly the event an
    // auditor asks about, so it is logged before the bytes go out. No user id —
    // there is no user — but the tenant, the link, the version they were shown
    // and the IP are all recorded.
    await logAudit(
      context.env.DB,
      null,
      link.tenant_id,
      'request_link.view',
      'request_link',
      link.id,
      JSON.stringify({
        request_id: request.id,
        version: request.version,
        item_count: view.items.length,
        ip,
      }),
      ip,
    );

    return new Response(JSON.stringify(view), {
      headers: {
        'Content-Type': 'application/json',
        // Never let a shared cache hold a compliance record keyed by a URL that
        // arrived in an email.
        'Cache-Control': 'no-store',
      },
    });
  } catch (err) {
    console.error('Supplier request view error:', err);
    return notFound();
  }
};
