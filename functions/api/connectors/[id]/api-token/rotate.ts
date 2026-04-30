/**
 * POST /api/connectors/:id/api-token/rotate
 *
 * Generate a new bearer token for the connector's HTTP POST drop door
 * (Phase B2). Auth is the standard JWT/API-key gate (this is the
 * connector OWNER rotating, not the vendor) so the route is NOT
 * allowlisted in `_middleware.ts` — only super_admin or org_admin in
 * the connector's tenant can rotate.
 *
 * Behavior:
 *   - Generates a fresh 32-byte random token (64-char hex), matching
 *     the shape of the existing `CONNECTOR_POLL_TOKEN` and the form the
 *     manual-create flow generates in `connectors/index.ts`.
 *   - Writes it to `connectors.api_token` (plaintext column from
 *     migration 0047 — not user-password-grade; it's a connector-scoped
 *     credential the user can rotate freely).
 *   - Returns `{ api_token }` in the response body. This is the ONLY
 *     time the new token is surfaced — partners need to copy it
 *     immediately. Subsequent GETs surface it the same way (it's
 *     plaintext at rest), but the rotation flow is the canonical way to
 *     hand a fresh token to a vendor.
 *   - Audit log: `connector.api_token_rotated` with the actor's user id
 *     and a `last4` of the new token (NOT the full token — we don't
 *     leak it via the audit feed).
 *   - Hard cutover semantics: the old token stops working immediately
 *     (no grace period). UI must warn the user before calling.
 */

import { logAudit, getClientIp } from '../../../../lib/db';
import {
  requireRole,
  requireTenantAccess,
  NotFoundError,
  errorToResponse,
} from '../../../../lib/permissions';
import type { Env, User } from '../../../../lib/types';

/**
 * Generate a 32-byte hex token via Web Crypto. Matches the shape of
 * `openssl rand -hex 32` output (64 lowercase hex chars).
 */
function generateApiToken(): string {
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
    const connectorId = context.params.id as string;

    requireRole(user, 'super_admin', 'org_admin');

    const connector = await context.env.DB.prepare(
      `SELECT id, tenant_id FROM connectors WHERE id = ? AND deleted_at IS NULL`,
    )
      .bind(connectorId)
      .first<{ id: string; tenant_id: string }>();

    if (!connector) {
      throw new NotFoundError('Connector not found');
    }

    requireTenantAccess(user, connector.tenant_id);

    const newToken = generateApiToken();

    await context.env.DB.prepare(
      `UPDATE connectors
          SET api_token = ?, updated_at = datetime('now')
        WHERE id = ?`,
    )
      .bind(newToken, connector.id)
      .run();

    // Audit log carries only the last4 of the new token so we have a
    // breadcrumb without persisting the secret to the audit feed.
    await logAudit(
      context.env.DB,
      user.id,
      connector.tenant_id,
      'connector.api_token_rotated',
      'connector',
      connector.id,
      JSON.stringify({
        last4: newToken.slice(-4),
        rotated_at: new Date().toISOString(),
      }),
      getClientIp(context.request),
    );

    return new Response(
      JSON.stringify({
        api_token: newToken,
        rotated_at: new Date().toISOString(),
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Rotate connector api_token error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }
};

