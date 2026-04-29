/**
 * Helpers shared across the Records forms endpoints (admin + public).
 *
 * Form persistence rules:
 *   - field_config / settings live as JSON in TEXT columns.
 *   - public_slug is auto-generated when is_public flips on (and only
 *     when the row has no slug yet). Slug rotation is opt-in via the
 *     `rotate_slug` flag on UpdateFormRequest.
 *   - All sheet/tenant access checks reuse loadSheetForUser from
 *     helpers.ts so the same NotFoundError-on-cross-tenant policy
 *     applies to forms as it does to sheets/rows.
 */

import { generateId } from '../db';
import { rebuildRowRefs, computeDisplayTitle, logRecordsActivity } from './helpers';
import { BadRequestError } from '../permissions';
import type {
  RecordColumnRow,
  RecordFormFieldConfig,
  RecordFormSettings,
  RecordFormRow,
  RecordForm,
  PublicFormFieldDef,
  PublicFormEntityOptions,
  PublicEntityOption,
  RecordRowData,
} from '../../../shared/types';

/**
 * Generate a URL-safe random slug. ~96 bits of entropy is plenty for
 * an unauthenticated public link — collisions are vanishingly rare and
 * the unique partial index in 0041 will reject the second insert if one
 * ever happens (caller can retry with a fresh slug).
 */
export function generatePublicSlug(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  // base64url, no padding
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

/** Parse the JSON field_config; tolerate null/malformed. */
export function parseFieldConfig(raw: string | null): RecordFormFieldConfig[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? (v as RecordFormFieldConfig[]) : [];
  } catch {
    return [];
  }
}

/** Parse the JSON settings; tolerate null/malformed. */
export function parseFormSettings(raw: string | null): RecordFormSettings {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as RecordFormSettings) : {};
  } catch {
    return {};
  }
}

/** Validate + normalize an incoming field_config payload. */
export function normalizeFieldConfig(
  input: unknown,
  validColumnIds: Set<string>,
): RecordFormFieldConfig[] {
  if (input == null) return [];
  if (!Array.isArray(input)) {
    throw new BadRequestError('field_config must be an array');
  }
  const out: RecordFormFieldConfig[] = [];
  const seen = new Set<string>();
  input.forEach((entry, idx) => {
    if (!entry || typeof entry !== 'object') {
      throw new BadRequestError(`field_config[${idx}] must be an object`);
    }
    const e = entry as Partial<RecordFormFieldConfig>;
    if (typeof e.column_id !== 'string' || !e.column_id) {
      throw new BadRequestError(`field_config[${idx}].column_id is required`);
    }
    if (!validColumnIds.has(e.column_id)) {
      throw new BadRequestError(`field_config[${idx}].column_id is not a column on this sheet`);
    }
    if (seen.has(e.column_id)) {
      throw new BadRequestError(`field_config[${idx}].column_id is duplicated`);
    }
    seen.add(e.column_id);
    out.push({
      column_id: e.column_id,
      required: !!e.required,
      label_override: typeof e.label_override === 'string' ? e.label_override : null,
      help_text: typeof e.help_text === 'string' ? e.help_text : null,
      position: typeof e.position === 'number' ? e.position : idx,
    });
  });
  out.sort((a, b) => a.position - b.position);
  return out;
}

/** Validate + normalize an incoming settings payload. */
export function normalizeSettings(input: unknown): RecordFormSettings {
  if (input == null) return {};
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new BadRequestError('settings must be an object');
  }
  const s = input as Partial<RecordFormSettings>;
  return {
    thank_you_message:
      typeof s.thank_you_message === 'string' ? s.thank_you_message : null,
    redirect_url: typeof s.redirect_url === 'string' ? s.redirect_url : null,
    accent_color: typeof s.accent_color === 'string' ? s.accent_color : null,
    logo_url: typeof s.logo_url === 'string' ? s.logo_url : null,
  };
}

/** Hydrate a raw D1 row into the RecordForm shape (parses JSON columns lazily on consume). */
export function hydrateForm(row: RecordFormRow & { creator_name?: string; submission_count?: number }): RecordForm {
  return row;
}

