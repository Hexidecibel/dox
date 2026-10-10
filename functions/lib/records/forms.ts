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

import { formAccentOrNull, normalizeFormAccent } from '../../../shared/tenantBrand';
import { generateId } from '../db';
import { rebuildRowRefs, computeDisplayTitle, logRecordsActivity } from './helpers';
import { isPublicFormFieldType, projectColumnConfig, recordsPublicAvailable } from './publicView';
import { BadRequestError } from '../permissions';
import type {
  RecordColumnRow,
  RecordColumnType,
  RecordFormFieldConfig,
  RecordFormSettings,
  RecordFormRow,
  RecordForm,
  PublicFormFieldDef,
  PublicFormEntityOptions,
  PublicEntityOption,
  PublicFormAttachmentPolicy,
  RecordRowData,
} from '../../../shared/types';
import { FORM_ATTACHMENT_DEFAULTS } from '../../../shared/types';

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

/** The three kinds a public form can publish a list of, when a field opts in. */
export type PublicEntityKind = 'customer' | 'supplier' | 'product';

export function entityKindForColumnType(type: RecordColumnType | string): PublicEntityKind | null {
  if (type === 'customer_ref') return 'customer';
  if (type === 'supplier_ref') return 'supplier';
  if (type === 'product_ref') return 'product';
  return null;
}

/**
 * Validate + normalize an incoming field_config payload.
 *
 * `public_picker` (C-120) is kept only as an explicit `true`, and only on a
 * column in `pickerColumnIds` (the sheet's customer / supplier / product
 * columns). Anything else -- a truthy string, the flag on a text column, a
 * caller that passes no set -- stores nothing, which is "not published".
 */
export function normalizeFieldConfig(
  input: unknown,
  validColumnIds: Set<string>,
  pickerColumnIds: Set<string> = new Set(),
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
      ...(e.public_picker === true && pickerColumnIds.has(e.column_id) ? { public_picker: true } : {}),
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
  // The accent is a colour or nothing (0140). `#abc` and lower case are
  // normalised rather than refused; a colour name or anything else is a 400
  // that says so -- it used to be stored and then drawn unchecked.
  const accent = normalizeFormAccent(s.accent_color);
  if (!accent.ok) throw new BadRequestError(accent.error);
  const out: RecordFormSettings = {
    thank_you_message:
      typeof s.thank_you_message === 'string' ? s.thank_you_message : null,
    redirect_url: typeof s.redirect_url === 'string' ? s.redirect_url : null,
    accent_color: accent.value,
    // `logo_url` is no longer stored: it was a link to any outside address and
    // no page ever drew it. A form shows the organisation's own logo.
  };
  if (typeof s.allow_attachments === 'boolean') {
    out.allow_attachments = s.allow_attachments;
  }
  if (typeof s.max_attachments === 'number' && Number.isFinite(s.max_attachments)) {
    // Hard ceiling so a misconfigured form can't tip a worker over.
    out.max_attachments = Math.max(1, Math.min(20, Math.floor(s.max_attachments)));
  }
  if (typeof s.max_file_size_mb === 'number' && Number.isFinite(s.max_file_size_mb)) {
    out.max_file_size_mb = Math.max(1, Math.min(50, Math.floor(s.max_file_size_mb)));
  }
  if (Array.isArray(s.allowed_mime_types)) {
    const types = s.allowed_mime_types
      .filter((t): t is string => typeof t === 'string' && t.includes('/'))
      .slice(0, 20);
    if (types.length > 0) out.allowed_mime_types = types;
  }
  return out;
}

/**
 * Resolve the live attachment policy for a form. Returns null if the
 * form did not opt in (allow_attachments is missing or false). Defaults
 * are filled in from FORM_ATTACHMENT_DEFAULTS so the upload endpoint
 * never has to "is this set" twice.
 */
