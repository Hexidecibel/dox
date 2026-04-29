/**
 * Helpers shared across the Records update-request endpoints (admin +
 * public). The flow is intentionally separate from records_forms — see
 * migration 0044 for the schema and the rationale.
 *
 * Conventions match `forms.ts`:
 *   - JSON columns are parsed with tolerant try/catch.
 *   - Tenant scoping is enforced at the query level (caller passes
 *     tenant_id + the query filters by tenant_id) — no cross-tenant
 *     joins anywhere.
 *   - Public endpoints use 404-or-success only, never 403, so a token
 *     can't be probed for existence.
 */

import { generateId } from '../db';
import {
  parseRowData,
  rebuildRowRefs,
  computeDisplayTitle,
  logRecordsActivity,
  refTypeForColumn,
} from './helpers';
import { BadRequestError, NotFoundError } from '../permissions';
import type {
  RecordColumnRow,
  RecordRowData,
  RecordUpdateRequestRow,
  PublicFormFieldDef,
} from '../../../shared/types';

/** Token entropy: 32 bytes -> base64url ~43 chars. Way past 24 chars. */
export function generateUpdateRequestToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

/** Default expiry window for new update requests (30 days). */
const DEFAULT_EXPIRY_DAYS = 30;

/**
 * Compute the expires_at string for a new request. Caller's explicit
 * value wins; otherwise we default to 30 days. Pass `null` to disable.
 */
export function computeExpiresAt(input: string | null | undefined): string | null {
  if (input === null) return null;
  if (typeof input === 'string' && input.trim()) return input;
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + DEFAULT_EXPIRY_DAYS);
  return d.toISOString();
}

/** Parse the JSON fields_requested column into a string[]. */
export function parseFieldsRequested(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v.filter((k): k is string => typeof k === 'string' && !!k);
  } catch {
    return [];
  }
}

/**
 * Validate an incoming fields_requested array against a sheet's columns.
 * Drops formula/rollup/attachment columns (those can't be filled by the
 * recipient — see the same restriction in forms.validateSubmission).
 *
 * Throws BadRequestError on empty selection or unknown keys so the user
 * gets a usable error message in the modal.
 */
export function normalizeFieldsRequested(
  input: unknown,
  columns: RecordColumnRow[],
): string[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new BadRequestError('Pick at least one field for the recipient to fill.');
  }
  const keys = input
    .filter((k): k is string => typeof k === 'string' && !!k)
    .map((k) => k.trim())
    .filter((k) => !!k);
  if (keys.length === 0) {
    throw new BadRequestError('Pick at least one field for the recipient to fill.');
  }

  const validKeys = new Set(
    columns
      .filter((c) => c.archived === 0)
      .filter((c) => c.type !== 'formula' && c.type !== 'rollup' && c.type !== 'attachment')
      .map((c) => c.key),
  );

  const seen = new Set<string>();
  const out: string[] = [];
  for (const k of keys) {
    if (!validKeys.has(k)) {
      throw new BadRequestError(`"${k}" is not a fillable column on this sheet.`);
    }
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return out;
}

/**
 * Build a PublicFormFieldDef[] for ONLY the requested keys. Mirrors the
 * shape buildPublicFormView produces so the recipient form can reuse
 * PublicFormRenderer with no special-casing.
 */
export function buildRequestFields(
  columns: RecordColumnRow[],
  requestedKeys: string[],
): PublicFormFieldDef[] {
  const colsByKey = new Map(columns.map((c) => [c.key, c]));
  const fields: PublicFormFieldDef[] = [];
  let position = 0;
  for (const key of requestedKeys) {
    const col = colsByKey.get(key);
    if (!col || col.archived) continue;
    if (col.type === 'formula' || col.type === 'rollup' || col.type === 'attachment') continue;

    let config = null;
    if (col.config) {
      try {
        config = JSON.parse(col.config);
      } catch {
        config = null;
      }
    }
    fields.push({
      key: col.key,
      type: col.type,
      label: col.label,
      help_text: null,
      required: col.required === 1,
      config,
      position: position++,
    });
  }
  return fields;
}

/**
 * Pick only the requested keys out of a full row's data. Returned object
 * is a new copy (never the row's parsed JSON itself).
 */
export function pickCurrentValues(
  data: RecordRowData,
  requestedKeys: string[],
): RecordRowData {
  const out: RecordRowData = {};
  for (const key of requestedKeys) {
    if (key in data) out[key] = data[key];
  }
  return out;
}

/**
 * Determine whether a request is currently fillable. Returns null when
 * yes, or a string reason when not (status not pending, expired, etc).
 * The reason is logged but never returned to the recipient — the public
 * GET 404s on any non-fillable state to avoid leaking the lifecycle.
 */
