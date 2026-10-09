/**
 * The tenant brand record (migration 0140): the ONE reader and the ONE writer.
 *
 *   loadTenantBrand(db, tenantId)      the resolved record, with fallbacks
 *   loadPublicBrand(db, tenantId, s)   what an outsider on surface `s` is given
 *   saveTenantBrand / storeBrandLogo / removeBrandLogo
 *   readBrandLogo(env, token)          the public logo route's only read
 *
 * WHO MAY ASK FOR A BRAND. There is no endpoint that answers "what is tenant
 * X's brand" to somebody who is not that tenant's admin. An outsider gets a
 * brand in exactly one way: inside the payload of a token route they already
 * hold a valid token for, where the route -- not the caller -- supplies the
 * tenant id from the link it resolved. `loadPublicBrand` therefore takes a
 * tenant id and must only ever be handed one that came off a resolved link,
 * a stored record or the signed-in user, never off a query string.
 *
 * A BRAND NEVER BREAKS THE THING IT DECORATES. `loadPublicBrand` returns null
 * on ANY failure (no row, no table yet, a bad row), and null draws exactly
 * what was drawn before 0140. A mail that would have been sent is still sent.
 */

import {
  cleanBrandColor,
  cleanBrandText,
  cleanDisplayName,
  cleanSupportLine,
  cleanSupportOverrides,
  isEmptySupportLine,
  judgeLogo,
  parseBrandColor,
  parseStoredOverrides,
  toPublicBrand,
  BRAND_LOGO_RETAINED_MAX,
  BRAND_WITHDRAW_REASON_MAX,
  LOGO_CONTENT_TYPES,
} from '../../shared/tenantBrand';
import type { BrandSource, BrandSurface, LogoContentType } from '../../shared/tenantBrand';
import type {
  BrandSupportLine,
  PublicBrand,
  TenantBrandLogo,
  TenantBrandLogoRecord,
  TenantBrandResponse,
  TenantBrandUpdateRequest,
} from '../../shared/types';
import { generateId, logAudit } from './db';
import { ForbiddenError } from './permissions';

// ---------------------------------------------------------------------------
// Logo addressing
// ---------------------------------------------------------------------------

const LOGO_TOKEN = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const EXTENSION: Record<LogoContentType, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

export const BRAND_LOGO_ROUTE = '/api/public/brand-logo';

export function brandLogoPath(urlToken: string): string {
  return `${BRAND_LOGO_ROUTE}/${urlToken}`;
}

/** The only shape of key a logo is ever written to or read from. */
export function brandLogoKey(tenantId: string, sha256: string, contentType: LogoContentType): string {
  return `brand/${tenantId}/logo-${sha256}.${EXTENSION[contentType]}`;
}

async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * The public URL token. It is a hash of the tenant and of the image, so the
 * only way to compute it is to already hold the image; the same image is the
 * same URL and a new image is a new one.
 */