export function resolveAttachmentPolicy(
  settings: RecordFormSettings,
): PublicFormAttachmentPolicy | null {
  if (!settings.allow_attachments) return null;
  return {
    enabled: true,
    max_attachments: settings.max_attachments ?? FORM_ATTACHMENT_DEFAULTS.max_attachments,
    max_file_size_mb: settings.max_file_size_mb ?? FORM_ATTACHMENT_DEFAULTS.max_file_size_mb,
    allowed_mime_types: settings.allowed_mime_types?.length
      ? settings.allowed_mime_types
      : [...FORM_ATTACHMENT_DEFAULTS.allowed_mime_types],
  };
}

/**
 * Check a MIME type against an allowlist. Wildcards `image/*` match the
 * first segment; exact strings must match in full. Comparison is case
 * insensitive on the type/subtype tokens.
 */
export function mimeAllowed(mime: string, allowlist: string[]): boolean {
  const m = (mime || '').toLowerCase().split(';')[0].trim();
  if (!m) return false;
  for (const raw of allowlist) {
    const a = raw.toLowerCase().trim();
    if (!a) continue;
    if (a === m) return true;
    if (a.endsWith('/*')) {
      const prefix = a.slice(0, -1); // keep "image/"
      if (m.startsWith(prefix)) return true;
    }
  }
  return false;
}

/** Hydrate a raw D1 row into the RecordForm shape (parses JSON columns lazily on consume). */
export function hydrateForm(row: RecordFormRow & { creator_name?: string; submission_count?: number }): RecordForm {
  return row;
}

/**
 * The ONE lookup of a public form by its slug, for all four routes beneath
 * /api/forms/public/:slug (read, submit, upload, remove an upload).
 *
 * Null -- which every caller answers with the same 404 -- unless ALL hold:
 * the form is public, live and not archived; its sheet is not archived AND
 * belongs to the form's own tenant (a form row filed under one tenant on
 * another's sheet resolves to nothing); the organisation is active and has
 * Records switched on. The columns come back with it, read with the same
 * tenant predicate, so no caller has a reason to query the sheet by id alone.
 */
export async function loadLivePublicForm(
  db: D1Database,
  slug: string,
): Promise<{ form: RecordFormRow; columns: RecordColumnRow[] } | null> {
  if (!slug) return null;
  const form = await db
    .prepare(
      `SELECT f.id, f.tenant_id, f.sheet_id, f.name, f.description, f.public_slug, f.is_public,
              f.status, f.field_config, f.settings, f.archived, f.created_at, f.updated_at,
              f.created_by_user_id
         FROM records_forms f
         JOIN records_sheets s ON s.id = f.sheet_id AND s.tenant_id = f.tenant_id
        WHERE f.public_slug = ?
          AND f.is_public = 1
          AND f.status = 'live'
          AND f.archived = 0
          AND s.archived = 0`,
    )
    .bind(slug)
    .first<RecordFormRow>();
  if (!form) return null;
  if (!(await recordsPublicAvailable(db, form.tenant_id))) return null;

  const cols = await db
    .prepare(
      `SELECT id, sheet_id, tenant_id, key, label, type, config, required, is_title,
              display_order, width, archived, created_at, updated_at
         FROM records_columns
        WHERE sheet_id = ? AND tenant_id = ? AND archived = 0
        ORDER BY display_order ASC`,
    )
    .bind(form.sheet_id, form.tenant_id)
    .all<RecordColumnRow>();
  return { form, columns: cols.results ?? [] };
}

/** One field of a public form: its config entry and the column it draws. */
export interface PublicFormField {
  config: RecordFormFieldConfig;
  column: RecordColumnRow;
  label: string;
  required: boolean;
  /** Set when the builder opted this field's list in (C-120). */
  pickerKind: PublicEntityKind | null;
}

/**
 * The fields of a form an outsider is shown and may fill, in order. ONE list
 * for the page, the submit validator and the id check, so the three cannot
 * disagree about what is on the form.
 */