export function getUnavailableReason(req: RecordUpdateRequestRow): string | null {
  if (req.status !== 'pending') return `status=${req.status}`;
  if (req.expires_at) {
    const exp = Date.parse(req.expires_at);
    if (!Number.isNaN(exp) && exp <= Date.now()) return 'expired';
  }
  return null;
}

/**
 * Apply a recipient's submitted values to the row. Server enforces the
 * fields_requested whitelist regardless of what the body contains, so a
 * recipient can't sneak an extra column write past the gate.
 *
 * Returns the count of cells actually changed (used as the activity
 * detail + the response).
 */
export async function applyUpdateRequestSubmission(
  db: D1Database,
  params: {
    request: RecordUpdateRequestRow;
    columns: RecordColumnRow[];
    submittedData: RecordRowData;
  },
): Promise<{ changes: Array<{ column_key: string; from: unknown; to: unknown }> }> {
  const { request, columns, submittedData } = params;
  const requestedKeys = parseFieldsRequested(request.fields_requested);

  // Load the current row so we can diff per-cell for the activity log.
  const row = await db
    .prepare(
      'SELECT id, sheet_id, tenant_id, data FROM records_rows WHERE id = ? AND sheet_id = ?',
    )
    .bind(request.row_id, request.sheet_id)
    .first<{ id: string; sheet_id: string; tenant_id: string; data: string | null }>();

  if (!row) {
    // Row was archived/deleted between request creation and recipient
    // submit. Treat as unavailable — same shape as the public 404 case.
    throw new NotFoundError('This request is no longer valid.');
  }

  const data = parseRowData(row.data);
  const colsByKey = new Map(columns.map((c) => [c.key, c]));

  const changes: Array<{ column_key: string; from: unknown; to: unknown }> = [];
  let touchedRefColumn = false;
  let touchedTitleColumn = false;

  for (const key of requestedKeys) {
    if (!(key in submittedData)) continue;
    const col = colsByKey.get(key);
    if (!col || col.archived) continue;
    if (col.type === 'formula' || col.type === 'rollup' || col.type === 'attachment') continue;

    const newValue = submittedData[key];
    const prevValue = data[key];
    // Cheap structural equality via JSON — same approach the cell PATCH
    // could use; since we're inside a request-handler hot path with at
    // most a few keys it's fine.
    if (JSON.stringify(prevValue ?? null) === JSON.stringify(newValue ?? null)) {
      continue;
    }
    data[key] = newValue;
    changes.push({ column_key: key, from: prevValue ?? null, to: newValue ?? null });
    if (refTypeForColumn(col.type)) touchedRefColumn = true;
    if (col.is_title === 1) touchedTitleColumn = true;
  }

  if (changes.length === 0) {
    return { changes };
  }

  const nextDisplayTitle = touchedTitleColumn
    ? computeDisplayTitle(columns, data)
    : undefined;

  if (nextDisplayTitle !== undefined) {
    await db
      .prepare(
        `UPDATE records_rows
           SET data = ?, display_title = ?, updated_at = datetime('now')
         WHERE id = ?`,
      )
      .bind(JSON.stringify(data), nextDisplayTitle, row.id)
      .run();
  } else {
    await db
      .prepare(
        `UPDATE records_rows
           SET data = ?, updated_at = datetime('now')
         WHERE id = ?`,
      )
      .bind(JSON.stringify(data), row.id)
      .run();
  }

  if (touchedRefColumn) {
    await rebuildRowRefs(db, row.tenant_id, row.sheet_id, row.id, columns, data);
  }

  return { changes };
}

/**
 * Mark the request as responded. Idempotent on the SQL side — a second
 * submit (e.g. browser refresh racing the response) will UPDATE 0 rows
 * because the WHERE clause includes status='pending'.
 */
export async function markRequestResponded(
  db: D1Database,
  requestId: string,
): Promise<boolean> {
  const res = await db
    .prepare(
      `UPDATE records_update_requests
         SET status = 'responded', responded_at = datetime('now')
       WHERE id = ? AND status = 'pending'`,
    )
    .bind(requestId)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

/** Re-export for callers. */
export { parseRowData };

// Helper used by adminEndpoints to expand a result row into the
// RecordUpdateRequest API shape.
export function hydrateUpdateRequest(
  row: RecordUpdateRequestRow & { creator_name?: string | null; row_display_title?: string | null },
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _opts?: undefined,
): import('../../../shared/types').RecordUpdateRequest {
  // Strip the token from the projection — admins never see it after
  // create.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { token: _token, ...rest } = row;
  return {
    ...rest,
    fields_requested_keys: parseFieldsRequested(row.fields_requested),
  };
}
