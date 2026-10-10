/**
 * What the three Records public pages -- a public form (/f/:slug), an update
 * request (/u/:token) and a workflow sign-off (/a/:token) -- are allowed to
 * say to somebody who is not signed in. Decisions C-120..C-132.
 *
 * Every response on those eight routes is BUILT FIELD BY FIELD from the
 * helpers here; none of them spreads a database row or a stored JSON blob. A
 * column added to a table, or a key added to a column's config, stays inside
 * until somebody names it in this file.
 *
 * `tests/api/records-public-leak.test.ts` pins the result: an allow-list of
 * keys per route, and a planted internal note, spec limit, comment, storage
 * key, portal user's email and another tenant's records that must never
 * appear.
 */

import { MODULES } from '../../../shared/modules';
import { isModuleEnabledForTenant } from '../module-access';
import { loadOutwardName } from '../tenant-brand';
import { checkRateLimit, recordAttempt } from '../ratelimit';
import type {
  PublicFieldConfig,
  PublicRecordValue,
  RecordColumnRow,
  RecordColumnType,
} from '../../../shared/types';

// ---------------------------------------------------------------------------
// Is anything served at all
// ---------------------------------------------------------------------------

/**
 * May a Records public page of this tenant be served right now?
 *
 * No when the organisation is inactive, and no when it has switched the
 * Records module off. "Off" is decided by the same function the scheduled
 * jobs ask (`isModuleEnabledForTenant`), so there is one rule: a
 * `tenant_modules` row saying 0 is off, and NO ROW is on (migration 0099).
 *
 * The caller answers a `false` with its ordinary 404: an outsider is not told
 * which of "no such link", "expired" and "this organisation stopped using
 * Records" they hit.
 */
export async function recordsPublicAvailable(db: D1Database, tenantId: string | null | undefined): Promise<boolean> {
  if (!tenantId) return false;
  const tenant = await db
    .prepare('SELECT active FROM tenants WHERE id = ?')
    .bind(tenantId)
    .first<{ active: number | null }>();
  if (!tenant || tenant.active !== 1) return false;
  return isModuleEnabledForTenant(db, tenantId, MODULES.records.key);
}

// ---------------------------------------------------------------------------
// Which column types an outsider may fill
// ---------------------------------------------------------------------------

/** Columns that are computed, or are files: never a field on a public page. */
function isComputedOrFile(type: RecordColumnType): boolean {
  return type === 'formula' || type === 'rollup' || type === 'attachment';
}

/**
 * May this column be a field on a PUBLIC FORM? A document or another record
 * can only be chosen from a list an outsider must not see, so those two are
 * left out with the computed ones.
 */
export function isPublicFormFieldType(type: RecordColumnType): boolean {
  return !isComputedOrFile(type) && type !== 'document_ref' && type !== 'record_ref';
}

/**
 * May this column be asked for in an UPDATE REQUEST? As a public form, minus
 * `contact`: a contact cell holds a person of the organisation (often with
 * their address), and showing its current value is showing that person.
 */
export function isUpdateRequestFieldType(type: RecordColumnType): boolean {
  return isPublicFormFieldType(type) && type !== 'contact';
}

// ---------------------------------------------------------------------------
// Column config: an allow-list per column type
// ---------------------------------------------------------------------------

