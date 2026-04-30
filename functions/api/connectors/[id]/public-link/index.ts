/**
 * DELETE /api/connectors/:id/public-link
 *
 * Phase B4 — revoke the per-connector public drop link. Sets
 * `public_link_token` and `public_link_expires_at` to NULL. After
 * this call the public form route returns "link not active" and the
 * drop endpoint rejects any vendor request still carrying the old
 * token.
 *
 * Auth: standard JWT/API-key gate; super_admin or org_admin in the
 * connector's tenant.
 *
 * Idempotent: revoking a connector that already has no token is a
 * 200 (no-op). The audit row is only written when there was actually
 * a token to revoke.
 */

import { logAudit, getClientIp } from '../../../../lib/db';
import {
  requireRole,
  requireTenantAccess,
  NotFoundError,
  errorToResponse,
} from '../../../../lib/permissions';
import { resolveConnectorHandle } from '../../../../lib/connectors/resolveHandle';
import type { Env, User } from '../../../../lib/types';

export const onRequestDelete: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const handle = context.params.id as string;

    requireRole(user, 'super_admin', 'org_admin');

    const connector = await resolveConnectorHandle<{
      id: string;
      tenant_id: string;
      deleted_at: string | null;
      public_link_token: string | null;
    }>(context.env.DB, handle, {
      columns: 'id, tenant_id, deleted_at, public_link_token',
    });

    if (!connector || connector.deleted_at !== null) {
      throw new NotFoundError('Connector not found');
    }

    requireTenantAccess(user, connector.tenant_id);

    const hadToken = !!connector.public_link_token;

    await context.env.DB.prepare(
      `UPDATE connectors
          SET public_link_token = NULL,
              public_link_expires_at = NULL,
              updated_at = datetime('now')
        WHERE id = ?`,
    )
      .bind(connector.id)
      .run();

    if (hadToken) {
      await logAudit(
        context.env.DB,
        user.id,
        connector.tenant_id,
        'connector.public_link_revoked',
        'connector',
        connector.id,
        JSON.stringify({
          last4: connector.public_link_token!.slice(-4),
          revoked_at: new Date().toISOString(),
        }),
        getClientIp(context.request),
      );
    }

    return new Response(
      JSON.stringify({ revoked: hadToken }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Revoke public link error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }
};