export async function brandLogoToken(tenantId: string, contentSha256: string): Promise<string> {
  return (await sha256Hex(`dox-brand-logo:${tenantId}:${contentSha256}`)).slice(0, 40);
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

interface BrandRow {
  tenant_id: string;
  tenant_name: string;
  has_row: number;
  display_name: string | null;
  primary_color: string | null;
  accent_color: string | null;
  support_text: string | null;
  support_email: string | null;
  support_phone: string | null;
  support_overrides: string | null;
  updated_at: string | null;
  updated_by_name: string | null;
  logo_token: string | null;
  logo_content_type: string | null;
  logo_size_bytes: number | null;
  logo_width: number | null;
  logo_height: number | null;
  logo_created_at: string | null;
}

/**
 * A brand with every fallback applied.
 *
 * `configured` is THE question every reader asks, and it is not "is there a
 * row". It is true when at least one field is set or a logo is current. A row
 * with nothing in it -- every field cleared, the logo taken off -- reads
 * exactly as no row: `configured` false, no `brand` in any payload, the
 * unbranded mail byte for byte. (The writer also deletes such a row, so the
 * reader's rule is the safety net and the writer's is the tidy state.)
 */
export interface ResolvedTenantBrand extends BrandSource {
  tenant_id: string;
  tenant_name: string;
  configured: boolean;
  /** A `tenant_brands` row exists, set or not. Only the writer cares. */
  stored: boolean;
  /** As stored (null = `display_name` above is the tenant name). */
  stored_display_name: string | null;
  support_overrides: Partial<Record<BrandSurface, BrandSupportLine>>;
  logo: TenantBrandLogo | null;
  updated_at: string | null;
  updated_by_name: string | null;
}

/**
 * One request's (or one scheduled run's) brands. Pass the same cache to every
 * call in a request and a tenant is read once. It is an explicit object rather
 * than something keyed on the database binding because a binding can outlive a
 * request, and a brand cached beyond the request that read it would go on
 * showing a logo an admin had just replaced.
 */
export type BrandCache = Map<string, Promise<ResolvedTenantBrand | null>>;

export function createBrandCache(): BrandCache {
  return new Map();
}

/** The cache of a Pages Function request, kept on `context.data`. */
export function requestBrandCache(data: Record<string, unknown> | undefined | null): BrandCache {
  if (!data) return createBrandCache();
  const existing = data.__brandCache;
  if (existing instanceof Map) return existing as BrandCache;
  const cache = createBrandCache();
  data.__brandCache = cache;
  return cache;
}

function toResolved(row: BrandRow): ResolvedTenantBrand {
  const stored = row.has_row === 1;
  // Every stored value goes back through the same validation it was written
  // through. A row edited by hand can lose a field this way; it cannot put an
  // unchecked string on a page.
  const name = stored ? cleanDisplayName(row.display_name) : null;
  const storedName = name && name.ok ? name.value : null;
  const supportResult = stored
    ? cleanSupportLine({ text: row.support_text, email: row.support_email, phone: row.support_phone }, 'support')
    : null;
  const support = supportResult && supportResult.ok ? supportResult.value : null;
  const primary = stored ? parseBrandColor(row.primary_color) : null;
  const accent = stored ? parseBrandColor(row.accent_color) : null;
  const overrides = stored ? parseStoredOverrides(row.support_overrides) : {};
  const logoOk =
    stored &&
    row.logo_token !== null &&
    LOGO_TOKEN.test(row.logo_token) &&
    (LOGO_CONTENT_TYPES as readonly string[]).includes(row.logo_content_type ?? '');
  // Judged on what SURVIVED validation: a row holding only values the reader
  // dropped is as empty as one holding none.
  const configured =
    stored &&
    (storedName !== null ||
      primary !== null ||
      accent !== null ||
      !isEmptySupportLine(support) ||
      Object.keys(overrides).length > 0 ||
      logoOk);
  return {
    tenant_id: row.tenant_id,
    tenant_name: row.tenant_name,
    configured,
    stored,
    stored_display_name: storedName,
    display_name: storedName ?? row.tenant_name,
    primary_color: primary,
    accent_color: accent,
    support,
    support_overrides: overrides,
    logo_path: logoOk ? brandLogoPath(row.logo_token!) : null,
    logo: logoOk
      ? {
          url: brandLogoPath(row.logo_token!),
          content_type: row.logo_content_type!,
          size_bytes: row.logo_size_bytes ?? 0,
          width: row.logo_width ?? 0,
          height: row.logo_height ?? 0,
          uploaded_at: row.logo_created_at ?? '',
        }
      : null,
    updated_at: configured ? row.updated_at : null,
    updated_by_name: configured ? row.updated_by_name : null,
  };
}

async function readBrand(db: D1Database, tenantId: string): Promise<ResolvedTenantBrand | null> {
  // The logo is joined on the TENANT as well as on its id: a brand row can
  // only ever resolve a logo of its own tenant, whatever its logo_id says.
  const row = await db
    .prepare(
      `SELECT t.id AS tenant_id, t.name AS tenant_name,
              CASE WHEN b.tenant_id IS NULL THEN 0 ELSE 1 END AS has_row,
              b.display_name, b.primary_color, b.accent_color,
              b.support_text, b.support_email, b.support_phone, b.support_overrides,
              b.updated_at, u.name AS updated_by_name,
              l.url_token AS logo_token, l.content_type AS logo_content_type,
              l.size_bytes AS logo_size_bytes, l.width AS logo_width, l.height AS logo_height,
              l.created_at AS logo_created_at
         FROM tenants t
         LEFT JOIN tenant_brands b ON b.tenant_id = t.id
         LEFT JOIN tenant_brand_logos l
           ON l.id = b.logo_id AND l.tenant_id = t.id AND l.withdrawn_at IS NULL
         LEFT JOIN users u ON u.id = b.updated_by
        WHERE t.id = ?`,
    )
    .bind(tenantId)
    .first<BrandRow>();
  return row ? toResolved(row) : null;
}

/**
 * The tenant's brand, fully resolved. Null only when the tenant does not
 * exist. A tenant with no brand -- no row, or a row with nothing in it -- comes
 * back with `configured: false`, the tenant name as its display name and
 * nothing else set.
 */
export function loadTenantBrand(
  db: D1Database,
  tenantId: string,
  cache?: BrandCache,
): Promise<ResolvedTenantBrand | null> {
  if (!cache) return readBrand(db, tenantId);
  let hit = cache.get(tenantId);
  if (!hit) {
    hit = readBrand(db, tenantId);
    cache.set(tenantId, hit);
  }
  return hit;
}

/**
 * What an outsider on `surface` is given, or null when the tenant has no brand
 * record (or anything at all went wrong reading it). `origin` makes the logo
 * URL absolute, which a mail needs and a page does not.
 */
export async function loadPublicBrand(
  db: D1Database,
  tenantId: string | null | undefined,
  surface: BrandSurface,
  opts: { origin?: string | null; cache?: BrandCache } = {},
): Promise<PublicBrand | null> {
  if (!tenantId) return null;
  try {
    const brand = await loadTenantBrand(db, tenantId, opts.cache);
    if (!brand || !brand.configured) return null;
    return toPublicBrand(brand, surface, opts.origin);
  } catch (err) {
    console.error('Tenant brand read failed; drawing the unbranded surface:', err);
    return null;
  }
}

interface LogoListRow extends LogoRow {
  created_at: string;
  withdrawn_by_name: string | null;
}

/** Every logo the tenant has published, newest first, withdrawn ones included. */
export async function listBrandLogos(db: D1Database, tenantId: string): Promise<TenantBrandLogoRecord[]> {
  const res = await db
    .prepare(
      `SELECT l.*, u.name AS withdrawn_by_name,
              CASE WHEN b.logo_id = l.id THEN 1 ELSE 0 END AS is_current
         FROM tenant_brand_logos l
         LEFT JOIN tenant_brands b ON b.tenant_id = l.tenant_id
         LEFT JOIN users u ON u.id = l.withdrawn_by
        WHERE l.tenant_id = ?
        ORDER BY l.created_at DESC, l.id DESC`,
    )
    .bind(tenantId)
    .all<LogoListRow & { is_current: number }>();
  return (res.results ?? []).map((l) => ({
    id: l.id,
    url: brandLogoPath(l.url_token),
    content_type: l.content_type,
    size_bytes: l.size_bytes,
    width: l.width,
    height: l.height,
    uploaded_at: l.created_at,
    current: l.is_current === 1 && !l.withdrawn_at,
    withdrawn_at: l.withdrawn_at ?? null,
    withdrawn_reason: l.withdrawn_reason ?? null,
    withdrawn_by_name: l.withdrawn_by_name ?? null,
  }));
}

/** The admin's view: the record, and every logo behind it. */
export async function brandResponse(db: D1Database, brand: ResolvedTenantBrand): Promise<TenantBrandResponse> {
  return {
    tenant_id: brand.tenant_id,
    tenant_name: brand.tenant_name,
    configured: brand.configured,
    display_name: brand.stored_display_name,
    primary_color: brand.primary_color,
    accent_color: brand.accent_color,
    support: brand.support ?? { text: null, email: null, phone: null },
    support_overrides: brand.support_overrides as Record<string, BrandSupportLine>,
    logo: brand.logo,
    logos: await listBrandLogos(db, brand.tenant_id),
    logo_limit: BRAND_LOGO_RETAINED_MAX,
    updated_at: brand.updated_at,
    updated_by_name: brand.updated_by_name,
  };
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * Who may manage a brand: an org_admin of THIS tenant, or a super_admin.
 * Checked BEFORE the tenant is looked up, so another tenant's admin gets the
 * same answer for a real tenant and an invented one.
 */
export function requireBrandAdmin(user: { role: string; tenant_id: string | null }, tenantId: string): void {
  if (user.role === 'super_admin') return;
  if (user.role === 'org_admin' && user.tenant_id === tenantId) return;
  throw new ForbiddenError('Only an administrator of this organization can manage its brand');
}

export class BrandValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrandValidationError';
  }
}

