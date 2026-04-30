/**
 * POST /api/connectors/:id/drop
 *
 * Phase B2 — HTTP POST API intake door. Vendors hit this URL with their
 * own automation/scripts to drop a single file straight into the
 * connector's pipeline. No JWT, no API key — auth is a per-connector
 * bearer token (`connectors.api_token` from migration 0047) compared in
 * constant time against the `Authorization: Bearer <token>` header.
 *
 * The route is allowlisted in `functions/api/_middleware.ts` so it
 * bypasses the global JWT/API-key gate. This handler is the only gate.
 *
 * Body: multipart/form-data with a single `file` field. Same per-kind
 * size limits as the manual-upload endpoint (5 MB text / 10 MB binary).
 *
 * Flow:
 *   1. Look up connector by id (active + non-deleted only).
 *   2. Constant-time compare bearer against connector.api_token.
 *      Return a single generic 401 for any of:
 *        - missing/malformed Authorization header
 *        - connector doesn't exist
 *        - connector exists but token doesn't match
 *        - connector is inactive / soft-deleted
 *      Internally we log which arm was taken; over the wire the partner
 *      sees the same error so connector existence isn't probeable.
 *   3. Parse multipart, validate file size + extension via the shared
 *      classifier (same source of truth as the manual upload zone).
 *   4. Stash a copy in R2 under `connector-drops/<connector_id>/<iso>-<filename>`
 *      so the file is auditable + retryable + the future R2 poller can
 *      see it. The orchestrator runs against the inline buffer though —
 *      no second R2 read needed.
 *   5. Dispatch via `executeConnectorRun({ source: 'api', ... })`.
 *   6. Insert a `connector_processed_keys` row for the new R2 key so the
 *      poller doesn't double-process if a vendor also drops the same
 *      file into a watched prefix.
 *   7. Return 200 with `{ run_id, file_key, accepted_at, status, ... }`.
 *
 * Status code mapping:
 *   - 401 — auth (any flavour, see above)
 *   - 400 — missing `file` field
 *   - 413 — file exceeds the per-kind size cap
 *   - 415 — extension/MIME not in the accepted list
 *   - 200 — accepted (run dispatched; per-record errors live in the
 *           response body, not the status code)
 */

import { generateId } from '../../../lib/db';
import {
  ACCEPTED_CONNECTOR_FILE_EXTENSIONS,
  classifyConnectorFile,
} from '../../../../shared/connectorFileTypes';
import { decryptCredentials } from '../../../lib/connectors/crypto';
import { executeConnectorRun } from '../../../lib/connectors/orchestrator';
import { resolveConnectorHandle } from '../../../lib/connectors/resolveHandle';
import { normalizeFieldMappings } from '../../../../shared/fieldMappings';
import type { Env } from '../../../lib/types';

const TEXT_SIZE_LIMIT = 5 * 1024 * 1024; // 5 MB for CSV / TSV / TXT
const BINARY_SIZE_LIMIT = 10 * 1024 * 1024; // 10 MB for XLSX / PDF

/**
 * Constant-time string compare. Both sides must be strings of the same
 * encoding; we early-return false on length mismatch (length is not a
 * secret) but still do a full XOR walk for matching lengths so timing
 * doesn't leak the prefix that did match.
 */