export function publicFormFields(form: RecordFormRow, columns: RecordColumnRow[]): PublicFormField[] {
  const colsById = new Map(columns.map((c) => [c.id, c]));
  const out: PublicFormField[] = [];
  for (const fc of parseFieldConfig(form.field_config)) {
    const column = colsById.get(fc.column_id);
    if (!column || column.archived) continue;
    if (!isPublicFormFieldType(column.type)) continue;
    const kind = entityKindForColumnType(column.type);
    out.push({
      config: fc,
      column,
      label: (typeof fc.label_override === 'string' && fc.label_override.trim()) || column.label,
      required: !!fc.required || column.required === 1,
      pickerKind: fc.public_picker === true ? kind : null,
    });
  }
  out.sort((a, b) => (a.config.position ?? 0) - (b.config.position ?? 0));
  return out;
}

/**
 * Build the PublicFormView projection from a form + the sheet's column
 * rows, field by field. Only columns referenced in field_config are
 * included; a column's config is projected per type (`projectColumnConfig`);
 * computed, file, document and record columns are left out.
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
  attachments?: PublicFormAttachmentPolicy;
} {
  const settings = parseFormSettings(form.settings);

  const fields: PublicFormFieldDef[] = publicFormFields(form, columns).map((f) => ({
    key: f.column.key,
    type: f.column.type,
    label: f.label,
    help_text: typeof f.config.help_text === 'string' ? f.config.help_text : null,
    required: f.required,
    config: projectColumnConfig(f.column.type, f.column.config),
    position: typeof f.config.position === 'number' ? f.config.position : 0,
    ...(f.pickerKind ? { picker: true as const } : {}),
  }));

  const attachments = resolveAttachmentPolicy(settings);

  return {
    form: {
      name: form.name,
      description: form.description,
      // A real colour or nothing. A value stored before the builder checked
      // it (`#abc`, lower case) is normalised; one that is not a colour at
      // all draws nothing and the form falls back to the organisation's brand.
      // `bin/report-form-accents` lists the forms that fall back.
      accent_color: formAccentOrNull(settings.accent_color),
      // Never published. It was a link to any outside address, which would
      // tell that site every time the form is opened; the logo a form shows is
      // the organisation's own, served by us (`brand.logo_url`).
      logo_url: null,
    },
    fields,
    turnstile_site_key: turnstileSiteKey,
    ...(entityOptions ? { entity_options: entityOptions } : {}),
    ...(attachments
      ? {
          attachments: {
            enabled: true as const,
            max_attachments: attachments.max_attachments,
            max_file_size_mb: attachments.max_file_size_mb,
            allowed_mime_types: attachments.allowed_mime_types.filter((t) => typeof t === 'string'),
          },
        }
      : {}),
  };
}

/**
 * Maximum number of entity options returned per kind on a public form.
 * Tenants with more entities will see only the first N alphabetically.
 *
 * TODO: search/pagination for >500 deferred.
 */
const ENTITY_OPTIONS_LIMIT = 500;

/**
 * The kinds whose list this form PUBLISHES: those with at least one field the
 * form builder opted in (`public_picker`, C-120). A form made before the
 * opt-in existed has none, so it publishes nothing.
 */
export function entityKindsReferencedByForm(
  form: RecordFormRow,
  columns: RecordColumnRow[],
): Set<PublicEntityKind> {
  const kinds = new Set<PublicEntityKind>();
  for (const f of publicFormFields(form, columns)) {
    if (f.pickerKind) kinds.add(f.pickerKind);
  }
  return kinds;
}

const ENTITY_TABLE: Record<PublicEntityKind, 'customers' | 'suppliers' | 'products'> = {
  customer: 'customers',
  supplier: 'suppliers',
  product: 'products',
};

/**
 * Fetch tenant-scoped entity options for the given kinds: the tenant's active
 * rows of that kind, ID AND NAME ONLY. No customer number, no product
 * description, nothing else off the row -- the SELECT names two columns and
 * the option is built from those two. Returns undefined when no kind is
 * passed, so the response has no `entity_options` key at all.
 */