/** The request is well formed and the brand's present state refuses it (409). */
export class BrandConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrandConflictError';
  }
}

interface StoredFields {
  display_name: string | null;
  primary_color: string | null;
  accent_color: string | null;
  support_text: string | null;
  support_email: string | null;
  support_phone: string | null;
  support_overrides: Partial<Record<BrandSurface, BrandSupportLine>>;
}

function storedFields(brand: ResolvedTenantBrand): StoredFields {
  return {
    display_name: brand.stored_display_name,
    primary_color: brand.primary_color,
    accent_color: brand.accent_color,
    support_text: brand.support?.text ?? null,
    support_email: brand.support?.email ?? null,
    support_phone: brand.support?.phone ?? null,
    support_overrides: brand.support_overrides,
  };
}

const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

/**
 * Apply a PUT body to the stored fields. Throws `BrandValidationError` naming
 * the first thing wrong; nothing is written unless every field passes.
 */
export function applyBrandUpdate(current: StoredFields, body: TenantBrandUpdateRequest): StoredFields {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new BrandValidationError('The request body must be an object');
  }
  const next: StoredFields = { ...current };
  const fail = (error: string): never => {
    throw new BrandValidationError(error);
  };

  if (has(body, 'display_name')) {
    const r = cleanDisplayName(body.display_name);
    next.display_name = r.ok ? r.value : fail(r.error);
  }
  if (has(body, 'primary_color')) {
    const r = cleanBrandColor(body.primary_color, 'Primary colour');
    next.primary_color = r.ok ? r.value : fail(r.error);
  }
  if (has(body, 'accent_color')) {
    const r = cleanBrandColor(body.accent_color, 'Accent colour');
    next.accent_color = r.ok ? r.value : fail(r.error);
  }
  if (has(body, 'support')) {
    // A field left out of `support` is unchanged, like a field left out of the body.
    const patch = body.support;
    if (patch !== null && (typeof patch !== 'object' || Array.isArray(patch))) fail('support must be an object');
    const merged = {
      text: patch && has(patch, 'text') ? patch.text : patch === null ? null : current.support_text,
      email: patch && has(patch, 'email') ? patch.email : patch === null ? null : current.support_email,
      phone: patch && has(patch, 'phone') ? patch.phone : patch === null ? null : current.support_phone,
    };
    const r = cleanSupportLine(merged, 'Support line');
    if (!r.ok) fail(r.error);
    else {
      next.support_text = r.value?.text ?? null;
      next.support_email = r.value?.email ?? null;
      next.support_phone = r.value?.phone ?? null;
    }
  }
  if (has(body, 'support_overrides')) {
    const r = cleanSupportOverrides(body.support_overrides);
    if (!r.ok) fail(r.error);
    else next.support_overrides = r.value;
  }
  return next;
}