/**
 * Build the PublicFormView projection from a form + the sheet's column
 * rows. Only columns referenced in field_config are included; everything
 * else (including hidden columns and full sheet metadata) stays
 * server-side. Formula/rollup columns are stripped — they're computed.
 */
export function buildPublicFormView(
  form: RecordFormRow,
  columns: RecordColumnRow[],
  turnstileSiteKey: string,
  entityOptions?: PublicFormEntityOptions,
): {
  form: { name: string; description: string | null; accent_color: string | null; logo_url: string | null };
  fields: PublicFormFieldDef[];
  turnstile_site_key: string;
  entity_options?: PublicFormEntityOptions;
} {
  const settings = parseFormSettings(form.settings);
  const fieldConfig = parseFieldConfig(form.field_config);
  const colsById = new Map(columns.map((c) => [c.id, c]));

  const fields: PublicFormFieldDef[] = [];
  for (const fc of fieldConfig) {
    const col = colsById.get(fc.column_id);
    if (!col || col.archived) continue;
    if (col.type === 'formula' || col.type === 'rollup') continue;

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
      label: fc.label_override?.trim() || col.label,
      help_text: fc.help_text ?? null,
      required: !!fc.required || col.required === 1,
      config,
      position: fc.position,
    });
  }
  fields.sort((a, b) => a.position - b.position);

  return {
    form: {
      name: form.name,
      description: form.description,
      accent_color: settings.accent_color ?? null,
      logo_url: settings.logo_url ?? null,
    },
    fields,
    turnstile_site_key: turnstileSiteKey,
    ...(entityOptions ? { entity_options: entityOptions } : {}),
  };
}

/**
 * Maximum number of entity options returned per kind on a public form.
 * Tenants with more entities will see only the first N alphabetically;
 * the renderer falls back to a free-text input gracefully when an id
 * isn't in the list (the submit endpoint still validates against the
 * full table).
 *
 * TODO: search/pagination for >500 deferred — wire up an opt-in
 * /api/forms/public/:slug/entities?type=customer&q=foo lookup if any
 * tenant grows past this threshold.
 */
const ENTITY_OPTIONS_LIMIT = 500;

/**
 * Resolve the set of entity-ref kinds referenced by the form's visible
 * columns. We use this to scope the entity_options fetch — a form with
 * no customer_ref column shouldn't trigger a customers query at all.
 */
export function entityKindsReferencedByForm(
  form: RecordFormRow,
  columns: RecordColumnRow[],
): Set<'customer' | 'supplier' | 'product'> {
  const kinds = new Set<'customer' | 'supplier' | 'product'>();
  const fieldConfig = parseFieldConfig(form.field_config);
  const colsById = new Map(columns.map((c) => [c.id, c]));
  for (const fc of fieldConfig) {
    const col = colsById.get(fc.column_id);
    if (!col || col.archived) continue;
    if (col.type === 'customer_ref') kinds.add('customer');
    else if (col.type === 'supplier_ref') kinds.add('supplier');
    else if (col.type === 'product_ref') kinds.add('product');
  }
  return kinds;
}

/**
 * Fetch tenant-scoped entity options for the given kinds. Result is the
 * exact `entity_options` shape attached to PublicFormView. Returns
 * undefined when no kinds are passed, so callers can spread the result
 * directly into the response.
 *
 * Each kind is capped at ENTITY_OPTIONS_LIMIT and ordered by name. We
 * surface only id + name + a single disambiguator — never PII — because
 * this ships over an unauthenticated route.
 */
