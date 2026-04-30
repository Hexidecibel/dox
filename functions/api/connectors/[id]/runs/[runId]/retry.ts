/**
 * POST /api/connectors/:id/runs/:runId/retry
 *
 * Phase B5 — replay path for failed runs. Refetches the original file
 * (R2 default bucket for `manual` / `api` / `public_link` runs, the
 * connector's per-connector S3 bucket for `s3` runs) and re-dispatches
 * via `executeConnectorRun`. The original run row is preserved as
 * historical record; the new row carries `retry_of_run_id` (migration
 * 0052) so the chain is reconstructable.
 *
 * Status code mapping:
 *   - 200 — retry dispatched; body shape matches /run
 *   - 400 — run is not retryable (still running, or already success)
 *   - 404 — run / connector not found, or caller lacks tenant access
 *   - 422 — source file is no longer retrievable (R2 object pruned, S3
 *           bucket creds missing, etc.). Distinct from 5xx so the UI
 *           knows this is a permanent state, not a transient hiccup.
 *   - 5xx — orchestrator threw / unexpected error
 */

import type { Env, User } from '../../../../../lib/types';
import {
  requireRole,
  requireTenantAccess,
  NotFoundError,
  BadRequestError,
  errorToResponse,
} from '../../../../../lib/permissions';
import { resolveConnectorHandle } from '../../../../../lib/connectors/resolveHandle';
import { decryptCredentials } from '../../../../../lib/connectors/crypto';
import { decryptIntakeSecret } from '../../../../../lib/intakeEncryption';
import { executeConnectorRun, type ConnectorRunSource } from '../../../../../lib/connectors/orchestrator';
import { normalizeFieldMappings } from '../../../../../../shared/fieldMappings';
import { AwsClient } from 'aws4fetch';

interface RunRow {
  id: string;
  connector_id: string;
  tenant_id: string;
  status: string;
  source: string | null;
  /** Optional details column carries the original r2_key when the door
   *  stashes the file before dispatch; we don't have a dedicated
   *  column for it on connector_runs so we look in two places: the
   *  details JSON, and the connector_processed_keys table for the
   *  r2_key that pointed at this run. */
  details: string | null;
}

interface ConnectorRow {
  id: string;
  tenant_id: string;
  active: number;
  deleted_at: string | null;
  config: string | null;
  field_mappings: string | null;
  credentials_encrypted: string | null;
  credentials_iv: string | null;
  r2_bucket_name: string | null;
  r2_access_key_id: string | null;
  r2_secret_access_key_encrypted: string | null;
}

function unprocessable(message: string): Response {
  return new Response(
    JSON.stringify({ error: message, code: 'unretryable' }),
    { status: 422, headers: { 'Content-Type': 'application/json' } },
  );
}

/**
 * Best-effort lookup of the R2 key the run originally consumed.
 * - For `manual` / `api` / `public_link` runs, the drop endpoint
 *   inserts a row into `connector_processed_keys` with `run_id =
 *   <run.id>` and `r2_key = connector-drops/<connector_id>/...`.
 * - For `s3` runs, the poller writes a `connector_processed_keys`
 *   row with `r2_key = <bucket-key>` (NOT prefixed). We distinguish
 *   by `run.source`.
 */