export async function fetchPublicEntityOptions(
  db: D1Database,
  tenantId: string,
  kinds: Set<PublicEntityKind>,
): Promise<PublicFormEntityOptions | undefined> {
  if (kinds.size === 0) return undefined;
  const result: PublicFormEntityOptions = {};
  for (const kind of ['customer', 'supplier', 'product'] as const) {
    if (!kinds.has(kind)) continue;
    const rows = await db
      .prepare(
        `SELECT id, name
           FROM ${ENTITY_TABLE[kind]}
          WHERE tenant_id = ? AND active = 1
          ORDER BY name COLLATE NOCASE ASC
          LIMIT ?`,
      )
      .bind(tenantId, ENTITY_OPTIONS_LIMIT + 1)
      .all<{ id: string; name: string }>();
    const list = rows.results ?? [];
    if (list.length > ENTITY_OPTIONS_LIMIT) {
      console.warn(`Public form: ${ENTITY_TABLE[kind]} list exceeds ${ENTITY_OPTIONS_LIMIT}; truncating.`);
    }
    result[kind] = list.slice(0, ENTITY_OPTIONS_LIMIT).map((r): PublicEntityOption => ({ id: r.id, name: r.name }));
  }
  return result;
}

/** A column an outsider may write through a public page, with the label to name it by. */
export interface PublicFillField {
  column: RecordColumnRow;
  label: string;
  required: boolean;
  /**
   * The kind whose list this field PUBLISHES, when its form builder opted it
   * in (C-120). Only such a field accepts an id, and only an id that list
   * offers. Null / absent -- every field without the opt-in, and every field
   * of an update request -- is typed text only (C-136).
   */
  pickerKind?: PublicEntityKind | null;
}

function isEmptyValue(value: unknown): boolean {
  return (
    value == null ||
    (typeof value === 'string' && value.trim() === '') ||
    (Array.isArray(value) && value.length === 0)
  );
}

/**
 * Coerce + validate what an outsider sent against a list of fillable fields.
 * Shared by the public form submit and the update-request submit (C-125).
 *
 *   - Only the listed fields are read; every other key is dropped, so nothing
 *     reaches a column that is not on the page.
 *   - Each value is coerced BY COLUMN TYPE (`coercePublicValue`); a value of
 *     the wrong shape is a 400, never stored as sent.
 *   - `onlyPresent: false` (a form): every field is considered, an empty
 *     required one is a 400, an empty optional one is left out.
 *   - `onlyPresent: true` (an update request): only keys actually sent are
 *     considered; an empty value clears the cell (null) unless required.
 */
export function validatePublicValues(
  rawData: unknown,
  fields: PublicFillField[],
  opts: { onlyPresent: boolean },
): RecordRowData {
  if (!rawData || typeof rawData !== 'object' || Array.isArray(rawData)) {
    throw new BadRequestError('data must be an object');
  }
  const data = rawData as Record<string, unknown>;
  const out: RecordRowData = {};
  for (const field of fields) {
    const key = field.column.key;
    if (opts.onlyPresent && !Object.prototype.hasOwnProperty.call(data, key)) continue;
    const value = data[key];
    if (isEmptyValue(value)) {
      if (field.required) throw new BadRequestError(`Field "${field.label}" is required`);
      if (opts.onlyPresent) out[key] = null;
      continue;
    }
    out[key] = coercePublicValue(field.column, value, field.label, { acceptIds: !!field.pickerKind });
  }
  return out;
}

/**
 * Verify every reference id in cleaned public data is one THE PUBLISHED LIST
 * OFFERS, and replace what the outsider sent beside it with the tenant's own
 * row (C-136, which tightens C-125 / C-126).
 *
 * An id can only be in the data for a field that opted its list in
 * (`coercePublicValue` refuses one everywhere else, before any lookup). For
 * such a field the id must be in the very list the form GET published --
 * `fetchPublicEntityOptions`, the same query and the same cap -- so an id is
 * accepted exactly when the page could have offered it: this tenant's, ACTIVE,
 * and within the first 500 by name. A deactivated supplier, another tenant's
 * id and an id that never existed are the same 400, which does not say which
 * id or why. The stored cell is `{ id, name }` with the name from the list,
 * so an outsider cannot attach a label of their choosing to a real id.
 *
 * Text an outsider typed (`{ name, unmatched: true }`, no id) is left as it
 * is: it references nothing, and nothing is matched for them.
 */
