/**
 * Scheduled S3-bucket poller — Phase B3 universal-doors model.
 *
 * Each connector that has been provisioned with an R2 bucket
 * (`connectors.r2_bucket_name IS NOT NULL`) opts into the 5-minute
 * cron poll. The poller:
 *
 *   1. Discovers active, non-deleted connectors with a non-NULL
 *      bucket name.
 *   2. Decrypts the connector's R2 secret access key.
 *   3. Issues a SigV4-signed `ListObjectsV2` against the bucket via
 *      R2's S3-compatible endpoint
 *      (https://<account>.r2.cloudflarestorage.com/<bucket>).
 *   4. Filters out keys already present in `connector_processed_keys`
 *      (migration 0046).
 *   5. SigV4-signs a GET for each new key, pulls the bytes inline,
 *      and dispatches via `executeConnectorRun({ source: 's3', ... })`.
 *   6. Records the `(connector_id, r2_key)` dedup row on success.
 *
 * Per-tick caps: 100 keys listed per connector, 25 dispatched
 * globally. Identical numbers to the legacy `r2_prefix` poller — same
 * cron budget.
 *
 * Failure handling matches the previous incarnation: per-record errors
 * captured in the run row but the dedup row IS written (re-running
 * won't fix a malformed CSV); throwing errors leave the dedup row
 * unwritten so the next tick retries.
 *
 * Legacy `config.r2_prefix` mode is removed — every R2 drop now lives
 * in its own per-connector bucket.
 */

import { AwsClient } from 'aws4fetch';
import type { Env } from '../types';
import { generateId } from '../db';
import { decryptCredentials } from './crypto';
import { decryptIntakeSecret } from '../intakeEncryption';
import { executeConnectorRun } from './orchestrator';
import { normalizeFieldMappings } from '../../../shared/fieldMappings';

/** Per-tick budgets. */
export const MAX_FILES_PER_TICK = 25;
export const MAX_KEYS_PER_CONNECTOR = 100;

interface ConnectorRow {
  id: string;
  tenant_id: string;
  config: string | null;
  field_mappings: string | null;
  credentials_encrypted: string | null;
  credentials_iv: string | null;
  r2_bucket_name: string;
  r2_access_key_id: string | null;
  r2_secret_access_key_encrypted: string | null;
}

export interface PollConnectorSummary {
  connector_id: string;
  bucket: string;
  listed: number;
  dispatched: number;
  skipped_already_processed: number;
  errors: string[];
}

export interface PollSummary {
  connectors_checked: number;
  total_dispatched: number;
  total_errors: number;
  per_connector: PollConnectorSummary[];
  truncated: boolean;
}

function basename(key: string): string {
  const idx = key.lastIndexOf('/');
  return idx >= 0 ? key.slice(idx + 1) : key;
}

function parseConfig(rawConfig: string | null): Record<string, unknown> {
  if (!rawConfig) return {};
  try {
    const parsed = JSON.parse(rawConfig);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* fallthrough */
  }
  return {};
}

function parseFieldMappings(raw: string | null): unknown {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/**
 * Extract `<Key>...</Key>` values from an S3 ListObjectsV2 XML
 * response. R2 returns a standard S3-compatible XML envelope; we
 * extract the keys via a tight regex rather than pulling in a full
 * XML parser. This is deliberate — the LIST response shape is stable
 * and we only need the key strings.
 *
 * Exported for unit testing.
 */
export function parseListKeys(xml: string): string[] {
  const out: string[] = [];
  const re = /<Key>([^<]+)<\/Key>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    // Decode the handful of XML entities S3 emits in keys.
    const decoded = m[1]
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");
    out.push(decoded);
  }
  return out;
}

/**
 * Build an S3-compat AwsClient bound to a single connector's
 * credentials. Region is always `auto` for R2.
 */
function makeAwsClient(accessKeyId: string, secretAccessKey: string): AwsClient {
  return new AwsClient({
    accessKeyId,
    secretAccessKey,
    service: 's3',
    region: 'auto',
  });
}

/**
 * SigV4-signed ListObjectsV2 request to R2's S3-compat endpoint.
 * Returns the raw key list capped to MAX_KEYS_PER_CONNECTOR by the
 * `max-keys` query param.
 */
async function listBucketKeys(
  aws: AwsClient,
  endpoint: string,
  bucket: string,
): Promise<string[]> {
  const url =
    `${endpoint}/${bucket}/?list-type=2&max-keys=${MAX_KEYS_PER_CONNECTOR}`;
  const res = await aws.fetch(url, { method: 'GET' });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`S3 LIST failed: ${res.status} ${body.slice(0, 200)}`);
  }
  const xml = await res.text();
  return parseListKeys(xml);
}

/**
 * SigV4-signed GET against R2 for a single object. Returns the file
 * bytes + content type header as reported by R2 (which we forward
 * into the orchestrator so the parser routes correctly).
 */
async function getBucketObject(
  aws: AwsClient,
  endpoint: string,
  bucket: string,
  key: string,
): Promise<{ buffer: ArrayBuffer; contentType: string }> {
  // S3 path-style: /<bucket>/<key>. Encode each path segment so keys
  // with spaces or `+` round-trip correctly.
  const encodedKey = key
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
  const url = `${endpoint}/${bucket}/${encodedKey}`;
  const res = await aws.fetch(url, { method: 'GET' });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`S3 GET failed: ${res.status} ${body.slice(0, 200)}`);
  }
  const contentType =
    res.headers.get('content-type') || 'application/octet-stream';
  const buffer = await res.arrayBuffer();
  return { buffer, contentType };
}