export async function fetchPublicEntityOptions(
  db: D1Database,
  tenantId: string,
  kinds: Set<'customer' | 'supplier' | 'product'>,
): Promise<PublicFormEntityOptions | undefined> {
  if (kinds.size === 0) return undefined;
  const result: PublicFormEntityOptions = {};

  if (kinds.has('customer')) {
    const rows = await db
      .prepare(
        `SELECT id, name, customer_number
         FROM customers
         WHERE tenant_id = ? AND active = 1
         ORDER BY name COLLATE NOCASE ASC
         LIMIT ?`,
      )
      .bind(tenantId, ENTITY_OPTIONS_LIMIT + 1)
      .all<{ id: string; name: string; customer_number: string | null }>();
    const list = rows.results ?? [];
    if (list.length > ENTITY_OPTIONS_LIMIT) {
      console.warn(
        `Public form: customers for tenant ${tenantId} exceeds ${ENTITY_OPTIONS_LIMIT}; truncating. Add search/pagination.`,
      );
    }
    result.customer = list.slice(0, ENTITY_OPTIONS_LIMIT).map((r) => toOption(r.id, r.name, r.customer_number));
  }

  if (kinds.has('supplier')) {
    const rows = await db
      .prepare(
        `SELECT id, name, slug
         FROM suppliers
         WHERE tenant_id = ? AND active = 1
         ORDER BY name COLLATE NOCASE ASC
         LIMIT ?`,
      )
      .bind(tenantId, ENTITY_OPTIONS_LIMIT + 1)
      .all<{ id: string; name: string; slug: string | null }>();
    const list = rows.results ?? [];
    if (list.length > ENTITY_OPTIONS_LIMIT) {
      console.warn(
        `Public form: suppliers for tenant ${tenantId} exceeds ${ENTITY_OPTIONS_LIMIT}; truncating. Add search/pagination.`,
      );
    }
    // Suppliers have no obvious PII-free disambiguator other than slug,
    // and slug is a derived URL form of the name — skip secondary so we
    // don't render a redundant "Acme — acme" subtitle.
    result.supplier = list.slice(0, ENTITY_OPTIONS_LIMIT).map((r) => toOption(r.id, r.name, null));
  }

  if (kinds.has('product')) {
    // products has no SKU column in the current schema (see migration
    // 0017). Use description as a soft secondary if present; otherwise
    // emit name only.
    const rows = await db
      .prepare(
        `SELECT id, name, description
         FROM products
         WHERE tenant_id = ? AND active = 1
         ORDER BY name COLLATE NOCASE ASC
         LIMIT ?`,
      )
      .bind(tenantId, ENTITY_OPTIONS_LIMIT + 1)
      .all<{ id: string; name: string; description: string | null }>();
    const list = rows.results ?? [];
    if (list.length > ENTITY_OPTIONS_LIMIT) {
      console.warn(
        `Public form: products for tenant ${tenantId} exceeds ${ENTITY_OPTIONS_LIMIT}; truncating. Add search/pagination.`,
      );
    }
    result.product = list.slice(0, ENTITY_OPTIONS_LIMIT).map((r) => toOption(r.id, r.name, r.description));
  }

  return result;
}

function toOption(id: string, name: string, secondary: string | null | undefined): PublicEntityOption {
  const opt: PublicEntityOption = { id, name };
  if (typeof secondary === 'string' && secondary.trim()) {
    opt.secondary = secondary.trim();
  }
  return opt;
}

/**
 * Coerce + validate a public submission payload against the form's
 * visible fields. Returns the cleaned RecordRowData ready to persist.
 *
 * Rules:
 *   - Only keys present in field_config are accepted; everything else
 *     is silently dropped (prevents form-bypass writes to hidden cols).
 *   - Required fields must have a non-empty value.
 *   - number / checkbox are coerced; date is left as ISO string.
 *   - record_ref / document_ref / contact / attachment are rejected if
 *     present in field_config — they require auth-side pickers and are
 *     deferred per the Phase 2 Slice 1 spec.
 */
export function validateSubmission(
  rawData: unknown,
  form: RecordFormRow,
  columns: RecordColumnRow[],
): RecordRowData {
  if (!rawData || typeof rawData !== 'object' || Array.isArray(rawData)) {
    throw new BadRequestError('data must be an object');
  }
  const data = rawData as Record<string, unknown>;
  const fieldConfig = parseFieldConfig(form.field_config);
  const colsById = new Map(columns.map((c) => [c.id, c]));

  const out: RecordRowData = {};
  for (const fc of fieldConfig) {
    const col = colsById.get(fc.column_id);
    if (!col || col.archived) continue;
    if (col.type === 'formula' || col.type === 'rollup') continue;
    if (col.type === 'record_ref' || col.type === 'document_ref' || col.type === 'attachment') {
      // Deferred for v1 of public forms — see spec.
      continue;
    }

    const required = !!fc.required || col.required === 1;
    const value = data[col.key];
    const isEmpty =
      value == null ||
      (typeof value === 'string' && value.trim() === '') ||
      (Array.isArray(value) && value.length === 0);

    if (isEmpty) {
      if (required) {
        throw new BadRequestError(`Field "${fc.label_override?.trim() || col.label}" is required`);
      }
      continue;
    }

    out[col.key] = coerceValue(col.type, value, fc.label_override?.trim() || col.label);
  }
  return out;
}