async function lookupOriginalKey(
  db: D1Database,
  runId: string,
): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT r2_key FROM connector_processed_keys WHERE run_id = ? LIMIT 1`,
    )
    .bind(runId)
    .first<{ r2_key: string }>();
  return row?.r2_key ?? null;
}

/**
 * Pull the bytes for an R2 / S3 object that backed an earlier run.
 * Throws on any retrieval failure — caller maps to 422.
 */
async function refetchSourceBytes(
  env: Env,
  connector: ConnectorRow,
  runSource: ConnectorRunSource,
  r2Key: string,
): Promise<{ buffer: ArrayBuffer; contentType: string; fileName: string }> {
  if (runSource === 's3') {
    if (
      !connector.r2_bucket_name ||
      !connector.r2_access_key_id ||
      !connector.r2_secret_access_key_encrypted ||
      !env.CLOUDFLARE_ACCOUNT_ID
    ) {
      throw new Error('S3 bucket credentials missing on connector');
    }
    const secret = await decryptIntakeSecret(
      connector.r2_secret_access_key_encrypted,
      env as Env & { INTAKE_ENCRYPTION_KEY: string },
    );
    const aws = new AwsClient({
      accessKeyId: connector.r2_access_key_id,
      secretAccessKey: secret,
      service: 's3',
      region: 'auto',
    });
    const endpoint = `https://${env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`;
    const encoded = r2Key
      .split('/')
      .map((seg) => encodeURIComponent(seg))
      .join('/');
    const res = await aws.fetch(
      `${endpoint}/${connector.r2_bucket_name}/${encoded}`,
      { method: 'GET' },
    );
    if (!res.ok) {
      throw new Error(`S3 GET failed: ${res.status}`);
    }
    const contentType =
      res.headers.get('content-type') || 'application/octet-stream';
    const buffer = await res.arrayBuffer();
    const fileName = r2Key.split('/').pop() || r2Key;
    return { buffer, contentType, fileName };
  }

  // Default-bucket retrieval (manual / api / public_link).
  const obj = await env.FILES.get(r2Key);
  if (!obj) {
    throw new Error('R2 object not found in default bucket');
  }
  const buffer = await obj.arrayBuffer();
  const contentType =
    obj.httpMetadata?.contentType || 'application/octet-stream';
  // Strip the connector-drops/<id>/<iso>- prefix to recover the
  // friendly filename. Not strictly required (the orchestrator only
  // uses fileName for parser routing + audit) but it keeps the
  // retry's audit row symmetric with the original.
  const last = r2Key.split('/').pop() || r2Key;
  const fileName = last.replace(/^[\d-]+T[\d-]+Z?-/, '') || last;
  return { buffer, contentType, fileName };
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const connectorHandle = context.params.id as string;
    const runId = context.params.runId as string;

    requireRole(user, 'super_admin', 'org_admin');

    const connector = await resolveConnectorHandle<ConnectorRow>(
      context.env.DB,
      connectorHandle,
      {
        columns:
          'id, tenant_id, active, deleted_at, config, field_mappings, ' +
          'credentials_encrypted, credentials_iv, r2_bucket_name, ' +
          'r2_access_key_id, r2_secret_access_key_encrypted',
      },
    );
    if (!connector) {
      throw new NotFoundError('Connector not found');
    }
    requireTenantAccess(user, connector.tenant_id);
    if (!connector.active || connector.deleted_at !== null) {
      throw new BadRequestError('Cannot retry on an inactive connector');
    }

    // The run must (a) belong to this connector and (b) be in a
    // retryable state. We don't gate on `partial` here — partials
    // can still leave one or two record-level errors that a fix-and-
    // retry would reconcile, but the user-visible "Retry" button
    // only surfaces on `error` rows. Bypass attempts (running /
    // success) get a 400.
    const run = await context.env.DB
      .prepare(
        `SELECT id, connector_id, tenant_id, status, source, details
           FROM connector_runs WHERE id = ? AND connector_id = ?`,
      )
      .bind(runId, connector.id)
      .first<RunRow>();
    if (!run) {
      throw new NotFoundError('Run not found');
    }
    if (run.status !== 'error') {
      throw new BadRequestError(
        `Only failed runs can be retried (status=${run.status})`,
      );
    }

    // Resolve the original payload location.
    const r2Key = await lookupOriginalKey(context.env.DB, run.id);
    if (!r2Key) {
      return unprocessable(
        'Original source file is no longer retrievable (no processed-keys row)',
      );
    }

    const runSource = (run.source as ConnectorRunSource | null) ?? 'manual';

    let payload: Awaited<ReturnType<typeof refetchSourceBytes>>;
    try {
      payload = await refetchSourceBytes(context.env, connector, runSource, r2Key);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`retry: refetch failed for run ${run.id}:`, msg);
      return unprocessable(
        `Original source file is no longer retrievable: ${msg}`,
      );
    }

    // Decode connector config / credentials — symmetric with /run.
    let config: Record<string, unknown> = {};
    try {
      config = JSON.parse(connector.config || '{}');
    } catch {
      config = {};
    }
    let credentials: Record<string, unknown> | undefined;
    if (
      connector.credentials_encrypted &&
      connector.credentials_iv &&
      context.env.CONNECTOR_ENCRYPTION_KEY
    ) {
      try {
        credentials = await decryptCredentials(
          connector.credentials_encrypted,
          connector.credentials_iv,
          context.env.CONNECTOR_ENCRYPTION_KEY,
          connector.tenant_id,
          connector.id,
        );
      } catch {
        credentials = undefined;
      }
    }
    const fieldMappings = normalizeFieldMappings(
      typeof connector.field_mappings === 'string'
        ? (() => { try { return JSON.parse(connector.field_mappings as string); } catch { return {}; } })()
        : connector.field_mappings,
    );

    // Dispatch with the same source as the original; the new run row
    // gets `retry_of_run_id = <original.id>` so the UI can fold the
    // chain together.
    const result = await executeConnectorRun({
      db: context.env.DB,
      r2: context.env.FILES,
      tenantId: connector.tenant_id,
      connectorId: connector.id,
      config,
      fieldMappings,
      credentials,
      input: {
        type: 'file_watch',
        fileName: payload.fileName,
        contentType: payload.contentType,
        r2Key,
        content: payload.buffer,
      },
      source: runSource,
      // Manual retry is admin-driven, so attribute it.
      userId: user.id,
      qwenUrl: context.env.QWEN_URL,
      qwenSecret: context.env.QWEN_SECRET,
    });

    // Patch the new row's retry_of_run_id. The orchestrator doesn't
    // know about this column (it's owned by the retry endpoint), so
    // we update after the fact. Wrapped in a try so an environment
    // missing migration 0052 silently degrades to "no link" rather
    // than 500ing.
    try {
      await context.env.DB
        .prepare(
          `UPDATE connector_runs SET retry_of_run_id = ? WHERE id = ?`,
        )
        .bind(run.id, result.runId)
        .run();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('no such column')) {
        console.warn(`retry: failed to write retry_of_run_id:`, msg);
      }
    }

    return new Response(
      JSON.stringify({
        run_id: result.runId,
        retry_of_run_id: run.id,
        status: result.status,
        orders_created: result.ordersCreated,
        customers_created: result.customersCreated,
        errors: result.errors,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Retry connector run error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }
};
