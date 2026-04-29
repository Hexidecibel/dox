/**
 * Scheduled R2-prefix poller for `file_watch` connectors.
 *
 * Companion to `executeConnectorRun` — does NOT reimplement run/dedup
 * logic locally. The poller is responsible for:
 *
 *   1. Discovering active `file_watch` connectors with a non-empty
 *      `config.r2_prefix` value.
 *   2. Listing R2 objects under each prefix (bounded).
 *   3. Filtering out keys we've already dispatched (via the
 *      `connector_processed_keys` table — migration 0046).
 *   4. Calling `executeConnectorRun` for each new key.
 *   5. On non-throwing run completion, recording the `(connector_id,
 *      r2_key)` pair so the next tick skips it.
 *
 * On run failure (executor throws), we deliberately do NOT mark the key
 * as processed — `connector_runs` already captured the error, and the
 * next tick will retry. Status="error" runs (errors collected on the
 * output) DO get the dedup row written: they completed without
 * throwing, just had per-record problems. Reprocessing them would
 * stamp another `connector_runs` row with the same errors.
 *
 * This file MUST stay pure backend — no React, no MUI, no DOM types.
 * It's invoked from `functions/api/connectors/poll.ts` (driven by the
 * companion Worker `workers/connector-poller/`).
 */

import type { Env } from '../types';
import { generateId } from '../db';
import { decryptCredentials } from './crypto';
import { executeConnectorRun } from './orchestrator';
import { normalizeFieldMappings } from '../../../shared/fieldMappings';

/**
 * Per-tick budget. A burst of new files across many connectors must not
 * blow the cron budget — we cap dispatch volume globally and per-list.
 */
export const MAX_FILES_PER_TICK = 25;
export const MAX_KEYS_PER_CONNECTOR = 100;

interface ConnectorRow {
  id: string;
  tenant_id: string;
  config: string | null;
  field_mappings: string | null;
  credentials_encrypted: string | null;
  credentials_iv: string | null;
}

export interface PollConnectorSummary {
  connector_id: string;
  prefix: string;
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

/**
 * Resolve the basename of an R2 key — strip directory components.
 *
 * The fileWatch executor uses `fileName` for content-type inference and
 * for writing into the orchestrator's `info` channel. Keeping it as the
 * basename matches manual-upload semantics (where the user drops
 * `coa-2026-04-29.pdf`, not `imports/test/coa-2026-04-29.pdf`).
 */
function basename(key: string): string {
  const idx = key.lastIndexOf('/');
  return idx >= 0 ? key.slice(idx + 1) : key;
}

/**
 * Pluck `config.r2_prefix` from a stored JSON blob safely.
 * Returns `null` for missing/empty/non-string values.
 */
function readPrefix(rawConfig: string | null): string | null {
  if (!rawConfig) return null;
  try {
    const parsed = JSON.parse(rawConfig);
    if (parsed && typeof parsed === 'object') {
      const v = (parsed as Record<string, unknown>).r2_prefix;
      if (typeof v === 'string' && v.trim().length > 0) {
        return v;
      }
    }
  } catch {
    /* fallthrough */
  }
  return null;
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
 * Poll all active file_watch connectors that have a non-empty
 * `config.r2_prefix` and dispatch a run for each new R2 object found.
 *
 * Returns a summary describing what was checked / dispatched. Never
 * throws under normal operation: per-connector failures are captured
 * in the summary's `errors` array.
 */
export async function pollAllR2Connectors(env: Env): Promise<PollSummary> {
  const result: PollSummary = {
    connectors_checked: 0,
    total_dispatched: 0,
    total_errors: 0,
    per_connector: [],
    truncated: false,
  };

  // Find active, non-deleted file_watch connectors with a configured
  // r2_prefix. JSON_EXTRACT works on D1 (SQLite) for our simple top-level
  // key — null/missing values won't satisfy the LIKE so empty configs are
  // filtered server-side. We still re-validate prefix in JS because
  // JSON_EXTRACT on a string config that happens to be invalid JSON would
  // silently return NULL and we'd want to log it.
  const rows = await env.DB
    .prepare(
      `SELECT id, tenant_id, config, field_mappings,
              credentials_encrypted, credentials_iv
         FROM connectors
        WHERE connector_type = 'file_watch'
          AND active = 1
          AND deleted_at IS NULL
          AND JSON_EXTRACT(config, '$.r2_prefix') IS NOT NULL
          AND TRIM(JSON_EXTRACT(config, '$.r2_prefix')) <> ''`
    )
    .all<ConnectorRow>();

  const connectors = rows.results ?? [];

  for (const row of connectors) {
    if (result.total_dispatched >= MAX_FILES_PER_TICK) {
      result.truncated = true;
      break;
    }

    const prefix = readPrefix(row.config);
    if (!prefix) continue; // shouldn't happen given the SQL filter

    result.connectors_checked++;

    const summary: PollConnectorSummary = {
      connector_id: row.id,
      prefix,
      listed: 0,
      dispatched: 0,
      skipped_already_processed: 0,
      errors: [],
    };

    try {
      const listed = await env.FILES.list({
        prefix,
        limit: MAX_KEYS_PER_CONNECTOR,
      });

      summary.listed = listed.objects.length;

      // Pre-decode config / mappings / credentials once per connector.
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

      for (const obj of listed.objects) {
        if (result.total_dispatched >= MAX_FILES_PER_TICK) {
          result.truncated = true;
          break;
        }

        const key = obj.key;

        // Dedup: skip if we've already dispatched a run for this
        // (connector, r2_key) pair.
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
          const runResult = await executeConnectorRun({
            db: env.DB,
            r2: env.FILES,
            tenantId: row.tenant_id,
            connectorId: row.id,
            connectorType: 'file_watch',
            config,
            fieldMappings,
            credentials,
            input: {
              type: 'file_watch',
              fileName: basename(key),
              r2Key: key,
            },
            // userId omitted — scheduled runs aren't user-attributed.
            // The orchestrator's audit-log call is gated on userId, so
            // this just skips the audit row (run row is still written).
            qwenUrl: env.QWEN_URL,
            qwenSecret: env.QWEN_SECRET,
          });

          // Record dedup AFTER the run completes without throwing.
          // status='error' (per-record errors but the executor didn't
          // throw) still gets a dedup row — reprocessing wouldn't fix
          // the underlying file format issue, and the run row already
          // captures the error for the user.
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
          // Executor threw — DO NOT mark as processed. The next tick
          // will retry. Capture the error for the response so the
          // operator can see what happened without tailing logs.
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