function parseObject(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * The part of a column's stored config a public page may have, by column
 * type. Everything else in the JSON -- `target_sheet_id`, a rollup's source,
 * whatever a later builder feature stores there -- is dropped. Returns null
 * when nothing survives, so a field with no public config says so plainly.
 */
export function projectColumnConfig(type: RecordColumnType, raw: string | null): PublicFieldConfig | null {
  const cfg = parseObject(raw);
  if (!cfg) return null;
  const out: PublicFieldConfig = {};

  switch (type) {
    case 'dropdown_single':
    case 'dropdown_multi': {
      if (Array.isArray(cfg.options)) {
        out.options = [];
        for (const o of cfg.options) {
          if (!o || typeof o !== 'object') continue;
          const opt = o as Record<string, unknown>;
          if (typeof opt.value !== 'string') continue;
          out.options.push({
            value: opt.value,
            ...(typeof opt.label === 'string' ? { label: opt.label } : {}),
            ...(typeof opt.color === 'string' ? { color: opt.color } : {}),
          });
        }
      }
      if (typeof cfg.allow_custom === 'boolean') out.allow_custom = cfg.allow_custom;
      break;
    }
    case 'number':
    case 'currency':
    case 'percent': {
      if (typeof cfg.precision === 'number' && Number.isFinite(cfg.precision)) out.precision = cfg.precision;
      if (cfg.format === 'plain' || cfg.format === 'currency' || cfg.format === 'percent') out.format = cfg.format;
      if (typeof cfg.currency_code === 'string') out.currency_code = cfg.currency_code.slice(0, 8);
      break;
    }
    case 'date':
    case 'datetime': {
      if (typeof cfg.format === 'string') out.format = cfg.format.slice(0, 40);
      if (typeof cfg.include_time === 'boolean') out.include_time = cfg.include_time;
      break;
    }
    case 'supplier_ref':
    case 'product_ref':
    case 'customer_ref': {
      if (typeof cfg.multiple === 'boolean') out.multiple = cfg.multiple;
      break;
    }
    default:
      break;
  }
  return Object.keys(out).length > 0 ? out : null;
}

// ---------------------------------------------------------------------------
// A cell, as an outsider may read it
// ---------------------------------------------------------------------------

/** Where a reference column's NAME lives. The id never leaves. */
const REF_NAME_SOURCE: Partial<Record<RecordColumnType, { table: string; column: string }>> = {
  supplier_ref: { table: 'suppliers', column: 'name' },
  product_ref: { table: 'products', column: 'name' },
  customer_ref: { table: 'customers', column: 'name' },
  document_ref: { table: 'documents', column: 'title' },
  record_ref: { table: 'records_rows', column: 'display_title' },
  contact: { table: 'users', column: 'name' },
};

export function isReferenceType(type: RecordColumnType): boolean {
  return type in REF_NAME_SOURCE;
}

/**
 * The names a reference cell points at, read from THIS tenant's own table.
 *
 * - A cell item carrying an id is looked up with a `tenant_id` predicate. An
 *   id that is not the tenant's resolves to nothing: neither the id nor the
 *   label stored beside it is shown, because that label came in with the id.
 * - A cell item with NO id is text somebody typed (`{ name, unmatched: true }`
 *   from a public page); it is shown as typed. A BARE STRING IS AN ID for
 *   every reference type -- `extractRefIds` (`helpers.ts`) reads it as one,
 *   and the two must agree. For a `contact` cell, which has no picker and so
 *   may also hold a name somebody typed, the string is resolved as a user id
 *   of this tenant FIRST (the name leaves, never the id); only when it is not
 *   one may it be shown as typed, and then only if it does not look like an
 *   id (`looksLikeId`) and is not an address (C-144). A string that looks
 *   like an id and resolves to nothing shows nothing.
 * - A CONTACT IS NEVER AN ADDRESS, whatever shape the cell has (C-134): a
 *   portal user's name that is their email, a bare string that is an email,
 *   an id-less `{ name }` that is an email -- each is left out. The rule is
 *   applied to the NAME about to leave, not to one branch of how it was found.
 * - A reference to ANOTHER RECORD is that record's title as an outsider may
 *   read it (`publicRowTitle`), not its stored `display_title`, which for a
 *   reference title column is the cell's raw JSON (C-133).
 */
async function referenceNames(
  db: D1Database,
  tenantId: string,
  type: RecordColumnType,
  value: unknown,
  depth: number,
): Promise<string[]> {
  const source = REF_NAME_SOURCE[type];
  if (!source || value == null) return [];
  const items = Array.isArray(value) ? value : [value];
  const names: string[] = [];
  for (const item of items.slice(0, 50)) {
    let id: string | null = null;
    let typed: string | null = null;
    if (typeof item === 'string') {
      id = item;
    } else if (item && typeof item === 'object') {
      const o = item as { id?: unknown; name?: unknown };
      if (typeof o.id === 'string' && o.id) id = o.id;
      else if (typeof o.name === 'string') typed = o.name;
    }
    let name: string | null = typed;
    if (id && type === 'record_ref') {
      name = await linkedRowTitle(db, tenantId, id, depth);
    } else if (id) {
      const row = await db
        .prepare(`SELECT ${source.column} AS name FROM ${source.table} WHERE id = ? AND tenant_id = ?`)
        .bind(id, tenantId)
        .first<{ name: string | null }>();
      name = row?.name ?? null;
      // A contact cell's bare string that is no user of this tenant: words
      // somebody typed, unless they have the shape of an id.
      if (!row && type === 'contact' && typeof item === 'string' && !looksLikeId(item)) name = item;
    }
    if (type === 'contact' && name && name.includes('@')) name = null;
    if (typeof name === 'string' && name.trim()) names.push(name.trim());
  }
  return names;
}

/**
 * Does a bare string in a contact cell have the SHAPE of an id rather than
 * of a name a person typed? Generated ids here are hex strings, UUIDs and
 * slugs like `user-org-admin`: no spaces, and either a digit, an underscore,
 * two or more hyphens, or twenty or more characters. "Dana", "Jean-Luc" and
 * "Dana Typed" are names; `3f2a...`, `user_17` and `user-org-admin` are not
 * shown. When this is wrong about a real name the cost is a dash on a page;
 * when it is wrong the other way the cost is an internal id outside.
 */
export function looksLikeId(text: string): boolean {
  const s = text.trim();
  if (!s || /\s/.test(s)) return false;
  return /[0-9_]/.test(s) || s.length >= 20 || (s.match(/-/g)?.length ?? 0) >= 2;
}

/** How many records deep a title may be followed (a record titled by a record). */
const LINKED_TITLE_DEPTH = 2;

/**
 * The title of a record another record points at: the tenant's own row, not
 * archived, titled through the same projection as any other cell. Past
 * `LINKED_TITLE_DEPTH` (records titled by records titled by records) it is
 * nothing rather than a loop.
 */
async function linkedRowTitle(
  db: D1Database,
  tenantId: string,
  rowId: string,
  depth: number,
): Promise<string | null> {
  if (depth >= LINKED_TITLE_DEPTH) return null;
  const row = await db
    .prepare('SELECT sheet_id, data FROM records_rows WHERE id = ? AND tenant_id = ? AND archived = 0')
    .bind(rowId, tenantId)
    .first<{ sheet_id: string; data: string | null }>();
  if (!row) return null;
  const titleColumn = await db
    .prepare(
      `SELECT key, type FROM records_columns
        WHERE sheet_id = ? AND tenant_id = ? AND is_title = 1 AND archived = 0
        ORDER BY display_order ASC LIMIT 1`,
    )
    .bind(row.sheet_id, tenantId)
    .first<{ key: string; type: RecordColumnType }>();
  if (!titleColumn) return null;
  return publicRowTitle(
    db,
    tenantId,
    [{ key: titleColumn.key, type: titleColumn.type, is_title: 1, archived: 0 }],
    parseObject(row.data) ?? {},
    depth + 1,
  );
}

/**
 * A record's public title by its id: for the mail that carries a link, which
 * has the row's id and not its data. Null for a row that is not the tenant's.
 */
export function loadPublicRowTitle(db: D1Database, tenantId: string, rowId: string): Promise<string | null> {
  return linkedRowTitle(db, tenantId, rowId, 0);
}

function primitive(value: unknown): string | number | boolean | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'boolean') return value;
  return null;
}

