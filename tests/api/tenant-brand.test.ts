/**
 * The tenant brand record (migration 0140).
 *
 * What is worth pinning is not "a colour is saved". It is the properties that
 * make putting a tenant-supplied name, image and sentence in front of people
 * OUTSIDE the organisation defensible:
 *
 *   1. ONLY THE TENANT'S OWN ADMINS manage a brand, and nobody can read one by
 *      tenant id without being one of them.
 *   2. NOTHING A TENANT TYPES BECOMES MARKUP OR STYLE. A colour is #RRGGBB or
 *      it is refused; text is stored as typed and escaped where it is drawn.
 *   3. THE LOGO ROUTE SERVES LOGOS AND NOTHING ELSE. No caller-supplied string
 *      reaches the bucket, whatever is in the URL or in the row.
 *   4. A TENANT'S BRAND APPEARS ONLY ON THAT TENANT'S PAGES AND MAIL. Three
 *      tenants -- A and B branded differently, C not at all -- on every token
 *      route there is.
 *   5. NO BRAND RECORD CHANGES NOTHING: the payload has no `brand` key and the
 *      mail is what it was.
 */

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { seedTestData, generateTestId } from '../helpers/db';
import { readJson, makeRequest } from '../helpers/requests';
import type { RequestFixture, TestUser } from '../helpers/requests';
import { jpegBytes, pngBytes, webpBytes, SVG_BYTES } from '../helpers/brand';
import { applyRecordsMigrations } from '../helpers/records';
import { onRequest as middleware } from '../../functions/api/_middleware';
import { onRequestGet as brandGet, onRequestPut as brandPut } from '../../functions/api/tenants/[id]/brand/index';
import { onRequestPost as logoPost, onRequestDelete as logoDelete } from '../../functions/api/tenants/[id]/brand/logo';
import { onRequestGet as logoGet } from '../../functions/api/public/brand-logo/[token]';
import { onRequestGet as alertGet } from '../../functions/api/alerts/public/[token]';
import { onRequestGet as exportGet } from '../../functions/api/document-exports/public/[token]';
import { onRequestPost as exportSend } from '../../functions/api/document-exports/send';
import { onRequestGet as requestGet } from '../../functions/api/supplier-requests/public/[token]';
import { onRequestGet as formGet } from '../../functions/api/forms/public/[slug]';
import { onRequestGet as updateRequestGet } from '../../functions/api/update-requests/public/[token]';
import { onRequestPost as updateRequestCreate } from '../../functions/api/records/sheets/[sheetId]/rows/[rowId]/update-requests/index';
import { onRequestGet as approvalGet } from '../../functions/api/workflow-approvals/public/[token]';
import { onRequestGet as dropGet } from '../../functions/api/public/connectors/[slug]';
import { mintAlertLink } from '../../functions/lib/alert-links';
import {
  brandLogoKey,
  brandLogoToken,
  loadOutwardName,
  loadPublicBrand,
  loadTenantBrand,
  readBrandLogo,
  createBrandCache,
} from '../../functions/lib/tenant-brand';
import { BRAND_LOGO_MAX_BYTES, BRAND_SURFACES } from '../../shared/tenantBrand';
import type { PublicBrand, TenantBrandResponse } from '../../shared/types';

const db = env.DB;
let seed: Awaited<ReturnType<typeof seedTestData>>;
const TENANT_C = 'brand-tenant-c';
const ADMIN_C = 'brand-admin-c';

let adminA: TestUser;
let adminB: TestUser;
let adminC: TestUser;
let superAdmin: TestUser;
let plainUser: TestUser;
let reader: TestUser;

const A_SECRET = 'A-ONLY-SUPPORT-LINE';
const B_SECRET = 'B-ONLY-SUPPORT-LINE';

type Ctx = Parameters<typeof brandGet>[0];

function ctx(
  url: string,
  init: { method?: string; body?: BodyInit | null; headers?: Record<string, string>; user?: TestUser | null; params?: Record<string, string>; data?: Record<string, unknown> } = {},
): Ctx {
  const u = new URL(url, 'http://localhost');
  return {
    request: new Request(u.toString(), { method: init.method ?? 'GET', body: init.body ?? undefined, headers: init.headers }),
    env,
    data: { ...(init.user ? { user: init.user, authMethod: 'jwt' } : {}), ...(init.data ?? {}) },
    params: init.params ?? {},
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response('NEXT'),
    functionPath: u.pathname,
  } as never;
}

const getBrand = (tenantId: string, user: TestUser | null, data?: Record<string, unknown>) =>
  brandGet(ctx(`/api/tenants/${tenantId}/brand`, { user, params: { id: tenantId }, data }));

const putBrand = (tenantId: string, body: unknown, user: TestUser, data?: Record<string, unknown>) =>
  brandPut(
    ctx(`/api/tenants/${tenantId}/brand`, {
      method: 'PUT',
      body: typeof body === 'string' ? body : JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
      user,
      params: { id: tenantId },
      data,
    }),
  );

function postLogo(
  tenantId: string,
  bytes: Uint8Array,
  user: TestUser,
  opts: { type?: string; name?: string; data?: Record<string, unknown>; field?: string } = {},
) {
  const form = new FormData();
  form.append(opts.field ?? 'file', new File([bytes], opts.name ?? 'logo.png', { type: opts.type ?? 'image/png' }));
  return logoPost(ctx(`/api/tenants/${tenantId}/brand/logo`, { method: 'POST', body: form, user, params: { id: tenantId }, data: opts.data }));
}

const deleteLogo = (tenantId: string, user: TestUser, data?: Record<string, unknown>) =>
  logoDelete(ctx(`/api/tenants/${tenantId}/brand/logo`, { method: 'DELETE', user, params: { id: tenantId }, data }));

const fetchLogo = (token: string) => logoGet(ctx(`/api/public/brand-logo/${token}`, { params: { token } }));

const tokenOf = (url: string) => url.split('/').pop()!;

async function body<T>(res: Response): Promise<T> {
  return (await readJson(res)) as T;
}

async function brandAudit(tenantId: string): Promise<Array<{ user_id: string | null; details: Record<string, unknown> }>> {
  const res = await db
    .prepare("SELECT user_id, details FROM audit_log WHERE action = 'tenant.brand_updated' AND tenant_id = ? ORDER BY id ASC")
    .bind(tenantId)
    .all<{ user_id: string | null; details: string }>();
  return (res.results ?? []).map((r) => ({ user_id: r.user_id, details: JSON.parse(r.details) }));
}

interface CapturedMail {
  to: string[] | string;
  from?: string;
  subject: string;
  html: string;
  text?: string;
  reply_to?: string;
}

function stubMail(): CapturedMail[] {
  const sent: CapturedMail[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).includes('resend.com')) sent.push(JSON.parse(String(init?.body)) as CapturedMail);
      return new Response('{}', { status: 200 });
    }),
  );
  return sent;
}