export async function verifyEntityRefIds(
  db: D1Database,
  tenantId: string,
  fields: PublicFillField[],
  data: RecordRowData,
): Promise<void> {
  const offered = new Map<PublicEntityKind, Map<string, string>>();
  for (const field of fields) {
    const kind = field.pickerKind;
    if (!kind) continue;
    const value = data[field.column.key];
    if (value == null) continue;
    const items = Array.isArray(value) ? value : [value];
    const verified: unknown[] = [];
    for (const item of items) {
      const id = item && typeof item === 'object' ? (item as { id?: unknown }).id : undefined;
      if (typeof id !== 'string' || !id) {
        verified.push(item);
        continue;
      }
      let list = offered.get(kind);
      if (!list) {
        const options = await fetchPublicEntityOptions(db, tenantId, new Set([kind]));
        list = new Map((options?.[kind] ?? []).map((o) => [o.id, o.name]));
        offered.set(kind, list);
      }
      const name = list.get(id);
      if (name === undefined) {
        throw new BadRequestError(`Field "${field.label}" has an invalid selection`);
      }
      verified.push({ id, name });
    }
    data[field.column.key] = Array.isArray(value) ? verified : verified[0];
  }
}

const PUBLIC_TEXT_MAX = 20000;
const PUBLIC_NAME_MAX = 200;
const PUBLIC_LIST_MAX = 50;

/**
 * Text an outsider typed where the grid holds a reference. Stored as
 * `{ name, unmatched: true }` -- NO id, so nothing is linked, no
 * `records_row_refs` row is written, and the grid shows the words with no
 * link. A person decides what it matches; the portal does not guess.
 */
function typedReference(text: string): { name: string; unmatched: true } {
  return { name: text.trim().slice(0, PUBLIC_NAME_MAX), unmatched: true };
}

function coerceReferenceItem(item: unknown, acceptIds: boolean, label: string): unknown {
  if (typeof item === 'string' && item.trim()) return typedReference(item);
  if (item && typeof item === 'object' && !Array.isArray(item)) {
    const o = item as { id?: unknown; name?: unknown };
    // An id is kept as an id ONLY, and only on a field that publishes its
    // list -- `verifyEntityRefIds` then checks it against that list and
    // supplies the name. Whatever else was in the object is dropped here.
    // On any other field an id is refused RIGHT HERE, with no lookup, so the
    // answer is the same whether or not the id exists.
    if (acceptIds && typeof o.id === 'string' && o.id) return { id: o.id };
    if (o.id == null && typeof o.name === 'string' && o.name.trim()) return typedReference(o.name);
  }
  throw new BadRequestError(`Field "${label}" has an invalid selection`);
}

/**
 * One submitted value, coerced by its column's type. Anything that is not the
 * shape the type allows is refused with the field's label; nothing an
 * outsider sends is stored as sent.
 */
