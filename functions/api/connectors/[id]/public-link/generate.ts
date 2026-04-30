/**
 * POST /api/connectors/:id/public-link/generate
 *
 * Phase B4 — generate (or rotate) the per-connector public drop link.
 * Auth is the standard JWT/API-key gate (this is the connector OWNER
 * generating the link, not an anonymous vendor) so the route is NOT
 * allowlisted in `_middleware.ts` — only super_admin or org_admin in
 * the connector's tenant can generate.
 *
 * Idempotent rotate semantics: if the connector already has a
 * `public_link_token`, this endpoint REPLACES it. The previous URL
 * stops working immediately. The UI must warn the owner before
 * calling.
 *
 * Body (optional): `{ expires_in_days?: number | null }`. Defaults to
 * 30 days. `null` -> no expiry. Whole numbers only, capped at 3650
 * (10 years) — anything longer is set-and-forget territory and should
 * use `null` instead.
 *
 * Response:
 *   {
 *     public_link_token: <64-char hex>,
 *     public_link_expires_at: <unix-seconds | null>,
 *     url: <full /drop/<slug>/<token> URL — best-effort using request origin>,
 *     generated_at: <ISO timestamp>,
 *   }
 *
 * The plaintext token is surfaced once here; subsequent GETs of the
 * connector return it the same way (it's plaintext at rest), but
 * generate is the canonical time to copy it. We log the rotation in
 * audit_log (`connector.public_link_generated`) carrying only the
 * last4 of the new token.
 */

import { logAudit, getClientIp } from '../../../../lib/db';
import {
  requireRole,
  requireTenantAccess,
  NotFoundError,
  BadRequestError,
  errorToResponse,
} from '../../../../lib/permissions';
import { resolveConnectorHandle } from '../../../../lib/connectors/resolveHandle';
import type { Env, User } from '../../../../lib/types';

const DEFAULT_EXPIRY_DAYS = 30;
const MAX_EXPIRY_DAYS = 3650; // 10 years; null means no expiry

/**
 * Generate a 32-byte hex token via Web Crypto. Same shape as
 * `connectors.api_token` (64 lowercase hex chars).
 */
function generatePublicLinkToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, '0');
  }
  return out;
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const handle = context.params.id as string;

    requireRole(user, 'super_admin', 'org_admin');

    const connector = await resolveConnectorHandle<{
      id: string;
      slug: string | null;
      tenant_id: string;
      deleted_at: string | null;
      public_link_token: string | null;
    }>(context.env.DB, handle, {
      columns: 'id, slug, tenant_id, deleted_at, public_link_token',
    });

    if (!connector || connector.deleted_at !== null) {
      throw new NotFoundError('Connector not found');
    }

    requireTenantAccess(user, connector.tenant_id);

    // Parse body — empty body is allowed (defaults).
    let body: { expires_in_days?: number | null } = {};
    const ct = context.request.headers.get('content-type') || '';
    if (ct.toLowerCase().includes('application/json')) {
      try {
        body = (await context.request.json()) as typeof body;
      } catch {
        body = {};
      }
    }

    let expiresAtSec: number | null;
    if (body.expires_in_days === null) {
      expiresAtSec = null;
    } else if (body.expires_in_days === undefined) {
      expiresAtSec = Math.floor(Date.now() / 1000) + DEFAULT_EXPIRY_DAYS * 86400;
    } else {
      const days = Number(body.expires_in_days);
      if (!Number.isFinite(days) || days <= 0 || days !== Math.floor(days)) {
        throw new BadRequestError(
          'expires_in_days must be a positive integer or null',
        );
      }
      if (days > MAX_EXPIRY_DAYS) {
        throw new BadRequestError(
          `expires_in_days must be <= ${MAX_EXPIRY_DAYS}; pass null for no expiry`,
        );
      }
      expiresAtSec = Math.floor(Date.now() / 1000) + days * 86400;
    }

    const newToken = generatePublicLinkToken();
    const isRotation = !!connector.public_link_token;

    await context.env.DB.prepare(
      `UPDATE connectors
          SET public_link_token = ?,
              public_link_expires_at = ?,
              updated_at = datetime('now')
        WHERE id = ?`,
    )
      .bind(newToken, expiresAtSec, connector.id)
      .run();

    await logAudit(
      context.env.DB,
      user.id,
      connector.tenant_id,
      isRotation ? 'connector.public_link_rotated' : 'connector.public_link_generated',
      'connector',
      connector.id,
      JSON.stringify({
        last4: newToken.slice(-4),
        expires_at: expiresAtSec,
        rotated: isRotation,
      }),
      getClientIp(context.request),
    );

    // Best-effort URL: prefer the request origin so the link copied
    // here is the same one the vendor lands on. Falls back to the
    // bare path when origin can't be derived.
    const url = new URL(context.request.url);
    const handleForUrl = connector.slug || connector.id;
    const fullUrl = `${url.origin}/drop/${handleForUrl}/${newToken}`;

    return new Response(
      JSON.stringify({
        public_link_token: newToken,
        public_link_expires_at: expiresAtSec,
        url: fullUrl,
        generated_at: new Date().toISOString(),
        rotated: isRotation,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Generate public link error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }
};
