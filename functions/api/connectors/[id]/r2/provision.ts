/**
 * POST /api/connectors/:id/r2/provision
 *
 * Phase B3 — lazy bring-up of the per-connector S3 drop bucket. When a
 * connector was created BEFORE B3 shipped (or if create-time
 * provisioning failed for any reason), this endpoint mints the bucket
 * + CF-managed token on demand so the owner doesn't have to recreate
 * the connector. The response payload echoes the plaintext secret
 * ONCE — this is the only time the vendor-side secret is visible.
 *
 * Idempotency: if the connector already has `r2_bucket_name` set,
 * this endpoint returns 409 with `{ error: 'already_provisioned' }`
 * to avoid silently double-provisioning. Callers who actually want to
 * cycle credentials should use the `/r2/rotate` endpoint instead.
 *
 * Auth: standard JWT/API-key gate (NOT allowlisted in middleware).
 * Only super_admin or org_admin in the connector's tenant may
 * provision.
 */

import { logAudit, getClientIp } from '../../../../lib/db';
import {
  requireRole,
  requireTenantAccess,
  NotFoundError,
  errorToResponse,
} from '../../../../lib/permissions';
import { resolveConnectorHandle } from '../../../../lib/connectors/resolveHandle';
import { provisionConnectorBucket } from '../../../../lib/connectors/provisionR2';
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
    }>(context.env.DB, handle, {
      columns: 'id, slug, tenant_id, deleted_at, r2_bucket_name',
    });

    if (!connector || connector.deleted_at !== null) {
      throw new NotFoundError('Connector not found');
    }

    requireTenantAccess(user, connector.tenant_id);

    if (!connector.slug) {
      return new Response(
        JSON.stringify({
          error:
            'Connector has no slug. Slug backfill must complete before R2 provisioning is available.',
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      );
    }

    if (connector.r2_bucket_name) {
      return new Response(
        JSON.stringify({
          error: 'already_provisioned',
          bucket_name: connector.r2_bucket_name,
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
            'R2 provisioning is not configured on this environment (missing CF / encryption secrets).',
        }),
        { status: 503, headers: { 'Content-Type': 'application/json' } },
      );
    }

    let creds;
    try {
      creds = await provisionConnectorBucket(context.env, {
        id: connector.id,
        slug: connector.slug,
      });
    } catch (provisionErr) {
      const msg =
        provisionErr instanceof Error ? provisionErr.message : String(provisionErr);
      console.error(`R2 provision endpoint failure for ${connector.id}: ${msg}`);
      return new Response(
        JSON.stringify({ error: `Provisioning failed: ${msg}` }),
        { status: 502, headers: { 'Content-Type': 'application/json' } },
      );
    }

    const encryptedSecret = await encryptIntakeSecret(
      creds.secret_access_key,
      context.env,
    );

    await context.env.DB.prepare(
      `UPDATE connectors
          SET r2_bucket_name = ?,
              r2_access_key_id = ?,
              r2_secret_access_key_encrypted = ?,
              r2_cf_token_id = ?,
              updated_at = datetime('now')
        WHERE id = ?`,
    )
      .bind(
        creds.bucket_name,
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
      'connector.r2_provisioned',
      'connector',
      connector.id,
      JSON.stringify({
        bucket_name: creds.bucket_name,
        // Last4 of the access key id is enough breadcrumb without
        // putting the full token in the audit trail.
        access_key_last4: creds.access_key_id.slice(-4),
      }),
      getClientIp(context.request),
    );

    return new Response(
      JSON.stringify({
        bucket_name: creds.bucket_name,
        access_key_id: creds.access_key_id,
        // Plaintext secret — surfaced ONCE on provisioning. Subsequent
        // GETs of the connector will not include it; the UI shows
        // "rotate to view" because we don't keep a recoverable copy.
        secret_access_key: creds.secret_access_key,
        endpoint: creds.endpoint,
        provisioned_at: new Date().toISOString(),
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('R2 provision endpoint error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }
};