beforeAll(async () => {
  seed = await seedTestData(db);
  // The Records tables are not in the shared test chain; this file reads three
  // Records public surfaces.
  await applyRecordsMigrations(db);
  await db
    .prepare(`INSERT OR IGNORE INTO tenants (id, name, slug, active) VALUES (?, 'Plain Corp', 'plain-corp-brand', 1)`)
    .bind(TENANT_C)
    .run();
  await db
    .prepare(
      `INSERT OR IGNORE INTO users (id, email, name, role, tenant_id, password_hash, active, force_password_change)
       VALUES (?, 'admin-c@test.com', 'Admin C', 'org_admin', ?, 'x', 1, 0)`,
    )
    .bind(ADMIN_C, TENANT_C)
    .run();

  adminA = { id: seed.orgAdminId, email: 'orgadmin@test.com', name: 'Org Admin', role: 'org_admin', tenant_id: seed.tenantId };
  adminB = { id: seed.orgAdmin2Id, email: 'orgadmin2@test.com', name: 'Org Admin 2', role: 'org_admin', tenant_id: seed.tenantId2 };
  adminC = { id: ADMIN_C, email: 'admin-c@test.com', name: 'Admin C', role: 'org_admin', tenant_id: TENANT_C };
  superAdmin = { id: seed.superAdminId, email: 'admin@test.com', name: 'Super Admin', role: 'super_admin', tenant_id: null };
  plainUser = { id: seed.userId, email: 'user@test.com', name: 'Regular User', role: 'user', tenant_id: seed.tenantId };
  reader = { id: seed.readerId, email: 'reader@test.com', name: 'Reader User', role: 'reader', tenant_id: seed.tenantId };
}, 30_000);

afterEach(() => {
  vi.unstubAllGlobals();
});

// ===========================================================================
// Who may manage a brand
// ===========================================================================