function overridesJson(o: Partial<Record<BrandSurface, BrandSupportLine>>): string | null {
  const keys = (Object.keys(o) as BrandSurface[]).filter((k) => !isEmptySupportLine(o[k])).sort();
  if (keys.length === 0) return null;
  return JSON.stringify(Object.fromEntries(keys.map((k) => [k, o[k]])));
}

function diffFields(before: StoredFields, after: StoredFields): Record<string, { from: unknown; to: unknown }> {
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const key of ['display_name', 'primary_color', 'accent_color', 'support_text', 'support_email', 'support_phone'] as const) {
    if ((before[key] ?? null) !== (after[key] ?? null)) changes[key] = { from: before[key] ?? null, to: after[key] ?? null };
  }
  const a = overridesJson(before.support_overrides);
  const b = overridesJson(after.support_overrides);
  if (a !== b) changes.support_overrides = { from: a ? JSON.parse(a) : null, to: b ? JSON.parse(b) : null };
  return changes;
}

export interface BrandActor {
  userId: string;
  ip: string | null;
  /** `jwt` or `api_key`, recorded in the audit row. */
  via?: string;
}

/**
 * Delete the brand row when NOTHING is left in it. One statement, so two
 * writers cannot leave an empty row between them. "No brand" is one state, and
 * clearing the last field is how a tenant gets back to it.
 */
