/**
 * POST /api/sources/:id/drop
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
import { resolveConnectorHandle } from '../../../lib/connectors/resolveHandle';
import { computeChecksum } from '../../../lib/r2';
import { enqueueDocument } from '../../../lib/intake/enqueue';
import { createConnectorRunHeader } from '../../../lib/intake/connectorRunHeader';
import { checkRateLimit, recordAttempt } from '../../../lib/ratelimit';
import type { Env } from '../../../lib/types';

// Phase B5 — per-connector drop rate limit. The vendor-facing API drop
// + public-link doors share a single 60-requests-per-60-second sliding
// window keyed by `connector:drop:<connector_id>`. S3 drops, manual
// uploads and email ingest are not rate-limited here (S3 has its own
// metering, manual is admin-authenticated, email comes through the
// email-worker bridge already debounced).
const DROP_RATE_LIMIT_MAX = 60;
const DROP_RATE_LIMIT_WINDOW_SEC = 60;

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

/**
 * Build the 429 response on rate-limit hit. We surface a `Retry-After`
 * seconds header so vendor automation that respects RFC 7231 backs off
 * cleanly without polling-storming us. The body mirrors the public
 * shape: `{ error, retry_after }`.
 */
function rateLimited(retryAfterSec: number): Response {
  const seconds = Math.max(1, Math.ceil(retryAfterSec));
  return new Response(
    JSON.stringify({ error: 'rate_limited', retry_after: seconds }),
    {
      status: 429,
      headers: {
        'Content-Type': 'application/json',
        'Retry-After': String(seconds),
      },
    },
  );
}

interface ConnectorRow {
  id: string;
  name: string | null;
  tenant_id: string;
  active: number;
  deleted_at: string | null;
  // Sources routing fields (migration 0067) — tag the queue row so the
  // worker + Review Queue know how to handle the doc.
  output_kind: string | null;
  supplier_id: string | null;
  document_type_id: string | null;
  api_token: string | null;
  // Phase B4 — public drop link auth. The drop endpoint accepts a
  // bearer that matches EITHER `api_token` (vendor-facing API door,
  // long-lived) OR `public_link_token` (public form, optionally
  // expiring). Both are checked in constant time; the public-link
  // token is rejected if `public_link_expires_at` is in the past.
  public_link_token: string | null;
  public_link_expires_at: number | null;
}

/**
 * Result of the dual-auth gate. `'api'` means the bearer matched
 * `api_token`; `'public_link'` means it matched `public_link_token`
 * and the link wasn't expired. `null` means no match — caller returns
 * 401.
 */
type AuthMatch = 'api' | 'public_link' | null;