export function coercePublicValue(
  column: RecordColumnRow,
  value: unknown,
  label: string,
  opts: { acceptIds?: boolean } = {},
): unknown {
  const type = column.type;
  switch (type) {
    case 'number':
    case 'currency':
    case 'percent': {
      const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value.trim()) : NaN;
      if (!Number.isFinite(n)) {
        throw new BadRequestError(`Field "${label}" must be a number`);
      }
      return n;
    }
    case 'checkbox': {
      if (typeof value === 'boolean') return value;
      if (value === 'true' || value === 1) return true;
      if (value === 'false' || value === 0) return false;
      throw new BadRequestError(`Field "${label}" must be yes or no`);
    }
    case 'text':
    case 'long_text':
    case 'email':
    case 'url':
    case 'phone':
    case 'date':
    case 'datetime':
    case 'duration': {
      if (typeof value !== 'string' && typeof value !== 'number') {
        throw new BadRequestError(`Field "${label}" must be text`);
      }
      const text = String(value);
      if (text.length > PUBLIC_TEXT_MAX) throw new BadRequestError(`Field "${label}" is too long`);
      return text;
    }
    case 'dropdown_single':
    case 'dropdown_multi': {
      const cfg = projectColumnConfig(type, column.config);
      const allowed = cfg?.options?.length && cfg.allow_custom !== true ? new Set(cfg.options.map((o) => o.value)) : null;
      const check = (v: unknown): string => {
        if (typeof v !== 'string' || v.length > PUBLIC_NAME_MAX || (allowed && !allowed.has(v))) {
          throw new BadRequestError(`Field "${label}" has an invalid selection`);
        }
        return v;
      };
      if (type === 'dropdown_single') return check(value);
      const list = Array.isArray(value) ? value : [value];
      if (list.length > PUBLIC_LIST_MAX) throw new BadRequestError(`Field "${label}" has an invalid selection`);
      return list.map(check);
    }
    case 'supplier_ref':
    case 'product_ref':
    case 'customer_ref':
    case 'contact': {
      // An id only where the field's own list is published (never a contact,
      // which has no list; never an update request, which publishes none).
      const acceptIds = type !== 'contact' && opts.acceptIds === true;
      if (Array.isArray(value)) {
        if (value.length > PUBLIC_LIST_MAX) throw new BadRequestError(`Field "${label}" has an invalid selection`);
        return value.map((item) => coerceReferenceItem(item, acceptIds, label));
      }
      return coerceReferenceItem(value, acceptIds, label);
    }
    default:
      // Computed, file, document and record columns are never fillable from
      // outside; a type added later is refused until it is given a rule here.
      throw new BadRequestError(`Field "${label}" cannot be filled in here`);
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
 * Link a list of pending attachments (issued by the public upload
 * endpoint) to a freshly-created row. Validates each attachment matches
 * the form, tenant, and is still pending + unexpired before flipping
 * row_id and clearing pending_*.
 *
 * Throws BadRequestError on the first mismatch. Caller is responsible
 * for transactional cleanup (the submit handler archives the row on
 * failure so the user sees a clean error rather than a half-linked row).
 */
export async function linkPendingAttachments(
  db: D1Database,
  params: {
    tenantId: string;
    formId: string;
    rowId: string;
    attachmentIds: string[];
    maxAttachments: number;
  },
): Promise<number> {
  const { tenantId, formId, rowId, attachmentIds, maxAttachments } = params;
  if (attachmentIds.length === 0) return 0;
  if (attachmentIds.length > maxAttachments) {
    throw new BadRequestError(
      `Too many attachments (max ${maxAttachments})`,
    );
  }

  // Drop duplicate ids in the request — protects us from double-click
  // submission shenanigans on the renderer side.
  const seen = new Set<string>();
  const unique = attachmentIds.filter((id) => {
    if (typeof id !== 'string' || !id) return false;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });

  const nowIso = new Date().toISOString();
  let linked = 0;

  for (const attId of unique) {
    // Conditional UPDATE so the link operation is atomic per row. If
    // someone already linked or expired the attachment between our
    // check and the write, `changes` returns 0 and we surface a
    // BadRequestError. Cheaper than a SELECT-then-UPDATE round trip.
    const res = await db
      .prepare(
        `UPDATE records_row_attachments
         SET row_id = ?, pending_token = NULL, pending_expires_at = NULL
         WHERE id = ?
           AND tenant_id = ?
           AND form_id = ?
           AND row_id IS NULL
           AND pending_token IS NOT NULL
           AND (pending_expires_at IS NULL OR pending_expires_at >= ?)`,
      )
      .bind(rowId, attId, tenantId, formId, nowIso)
      .run();

    const changes = res.meta?.changes ?? 0;
    if (changes < 1) {
      throw new BadRequestError(
        'One or more attachments are no longer available. Please try uploading again.',
      );
    }
    linked += 1;
  }
  return linked;
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