async function dropRowIfEmpty(db: D1Database, tenantId: string): Promise<void> {
  await db
    .prepare(
      `DELETE FROM tenant_brands
        WHERE tenant_id = ?
          AND display_name IS NULL AND primary_color IS NULL AND accent_color IS NULL
          AND support_text IS NULL AND support_email IS NULL AND support_phone IS NULL
          AND support_overrides IS NULL AND logo_id IS NULL`,
    )
    .bind(tenantId)
    .run();
}

function isEmptyFields(f: StoredFields): boolean {
  return (
    f.display_name === null &&
    f.primary_color === null &&
    f.accent_color === null &&
    f.support_text === null &&
    f.support_email === null &&
    f.support_phone === null &&
    overridesJson(f.support_overrides) === null
  );
}

/**
 * Save the text and colour fields.
 *
 *   - Nothing changed: nothing is written and nothing is audited -- including
 *     an empty body on a tenant that has no brand, which creates no row.
 *   - Something is set: the row is created or updated.
 *   - The last thing was cleared (and no logo is current): the row is DELETED.
 *     The tenant is unbranded again, exactly as if it had never had a brand.
 */
export async function saveTenantBrand(
  db: D1Database,
  tenantId: string,
  body: TenantBrandUpdateRequest,
  actor: BrandActor,
): Promise<ResolvedTenantBrand | null> {
  const current = await readBrand(db, tenantId);
  if (!current) return null;
  const before = storedFields(current);
  const after = applyBrandUpdate(before, body);
  const changes = diffFields(before, after);
  if (Object.keys(changes).length === 0) return current;

  await db
    .prepare(
      `INSERT INTO tenant_brands
         (tenant_id, display_name, primary_color, accent_color,
          support_text, support_email, support_phone, support_overrides, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(tenant_id) DO UPDATE SET
         display_name = excluded.display_name,
         primary_color = excluded.primary_color,
         accent_color = excluded.accent_color,
         support_text = excluded.support_text,
         support_email = excluded.support_email,
         support_phone = excluded.support_phone,
         support_overrides = excluded.support_overrides,
         updated_by = excluded.updated_by,
         updated_at = datetime('now')`,
    )
    .bind(
      tenantId,
      after.display_name,
      after.primary_color,
      after.accent_color,
      after.support_text,
      after.support_email,
      after.support_phone,
      overridesJson(after.support_overrides),
      actor.userId,
    )
    .run();
  if (isEmptyFields(after)) await dropRowIfEmpty(db, tenantId);

  const next = await readBrand(db, tenantId);
  await logAudit(
    db,
    actor.userId,
    tenantId,
    'tenant.brand_updated',
    'tenant',
    tenantId,
    JSON.stringify({
      changes,
      created: !current.configured,
      ...(next && !next.configured ? { removed: true } : {}),
      via: actor.via ?? 'jwt',
    }),
    actor.ip,
  );
  return next;
}

/**
 * "Remove brand": every field cleared and the logo taken off, in one act. The
 * tenant is unbranded from the next page and the next mail. Logos already
 * published stay reachable (mail already sent shows them) until an admin
 * withdraws them; this does not withdraw anything.
 */
export async function removeTenantBrand(
  db: D1Database,
  tenantId: string,
  actor: BrandActor,
): Promise<ResolvedTenantBrand | null> {
  const current = await readBrand(db, tenantId);
  if (!current) return null;
  if (!current.stored) return current;
  const before = storedFields(current);
  const changes = diffFields(before, {
    display_name: null,
    primary_color: null,
    accent_color: null,
    support_text: null,
    support_email: null,
    support_phone: null,
    support_overrides: {},
  });
  const logo = await currentLogo(db, tenantId);
  await db.prepare('DELETE FROM tenant_brands WHERE tenant_id = ?').bind(tenantId).run();
  // An empty row was already "no brand": tidying it away is not an event.
  if (current.configured) {
    await logAudit(
      db,
      actor.userId,
      tenantId,
      'tenant.brand_updated',
      'tenant',
      tenantId,
      JSON.stringify({
        changes: { ...changes, ...(logo ? { logo: { from: logoAudit(logo), to: null } } : {}) },
        created: false,
        removed: true,
        via: actor.via ?? 'jwt',
      }),
      actor.ip,
    );
  }
  return readBrand(db, tenantId);
}