describe('authority', () => {
  it('a tenant with no brand reads as not configured, with the organisation name as its only value', async () => {
    const res = await getBrand(TENANT_C, adminC);
    expect(res.status).toBe(200);
    expect(await body<TenantBrandResponse>(res)).toEqual({
      tenant_id: TENANT_C,
      tenant_name: 'Plain Corp',
      configured: false,
      display_name: null,
      primary_color: null,
      accent_color: null,
      support: { text: null, email: null, phone: null },
      support_overrides: {},
      logo: null,
      updated_at: null,
      updated_by_name: null,
    });
    // Reading it did not create it.
    expect(await db.prepare('SELECT tenant_id FROM tenant_brands WHERE tenant_id = ?').bind(TENANT_C).first()).toBeNull();
  });

  it('a reader and a user are refused, on every verb', async () => {
    for (const who of [reader, plainUser]) {
      expect((await getBrand(seed.tenantId, who)).status).toBe(403);
      expect((await putBrand(seed.tenantId, { display_name: 'Nope' }, who)).status).toBe(403);
      expect((await postLogo(seed.tenantId, pngBytes(320, 96), who)).status).toBe(403);
      expect((await deleteLogo(seed.tenantId, who)).status).toBe(403);
    }
    expect(await db.prepare('SELECT tenant_id FROM tenant_brands WHERE tenant_id = ?').bind(seed.tenantId).first()).toBeNull();
  });

  it("another tenant's admin is refused, and cannot tell a real tenant from an invented one", async () => {
    const real = await getBrand(seed.tenantId, adminB);
    const invented = await getBrand('no-such-tenant', adminB);
    expect(real.status).toBe(403);
    expect(invented.status).toBe(403);
    expect(await real.text()).toBe(await invented.text());
    expect((await putBrand(seed.tenantId, { display_name: 'Hijacked' }, adminB)).status).toBe(403);
    expect((await postLogo(seed.tenantId, pngBytes(320, 96), adminB)).status).toBe(403);
    expect((await deleteLogo(seed.tenantId, adminB)).status).toBe(403);
    expect(await db.prepare('SELECT tenant_id FROM tenant_brands WHERE tenant_id = ?').bind(seed.tenantId).first()).toBeNull();
  });

  it('the brand endpoints sit behind the login; only the logo route is public', async () => {
    const auth = middleware[1];
    const gated = await auth(ctx(`/api/tenants/${seed.tenantId}/brand`));
    expect(gated.status).toBe(401);
    const gatedLogo = await auth(ctx(`/api/tenants/${seed.tenantId}/brand/logo`, { method: 'POST' }));
    expect(gatedLogo.status).toBe(401);
    const open = await auth(ctx(`/api/public/brand-logo/${'a'.repeat(40)}`));
    expect(await open.text()).toBe('NEXT');
  });

  it("an org_admin saves their own tenant's brand; the first save creates the row and is audited", async () => {
    const res = await putBrand(
      seed.tenantId,
      {
        display_name: '  Northfield Foods  ',
        primary_color: '#0b6e4f',
        accent_color: '#F2A900',
        support: { text: A_SECRET, email: 'purchasing@northfield.example', phone: '555 0100' },
        support_overrides: {
          supplier_request: { text: 'Supplier desk A', email: 'suppliers@northfield.example' },
          document_export: { text: 'Customer Service A' },
        },
      },
      adminA,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const saved = await body<TenantBrandResponse>(res);
    expect(saved).toMatchObject({
      configured: true,
      display_name: 'Northfield Foods',
      primary_color: '#0B6E4F',
      accent_color: '#F2A900',
      support: { text: A_SECRET, email: 'purchasing@northfield.example', phone: '555 0100' },
      support_overrides: {
        supplier_request: { text: 'Supplier desk A', email: 'suppliers@northfield.example', phone: null },
        document_export: { text: 'Customer Service A', email: null, phone: null },
      },
      logo: null,
      updated_by_name: 'Org Admin',
    });

    const audit = await brandAudit(seed.tenantId);
    expect(audit).toHaveLength(1);
    expect(audit[0].user_id).toBe(seed.orgAdminId);
    expect(audit[0].details).toMatchObject({
      created: true,
      via: 'jwt',
      changes: {
        display_name: { from: null, to: 'Northfield Foods' },
        primary_color: { from: null, to: '#0B6E4F' },
        support_text: { from: null, to: A_SECRET },
      },
    });
  });

  it('a PUT is a patch: a field left out is unchanged, null clears, and an unchanged save writes nothing', async () => {
    const before = (await brandAudit(seed.tenantId)).length;
    const same = await putBrand(seed.tenantId, { display_name: 'Northfield Foods' }, adminA);
    expect(same.status).toBe(200);
    expect((await brandAudit(seed.tenantId)).length).toBe(before);

    const res = await putBrand(seed.tenantId, { support: { phone: null } }, adminA);
    const next = await body<TenantBrandResponse>(res);
    expect(next.support).toEqual({ text: A_SECRET, email: 'purchasing@northfield.example', phone: null });
    expect(next.display_name).toBe('Northfield Foods');
    expect(next.primary_color).toBe('#0B6E4F');
    expect(Object.keys(next.support_overrides).sort()).toEqual(['document_export', 'supplier_request']);

    const audit = await brandAudit(seed.tenantId);
    expect(audit).toHaveLength(before + 1);
    expect(audit[audit.length - 1].details).toMatchObject({
      created: false,
      changes: { support_phone: { from: '555 0100', to: null } },
    });
    expect(Object.keys((audit[audit.length - 1].details as { changes: object }).changes)).toEqual(['support_phone']);
  });

  it('a super_admin manages any tenant; an unknown tenant is a 404 for them', async () => {
    const res = await putBrand(
      seed.tenantId2,
      { display_name: 'Harborline Dairy Co', primary_color: '#7A1F5C', support: { text: B_SECRET } },
      superAdmin,
    );
    expect(res.status).toBe(200);
    expect((await body<TenantBrandResponse>(res)).display_name).toBe('Harborline Dairy Co');
    expect((await getBrand('no-such-tenant', superAdmin)).status).toBe(404);
    expect((await putBrand('no-such-tenant', { display_name: 'x' }, superAdmin)).status).toBe(404);
  });

  it('an admin API key may read and set the text and colours, and may not publish or remove a logo', async () => {
    const key = { authMethod: 'api_key', apiKeyId: 'key-1' };
    expect((await getBrand(seed.tenantId, adminA, key)).status).toBe(200);
    const put = await putBrand(seed.tenantId, { support: { phone: '555 0100' } }, adminA, key);
    expect(put.status).toBe(200);
    const audit = await brandAudit(seed.tenantId);
    expect(audit[audit.length - 1].details).toMatchObject({ via: 'api_key' });

    const up = await postLogo(seed.tenantId, pngBytes(320, 96), adminA, { data: key });
    expect(up.status).toBe(403);
    expect((await body<{ error: string }>(up)).error).toContain('API key');
    expect((await deleteLogo(seed.tenantId, adminA, key)).status).toBe(403);
    expect(await db.prepare('SELECT id FROM tenant_brand_logos WHERE tenant_id = ?').bind(seed.tenantId).first()).toBeNull();
    // A key belonging to a user is still that user: no brand for a `user` key.
    expect((await putBrand(seed.tenantId, { display_name: 'x' }, plainUser, key)).status).toBe(403);
  });
});

// ===========================================================================
// Validation
// ===========================================================================

describe('validation', () => {
  const stored = () => db.prepare('SELECT * FROM tenant_brands WHERE tenant_id = ?').bind(seed.tenantId).first<Record<string, unknown>>();

  it.each([
    'red',
    '#fff',
    '#0B6E4',
    '#0B6E4FF',
    '#0B6E4G',
    ' #0B6E4F',
    '#0B6E4F;background:url(//evil.example/x)',
    'rgb(11,110,79)',
    'var(--primary)',
    '"><script>alert(1)</script>',
    '#0B6E4F\n',
  ])('refuses the colour %j and writes nothing', async (bad) => {
    const before = await stored();
    for (const field of ['primary_color', 'accent_color']) {
      const res = await putBrand(seed.tenantId, { [field]: bad, display_name: 'Should not be saved' }, adminA);
      expect(res.status).toBe(400);
      expect((await body<{ error: string }>(res)).error).toContain('hex colour');
    }
    expect(await stored()).toEqual(before);
  });

  it('refuses a colour that is not a string', async () => {
    for (const bad of [0x0b6e4f, ['#0B6E4F'], { hex: '#0B6E4F' }, true]) {
      expect((await putBrand(seed.tenantId, { primary_color: bad }, adminA)).status).toBe(400);
    }
  });

  it('caps every text field, and refuses anything that is not one line of text', async () => {
    const before = await stored();
    const cases: unknown[] = [
      { display_name: 'x'.repeat(81) },
      { display_name: 'two\nlines' },
      { display_name: 'tab\there' },
      { display_name: 42 },
      { support: { text: 'x'.repeat(201) } },
      { support: { text: 'line\r\nbreak' } },
      { support: { email: 'not an address' } },
      { support: { email: 'a@b.example?subject=x' } },
      { support: { email: `${'a'.repeat(250)}@b.example` } },
      { support: { phone: 'call the office' } },
      { support: { phone: '1'.repeat(41) } },
      { support: 'Questions?' },
      { support_overrides: { suplier_request: { text: 'typo in the surface' } } },
      { support_overrides: { complaint_intake: { text: 'not a surface yet' } } },
      { support_overrides: { supplier_request: { text: 'x'.repeat(201) } } },
      { support_overrides: [{ text: 'x' }] },
      { support_overrides: { __proto__: { text: 'x' }, constructor: { text: 'x' } } },
    ];
    for (const bad of cases) {
      const res = await putBrand(seed.tenantId, bad, adminA);
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
    expect((await putBrand(seed.tenantId, '{not json', adminA)).status).toBe(400);
    expect((await putBrand(seed.tenantId, '[1,2]', adminA)).status).toBe(400);
    expect((await putBrand(seed.tenantId, 'null', adminA)).status).toBe(400);
    expect(await stored()).toEqual(before);
  });

  it('accepts the boundary lengths', async () => {
    const res = await putBrand(seed.tenantId, { display_name: 'x'.repeat(80), support: { text: 'y'.repeat(200) } }, adminA);
    expect(res.status).toBe(200);
    await putBrand(seed.tenantId, { display_name: 'Northfield Foods', support: { text: A_SECRET } }, adminA);
  });

  it('HTML in a text field is stored as typed -- it is text -- and comes back as text', async () => {
    const hostile = `<script>alert(1)</script>"'&`;
    const res = await putBrand(seed.tenantId, { display_name: hostile, support: { text: `"><img src=x onerror=alert(2)>` } }, adminA);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/json');
    const saved = await body<TenantBrandResponse>(res);
    expect(saved.display_name).toBe(hostile);
    expect(saved.support.text).toBe(`"><img src=x onerror=alert(2)>`);
    await putBrand(seed.tenantId, { display_name: 'Northfield Foods', support: { text: A_SECRET } }, adminA);
  });

  it('a logo is judged by its bytes: SVG, HTML and mislabelled files are refused', async () => {
    const enc = (s: string) => new TextEncoder().encode(s);
    const refused: Array<[string, Uint8Array, string]> = [
      ['an SVG labelled as SVG', SVG_BYTES, 'image/svg+xml'],
      ['an SVG labelled as PNG', SVG_BYTES, 'image/png'],
      ['HTML labelled as PNG', enc('<!DOCTYPE html><html><script>alert(1)</script></html>'), 'image/png'],
      ['text labelled as JPEG', enc('just some text, not an image at all, padded out a little'), 'image/jpeg'],
      ['a GIF', enc('GIF89a' + 'x'.repeat(60)), 'image/gif'],
      ['a PDF labelled as PNG', enc('%PDF-1.7\n' + 'x'.repeat(60)), 'image/png'],
      ['a truncated PNG', pngBytes(320, 96).slice(0, 12), 'image/png'],
      ['an animated WebP', webpBytes(256, 64, 'VP8X', { animated: true }), 'image/webp'],
      ['a PNG that is 8 pixels wide', pngBytes(8, 96), 'image/png'],
      ['a PNG that is 9000 pixels tall', pngBytes(320, 9000), 'image/png'],
    ];
    for (const [what, bytes, type] of refused) {
      const res = await postLogo(seed.tenantId, bytes, adminA, { type });
      expect(res.status, what).toBe(400);
    }
    const svg = await postLogo(seed.tenantId, SVG_BYTES, adminA, { type: 'image/png' });
    expect((await body<{ error: string }>(svg)).error).toContain('SVG is not accepted');

    const empty = await postLogo(seed.tenantId, new Uint8Array(0), adminA);
    expect(empty.status).toBe(400);

    const big = await postLogo(seed.tenantId, pngBytes(320, 96, BRAND_LOGO_MAX_BYTES + 1), adminA);
    expect(big.status).toBe(413);
    expect((await body<{ error: string }>(big)).error).toContain('512 KB');

    const wrongField = await postLogo(seed.tenantId, pngBytes(320, 96), adminA, { field: 'logo' });
    expect(wrongField.status).toBe(400);
    const notMultipart = await logoPost(
      ctx(`/api/tenants/${seed.tenantId}/brand/logo`, {
        method: 'POST',
        body: JSON.stringify({ file: 'x' }),
        headers: { 'Content-Type': 'application/json' },
        user: adminA,
        params: { id: seed.tenantId },
      }),
    );
    expect(notMultipart.status).toBe(400);

    expect(await db.prepare('SELECT id FROM tenant_brand_logos WHERE tenant_id = ?').bind(seed.tenantId).first()).toBeNull();
    expect((await env.FILES.list({ prefix: `brand/${seed.tenantId}/` })).objects).toHaveLength(0);
  });
});

// ===========================================================================
// The logo and its public route
// ===========================================================================

describe('the logo', () => {
  const first = pngBytes(320, 96, 2000, 1);
  const second = jpegBytes(400, 120, 3000, 2);
  let firstUrl = '';
  let secondUrl = '';

  it('is stored under a tenant-and-hash key, with the type its BYTES have', async () => {
    // Uploaded with a lying label and a hostile file name: neither is used.
    const res = await postLogo(seed.tenantId, first, adminA, { type: 'text/html', name: '../../evil.html' });
    expect(res.status).toBe(200);
    const saved = await body<TenantBrandResponse>(res);
    expect(saved.logo).toMatchObject({ content_type: 'image/png', size_bytes: 2000, width: 320, height: 96 });
    firstUrl = saved.logo!.url;
    expect(firstUrl).toMatch(/^\/api\/public\/brand-logo\/[0-9a-f]{40}$/);
    // The URL names no tenant.
    expect(firstUrl).not.toContain(seed.tenantId);

    const row = await db.prepare('SELECT * FROM tenant_brand_logos WHERE tenant_id = ?').bind(seed.tenantId).first<Record<string, string>>();
    expect(row!.r2_key).toBe(`brand/${seed.tenantId}/logo-${row!.sha256}.png`);
    expect(row!.r2_key).toBe(brandLogoKey(seed.tenantId, row!.sha256, 'image/png'));
    expect(row!.url_token).toBe(await brandLogoToken(seed.tenantId, row!.sha256));
    expect(row!.r2_key).not.toContain('evil');
    const object = await env.FILES.get(row!.r2_key);
    expect(new Uint8Array(await object!.arrayBuffer())).toEqual(first);
  });

  it('is served publicly with the validated type, nosniff and a long immutable cache', async () => {
    const res = await fetchLogo(tokenOf(firstUrl));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/png');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
    expect(res.headers.get('Content-Length')).toBe('2000');
    expect(res.headers.get('Content-Disposition')).toBe('inline');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(first);
    // Nothing in the response says whose it is.
    const headers = JSON.stringify([...res.headers.entries()]);
    expect(headers).not.toContain(seed.tenantId);
    expect(headers).not.toContain('Northfield');
  });

  it('the audit row says what the logo was, never the image', async () => {
    const audit = await brandAudit(seed.tenantId);
    const last = audit[audit.length - 1].details as { changes: { logo: { from: unknown; to: Record<string, unknown> } } };
    expect(last.changes.logo.from).toBeNull();
    expect(Object.keys(last.changes.logo.to).sort()).toEqual(['content_type', 'height', 'sha256', 'size_bytes', 'width']);
    expect(JSON.stringify(last).length).toBeLessThan(600);
  });

  it('the same image again is the same URL, and writes nothing', async () => {
    const before = (await brandAudit(seed.tenantId)).length;
    const res = await postLogo(seed.tenantId, first, adminA);
    expect((await body<TenantBrandResponse>(res)).logo!.url).toBe(firstUrl);
    expect((await brandAudit(seed.tenantId)).length).toBe(before);
    expect((await db.prepare('SELECT count(*) AS n FROM tenant_brand_logos WHERE tenant_id = ?').bind(seed.tenantId).first<{ n: number }>())!.n).toBe(1);
  });

  it('a replaced logo gets a NEW URL, and the old URL still serves the old image', async () => {
    const res = await postLogo(seed.tenantId, second, adminA);
    const saved = await body<TenantBrandResponse>(res);
    secondUrl = saved.logo!.url;
    expect(secondUrl).not.toBe(firstUrl);
    expect(saved.logo).toMatchObject({ content_type: 'image/jpeg', width: 400, height: 120 });

    const fresh = await fetchLogo(tokenOf(secondUrl));
    expect(fresh.headers.get('Content-Type')).toBe('image/jpeg');
    expect(new Uint8Array(await fresh.arrayBuffer())).toEqual(second);

    // Mail already sent points at the old URL.
    const old = await fetchLogo(tokenOf(firstUrl));
    expect(old.status).toBe(200);
    expect(old.headers.get('Content-Type')).toBe('image/png');
    expect(new Uint8Array(await old.arrayBuffer())).toEqual(first);

    const audit = await brandAudit(seed.tenantId);
    const last = audit[audit.length - 1].details as { changes: { logo: { from: { content_type: string }; to: { content_type: string } } } };
    expect(last.changes.logo.from.content_type).toBe('image/png');
    expect(last.changes.logo.to.content_type).toBe('image/jpeg');
  });

  it('removing it takes it off the brand; what was published stays reachable', async () => {
    const res = await deleteLogo(seed.tenantId, adminA);
    expect(res.status).toBe(200);
    expect((await body<TenantBrandResponse>(res)).logo).toBeNull();
    expect((await loadPublicBrand(db, seed.tenantId, 'alert'))!.logo_url).toBeNull();
    expect((await fetchLogo(tokenOf(secondUrl))).status).toBe(200);
    expect((await fetchLogo(tokenOf(firstUrl))).status).toBe(200);
    // Removing nothing is not an event.
    const before = (await brandAudit(seed.tenantId)).length;
    expect((await deleteLogo(seed.tenantId, adminA)).status).toBe(200);
    expect((await brandAudit(seed.tenantId)).length).toBe(before);
    // Put the first one back for the rest of the file.
    expect((await body<TenantBrandResponse>(await postLogo(seed.tenantId, first, adminA))).logo!.url).toBe(firstUrl);
  });

  it('two tenants with the same image have different URLs and different objects', async () => {
    const res = await postLogo(seed.tenantId2, first, adminB);
    const urlB = (await body<TenantBrandResponse>(res)).logo!.url;
    expect(urlB).not.toBe(firstUrl);
    const rows = await db.prepare('SELECT tenant_id, r2_key FROM tenant_brand_logos WHERE sha256 = (SELECT sha256 FROM tenant_brand_logos WHERE url_token = ?) ORDER BY tenant_id').bind(tokenOf(firstUrl)).all<{ tenant_id: string; r2_key: string }>();
    expect(rows.results!.map((r) => r.tenant_id).sort()).toEqual([seed.tenantId, seed.tenantId2].sort());
    expect(new Set(rows.results!.map((r) => r.r2_key)).size).toBe(2);
  });

  it('anything that is not a published logo is one 404', async () => {
    // A document sits in the same bucket. Nothing below may reach it.
    const docKey = `docs/secret-${generateTestId()}/coa.pdf`;
    await env.FILES.put(docKey, new TextEncoder().encode('SECRET-DOCUMENT-BYTES'));

    const attempts = [
      'a'.repeat(40), // well formed, unknown
      'A'.repeat(40), // wrong case
      'a'.repeat(39),
      'a'.repeat(41),
      '',
      docKey,
      encodeURIComponent(docKey),
      `../../${docKey}`,
      `brand/${seed.tenantId}/logo-x.png`,
      seed.tenantId,
      `${tokenOf(firstUrl)}/../x`,
      `${tokenOf(firstUrl)}.png`,
      `${tokenOf(firstUrl)}%00`,
      "' OR '1'='1",
    ];
    for (const attempt of attempts) {
      const res = await fetchLogo(attempt);
      expect(res.status, attempt).toBe(404);
      expect(await res.text()).toBe('Not found');
      expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(res.headers.get('Cache-Control')).toBe('no-store');
    }
  });

  it('the bucket key is rebuilt from the row: a row pointed at a document serves nothing', async () => {
    const docKey = `docs/secret-${generateTestId()}/coa.pdf`;
    await env.FILES.put(docKey, new TextEncoder().encode('SECRET-DOCUMENT-BYTES'));
    const token = tokenOf(firstUrl);
    const row = await db.prepare('SELECT * FROM tenant_brand_logos WHERE url_token = ?').bind(token).first<Record<string, string>>();

    // Somebody edits the row to point at a document.
    await db.prepare('UPDATE tenant_brand_logos SET r2_key = ? WHERE id = ?').bind(docKey, row!.id).run();
    expect(await readBrandLogo(env, token)).toBeNull();
    expect((await fetchLogo(token)).status).toBe(404);

    // ...or at another tenant's logo object.
    const other = await db.prepare('SELECT r2_key FROM tenant_brand_logos WHERE tenant_id = ?').bind(seed.tenantId2).first<{ r2_key: string }>();
    await db.prepare('UPDATE tenant_brand_logos SET r2_key = ? WHERE id = ?').bind(other!.r2_key, row!.id).run();
    expect(await readBrandLogo(env, token)).toBeNull();

    await db.prepare('UPDATE tenant_brand_logos SET r2_key = ? WHERE id = ?').bind(row!.r2_key, row!.id).run();
    expect((await fetchLogo(token)).status).toBe(200);
  });

  it('a row whose object is gone is a 404, not an error', async () => {
    const bytes = webpBytes(128, 64, 'VP8L', { total: 500, seed: 9 });
    const res = await postLogo(TENANT_C, bytes, adminC);
    const url = (await body<TenantBrandResponse>(res)).logo!.url;
    expect((await fetchLogo(tokenOf(url))).headers.get('Content-Type')).toBe('image/webp');
    const row = await db.prepare('SELECT r2_key FROM tenant_brand_logos WHERE url_token = ?').bind(tokenOf(url)).first<{ r2_key: string }>();
    await env.FILES.delete(row!.r2_key);
    expect((await fetchLogo(tokenOf(url))).status).toBe(404);
    // Tenant C goes back to having no brand at all for the tests below.
    await db.prepare('DELETE FROM tenant_brands WHERE tenant_id = ?').bind(TENANT_C).run();
    await db.prepare('DELETE FROM tenant_brand_logos WHERE tenant_id = ?').bind(TENANT_C).run();
  });
});

// ===========================================================================
// The resolver
// ===========================================================================

describe('the resolver', () => {
  it('no row: the organisation name, nothing else, and nothing for an outsider', async () => {
    const brand = await loadTenantBrand(db, TENANT_C);
    expect(brand).toMatchObject({ configured: false, display_name: 'Plain Corp', primary_color: null, accent_color: null, support: null, logo_path: null });
    expect(await loadPublicBrand(db, TENANT_C, 'supplier_request')).toBeNull();
    expect(await loadOutwardName(db, TENANT_C, 'fallback')).toBe('Plain Corp');
    expect(await loadTenantBrand(db, 'no-such-tenant')).toBeNull();
    expect(await loadPublicBrand(db, 'no-such-tenant', 'alert')).toBeNull();
    expect(await loadPublicBrand(db, null, 'alert')).toBeNull();
    expect(await loadOutwardName(db, 'no-such-tenant', 'fallback')).toBe('fallback');
  });

  it('each surface gets its own support line, and only that one', async () => {
    const supplier = await loadPublicBrand(db, seed.tenantId, 'supplier_request');
    expect(supplier!.support).toEqual({ text: 'Supplier desk A', email: 'suppliers@northfield.example', phone: null });
    const exported = await loadPublicBrand(db, seed.tenantId, 'document_export');
    expect(exported!.support).toEqual({ text: 'Customer Service A', email: null, phone: null });
    // No override: the default line, whole.
    for (const surface of ['order_send', 'alert', 'records_form', 'records_update_request', 'records_approval', 'file_drop'] as const) {
      const b = await loadPublicBrand(db, seed.tenantId, surface);
      expect(b!.support, surface).toEqual({ text: A_SECRET, email: 'purchasing@northfield.example', phone: '555 0100' });
      expect(JSON.stringify(b)).not.toContain('Supplier desk A');
    }
    expect(JSON.stringify(supplier)).not.toContain(A_SECRET);
    expect(JSON.stringify(supplier)).not.toContain('Customer Service A');
  });

  it('is an allow-list: five fields, an absolute logo URL only when asked', async () => {
    const page = await loadPublicBrand(db, seed.tenantId, 'alert');
    expect(Object.keys(page!).sort()).toEqual(['accent_color', 'display_name', 'logo_url', 'primary_color', 'support']);
    expect(page!.logo_url).toMatch(/^\/api\/public\/brand-logo\/[0-9a-f]{40}$/);
    const mail = await loadPublicBrand(db, seed.tenantId, 'alert', { origin: 'https://portal.example' });
    expect(mail!.logo_url).toBe(`https://portal.example${page!.logo_url}`);
    const serialized = JSON.stringify(page);
    expect(serialized).not.toContain(seed.tenantId);
    expect(serialized).not.toContain('Org Admin');
    expect(serialized).not.toContain(seed.orgAdminId);
  });

  it('one request reads a tenant once; a new request sees a change', async () => {
    const cache = createBrandCache();
    const spy = vi.spyOn(db, 'prepare');
    await loadPublicBrand(db, seed.tenantId, 'alert', { cache });
    await loadPublicBrand(db, seed.tenantId, 'order_send', { cache });
    await loadOutwardName(db, seed.tenantId, 'x', cache);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();

    await putBrand(seed.tenantId, { accent_color: '#112233' }, adminA);
    expect((await loadPublicBrand(db, seed.tenantId, 'alert', { cache }))!.accent_color).toBe('#F2A900');
    expect((await loadPublicBrand(db, seed.tenantId, 'alert'))!.accent_color).toBe('#112233');
    await putBrand(seed.tenantId, { accent_color: '#F2A900' }, adminA);
  });

  it('a row edited by hand can lose a field; it cannot put an unchecked value in front of an outsider', async () => {
    // The CHECKs stop a bad colour at the database, so the overrides JSON and
    // the support fields are where a hand edit could land.
    await db
      .prepare('UPDATE tenant_brands SET support_overrides = ?, support_email = ? WHERE tenant_id = ?')
      .bind(JSON.stringify({ alert: { text: 'two\nlines' }, nonsense: { text: 'x' }, order_send: { email: 'a"b@c.example' } }), 'not an address', seed.tenantId2)
      .run();
    const b = await loadPublicBrand(db, seed.tenantId2, 'alert');
    expect(b!.support).toBeNull(); // the whole default line fails with its bad email
    expect((await loadTenantBrand(db, seed.tenantId2))!.support_overrides).toEqual({});
    await db.prepare('UPDATE tenant_brands SET support_overrides = NULL, support_email = NULL WHERE tenant_id = ?').bind(seed.tenantId2).run();
    expect((await loadPublicBrand(db, seed.tenantId2, 'alert'))!.support).toEqual({ text: B_SECRET, email: null, phone: null });
  });

  it('a failing read is no brand, never an error on the page it decorates', async () => {
    const broken = { prepare: () => { throw new Error('no such table: tenant_brands'); } } as unknown as D1Database;
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await loadPublicBrand(broken, seed.tenantId, 'alert')).toBeNull();
    expect(await loadOutwardName(broken, seed.tenantId, 'Test Corp')).toBe('Test Corp');
    spy.mockRestore();
  });
});

// ===========================================================================
// Every token route, three tenants
// ===========================================================================

interface Surfaces {
  alert: string;
  request: string;
  formSlug: string;
  updateToken: string;
  approvalToken: string;
  drop: { slug: string; token: string };
  sheetId: string;
  rowId: string;
}

async function makeSurfaces(tenantId: string, adminId: string, tag: string): Promise<Surfaces> {
  const supplierId = generateTestId();
  await db.prepare('INSERT INTO suppliers (id, tenant_id, name, slug) VALUES (?, ?, ?, ?)').bind(supplierId, tenantId, `Harbor Mills ${tag}`, `harbor-${tag}-${supplierId.slice(0, 5)}`).run();

  // -- alert page
  const documentId = generateTestId();
  await db
    .prepare(`INSERT INTO documents (id, tenant_id, title, current_version, status, created_by, supplier_id) VALUES (?, ?, ?, 1, 'active', ?, ?)`)
    .bind(documentId, tenantId, `COA ${tag}`, adminId, supplierId)
    .run();
  const alert = (await mintAlertLink(db, { tenantId, kind: 'spec_alert', documentId }))!;

  // -- supplier request page
  const requirementId = generateTestId();
  await db.prepare('INSERT INTO requirements (id, tenant_id, name, slug) VALUES (?, ?, ?, ?)').bind(requirementId, tenantId, `Kosher ${tag}`, `kosher-${tag}-${requirementId.slice(0, 5)}`).run();
  const fx: RequestFixture = { tenantId, orgAdminId: adminId, supplierId, requirementIds: [requirementId] };
  const request = (await makeRequest(fx, ['Kosher certificate'])).token;

  // -- Records: a sheet, a row, a public form, an update request, an approval
  const sheetId = generateTestId();
  await db.prepare('INSERT INTO records_sheets (id, tenant_id, name, slug, created_by) VALUES (?, ?, ?, ?, ?)').bind(sheetId, tenantId, `Contacts ${tag}`, `contacts-${tag}-${sheetId.slice(0, 5)}`, adminId).run();
  const columnId = generateTestId();
  await db
    .prepare(`INSERT INTO records_columns (id, sheet_id, tenant_id, key, label, type, is_title, display_order) VALUES (?, ?, ?, 'name', 'Name', 'text', 1, 0)`)
    .bind(columnId, sheetId, tenantId)
    .run();
  const rowId = generateTestId();
  await db
    .prepare('INSERT INTO records_rows (id, sheet_id, tenant_id, display_title, data, created_by) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(rowId, sheetId, tenantId, `Row ${tag}`, JSON.stringify({ name: `Row ${tag}` }), adminId)
    .run();

  const formSlug = `form-${tag}-${generateTestId().slice(0, 8)}`;
  await db
    .prepare(
      `INSERT INTO records_forms (id, tenant_id, sheet_id, name, public_slug, is_public, status, field_config, settings, created_by_user_id)
       VALUES (?, ?, ?, ?, ?, 1, 'live', ?, ?, ?)`,
    )
    .bind(generateTestId(), tenantId, sheetId, `Intake ${tag}`, formSlug, JSON.stringify([{ column_id: columnId, position: 0, required: false }]), JSON.stringify({ accent_color: 'red; background:url(x)', logo_url: 'https://tracker.example/pixel.png' }), adminId)
    .run();

  const updateToken = `upd-${tag}-${generateTestId()}`;
  await db
    .prepare(
      `INSERT INTO records_update_requests (id, tenant_id, sheet_id, row_id, token, recipient_email, fields_requested, status, created_by_user_id)
       VALUES (?, ?, ?, ?, ?, 'pat@supplier.example', '["name"]', 'pending', ?)`,
    )
    .bind(generateTestId(), tenantId, sheetId, rowId, updateToken, adminId)
    .run();

  const workflowId = generateTestId();
  const stepId = 'step-1';
  await db
    .prepare(
      `INSERT INTO records_workflows (id, tenant_id, sheet_id, name, steps, status, created_by_user_id)
       VALUES (?, ?, ?, ?, ?, 'active', ?)`,
    )
    .bind(workflowId, tenantId, sheetId, `Onboarding ${tag}`, JSON.stringify([{ id: stepId, type: 'approval', name: 'QA sign-off', config: { assignee_email: 'qa@outside.example' } }]), adminId)
    .run();
  const runId = generateTestId();
  await db
    .prepare(`INSERT INTO records_workflow_runs (id, tenant_id, workflow_id, sheet_id, row_id, status, current_step_id) VALUES (?, ?, ?, ?, ?, 'in_progress', ?)`)
    .bind(runId, tenantId, workflowId, sheetId, rowId, stepId)
    .run();
  const approvalToken = `apr-${tag}-${generateTestId()}`;
  await db
    .prepare(
      `INSERT INTO records_workflow_step_runs (id, run_id, step_id, step_index, step_type, status, assignee_email, approver_token)
       VALUES (?, ?, ?, 0, 'approval', 'awaiting_response', 'qa@outside.example', ?)`,
    )
    .bind(generateTestId(), runId, stepId, approvalToken)
    .run();

  // -- file drop page
  const connectorId = generateTestId();
  const slug = `drop-${tag}-${connectorId.slice(0, 8)}`;
  const dropToken = `drop-token-${tag}-${connectorId}`;
  await db
    .prepare(
      `INSERT INTO connectors (id, tenant_id, name, slug, config, field_mappings, active, public_link_token, created_at, updated_at)
       VALUES (?, ?, ?, ?, '{}', '{}', 1, ?, datetime('now'), datetime('now'))`,
    )
    .bind(connectorId, tenantId, `Drop ${tag}`, slug, dropToken)
    .run();

  return { alert, request, formSlug, updateToken, approvalToken, drop: { slug, token: dropToken }, sheetId, rowId };
}

type Payload = { brand?: PublicBrand | null } & Record<string, unknown>;

async function readSurfaces(s: Surfaces): Promise<Record<string, { status: number; payload: Payload }>> {
  const call = async (res: Response) => ({ status: res.status, payload: (await readJson(res)) as Payload });
  return {
    alert: await call(await alertGet(ctx(`/api/alerts/public/${s.alert}`, { params: { token: s.alert } }))),
    supplier_request: await call(await requestGet(ctx(`/api/supplier-requests/public/${s.request}`, { params: { token: s.request } }))),
    records_form: await call(await formGet(ctx(`/api/forms/public/${s.formSlug}`, { params: { slug: s.formSlug } }))),
    records_update_request: await call(await updateRequestGet(ctx(`/api/update-requests/public/${s.updateToken}`, { params: { token: s.updateToken } }))),
    records_approval: await call(await approvalGet(ctx(`/api/workflow-approvals/public/${s.approvalToken}`, { params: { token: s.approvalToken } }))),
    file_drop: await call(await dropGet(ctx(`/api/public/connectors/${s.drop.slug}?token=${s.drop.token}`, { params: { slug: s.drop.slug } }))),
  };
}

describe('every token route carries its own tenant\'s brand and nobody else\'s', () => {
  let a: Surfaces;
  let b: Surfaces;
  let c: Surfaces;

  beforeAll(async () => {
    a = await makeSurfaces(seed.tenantId, seed.orgAdminId, 'a');
    b = await makeSurfaces(seed.tenantId2, seed.orgAdmin2Id, 'b');
    c = await makeSurfaces(TENANT_C, ADMIN_C, 'c');
  }, 30_000);

  it('tenant A: its name, colours, logo and the support line for each surface', async () => {
    const pages = await readSurfaces(a);
    const logo = (await loadPublicBrand(db, seed.tenantId, 'alert'))!.logo_url;
    for (const [surface, { status, payload }] of Object.entries(pages)) {
      expect(status, surface).toBe(200);
      expect(payload.brand, surface).toEqual({
        display_name: 'Northfield Foods',
        logo_url: logo,
        primary_color: '#0B6E4F',
        accent_color: '#F2A900',
        support:
          surface === 'supplier_request'
            ? { text: 'Supplier desk A', email: 'suppliers@northfield.example', phone: null }
            : { text: A_SECRET, email: 'purchasing@northfield.example', phone: '555 0100' },
      });
      const serialized = JSON.stringify(payload);
      expect(serialized, surface).not.toContain('Harborline');
      expect(serialized, surface).not.toContain(B_SECRET);
      expect(serialized, surface).not.toContain('#7A1F5C');
      // Only this surface's line: the other overrides stay home.
      if (surface !== 'supplier_request') expect(serialized, surface).not.toContain('Supplier desk A');
      expect(serialized, surface).not.toContain('Customer Service A');
    }
  });

  it('tenant B: its own brand, and nothing of A', async () => {
    const pages = await readSurfaces(b);
    const logo = (await loadPublicBrand(db, seed.tenantId2, 'alert'))!.logo_url;
    const logoA = (await loadPublicBrand(db, seed.tenantId, 'alert'))!.logo_url;
    expect(logo).not.toBe(logoA);
    for (const [surface, { status, payload }] of Object.entries(pages)) {
      expect(status, surface).toBe(200);
      expect(payload.brand, surface).toEqual({
        display_name: 'Harborline Dairy Co',
        logo_url: logo,
        primary_color: '#7A1F5C',
        accent_color: null,
        support: { text: B_SECRET, email: null, phone: null },
      });
      const serialized = JSON.stringify(payload);
      for (const leak of ['Northfield', A_SECRET, 'Supplier desk A', 'Customer Service A', '#0B6E4F', '#F2A900', 'purchasing@northfield.example', logoA!]) {
        expect(serialized, `${surface}: ${leak}`).not.toContain(leak);
      }
    }
  });

  it('tenant C, with no brand record: no `brand` key at all, and nobody else\'s values', async () => {
    const pages = await readSurfaces(c);
    for (const [surface, { status, payload }] of Object.entries(pages)) {
      expect(status, surface).toBe(200);
      expect(Object.prototype.hasOwnProperty.call(payload, 'brand'), surface).toBe(false);
      const serialized = JSON.stringify(payload);
      for (const leak of ['Northfield', 'Harborline', A_SECRET, B_SECRET, 'brand-logo']) {
        expect(serialized, `${surface}: ${leak}`).not.toContain(leak);
      }
    }
  });

  it('a token is what picks the tenant: nothing in the request can ask for another one', async () => {
    // A's token with B's tenant id thrown at it every way a caller can.
    const url = `/api/supplier-requests/public/${a.request}?tenant_id=${seed.tenantId2}&tenant=${seed.tenantId2}&brand=${seed.tenantId2}`;
    const res = await requestGet(
      ctx(url, { params: { token: a.request }, headers: { 'X-Tenant-Id': seed.tenantId2 }, data: { user: adminB, authMethod: 'jwt' } }),
    );
    const payload = (await readJson(res)) as Payload;
    expect(payload.brand!.display_name).toBe('Northfield Foods');
    expect(JSON.stringify(payload)).not.toContain('Harborline');
  });

  it('an unknown or dead token gets the same 404 it always did, with no brand in it', async () => {
    for (const res of [
      await alertGet(ctx('/api/alerts/public/nope', { params: { token: 'nope' } })),
      await requestGet(ctx('/api/supplier-requests/public/nope', { params: { token: 'nope' } })),
      await formGet(ctx('/api/forms/public/nope', { params: { slug: 'nope' } })),
      await updateRequestGet(ctx('/api/update-requests/public/nope', { params: { token: 'nope' } })),
      await approvalGet(ctx('/api/workflow-approvals/public/nope', { params: { token: 'nope' } })),
      await dropGet(ctx(`/api/public/connectors/${a.drop.slug}?token=wrong`, { params: { slug: a.drop.slug } })),
    ]) {
      expect(res.status).toBe(404);
      const text = await res.text();
      expect(text).not.toContain('brand');
      expect(text).not.toContain('Northfield');
    }
  });

  it('a public form publishes a real accent colour or none, and never an outside logo link', async () => {
    const pages = await readSurfaces(a);
    const form = pages.records_form.payload.form as { accent_color: string | null; logo_url: string | null };
    expect(form.accent_color).toBeNull(); // the stored value was not a colour
    expect(form.logo_url).toBeNull();
    expect(JSON.stringify(pages.records_form.payload)).not.toContain('tracker.example');

    await db.prepare(`UPDATE records_forms SET settings = '{"accent_color":"#3366cc"}' WHERE public_slug = ?`).bind(a.formSlug).run();
    const again = await formGet(ctx(`/api/forms/public/${a.formSlug}`, { params: { slug: a.formSlug } }));
    expect(((await readJson(again)) as { form: { accent_color: string } }).form.accent_color).toBe('#3366CC');
  });

  // -------------------------------------------------------------------------
  // The export page and the two mails this file can send end to end
  // -------------------------------------------------------------------------

  async function makeDocument(tenantId: string, adminId: string, title: string): Promise<string> {
    const id = generateTestId();
    const typeId = generateTestId();
    // "Certificate of Analysis" is a send-freely type (C-003), so the test is
    // about the brand and not about the sharing rule.
    await db.prepare(`INSERT INTO document_types (id, tenant_id, name, slug, sharing_rule) VALUES (?, ?, 'Certificate of Analysis', ?, 'free')`).bind(typeId, tenantId, `coa-brand-${typeId.slice(0, 6)}`).run();
    await db
      .prepare(`INSERT INTO documents (id, tenant_id, title, tags, current_version, status, created_by, document_type_id) VALUES (?, ?, ?, '[]', 1, 'active', ?, ?)`)
      .bind(id, tenantId, title, adminId, typeId)
      .run();
    const key = `docs/${id}/coa.pdf`;
    await db
      .prepare(`INSERT INTO document_versions (id, document_id, version_number, file_name, file_size, mime_type, r2_key, uploaded_by) VALUES (?, ?, 1, 'coa.pdf', 9, 'application/pdf', ?, ?)`)
      .bind(generateTestId(), id, key, adminId)
      .run();
    await env.FILES.put(key, new TextEncoder().encode('PDF-BYTES'));
    return id;
  }

  async function sendExport(admin: TestUser, title: string): Promise<{ mail: CapturedMail; token: string }> {
    const sent = stubMail();
    const docId = await makeDocument(admin.tenant_id!, admin.id, title);
    const res = await exportSend(
      ctx('http://portal.test/api/document-exports/send', {
        method: 'POST',
        body: JSON.stringify({ document_ids: [docId], recipients: ['buyer@customer.example'], message: 'As requested.' }),
        headers: { 'Content-Type': 'application/json' },
        user: admin,
      }),
    );
    expect(res.status).toBe(200);
    expect(sent).toHaveLength(1);
    const token = /\/export\/([A-Za-z0-9_-]+)/.exec(sent[0].html)![1];
    vi.unstubAllGlobals();
    return { mail: sent[0], token };
  }

  it('the export mail and the export page carry the sender\'s tenant brand, with the export support line', async () => {
    const { mail, token } = await sendExport(adminA, 'COA for A');
    const logo = (await loadPublicBrand(db, seed.tenantId, 'document_export', { origin: 'http://portal.test' }))!.logo_url!;
    expect(logo.startsWith('http://portal.test/api/public/brand-logo/')).toBe(true);
    expect(mail.html).toContain(`<img src="${logo}" alt="Northfield Foods"`);
    expect(mail.html).toContain('<strong>Northfield Foods</strong>');
    expect(mail.html).toContain('Customer Service A');
    expect(mail.html).toContain('background:#0B6E4F;color:#ffffff;');
    expect(mail.subject).toBe('Northfield Foods: 1 document from Org Admin');
    // Not the default line, not another surface's line, not another tenant.
    for (const leak of [A_SECRET, 'Supplier desk A', 'Harborline', B_SECRET, '#7A1F5C']) expect(mail.html).not.toContain(leak);
    // The sender and the reply-to are exactly what they were.
    expect(mail.reply_to).toBe('orgadmin@test.com');
    expect(mail.from).toBe('SupDox <noreply@supdox.com>');

    const page = (await readJson(await exportGet(ctx(`/api/document-exports/public/${token}`, { params: { token } })))) as Payload;
    expect(page.brand).toMatchObject({ display_name: 'Northfield Foods', support: { text: 'Customer Service A', email: null, phone: null } });
    expect(JSON.stringify(page)).not.toContain('Harborline');

    const audit = await db.prepare("SELECT details FROM audit_log WHERE action = 'document_export.sent' AND tenant_id = ? ORDER BY id DESC LIMIT 1").bind(seed.tenantId).first<{ details: string }>();
    expect(JSON.parse(audit!.details).brand).toMatchObject({ display_name: 'Northfield Foods', support: 'Customer Service A' });
  });

  it("tenant B's export mail is B's, and tenant C's is exactly the unbranded mail", async () => {
    const b1 = await sendExport(adminB, 'COA for B');
    expect(b1.mail.html).toContain('alt="Harborline Dairy Co"');
    expect(b1.mail.html).toContain(B_SECRET);
    for (const leak of ['Northfield', A_SECRET, 'Customer Service A', '#0B6E4F']) expect(b1.mail.html).not.toContain(leak);

    const c1 = await sendExport(adminC, 'COA for C');
    expect(c1.mail.subject).toBe('Plain Corp: 1 document from Admin C');
    expect(c1.mail.html).toContain(
      '<td style="background:#1A365D;padding:24px 32px;">\n        <h1 style="margin:0;color:#ffffff;font-size:20px;font-weight:600;">Plain Corp</h1>',
    );
    expect(c1.mail.html).not.toContain('<img');
    expect(c1.mail.html).not.toContain('brand-logo');
    for (const leak of ['Northfield', 'Harborline', A_SECRET, B_SECRET]) expect(c1.mail.html).not.toContain(leak);
    const page = (await readJson(await exportGet(ctx(`/api/document-exports/public/${c1.token}`, { params: { token: c1.token } })))) as Payload;
    expect(Object.prototype.hasOwnProperty.call(page, 'brand')).toBe(false);
    const audit = await db.prepare("SELECT details FROM audit_log WHERE action = 'document_export.sent' AND tenant_id = ? ORDER BY id DESC LIMIT 1").bind(TENANT_C).first<{ details: string }>();
    expect(Object.prototype.hasOwnProperty.call(JSON.parse(audit!.details), 'brand')).toBe(false);
  });

  it('a hostile display name and support line are escaped in the mail that is really sent', async () => {
    await putBrand(seed.tenantId2, { display_name: `<script>alert(1)</script>"'`, support: { text: `"><img src=x onerror=alert(2)>` } }, adminB);
    const { mail, token } = await sendExport(adminB, 'COA hostile');
    expect(mail.html).not.toContain('<script>');
    expect(mail.html).not.toContain('onerror=alert(2)>');
    expect(mail.html).toContain('alt="&lt;script&gt;alert(1)&lt;/script&gt;&quot;&#39;"');
    expect(mail.html).toContain('&quot;&gt;&lt;img src=x onerror=alert(2)&gt;');
    // On the page it travels as JSON text, to be rendered as text.
    const res = await exportGet(ctx(`/api/document-exports/public/${token}`, { params: { token } }));
    expect(res.headers.get('Content-Type')).toBe('application/json');
    expect(((await readJson(res)) as Payload).brand!.display_name).toBe(`<script>alert(1)</script>"'`);
    await putBrand(seed.tenantId2, { display_name: 'Harborline Dairy Co', support: { text: B_SECRET } }, adminB);
  });

  async function sendUpdateRequest(admin: TestUser, s: Surfaces): Promise<CapturedMail> {
    const sent = stubMail();
    const res = await updateRequestCreate(
      ctx(`http://portal.test/api/records/sheets/${s.sheetId}/rows/${s.rowId}/update-requests`, {
        method: 'POST',
        body: JSON.stringify({ recipient_email: 'pat@supplier.example', fields_requested: ['name'], message: 'Two minutes.' }),
        headers: { 'Content-Type': 'application/json' },
        user: admin,
        params: { sheetId: s.sheetId, rowId: s.rowId },
      }),
    );
    expect(res.status).toBeLessThan(300);
    expect(sent).toHaveLength(1);
    vi.unstubAllGlobals();
    return sent[0];
  }

  it('the update-request mail names the organisation and carries its line; unbranded it still says SupDox', async () => {
    const mailA = await sendUpdateRequest(adminA, a);
    expect(mailA.html).toContain('alt="Northfield Foods"');
    expect(mailA.html).toContain(A_SECRET); // no override for this surface: the default line
    expect(mailA.html).not.toContain('font-weight:600;">SupDox</h1>');
    for (const leak of ['Harborline', B_SECRET, 'Supplier desk A', 'Customer Service A']) expect(mailA.html).not.toContain(leak);

    const mailC = await sendUpdateRequest(adminC, c);
    expect(mailC.html).toContain('<h1 style="margin:0;color:#ffffff;font-size:20px;font-weight:600;">SupDox</h1>');
    expect(mailC.html).not.toContain('<img');
    for (const leak of ['Northfield', 'Harborline', A_SECRET, B_SECRET]) expect(mailC.html).not.toContain(leak);
  });

  it('every surface in the list is one this file reads or sends', () => {
    // A surface added to BRAND_SURFACES without a test here should fail loudly.
    expect(BRAND_SURFACES.map((s) => s.key).sort()).toEqual(
      ['alert', 'document_export', 'file_drop', 'order_send', 'records_approval', 'records_form', 'records_update_request', 'supplier_request'].sort(),
    );
  });
});
