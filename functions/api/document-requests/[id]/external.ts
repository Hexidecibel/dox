/**
 * GET /api/document-requests/:id/external — EXACTLY what a supplier may see.
 *
 * WHY THIS ENDPOINT EXISTS AT ALL
 * -------------------------------
 * The internal routing record is created at issue and is never visible
 * externally. The way that guarantee is kept is `buildSupplierRequestView`, an
 * ALLOW-LIST that constructs the outward payload field by field from named
 * columns — the same discipline `buildAlertLandingView` uses in
 * functions/lib/alert-links.ts, for the same reason: an internal note or the
 * assigned buyer's identity reaching a vendor is not recoverable by
 * apologising.
 *
 * An allow-list only works if it is the ONE place the outward shape is decided.
 * So the projection is a single exported function and this route is the only
 * thing that serves it. Every future outward channel — a supplier portal page,
 * the body of an outbound email, a PDF — calls the same function rather than
 * assembling its own "mostly the same" object, which is how the second copy
 * ends up with one field too many.
 *
 * WHAT THIS IS TODAY: an authenticated PREVIEW. It is behind the same auth as
 * everything else under /api, and it answers "show me what they will see"
 * before a buyer presses issue, and "what exactly did we send them" after.
 * There is deliberately no token-gated public variant yet — the moment one is
 * wanted it follows the alert_links pattern (0089): an expiring token, one
 * link, one ask, read only. It is not a filter added to this route.
 *
 * WHAT IT NEVER RETURNS: the routing row in any form, `assigned_to`, any
 * internal id, `origin`, the version chain, `amendment_reason`, per-line
 * status, `owner`, or `line_kind`. See the type `SupplierRequestView` and
 * `buildSupplierRequestView` for the full list and the reasoning per field.
 *
 * A request that is not currently issued projects to nothing at all: a draft,
 * a cancelled ask and a superseded version each return 409 rather than a
 * partial view, because there is no state in which showing a supplier an
 * unissued packet is correct.
 */

import { errorToResponse } from '../../../lib/permissions';
import {
  buildSupplierRequestView,
  loadLines,
  loadRequest,
  resolveTenantForRequest,
} from '../../../lib/document-requests';
import type { Env, User } from '../../../lib/types';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const id = context.params.id as string;
    const tenantId = await resolveTenantForRequest(context.env.DB, user, id);

    const request = await loadRequest(context.env.DB, tenantId, id);
    const lines = await loadLines(context.env.DB, tenantId, id);

    const tenant = await context.env.DB.prepare('SELECT name FROM tenants WHERE id = ?')
      .bind(tenantId)
      .first<{ name: string }>();

    const view = buildSupplierRequestView(tenant?.name ?? '', request, lines);
    if (!view) {
      return json(
        {
          error:
            request.superseded_at
              ? 'This version has been superseded by an amendment and is not what the supplier holds.'
              : `A ${request.status} request has no external view.`,
        },
        409,
      );
    }

    return json({ view });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('External request view error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
};