interface LogoRow {
  id: string;
  tenant_id: string;
  url_token: string;
  sha256: string;
  r2_key: string;
  content_type: string;
  size_bytes: number;
  width: number;
  height: number;
  withdrawn_at?: string | null;
  withdrawn_by?: string | null;
  withdrawn_reason?: string | null;
}

/** What the audit row says about a logo: what it was, never the image. */
function logoAudit(l: Pick<LogoRow, 'sha256' | 'content_type' | 'size_bytes' | 'width' | 'height'> | null) {
  return l
    ? { sha256: l.sha256, content_type: l.content_type, size_bytes: l.size_bytes, width: l.width, height: l.height }
    : null;
}

async function currentLogo(db: D1Database, tenantId: string): Promise<LogoRow | null> {
  return db
    .prepare(
      `SELECT l.* FROM tenant_brands b
         JOIN tenant_brand_logos l ON l.id = b.logo_id AND l.tenant_id = b.tenant_id
        WHERE b.tenant_id = ?`,
    )
    .bind(tenantId)
    .first<LogoRow>();
}

const logoBySha = (db: D1Database, tenantId: string, sha256: string) =>
  db.prepare('SELECT * FROM tenant_brand_logos WHERE tenant_id = ? AND sha256 = ?').bind(tenantId, sha256).first<LogoRow>();

/**
 * Publish a logo: judge the BYTES (never the claimed type), store them under a
 * key built from the tenant and the content hash, and point the brand at them.
 *
 * THE SAME IMAGE TWICE IS ONE LOGO, however the two uploads are timed: the row
 * is written with ON CONFLICT DO NOTHING and read back, so two requests that
 * arrive together both succeed and both name the same logo.
 *
 * AN IMAGE THAT WAS WITHDRAWN AND IS UPLOADED AGAIN IS PUBLISHED AGAIN, at the
 * URL it had. That is the admin choosing to put it back, and it is audited as
 * a restoration; mail that showed a broken image shows the logo again.
 *
 * THE CAP. A tenant keeps at most BRAND_LOGO_RETAINED_MAX published logos. A
 * NEW image past that is refused with the reason; nothing is withdrawn to
 * make room, because withdrawing breaks the image in mail already sent and
 * that is a person's decision.
 */
export async function storeBrandLogo(
  env: { DB: D1Database; FILES: R2Bucket },
  tenantId: string,
  bytes: Uint8Array,
  actor: BrandActor,
): Promise<ResolvedTenantBrand | null> {
  const verdict = judgeLogo(bytes);
  if (!verdict.ok) throw new BrandValidationError(verdict.error);
  const { contentType, width, height } = verdict.logo;

  const brand = await readBrand(env.DB, tenantId);
  if (!brand) return null;

  const sha256 = await sha256Hex(bytes);
  const key = brandLogoKey(tenantId, sha256, contentType);
  const urlToken = await brandLogoToken(tenantId, sha256);

  const existing = await logoBySha(env.DB, tenantId, sha256);
  const restoring = !!existing?.withdrawn_at;
  if (!existing || restoring) {
    const kept = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM tenant_brand_logos WHERE tenant_id = ? AND withdrawn_at IS NULL',
    )
      .bind(tenantId)
      .first<{ n: number }>();
    if ((kept?.n ?? 0) >= BRAND_LOGO_RETAINED_MAX) {
      throw new BrandConflictError(
        `This organization already keeps ${BRAND_LOGO_RETAINED_MAX} published logos, the most allowed. ` +
          'Withdraw one you no longer need (Settings > Brand > Past logos) before uploading another.',
      );
    }
  }

  // Idempotent: the key is the content hash, so writing it again writes the
  // same bytes. It also puts back the object of a withdrawn image.
  await env.FILES.put(key, bytes, { httpMetadata: { contentType } });
  await env.DB.prepare(
    `INSERT INTO tenant_brand_logos
       (id, tenant_id, url_token, sha256, r2_key, content_type, size_bytes, width, height, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT DO NOTHING`,
  )
    .bind(generateId(), tenantId, urlToken, sha256, key, contentType, bytes.length, width, height, actor.userId)
    .run();
  if (restoring) {
    await env.DB.prepare(
      `UPDATE tenant_brand_logos
          SET withdrawn_at = NULL, withdrawn_by = NULL, withdrawn_reason = NULL
        WHERE tenant_id = ? AND sha256 = ?`,
    )
      .bind(tenantId, sha256)
      .run();
  }
  const logo = await logoBySha(env.DB, tenantId, sha256);
  if (!logo) throw new Error('The logo row could not be read back');

  const previous = await currentLogo(env.DB, tenantId);
  if (previous?.id !== logo.id) {
    await env.DB.prepare(
      `INSERT INTO tenant_brands (tenant_id, logo_id, updated_by) VALUES (?, ?, ?)
       ON CONFLICT(tenant_id) DO UPDATE SET
         logo_id = excluded.logo_id, updated_by = excluded.updated_by, updated_at = datetime('now')`,
    )
      .bind(tenantId, logo.id, actor.userId)
      .run();
    await logAudit(
      env.DB,
      actor.userId,
      tenantId,
      'tenant.brand_updated',
      'tenant',
      tenantId,
      JSON.stringify({
        changes: { logo: { from: logoAudit(previous), to: logoAudit(logo) } },
        created: !brand.configured,
        ...(restoring ? { restored_withdrawn_logo: true } : {}),
        via: actor.via ?? 'jwt',
      }),
      actor.ip,
    );
  }
  return readBrand(env.DB, tenantId);
}

