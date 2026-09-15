/**
 * GET /api/document-exports/public/:token
 *
 * The unauthenticated read behind /export/:token — the page an "here are the
 * documents you asked for" email points at.
 *
 * Posture is /api/alerts/public/:token's, with one deliberate difference: that
 * page shows a record and offers no file, this one EXISTS to hand files over
 * (see ./[token]/download.ts and ./[token]/file/[index].ts).
 *
 *   - The token is the only gate. 32 bytes of entropy, minted per send.
 *   - 404 covers EVERY non-servable case (unknown, expired, revoked, tenant
 *     gone) so a token cannot be probed and an expired link cannot be told
 *     apart from a fabricated one.
 *   - Rate limited per (link, IP).
 *   - The response is an allow-list built in `functions/lib/document-export.ts`.
 *     It shows the documents THIS export contained and can never widen: the id
 *     list was frozen at send time and nothing in the request can add to it.
 */
import { logAudit, getClientIp } from '../../../lib/db';
import { checkRateLimit, recordAttempt } from '../../../lib/ratelimit';
import {
  loadUsableExportLink,
  buildExportLandingView,
  recordExportLinkView,
} from '../../../lib/document-export';
import type { Env } from '../../../lib/types';

/** Generous for a human refreshing a page; tight enough to stop a scraper. */
const RATE_LIMIT_PER_HOUR = 60;
const RATE_LIMIT_WINDOW_SECONDS = 60 * 60;

function notFound(): Response {
  return new Response(JSON.stringify({ error: 'These documents are no longer available' }), {
    status: 404,
    headers: { 'Content-Type': 'application/json' },
  });
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const token = context.params.token as string;
    if (!token) return notFound();

    const ip = getClientIp(context.request) ?? 'unknown';
    const link = await loadUsableExportLink(context.env.DB, token);
    if (!link) return notFound();

    // Keyed on the link, not the raw token, so the key never carries the
    // secret and one leaked link cannot exhaust another's budget.
    const rlKey = `document_export_view:${link.id}:${ip}`;
    const rl = await checkRateLimit(
      context.env.DB,
      rlKey,
      RATE_LIMIT_PER_HOUR,
      RATE_LIMIT_WINDOW_SECONDS,
    );
    if (!rl.allowed) {
      return new Response(JSON.stringify({ error: 'Rate limit exceeded. Try again later.' }), {
        status: 429,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    await recordAttempt(context.env.DB, rlKey, RATE_LIMIT_WINDOW_SECONDS);

    const view = await buildExportLandingView(context.env.DB, link);
    if (!view) return notFound();

    await recordExportLinkView(context.env.DB, link.id, 'view');

    await logAudit(
      context.env.DB,
      null,
      link.tenant_id,
      'document_export_link.view',
      'document_export_link',
      link.id,
      JSON.stringify({ document_count: view.documents.length, ip }),
      ip,
    );

    return new Response(JSON.stringify(view), {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      },
    });
  } catch (err) {
    console.error('Document export link fetch error:', err);
    return notFound();
  }
};
