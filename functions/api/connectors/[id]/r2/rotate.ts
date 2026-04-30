/**
 * POST /api/connectors/:id/r2/rotate
 *
 * Phase B3 — rotate the per-connector R2 vendor token. Revokes the
 * existing CF-managed token and mints a new one against the same
 * bucket. Returns the new plaintext secret access key ONCE; the old
 * key stops working immediately (hard cutover, no grace period).
 *
 * Auth: standard JWT/API-key gate (NOT allowlisted in middleware).
 * Only super_admin or org_admin in the connector's tenant may rotate.
 *
 * Failure modes:
 *   - Connector has no bucket yet → 409, suggesting the caller hit
 *     `/r2/provision` first.
 *   - CF API failure (revoke or mint) → 502 with the truncated CF
 *     error message. The DB row is NOT updated on failure, so the old
 *     token remains both active and the system-of-record.
 */

import { logAudit, getClientIp } from '../../../../lib/db';
import {
  requireRole,
  requireTenantAccess,
  NotFoundError,
  errorToResponse,
} from '../../../../lib/permissions';
import { resolveConnectorHandle } from '../../../../lib/connectors/resolveHandle';
import { rotateConnectorR2Token } from '../../../../lib/connectors/provisionR2';
import { encryptIntakeSecret } from '../../../../lib/intakeEncryption';
import type { Env, User } from '../../../../lib/types';

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
      r2_bucket_name: string | null;
      r2_cf_token_id: string | null;
    }>(context.env.DB, handle, {
      columns:
        'id, slug, tenant_id, deleted_at, r2_bucket_name, r2_cf_token_id',
    });

    if (!connector || connector.deleted_at !== null) {
      throw new NotFoundError('Connector not found');
    }

    requireTenantAccess(user, connector.tenant_id);

    if (!connector.slug || !connector.r2_bucket_name) {
      return new Response(
        JSON.stringify({
          error: 'not_provisioned',
          message:
            'This connector has no S3 drop bucket yet. Call POST /r2/provision first.',
        }),
        { status: 409, headers: { 'Content-Type': 'application/json' } },
      );
    }

    if (
      !context.env.CLOUDFLARE_ACCOUNT_ID ||
      !context.env.CLOUDFLARE_API_TOKEN ||
      !context.env.INTAKE_ENCRYPTION_KEY
    ) {
      return new Response(
        JSON.stringify({
          error:
            'R2 rotation is not configured on this environment (missing CF / encryption secrets).',
        }),
        { status: 503, headers: { 'Content-Type': 'application/json' } },
      );
    }

    let creds;
    try {
      creds = await rotateConnectorR2Token(context.env, {
        id: connector.id,
        slug: connector.slug,
        // Cf token id may be NULL on rows that were provisioned in a
        // previous Phase B3 deploy that didn't capture it. The helper
        // tolerates an empty string by skipping the revoke step (best
        // effort) and minting a fresh token.
        cf_token_id: connector.r2_cf_token_id ?? '',
      });
    } catch (rotateErr) {
      const msg =
        rotateErr instanceof Error ? rotateErr.message : String(rotateErr);
      console.error(`R2 rotate endpoint failure for ${connector.id}: ${msg}`);
      return new Response(
        JSON.stringify({ error: `Rotation failed: ${msg}` }),
        { status: 502, headers: { 'Content-Type': 'application/json' } },
      );
    }

    const encryptedSecret = await encryptIntakeSecret(
      creds.secret_access_key,
      context.env,
    );

    await context.env.DB.prepare(
      `UPDATE connectors
          SET r2_access_key_id = ?,
              r2_secret_access_key_encrypted = ?,
              r2_cf_token_id = ?,
              updated_at = datetime('now')
        WHERE id = ?`,
    )
      .bind(
        creds.access_key_id,
        encryptedSecret,
        creds.cf_token_id,
        connector.id,
      )
      .run();

    await logAudit(
      context.env.DB,
      user.id,
      connector.tenant_id,
      'connector.r2_rotated',
      'connector',
      connector.id,
      JSON.stringify({
        bucket_name: creds.bucket_name,
        access_key_last4: creds.access_key_id.slice(-4),
      }),
      getClientIp(context.request),
    );

    return new Response(
      JSON.stringify({
        bucket_name: creds.bucket_name,
        access_key_id: creds.access_key_id,
        secret_access_key: creds.secret_access_key,
        endpoint: creds.endpoint,
        rotated_at: new Date().toISOString(),
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('R2 rotate endpoint error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }
};