/**
 * Poll all active connectors that have an R2 bucket provisioned and
 * dispatch a run for each new object. Never throws under normal
 * operation — per-connector failures land in the summary's `errors`
 * array.
 */
export async function pollAllR2Connectors(env: Env): Promise<PollSummary> {
  const result: PollSummary = {
    connectors_checked: 0,
    total_dispatched: 0,
    total_errors: 0,
    per_connector: [],
    truncated: false,
  };

  if (!env.CLOUDFLARE_ACCOUNT_ID) {
    // Fail closed: without an account id we can't address R2's S3 endpoint.
    // Tick returns an empty summary so the cron worker doesn't blow up.
    return result;
  }
  const endpoint = `https://${env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`;

  const rows = await env.DB
    .prepare(
      `SELECT id, tenant_id, config, field_mappings,
              credentials_encrypted, credentials_iv,
              r2_bucket_name, r2_access_key_id,
              r2_secret_access_key_encrypted
         FROM connectors
        WHERE active = 1
          AND deleted_at IS NULL
          AND r2_bucket_name IS NOT NULL
          AND r2_access_key_id IS NOT NULL
          AND r2_secret_access_key_encrypted IS NOT NULL`,
    )
    .all<ConnectorRow>();

  const connectors = rows.results ?? [];

  for (const row of connectors) {
    if (result.total_dispatched >= MAX_FILES_PER_TICK) {
      result.truncated = true;
      break;
    }

    result.connectors_checked++;

    const summary: PollConnectorSummary = {
      connector_id: row.id,
      bucket: row.r2_bucket_name,
      listed: 0,
      dispatched: 0,
      skipped_already_processed: 0,
      errors: [],
    };

    try {
      // Decrypt the per-connector vendor secret. If decryption fails
      // (e.g. INTAKE_ENCRYPTION_KEY rotated without re-provisioning),
      // skip this connector — we can't sign requests without the
      // secret, and surfacing the error in the summary is more useful
      // than silently 0-listing.
      let secret: string;
      try {
        secret = await decryptIntakeSecret(
          row.r2_secret_access_key_encrypted as string,
          env as Env & { INTAKE_ENCRYPTION_KEY: string },
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        summary.errors.push(`decrypt secret failed: ${msg}`);
        result.total_errors++;
        result.per_connector.push(summary);
        continue;
      }

      const aws = makeAwsClient(row.r2_access_key_id as string, secret);

      const keys = await listBucketKeys(aws, endpoint, row.r2_bucket_name);
      summary.listed = keys.length;

      const config = parseConfig(row.config);
      const fieldMappings = normalizeFieldMappings(
        parseFieldMappings(row.field_mappings),
      );

      let credentials: Record<string, unknown> | undefined;
      if (
        row.credentials_encrypted &&
        row.credentials_iv &&
        env.CONNECTOR_ENCRYPTION_KEY
      ) {
        try {
          credentials = await decryptCredentials(
            row.credentials_encrypted,
            row.credentials_iv,
            env.CONNECTOR_ENCRYPTION_KEY,
            row.tenant_id,
            row.id,
          );
        } catch {
          credentials = undefined;
        }
      }

      for (const key of keys) {
        if (result.total_dispatched >= MAX_FILES_PER_TICK) {
          result.truncated = true;
          break;
        }

        // Dedup: skip if we've already dispatched a run for this
        // (connector, bucket-key) pair.
        const existing = await env.DB
          .prepare(
            `SELECT 1 FROM connector_processed_keys
              WHERE connector_id = ? AND r2_key = ?
              LIMIT 1`,
          )
          .bind(row.id, key)
          .first<{ '1': number }>();

        if (existing) {
          summary.skipped_already_processed++;
          continue;
        }

        try {
          // Pull the file bytes via SigV4 — the per-connector bucket
          // isn't bound to the Worker, so the orchestrator can't
          // resolve the key from `ctx.r2`. We pass `content` inline
          // and a synthetic R2 key for the run row.
          const { buffer, contentType } = await getBucketObject(
            aws,
            endpoint,
            row.r2_bucket_name,
            key,
          );

          const runResult = await executeConnectorRun({
            db: env.DB,
            r2: env.FILES,
            tenantId: row.tenant_id,
            connectorId: row.id,
            config,
            fieldMappings,
            credentials,
            input: {
              type: 'file_watch',
              fileName: basename(key),
              contentType,
              // Synthetic R2 reference — the actual bytes ride the
              // `content` channel since the per-connector bucket
              // isn't bound to the Worker.
              r2Key: `s3://${row.r2_bucket_name}/${key}`,
              content: buffer,
            },
            // 's3' tags this run so the activity feed can distinguish
            // S3-bucket polls from manual / API drops / email runs.
            source: 's3',
            qwenUrl: env.QWEN_URL,
            qwenSecret: env.QWEN_SECRET,
          });

          await env.DB
            .prepare(
              `INSERT OR IGNORE INTO connector_processed_keys
                 (id, connector_id, r2_key, processed_at, run_id)
               VALUES (?, ?, ?, ?, ?)`,
            )
            .bind(generateId(), row.id, key, Date.now(), runResult.runId)
            .run();

          summary.dispatched++;
          result.total_dispatched++;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          summary.errors.push(`${key}: ${msg}`);
          result.total_errors++;
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      summary.errors.push(`list/dispatch failed: ${msg}`);
      result.total_errors++;
    }

    result.per_connector.push(summary);
  }

  return result;
}