function checkAuth(connector: ConnectorRow, provided: string): AuthMatch {
  // API token path: long-lived, never expires.
  if (
    connector.api_token &&
    constantTimeEquals(provided, connector.api_token)
  ) {
    return 'api';
  }
  // Public-link token path: optional expiry. We do the constant-time
  // compare BEFORE the expiry check so the expiry branch is only
  // visited when the token actually matches — keeps the timing
  // shape independent of the expiry state.
  if (
    connector.public_link_token &&
    constantTimeEquals(provided, connector.public_link_token)
  ) {
    if (
      connector.public_link_expires_at !== null &&
      connector.public_link_expires_at < Math.floor(Date.now() / 1000)
    ) {
      return null;
    }
    return 'public_link';
  }
  return null;
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
        'id, name, tenant_id, active, deleted_at, api_token, ' +
        'public_link_token, public_link_expires_at, ' +
        'output_kind, supplier_id, document_type_id',
    },
  );

  if (!connector || connector.deleted_at !== null || !connector.active) {
    console.warn(`drop: connector ${connectorHandle} not found / inactive / deleted`);
    return unauthorized();
  }

  if (!connector.api_token && !connector.public_link_token) {
    // Connector exists but has neither auth path enabled — treat as
    // missing for partner-facing purposes. The owner needs to either
    // generate an api_token or a public_link before this door works.
    console.warn(
      `drop: connector ${connector.id} has neither api_token nor public_link_token`,
    );
    return unauthorized();
  }

  const authMatch = checkAuth(connector, provided);
  if (authMatch === null) {
    console.warn(`drop: bearer mismatch / expired on connector ${connector.id}`);
    return unauthorized();
  }

  // ----- Rate limit (per connector) -----
  // Bearer-token and link-token paths share the same bucket so a
  // misbehaving public link can't dodge the limit by also rotating the
  // api_token, and vice versa. Keyed by connector_id alone — the only
  // gate we care about is "this connector is being hammered".
  const rateLimitKey = `connector:drop:${connector.id}`;
  const rateCheck = await checkRateLimit(
    context.env.DB,
    rateLimitKey,
    DROP_RATE_LIMIT_MAX,
    DROP_RATE_LIMIT_WINDOW_SEC,
  );
  if (!rateCheck.allowed) {
    const retryAfterSec = rateCheck.resetAt
      ? Math.ceil((new Date(rateCheck.resetAt).getTime() - Date.now()) / 1000)
      : DROP_RATE_LIMIT_WINDOW_SEC;
    console.warn(
      `drop: rate limit hit for connector ${connector.id} (key=${rateLimitKey})`,
    );
    return rateLimited(retryAfterSec);
  }
  // Record the attempt up front. We deliberately count failed-validation
  // attempts (bad MIME / oversize body) so a vendor spamming garbage
  // still trips the limit — otherwise abuse vectors that never reach
  // the dispatch step would slip past.
  await recordAttempt(
    context.env.DB,
    rateLimitKey,
    DROP_RATE_LIMIT_WINDOW_SEC,
  );

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
        source: authMatch === 'public_link' ? 'public_link' : 'api',
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

  // ----- Enqueue (Connectors → Sources) -----
  // The drop door no longer runs the synchronous orchestrator. The file is
  // already in R2 above; we create a batch rollup header and enqueue the
  // file into processing_queue so it flows through the worker → Review
  // Queue. Nothing auto-ingests.
  const checksum = await computeChecksum(buffer);
  const doorSource = authMatch === 'public_link' ? 'public_link' : 'api';

  let connectorRunId: string;
  try {
    connectorRunId = await createConnectorRunHeader(context.env.DB, {
      connectorId: connector.id,
      tenantId: connector.tenant_id,
      source: doorSource,
    });
  } catch (err) {
    console.error(`drop: failed to create run header for ${connector.id}:`, err);
    return new Response(
      JSON.stringify({
        error: 'Run dispatch failed',
        details: err instanceof Error ? err.message : String(err),
      }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }

  let queueId: string;
  try {
    ({ queueId } = await enqueueDocument(context.env.DB, {
      id: generateId(),
      tenantId: connector.tenant_id,
      documentTypeId: connector.document_type_id,
      fileR2Key: r2Key,
      fileName: uploaded.name,
      fileSize: uploaded.size,
      mimeType: uploaded.type || 'application/octet-stream',
      checksum,
      // Vendor-driven, not user-attributed — same as the old orchestrator
      // path (userId omitted). created_by is nullable.
      createdBy: null,
      source: doorSource,
      sourceDetail: connector.name ? `connector:${connector.name}` : `connector:${connector.id}`,
      outputKind: connector.output_kind,
      sourceId: connector.id,
      supplierId: connector.supplier_id,
      connectorRunId,
    }));
  } catch (err) {
    console.error(`drop: enqueue failed for connector ${connector.id}:`, err);
    return new Response(
      JSON.stringify({
        error: 'Run dispatch failed',
        details: err instanceof Error ? err.message : String(err),
      }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }

  // ----- Mark processed for the R2 poller -----
  // INSERT OR IGNORE — if a previous attempt already wrote this row, we
  // don't want a unique-constraint blowup.
  try {
    await context.env.DB.prepare(
      `INSERT OR IGNORE INTO connector_processed_keys
         (id, connector_id, r2_key, processed_at, run_id)
       VALUES (?, ?, ?, ?, ?)`,
    )
      .bind(generateId(), connector.id, r2Key, Date.now(), connectorRunId)
      .run();
  } catch (err) {
    // Non-fatal: the file is already queued. Worst case the poller picks
    // it up once more and dedups on the queue side.
    console.warn(`drop: failed to write processed_keys for ${r2Key}:`, err);
  }

  return new Response(
    JSON.stringify({
      queued: true,
      queue_id: queueId,
      run_id: connectorRunId,
      file_key: r2Key,
      accepted_at: new Date().toISOString(),
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