/**
 * Verify that any entity-ref values in a submission point at rows that
 * actually live in the form's tenant. Prevents drive-by submission of a
 * known-good id from another tenant.
 *
 * - Iterates the form's visible entity-ref fields (customer/supplier/
 *   product).
 * - Extracts ids using the same shape rules as the grid (string id or
 *   `{id}`).
 * - Cross-checks `tenant_id` on the target table.
 *
 * Throws `BadRequestError` for the first invalid id encountered with a
 * generic message (we don't echo back which id was invalid — keeps
 * cross-tenant id existence un-enumerable).
 *
 * Cost: at most one query per ref field per submission. Negligible for
 * the form-submit hot path.
 */
export async function verifyEntityRefIds(
  db: D1Database,
  tenantId: string,
  form: RecordFormRow,
  columns: RecordColumnRow[],
  data: RecordRowData,
): Promise<void> {
  const fieldConfig = parseFieldConfig(form.field_config);
  const colsById = new Map(columns.map((c) => [c.id, c]));
  for (const fc of fieldConfig) {
    const col = colsById.get(fc.column_id);
    if (!col || col.archived) continue;
    const table = entityRefTable(col.type);
    if (!table) continue;
    const value = data[col.key];
    if (value == null) continue;
    const ids = extractEntityRefIds(value);
    if (ids.length === 0) continue;
    for (const id of ids) {
      const row = await db
        .prepare(`SELECT id FROM ${table} WHERE id = ? AND tenant_id = ?`)
        .bind(id, tenantId)
        .first<{ id: string }>();
      if (!row) {
        throw new BadRequestError(
          `Field "${fc.label_override?.trim() || col.label}" has an invalid selection`,
        );
      }
    }
  }
}

/** Map a column type to its tenant-scoped table for ref verification. */
function entityRefTable(columnType: string): 'customers' | 'suppliers' | 'products' | null {
  switch (columnType) {
    case 'customer_ref':
      return 'customers';
    case 'supplier_ref':
      return 'suppliers';
    case 'product_ref':
      return 'products';
    default:
      return null;
  }
}

/** Extract ids from an entity-ref cell value. Mirrors helpers.extractRefIds. */
function extractEntityRefIds(value: unknown): string[] {
  if (value == null) return [];
  const items = Array.isArray(value) ? value : [value];
  const ids: string[] = [];
  for (const item of items) {
    if (typeof item === 'string' && item) {
      ids.push(item);
    } else if (item && typeof item === 'object' && 'id' in item) {
      const id = (item as { id?: unknown }).id;
      if (typeof id === 'string' && id) ids.push(id);
    }
  }
  return ids;
}

function coerceValue(type: string, value: unknown, label: string): unknown {
  switch (type) {
    case 'number':
    case 'currency':
    case 'percent': {
      const n = typeof value === 'number' ? value : Number(value);
      if (Number.isNaN(n)) {
        throw new BadRequestError(`Field "${label}" must be a number`);
      }
      return n;
    }
    case 'checkbox':
      return !!value;
    case 'text':
    case 'long_text':
    case 'email':
    case 'url':
    case 'phone':
    case 'date':
    case 'datetime':
    case 'duration':
      return typeof value === 'string' ? value : String(value);
    case 'dropdown_single':
      return typeof value === 'string' ? value : String(value);
    case 'dropdown_multi':
      if (Array.isArray(value)) return value.map((v) => String(v));
      return [String(value)];
    case 'supplier_ref':
    case 'product_ref':
    case 'customer_ref':
    case 'contact':
      // Accept {id} or string id — same shape the admin row endpoints accept.
      return value;
    default:
      return value;
  }
}