function constantTimeEquals(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function unauthorized(): Response {
  // Single generic message regardless of which auth arm tripped — we do
  // not want to leak whether a connector exists at this URL.
  return new Response(
    JSON.stringify({ error: 'Invalid bearer token' }),
    { status: 401, headers: { 'Content-Type': 'application/json' } },
  );
}

function badRequest(message: string): Response {
  return new Response(
    JSON.stringify({ error: message }),
    { status: 400, headers: { 'Content-Type': 'application/json' } },
  );
}

function payloadTooLarge(message: string): Response {
  return new Response(
    JSON.stringify({ error: message }),
    { status: 413, headers: { 'Content-Type': 'application/json' } },
  );
}

function unsupportedMedia(message: string): Response {
  return new Response(
    JSON.stringify({ error: message }),
    { status: 415, headers: { 'Content-Type': 'application/json' } },
  );
}

interface ConnectorRow {
  id: string;
  tenant_id: string;
  active: number;
  deleted_at: string | null;
  api_token: string | null;
  config: string | null;
  field_mappings: string | null;
  credentials_encrypted: string | null;
  credentials_iv: string | null;
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  // Phase B0.5: the path param is named `id` in the route file but
  // accepts either the connector's slug or its random-hex id. We log
  // it as `handle` to keep the breadcrumb honest.
  const connectorHandle = context.params.id as string;

  // ----- Auth gate -----
  const authHeader = context.request.headers.get('Authorization') || '';
  if (!authHeader.toLowerCase().startsWith('bearer ')) {
    console.warn(`drop: missing bearer for connector ${connectorHandle}`);
    return unauthorized();
  }
  const provided = authHeader.slice('bearer '.length).trim();
  if (!provided) {
    return unauthorized();
  }

  // Look up the connector (active, non-deleted). We deliberately do NOT
  // 404 on missing — collapse all auth failure modes into a single 401
  // so an attacker can't enumerate connector handles by probing this URL.
  const connector = await resolveConnectorHandle<ConnectorRow>(
    context.env.DB,
    connectorHandle,
    {
      columns:
        'id, tenant_id, active, deleted_at, api_token, ' +
        'config, field_mappings, credentials_encrypted, credentials_iv',
    },
  );

  if (!connector || connector.deleted_at !== null || !connector.active) {
    console.warn(`drop: connector ${connectorHandle} not found / inactive / deleted`);
    return unauthorized();
  }

  if (!connector.api_token) {
    // Connector exists but has no token configured — treat as missing
    // for partner-facing purposes. The owner needs to generate one in
    // the UI before this door is usable.
    console.warn(`drop: connector ${connector.id} has no api_token configured`);
    return unauthorized();
  }

  if (!constantTimeEquals(provided, connector.api_token)) {
    console.warn(`drop: bearer mismatch on connector ${connector.id}`);
    return unauthorized();
  }

  // ----- Parse multipart body -----
  const contentType = context.request.headers.get('content-type') || '';
  if (!contentType.toLowerCase().includes('multipart/form-data')) {
    return badRequest('Drop requires multipart/form-data with a `file` field');
  }

  let formData: FormData;
  try {
    formData = await context.request.formData();
  } catch (err) {
    return badRequest(
      `Failed to parse multipart body: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const file = formData.get('file');
  if (!file || typeof file === 'string') {
    return badRequest('file is required (multipart form field "file")');
  }
  const uploaded = file as File;

  // ----- Validate file -----
  const { kind } = classifyConnectorFile(uploaded.name, uploaded.type);
  if (kind === 'unknown') {
    return unsupportedMedia(
      `Unsupported file type: ${uploaded.name}. Accepted: ${ACCEPTED_CONNECTOR_FILE_EXTENSIONS.join(', ')}`,
    );
  }
  const limit = kind === 'text' ? TEXT_SIZE_LIMIT : BINARY_SIZE_LIMIT;
  if (uploaded.size > limit) {
    return payloadTooLarge(
      `File too large (${uploaded.size} bytes, limit ${limit}). Split the file and try again.`,
    );
  }

  const buffer = await uploaded.arrayBuffer();

  // ----- Stash in R2 -----
  // Key shape: connector-drops/<connector_id>/<iso>-<filename>. The ISO
  // timestamp guarantees uniqueness even if a vendor sends the same
  // filename twice in the same minute, and keeps the prefix pruneable
  // by date if we ever need a sweep job. We slug the filename lightly to
  // avoid leaking unsanitised user input into R2 keys.
  const safeName = (uploaded.name || 'file')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .slice(0, 200);
  const isoStamp = new Date().toISOString().replace(/[:.]/g, '-');
  const r2Key = `connector-drops/${connector.id}/${isoStamp}-${safeName}`;

  try {
    await context.env.FILES.put(r2Key, buffer, {
      httpMetadata: {
        contentType: uploaded.type || 'application/octet-stream',
      },
      customMetadata: {
        connector_id: connector.id,
        tenant_id: connector.tenant_id,
        source: 'api',
        original_name: uploaded.name,
      },
    });
  } catch (err) {
    console.error(`drop: R2 put failed for ${r2Key}:`, err);
    return new Response(
      JSON.stringify({ error: 'Failed to persist file to storage' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }

  // ----- Decode connector config / credentials -----
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

  // ----- Dispatch -----
  // The API drop door reuses the file_watch executor — same parser, same
  // orchestrator tail. The only difference is `source: 'api'` so the
  // run can be filtered/grouped distinctly downstream.
  let runResult: Awaited<ReturnType<typeof executeConnectorRun>>;
  try {
    runResult = await executeConnectorRun({
      db: context.env.DB,
      r2: context.env.FILES,
      tenantId: connector.tenant_id,
      connectorId: connector.id,
      config,
      fieldMappings,
      credentials,
      input: {
        type: 'file_watch',
        fileName: uploaded.name,
        contentType: uploaded.type || undefined,
        r2Key,
        content: buffer,
      },
      source: 'api',
      // userId omitted — vendor-driven, not user-attributed. Audit log
      // for the run dispatch lives on the run row's `details` blob.
      qwenUrl: context.env.QWEN_URL,
      qwenSecret: context.env.QWEN_SECRET,
    });
  } catch (err) {
    console.error(`drop: orchestrator threw for connector ${connector.id}:`, err);
    return new Response(
      JSON.stringify({
        error: 'Run dispatch failed',
        details: err instanceof Error ? err.message : String(err),
      }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }

  // ----- Mark processed for the R2 poller -----
  // INSERT OR IGNORE — if a previous attempt already wrote this row
  // (e.g. retried due to a transient downstream failure between
  // dispatch and dedup), we don't want a unique-constraint blowup.
  try {
    await context.env.DB.prepare(
      `INSERT OR IGNORE INTO connector_processed_keys
         (id, connector_id, r2_key, processed_at, run_id)
       VALUES (?, ?, ?, ?, ?)`,
    )
      .bind(generateId(), connector.id, r2Key, Date.now(), runResult.runId)
      .run();
  } catch (err) {
    // Non-fatal: the run already happened. Worst case the poller picks
    // up the file once more — `executeConnectorRun` is idempotent on
    // order/customer upserts.
    console.warn(`drop: failed to write processed_keys for ${r2Key}:`, err);
  }

  return new Response(
    JSON.stringify({
      run_id: runResult.runId,
      file_key: r2Key,
      accepted_at: new Date().toISOString(),
      status: runResult.status,
      orders_created: runResult.ordersCreated,
      customers_created: runResult.customersCreated,
      errors: runResult.errors,
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
};

// Friendly 405 on the wrong method so partners get an actionable message.
export const onRequestGet: PagesFunction<Env> = async () => {
  return new Response(
    JSON.stringify({ error: 'Use POST with multipart/form-data' }),
    { status: 405, headers: { 'Content-Type': 'application/json', Allow: 'POST' } },
  );
};
