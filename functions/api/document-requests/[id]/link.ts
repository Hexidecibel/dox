/**
 * GET  /api/document-requests/:id/link — the URL to send the supplier.
 * POST /api/document-requests/:id/link — revoke the current one and mint a new one.
 *
 * The composer's counterpart to the public door. Issuing mints a link
 * automatically (see `issueRequest`); this is how a person GETS it, and how
 * they take it away again.
 *
 * WHY REVOKE-AND-REMINT IS ONE OPERATION
 * --------------------------------------
 * The realistic reason to touch this is "it went to the wrong person" or "their
 * QA lead left". In both, killing the old link and having a new one are the
 * same intention, and splitting them into two calls creates a window where the
 * buyer has revoked the supplier's only way in and not yet noticed they have
 * to mint a replacement. The old token stops working the instant this returns.
 *
 * The link is scoped to the ROOT request, so this is per-ask, not per-version:
 * amending a packet does not and must not rotate the supplier's URL.
 *
 * The token itself is returned ONLY to an authenticated tenant user, which is
 * the same trust boundary as the rest of /api. It is never written into the
 * external projection.
 */

import { errorToResponse } from '../../../lib/permissions';
import {
  auditRequest,
  loadRequest,
  requireComposer,
  resolveTenantForRequest,
} from '../../../lib/document-requests';
import { getClientIp } from '../../../lib/db';
import { mintRequestLink, requestLinkUrl } from '../../../lib/request-links';
import type { RequestLinkRow } from '../../../lib/request-links';
import type { Env, User } from '../../../lib/types';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function liveLink(
  db: D1Database,
  tenantId: string,
  rootRequestId: string,
): Promise<RequestLinkRow | null> {
  const row = await db
    .prepare(
      `SELECT * FROM request_links
        WHERE root_request_id = ? AND tenant_id = ?
          AND revoked_at IS NULL AND expires_at > datetime('now')
        ORDER BY created_at DESC
        LIMIT 1`,
    )
    .bind(rootRequestId, tenantId)
    .first<RequestLinkRow>();
  return row ?? null;
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const id = context.params.id as string;
    const tenantId = await resolveTenantForRequest(context.env.DB, user, id);
    const request = await loadRequest(context.env.DB, tenantId, id);

    const link = await liveLink(context.env.DB, tenantId, request.root_request_id);
    if (!link) return json({ link: null });

    return json({
      link: {
        url: requestLinkUrl(new URL(context.request.url).origin, link.token),
        expires_at: link.expires_at,
        created_at: link.created_at,
        view_count: link.view_count,
        last_viewed_at: link.last_viewed_at,
        last_upload_at: link.last_upload_at,
      },
    });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Request link read error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
};

export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireComposer(user);
    const id = context.params.id as string;
    const tenantId = await resolveTenantForRequest(context.env.DB, user, id);
    const request = await loadRequest(context.env.DB, tenantId, id);

    // Revoke first. If minting then fails, the outcome is "no live link", which
    // a person can retry; the reverse ordering could leave the compromised link
    // alive next to its replacement.
    await context.env.DB.prepare(
      `UPDATE request_links
          SET revoked_at = datetime('now')
        WHERE root_request_id = ? AND tenant_id = ? AND revoked_at IS NULL`,
    )
      .bind(request.root_request_id, tenantId)
      .run();

    const token = await mintRequestLink(context.env.DB, {
      tenantId,
      rootRequestId: request.root_request_id,
      supplierId: request.supplier_id,
      dueDate: request.due_date,
      createdBy: user.id,
    });
    if (!token) return json({ error: 'Could not mint a new link' }, 500);

    await auditRequest(
      context.env.DB,
      user,
      tenantId,
      'document_request.link_rotated',
      request.id,
      { root_request_id: request.root_request_id },
      getClientIp(context.request),
    );

    return json({
      link: { url: requestLinkUrl(new URL(context.request.url).origin, token) },
    });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Request link rotate error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
};