/**
 * One cell as a public page may show it: text, a number, a yes / no, or a
 * list of texts. A reference is its name (several: joined with ", "). An
 * object that is not understood is NOTHING -- never passed through.
 */
export async function publicCellValue(
  db: D1Database,
  tenantId: string,
  column: Pick<RecordColumnRow, 'type'>,
  value: unknown,
  depth = 0,
): Promise<PublicRecordValue> {
  if (value == null || isComputedOrFile(column.type)) return null;

  if (isReferenceType(column.type)) {
    const names = await referenceNames(db, tenantId, column.type, value, depth);
    return names.length ? names.join(', ') : null;
  }

  switch (column.type) {
    case 'number':
    case 'currency':
    case 'percent': {
      const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
      return Number.isFinite(n) ? n : null;
    }
    case 'checkbox':
      return typeof value === 'boolean' ? value : null;
    case 'dropdown_multi': {
      if (!Array.isArray(value)) return typeof value === 'string' ? [value] : null;
      return value.filter((v): v is string => typeof v === 'string');
    }
    default:
      return primitive(value);
  }
}

/**
 * A record's TITLE as somebody outside may read it (C-133): the title
 * column's cell through `publicCellValue`, as text.
 *
 * NEVER `records_rows.display_title`. That column is written for the signed-in
 * grid, and for a title column that is a reference it has held the cell's raw
 * JSON -- `{"id":"...","name":"..."}` -- so printing it put an internal id (and,
 * for an id of another tenant sitting in the cell, that id and its label) on
 * the update-request page, the sign-off page and the mail that carries the
 * link. Every title that leaves is computed here from the row's data instead.
 * No title column, or a title that resolves to nothing, is null and the page
 * says "this record".
 */