/**
 * Take the logo off the brand. The published object and its row STAY, so mail
 * already sent keeps showing the logo it was sent with; only new mail and
 * pages stop using it. (To make a published logo unreachable, withdraw it.)
 * If the logo was the last thing the brand held, the tenant is unbranded.
 */
export async function removeBrandLogo(
  db: D1Database,
  tenantId: string,
  actor: BrandActor,
): Promise<ResolvedTenantBrand | null> {
  const brand = await readBrand(db, tenantId);
  if (!brand) return null;
  const previous = await currentLogo(db, tenantId);
  if (!previous) return brand;
  await db
    .prepare(`UPDATE tenant_brands SET logo_id = NULL, updated_by = ?, updated_at = datetime('now') WHERE tenant_id = ?`)
    .bind(actor.userId, tenantId)
    .run();
  await dropRowIfEmpty(db, tenantId);
  const next = await readBrand(db, tenantId);
  await logAudit(
    db,
    actor.userId,
    tenantId,
    'tenant.brand_updated',
    'tenant',
    tenantId,
    JSON.stringify({
      changes: { logo: { from: logoAudit(previous), to: null } },
      created: false,
      ...(next && !next.configured ? { removed: true } : {}),
      via: actor.via ?? 'jwt',
    }),
    actor.ip,
  );
  return next;
}

export type WithdrawOutcome =
  | { ok: true; brand: ResolvedTenantBrand; already: boolean }
  | { ok: false; reason: 'tenant_not_found' | 'logo_not_found' };

/**
 * WITHDRAW a published logo: its URL answers 404 from now on and the image is
 * deleted from storage. This is the one way a logo stops being reachable, and
 * it is a person's act with a stated reason, because mail already sent that
 * shows this logo will show a broken image instead.
 *
 * The row is marked first and the object deleted second: the URL is dead the
 * moment the row says so (`readBrandLogo` refuses a withdrawn row), so a failed
 * delete leaves nothing reachable, and asking again deletes what is left.
 * A logo the brand is showing is taken off the brand as part of the same act.
 */
