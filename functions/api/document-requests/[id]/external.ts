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
 * WHAT THIS IS: an authenticated PREVIEW. It is behind the same auth as
 * everything else under /api, and it answers "show me what they will see"
 * before a buyer presses issue, and "what exactly did we send them" after.
 *
 * The token-gated public variant this file used to anticipate now exists, at
 * /api/supplier-requests/public/:token (migration 0092), and it followed the
 * alert_links pattern as predicted. Both routes go through
 * `assembleSupplierView` into the one `buildSupplierRequestView`, which is the
 * arrangement the paragraph below insists on. Neither assembles its own object.
 *
 * The preview binds to the LIVE link when the ask has one, so the item handles
 * and the upload history it shows are the supplier's actual ones rather than a
 * plausible imitation — "what exactly did we send them" is only a true answer
 * if it reads the same row the supplier is reading. With no link yet, it falls
 * back to an ephemeral token: the shape is exact and the handles address
 * nothing, which is correct for a packet nobody has been given.
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
  assembleSupplierView,
  loadRequest,
  resolveTenantForRequest,
} from '../../../lib/document-requests';
import { computeRequestLinkExpiry, generateRequestToken } from '../../../lib/request-links';
import type { RequestLinkRow } from '../../../lib/request-links';
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

    // The live link for this ask, if one has been minted. Revoked and expired
    // links are excluded for the same reason the public route excludes them:
    // they are not what the supplier holds.
    const link = await context.env.DB.prepare(
      `SELECT * FROM request_links
        WHERE root_request_id = ? AND tenant_id = ?
          AND revoked_at IS NULL AND expires_at > datetime('now')
        ORDER BY created_at DESC
        LIMIT 1`,
    )
      .bind(request.root_request_id, tenantId)
      .first<RequestLinkRow>();

    const view = await assembleSupplierView(context.env.DB, {
      tenantId,
      token: link?.token ?? generateRequestToken(),
      request,
      rootRequestId: request.root_request_id,
      supplierId: request.supplier_id,
      linkId: link?.id ?? null,
      linkExpiresAt: link?.expires_at ?? computeRequestLinkExpiry(request.due_date),
      acceptingUploads: request.status === 'issued',
    });
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