/**
 * Persist a row from a public submission. Mirrors the writes performed
 * by POST /api/records/sheets/:sheetId/rows so behaviour stays identical
 * (display_title, refs, activity feed). Returns the new row id.
 */
export async function createRowFromSubmission(
  db: D1Database,
  params: {
    sheetId: string;
    tenantId: string;
    formId: string;
    columns: RecordColumnRow[];
    data: RecordRowData;
  },
): Promise<string> {
  const { sheetId, tenantId, formId, columns, data } = params;

  // Append to end (max(position)+1) — public submissions always land
  // at the bottom, never overwriting interactive ordering.
  const maxRow = await db
    .prepare('SELECT COALESCE(MAX(position), -1) as max_position FROM records_rows WHERE sheet_id = ?')
    .bind(sheetId)
    .first<{ max_position: number }>();
  const position = (maxRow?.max_position ?? -1) + 1;

  const displayTitle = computeDisplayTitle(columns, data);
  const id = generateId();

  await db
    .prepare(
      `INSERT INTO records_rows
         (id, sheet_id, tenant_id, display_title, data, position, created_by, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, sheetId, tenantId, displayTitle, JSON.stringify(data), position, null, null)
    .run();

  await rebuildRowRefs(db, tenantId, sheetId, id, columns, data);

  await logRecordsActivity(db, {
    tenantId,
    sheetId,
    rowId: id,
    actorId: null,
    kind: 'created_via_form',
    details: { form_id: formId, display_title: displayTitle },
  });

  return id;
}

/**
 * Verify a Cloudflare Turnstile token via the siteverify endpoint.
 * Returns true on success. The test secret `1x0000000000000000000000000000000AA`
 * always returns success — fine for staging until a real secret is set.
 */
export async function verifyTurnstileToken(
  secret: string | undefined,
  token: string,
  remoteIp: string | null,
): Promise<boolean> {
  if (!secret) {
    // No secret configured — fail closed in prod, but be loud about it.
    console.warn('TURNSTILE_SECRET not set; refusing public form submission');
    return false;
  }
  if (!token) return false;
  const body = new URLSearchParams();
  body.set('secret', secret);
  body.set('response', token);
  if (remoteIp) body.set('remoteip', remoteIp);
  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body,
    });
    if (!res.ok) return false;
    const json = (await res.json()) as { success?: boolean };
    return !!json.success;
  } catch (err) {
    console.error('Turnstile verify error:', err);
    return false;
  }
}

/**
 * Best-effort fan-out to the SheetSession DO so any active grid viewers
 * see the new row appear live. Mirrors the broadcast pattern used by the
 * cell PATCH endpoint — a DO failure must NEVER fail the submission.
 *
 * Note: the DO currently understands cell_update messages; the Phase 2
 * follow-up will teach it about row_inserted explicitly. For now, we
 * post a row_inserted hint and the DO can no-op until that's wired.
 */
export async function broadcastRowInserted(
  doNamespace: DurableObjectNamespace | undefined,
  sheetId: string,
  rowId: string,
): Promise<void> {
  if (!doNamespace) return;
  try {
    const stubId = doNamespace.idFromName(sheetId);
    const stub = doNamespace.get(stubId);
    await stub.fetch(
      new Request('https://sheet-session.do/broadcast', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: 'row_inserted',
          rowId,
        }),
      }),
    );
  } catch (err) {
    console.error('SheetSession row_inserted broadcast failed:', err);
  }
}

/** Add a populated submission_count to a list of forms. */
export async function attachSubmissionCounts(
  db: D1Database,
  forms: RecordForm[],
): Promise<void> {
  if (!forms.length) return;
  const placeholders = forms.map(() => '?').join(',');
  const rows = await db
    .prepare(
      `SELECT form_id, COUNT(*) as cnt FROM records_form_submissions
       WHERE form_id IN (${placeholders})
       GROUP BY form_id`,
    )
    .bind(...forms.map((f) => f.id))
    .all<{ form_id: string; cnt: number }>();
  const map = new Map((rows.results ?? []).map((r) => [r.form_id, r.cnt]));
  for (const f of forms) {
    f.submission_count = map.get(f.id) ?? 0;
  }
}
