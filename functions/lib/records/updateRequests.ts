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

import {
  parseRowData,
  rebuildRowRefs,
  computeDisplayTitle,
  refTypeForColumn,
} from './helpers';
import { BadRequestError, NotFoundError } from '../permissions';
import { validatePublicValues, type PublicFillField } from './forms';
import {
  isReferenceType,
  isUpdateRequestFieldType,
  projectColumnConfig,
  publicCellValue,
} from './publicView';
import type {
  RecordColumnRow,
  RecordRowData,
  RecordUpdateRequestRow,
  PublicFormFieldDef,
  PublicRecordValue,
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
 * Refuses computed and file columns, and (C-124) document, record and contact
 * columns: the recipient is an outsider, and those cells hold things an
 * outsider is neither shown nor allowed to choose (`isUpdateRequestFieldType`).
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
      .filter((c) => isUpdateRequestFieldType(c.type))
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
 * The columns a request's recipient is shown and may write, in the order
 * asked. ONE list for the page, the current values and the submit, so the
 * three cannot disagree. A key stored on a request made before document,
 * record and contact columns were excluded is simply not in it.
 */
export function requestFillFields(
  columns: RecordColumnRow[],
  requestedKeys: string[],
): PublicFillField[] {
  const colsByKey = new Map(columns.map((c) => [c.key, c]));
  const out: PublicFillField[] = [];
  const seen = new Set<string>();
  for (const key of requestedKeys) {
    const column = colsByKey.get(key);
    if (!column || column.archived || seen.has(key)) continue;
    if (!isUpdateRequestFieldType(column.type)) continue;
    seen.add(key);
    out.push({ column, label: column.label, required: column.required === 1 });
  }
  return out;
}

/**
 * Build a PublicFormFieldDef[] for ONLY the requested keys. Mirrors the
 * shape buildPublicFormView produces so the recipient form can reuse
 * PublicFormRenderer with no special-casing. Built field by field; a
 * column's config is projected per type. No field is a pick-list: a request
 * never publishes the organisation's customers, suppliers or products.
 */
export function buildRequestFields(
  columns: RecordColumnRow[],
  requestedKeys: string[],
): PublicFormFieldDef[] {
  return requestFillFields(columns, requestedKeys).map((f, position) => ({
    key: f.column.key,
    type: f.column.type,
    label: f.label,
    help_text: null,
    required: f.required,
    config: projectColumnConfig(f.column.type, f.column.config),
    position,
  }));
}

/**
 * The row's current values for ONLY the requested columns, as an outsider
 * may read them (`publicCellValue`): a reference is its NAME, read from this
 * tenant's own table, never an id; an object is never passed through.
 */
export async function publicCurrentValues(
  db: D1Database,
  tenantId: string,
  columns: RecordColumnRow[],
  data: RecordRowData,
  requestedKeys: string[],
): Promise<Record<string, PublicRecordValue>> {
  const out: Record<string, PublicRecordValue> = {};
  for (const field of requestFillFields(columns, requestedKeys)) {
    const key = field.column.key;
    if (!(key in data)) continue;
    out[key] = await publicCellValue(db, tenantId, field.column, data[key]);
  }
  return out;
}

/**
 * What a recipient sent, made safe to store (C-125):
 *
 *   1. only requested, fillable columns are read; each value is coerced by
 *      column type, and a wrong shape is a 400;
 *   2. a reference field takes TYPED TEXT ONLY (C-136). A request never
 *      publishes a list, so there is no id its recipient could have been
 *      offered: any `{ id }` is a 400, the same whether or not the id exists;
 *   3. a value the recipient did not touch is NOT a change, and is not
 *      judged. The page pre-fills every field with what it showed, and the
 *      whole form comes back; a field sent back exactly as shown is dropped
 *      before validation. Otherwise a reference shown as a name would be
 *      turned from a real link into typed text, and a row holding an older
 *      value its column no longer allows (a dropdown option since removed)
 *      could not be answered at all.
 */
export async function cleanUpdateRequestSubmission(
  db: D1Database,
  params: {
    tenantId: string;
    columns: RecordColumnRow[];
    requestedKeys: string[];
    rawData: unknown;
    currentData: RecordRowData;
  },
): Promise<RecordRowData> {
  const fields = requestFillFields(params.columns, params.requestedKeys);
  if (!params.rawData || typeof params.rawData !== 'object' || Array.isArray(params.rawData)) {
    throw new BadRequestError('data must be an object');
  }
  const raw = params.rawData as Record<string, unknown>;

  // Exactly what the page showed, sent back: untouched.
  const touched: Record<string, unknown> = {};
  const shownByKey = new Map<string, unknown>();
  for (const field of fields) {
    const key = field.column.key;
    if (!Object.prototype.hasOwnProperty.call(raw, key)) continue;
    const shown = key in params.currentData
      ? await publicCellValue(db, params.tenantId, field.column, params.currentData[key])
      : null;
    shownByKey.set(key, shown);
    if (JSON.stringify(raw[key] ?? null) === JSON.stringify(shown ?? null)) continue;
    touched[key] = raw[key];
  }

  // No field of a request has `pickerKind`, so an `{ id }` is refused here
  // without a lookup: a request never published a list to pick one from.
  const clean = validatePublicValues(touched, fields, { onlyPresent: true });

  // The same for a reference whose name came back in another shape
  // (`{ name }` rather than the bare string).
  for (const field of fields) {
    const key = field.column.key;
    if (!(key in clean) || !isReferenceType(field.column.type)) continue;
    const sent = clean[key] as { name?: unknown; unmatched?: unknown } | null;
    if (!sent || Array.isArray(sent) || sent.unmatched !== true || typeof sent.name !== 'string') continue;
    if (shownByKey.get(key) === sent.name) delete clean[key];
  }
  return clean;
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
 * Apply a recipient's submitted values to the row. `submittedData` is what
 * `cleanUpdateRequestSubmission` returned -- already coerced and its ids
 * verified. The fields_requested whitelist is enforced again here regardless,
 * so a recipient can't sneak an extra column write past the gate.
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

  // Load the current row so we can diff per-cell for the activity log. The
  // row must be on the request's sheet AND in the request's tenant.
  const row = await db
    .prepare(
      `SELECT id, sheet_id, tenant_id, data FROM records_rows
        WHERE id = ? AND sheet_id = ? AND tenant_id = ? AND archived = 0`,
    )
    .bind(request.row_id, request.sheet_id, request.tenant_id)
    .first<{ id: string; sheet_id: string; tenant_id: string; data: string | null }>();

  if (!row) {
    // Row was archived/deleted between request creation and recipient
    // submit. Treat as unavailable — same shape as the public 404 case.
    throw new NotFoundError('This request is no longer valid.');
  }

  const data = parseRowData(row.data);

  const changes: Array<{ column_key: string; from: unknown; to: unknown }> = [];
  let touchedRefColumn = false;
  let touchedTitleColumn = false;

  for (const field of requestFillFields(columns, requestedKeys)) {
    const key = field.column.key;
    const col = field.column;
    if (!(key in submittedData)) continue;

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
         WHERE id = ? AND tenant_id = ?`,
      )
      .bind(JSON.stringify(data), nextDisplayTitle, row.id, row.tenant_id)
      .run();
  } else {
    await db
      .prepare(
        `UPDATE records_rows
           SET data = ?, updated_at = datetime('now')
         WHERE id = ? AND tenant_id = ?`,
      )
      .bind(JSON.stringify(data), row.id, row.tenant_id)
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