export async function withdrawBrandLogo(
  env: { DB: D1Database; FILES: R2Bucket },
  tenantId: string,
  logoId: string,
  reasonRaw: unknown,
  actor: BrandActor,
): Promise<WithdrawOutcome> {
  const reason = cleanBrandText(reasonRaw, 'Reason', BRAND_WITHDRAW_REASON_MAX, { requireVisible: true });
  if (!reason.ok) throw new BrandValidationError(reason.error);
  if (reason.value === null) throw new BrandValidationError('Say why this logo is being withdrawn');

  const brand = await readBrand(env.DB, tenantId);
  if (!brand) return { ok: false, reason: 'tenant_not_found' };
  // Found by id AND tenant: another tenant's logo id is simply not there.
  const row = await env.DB.prepare('SELECT * FROM tenant_brand_logos WHERE id = ? AND tenant_id = ?')
    .bind(logoId, tenantId)
    .first<LogoRow>();
  if (!row) return { ok: false, reason: 'logo_not_found' };

  // The only key ever deleted is the one this row can be PROVEN to own.
  const typeOk = (LOGO_CONTENT_TYPES as readonly string[]).includes(row.content_type) && SHA256.test(row.sha256);
  const key = typeOk ? brandLogoKey(row.tenant_id, row.sha256, row.content_type as LogoContentType) : null;
  const ownedKey = key !== null && key === row.r2_key ? key : null;

  if (row.withdrawn_at) {
    if (ownedKey) await env.FILES.delete(ownedKey);
    return { ok: true, brand, already: true };
  }

  const current = await currentLogo(env.DB, tenantId);
  const wasCurrent = current?.id === row.id;
  if (wasCurrent) {
    await env.DB.prepare(
      `UPDATE tenant_brands SET logo_id = NULL, updated_by = ?, updated_at = datetime('now') WHERE tenant_id = ?`,
    )
      .bind(actor.userId, tenantId)
      .run();
    await dropRowIfEmpty(env.DB, tenantId);
  }
  await env.DB.prepare(
    `UPDATE tenant_brand_logos
        SET withdrawn_at = datetime('now'), withdrawn_by = ?, withdrawn_reason = ?
      WHERE id = ? AND tenant_id = ? AND withdrawn_at IS NULL`,
  )
    .bind(actor.userId, reason.value, row.id, tenantId)
    .run();
  if (ownedKey) await env.FILES.delete(ownedKey);

  await logAudit(
    env.DB,
    actor.userId,
    tenantId,
    'tenant.brand_logo_withdrawn',
    'tenant',
    tenantId,
    JSON.stringify({
      logo_id: row.id,
      logo: logoAudit(row),
      reason: reason.value,
      was_current: wasCurrent,
      object_deleted: ownedKey !== null,
      via: actor.via ?? 'jwt',
    }),
    actor.ip,
  );
  const next = await readBrand(env.DB, tenantId);
  return { ok: true, brand: next ?? brand, already: false };
}

// ---------------------------------------------------------------------------
// The public logo read
// ---------------------------------------------------------------------------

export interface BrandLogoObject {
  body: ReadableStream;
  contentType: LogoContentType;
  size: number;
  etag: string;
}

/**
 * The bytes behind one public logo URL, or null.
 *
 * NO CALLER-SUPPLIED STRING REACHES THE BUCKET. The token is matched against a
 * fixed pattern and used only as a bound parameter to find a row; the key that
 * is read is REBUILT here from that row's tenant, hash and type, and must equal
 * the key the row stores. So this can only ever read an object that
 * `storeBrandLogo` wrote under `brand/<tenant>/logo-<hash>.<ext>` -- never a
 * document, whatever is in the URL or in the row. A WITHDRAWN logo is not
 * served: its row says so before the bucket is asked.
 */
export async function readBrandLogo(
  env: { DB: D1Database; FILES: R2Bucket },
  token: string,
): Promise<BrandLogoObject | null> {
  if (typeof token !== 'string' || !LOGO_TOKEN.test(token)) return null;
  const row = await env.DB.prepare('SELECT * FROM tenant_brand_logos WHERE url_token = ?').bind(token).first<LogoRow>();
  if (!row) return null;
  // Withdrawn: the URL is dead, whether or not the object is gone yet.
  if (row.withdrawn_at) return null;
  if (!(LOGO_CONTENT_TYPES as readonly string[]).includes(row.content_type)) return null;
  if (!SHA256.test(row.sha256)) return null;
  const contentType = row.content_type as LogoContentType;
  const key = brandLogoKey(row.tenant_id, row.sha256, contentType);
  if (row.r2_key !== key) return null;
  const object = await env.FILES.get(key);
  if (!object) return null;
  return { body: object.body, contentType, size: object.size, etag: row.sha256 };
}

/**
 * What the organisation is called to an OUTSIDER: the brand's display name,
 * which is the tenant's own name until an admin sets one. Used for the From
 * name and the default subject of mail that leaves, so the name in the inbox
 * and the name in the header are the same name. Never throws: on any failure
 * it is `fallback`.
 */
export async function loadOutwardName(
  db: D1Database,
  tenantId: string | null | undefined,
  fallback: string,
  cache?: BrandCache,
): Promise<string> {
  if (!tenantId) return fallback;
  try {
    const brand = await loadTenantBrand(db, tenantId, cache);
    return brand?.display_name || fallback;
  } catch (err) {
    console.error('Tenant brand read failed; using the organisation name:', err);
    return fallback;
  }
}
