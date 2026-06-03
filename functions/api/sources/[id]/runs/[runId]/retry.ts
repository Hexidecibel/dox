/**
 * POST /api/sources/:id/runs/:runId/retry
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
import { decryptIntakeSecret } from '../../../../../lib/intakeEncryption';
import type { ConnectorRunSource } from '../../../../../lib/connectors/types';
import { computeChecksum } from '../../../../../lib/r2';
import { enqueueDocument } from '../../../../../lib/intake/enqueue';
import { createConnectorRunHeader } from '../../../../../lib/intake/connectorRunHeader';
import { generateId } from '../../../../../lib/db';
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
  name: string | null;
  tenant_id: string;
  active: number;
  deleted_at: string | null;
  // Sources routing fields (migration 0067) — tag the re-enqueued queue row.
  output_kind: string | null;
  supplier_id: string | null;
  document_type_id: string | null;
  // S3-bucket retrieval creds (still needed to refetch the original bytes
  // for `s3`-sourced runs).
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
          'id, name, tenant_id, active, deleted_at, ' +
          'output_kind, supplier_id, document_type_id, r2_bucket_name, ' +
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

    // Re-enqueue (Connectors → Sources) instead of running the synchronous
    // orchestrator. The bytes are in hand from refetchSourceBytes.
    //
    // For `manual` / `api` / `public_link` runs the original r2Key already
    // lives in the default FILES bucket, so the worker can read it directly
    // and we re-use it. For `s3` runs the bytes came from the per-connector
    // bucket (not bound to the Worker), so we must persist a copy into FILES
    // under the standard connector-drops prefix for the worker to pick up.
    let enqueueR2Key = r2Key;
    if (runSource === 's3') {
      const safeName = (payload.fileName || 'file')
        .replace(/[^A-Za-z0-9._-]+/g, '_')
        .slice(0, 200);
      const isoStamp = new Date().toISOString().replace(/[:.]/g, '-');
      enqueueR2Key = `connector-drops/${connector.id}/${isoStamp}-${safeName}`;
      await context.env.FILES.put(enqueueR2Key, payload.buffer, {
        httpMetadata: { contentType: payload.contentType },
        customMetadata: {
          connector_id: connector.id,
          tenant_id: connector.tenant_id,
          source: 's3',
          original_name: payload.fileName,
        },
      });
    }

    const checksum = await computeChecksum(payload.buffer);

    // New batch ROLLUP HEADER for the retry; linked to the original via
    // retry_of_run_id below.
    const connectorRunId = await createConnectorRunHeader(context.env.DB, {
      connectorId: connector.id,
      tenantId: connector.tenant_id,
      source: runSource,
    });

    const { queueId } = await enqueueDocument(context.env.DB, {
      id: generateId(),
      tenantId: connector.tenant_id,
      documentTypeId: connector.document_type_id,
      fileR2Key: enqueueR2Key,
      fileName: payload.fileName,
      fileSize: payload.buffer.byteLength,
      mimeType: payload.contentType || 'application/octet-stream',
      checksum,
      // Manual retry is admin-driven, so attribute it.
      createdBy: user.id,
      source: runSource,
      sourceDetail: connector.name ? `connector:${connector.name}` : `connector:${connector.id}`,
      outputKind: connector.output_kind,
      sourceId: connector.id,
      supplierId: connector.supplier_id,
      connectorRunId,
    });

    // Patch the new run row's retry_of_run_id so the UI can fold the chain
    // together. Wrapped in a try so an environment missing migration 0052
    // silently degrades to "no link" rather than 500ing.
    try {
      await context.env.DB
        .prepare(
          `UPDATE connector_runs SET retry_of_run_id = ? WHERE id = ?`,
        )
        .bind(run.id, connectorRunId)
        .run();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('no such column')) {
        console.warn(`retry: failed to write retry_of_run_id:`, msg);
      }
    }

    // Record the (possibly new) R2 key as processed so the poller doesn't
    // re-enqueue it.
    try {
      await context.env.DB.prepare(
        `INSERT OR IGNORE INTO connector_processed_keys
           (id, connector_id, r2_key, processed_at, run_id)
         VALUES (?, ?, ?, ?, ?)`,
      )
        .bind(generateId(), connector.id, enqueueR2Key, Date.now(), connectorRunId)
        .run();
    } catch (err) {
      console.warn(`retry: failed to write processed_keys for ${enqueueR2Key}:`, err);
    }

    return new Response(
      JSON.stringify({
        queued: true,
        queue_id: queueId,
        run_id: connectorRunId,
        retry_of_run_id: run.id,
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