export async function publicRowTitle(
  db: D1Database,
  tenantId: string,
  columns: Array<Pick<RecordColumnRow, 'key' | 'type' | 'is_title' | 'archived'>>,
  data: Record<string, unknown>,
  depth = 0,
): Promise<string | null> {
  const titleColumn = columns.find((c) => c.is_title === 1 && !c.archived);
  if (!titleColumn) return null;
  const value = await publicCellValue(db, tenantId, titleColumn, data[titleColumn.key], depth);
  if (value == null) return null;
  const text = Array.isArray(value)
    ? value.join(', ')
    : typeof value === 'boolean'
      ? (value ? 'Yes' : 'No')
      : String(value);
  return text.trim() ? text.trim().slice(0, 300) : null;
}

/**
 * The address a public Records route counts a caller by: the one Cloudflare
 * itself reports. `X-Forwarded-For` is the caller's own header and is NOT
 * read here -- a limiter keyed on it is reset by changing a string. With no
 * `CF-Connecting-IP` (only possible off Cloudflare) every caller shares one
 * bucket, which is the safe direction.
 */
export function publicClientIp(request: Request): string {
  return request.headers.get('CF-Connecting-IP')?.trim() || 'unknown';
}

// ---------------------------------------------------------------------------
// Who sent this
// ---------------------------------------------------------------------------

/**
 * The name an outsider reads as "who sent this": the sender's display name,
 * otherwise the organisation's (brand display name, then the tenant's own
 * name). NEVER an email address -- a user whose name was never set, or was
 * set to their address, is shown as the organisation.
 */
export async function publicSenderName(
  db: D1Database,
  tenantId: string,
  senderName: string | null | undefined,
): Promise<string> {
  const name = (senderName ?? '').trim();
  if (name && !name.includes('@')) return name;
  const tenant = await db.prepare('SELECT name FROM tenants WHERE id = ?').bind(tenantId).first<{ name: string | null }>();
  return loadOutwardName(db, tenantId, tenant?.name || 'The team');
}

// ---------------------------------------------------------------------------
// Reading a page: rate limit
// ---------------------------------------------------------------------------

const VIEW_WINDOW_SECONDS = 60 * 60;

/**
 * Count one read of a public page against (the thing read, the address).
 * Keyed on the record's id, never on the slug or token, so the key does not
 * carry the secret and one leaked link cannot spend another's budget.
 * Returns false when the address is over the limit.
 */
export async function takePublicView(
  db: D1Database,
  bucket: 'records_form_view' | 'records_update_request_view' | 'records_approval_view',
  recordId: string,
  ip: string,
  limitPerHour: number,
): Promise<boolean> {
  const key = `${bucket}:${recordId}:${ip}`;
  const rl = await checkRateLimit(db, key, limitPerHour, VIEW_WINDOW_SECONDS);
  if (!rl.allowed) return false;
  await recordAttempt(db, key, VIEW_WINDOW_SECONDS);
  return true;
}

export function rateLimited(): Response {
  return new Response(JSON.stringify({ error: 'Rate limit exceeded. Try again later.' }), {
    status: 429,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

/** The one 404 of a surface. Every unusable state answers with exactly this. */
export function publicNotFound(message: 'Form not found' | 'Request not found' | 'Approval not found'): Response {
  return new Response(JSON.stringify({ error: message }), {
    status: 404,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
