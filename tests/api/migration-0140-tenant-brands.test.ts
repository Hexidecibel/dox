/**
 * Migration 0140 (the tenant brand record) rehearsed on a POPULATED pre-0140
 * schema, applied as ONE batch the way `wrangler d1 execute --file` applies a
 * file.
 *
 * What it must prove:
 *
 *   1. ADDITIVE, AND NOBODY IS GIVEN A BRAND. No existing row changes and both
 *      new tables are empty afterwards: a tenant has a brand when an admin
 *      saves one, not before.
 *   2. The tables hold their own rules. A colour is '#RRGGBB' in upper case or
 *      it is refused; a logo is one of three raster types; the lengths are
 *      capped; one row per tenant.
 *   3. A brand can only point at a logo of ITS OWN tenant.
 *   4. Both tables go with their tenant. Running the file twice changes nothing.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { runMigrations, MIGRATIONS, splitStatements } from '../helpers/db';
import m0140 from '../../migrations/0140_tenant_brands.sql?raw';

const db = env.MIGRATION_DB;
const IDX = MIGRATIONS.indexOf(m0140);
const A = 'tenant-0140-a';
const B = 'tenant-0140-b';
const U = 'user-0140';
type Row = Record<string, unknown>;
const all = async (sql: string): Promise<Row[]> => (await db.prepare(sql).all<Row>()).results ?? [];
const run = (sql: string) => db.prepare(sql).run();

const TOKEN_A = 'a'.repeat(40);
const TOKEN_B = 'b'.repeat(40);
const SHA_A = '1'.repeat(64);
const SHA_B = '2'.repeat(64);

const logo = (id: string, tenant: string, token: string, sha: string, cols: Record<string, string> = {}) => {
  const row: Record<string, string> = {
    id: `'${id}'`,
    tenant_id: `'${tenant}'`,
    url_token: `'${token}'`,
    sha256: `'${sha}'`,
    r2_key: `'brand/${tenant}/logo-${sha}.png'`,
    content_type: `'image/png'`,
    size_bytes: '1200',
    width: '320',
    height: '96',
    ...cols,
  };
  const keys = Object.keys(row);
  return `INSERT INTO tenant_brand_logos (${keys.join(', ')}) VALUES (${keys.map((k) => row[k]).join(', ')})`;
};

const brand = (tenant: string, cols: Record<string, string> = {}) => {
  const row: Record<string, string> = { tenant_id: `'${tenant}'`, ...cols };
  const keys = Object.keys(row);
  return `INSERT INTO tenant_brands (${keys.join(', ')}) VALUES (${keys.map((k) => row[k]).join(', ')})`;
};

let before = '';
const snapshot = async () =>
  JSON.stringify({
    tenants: await all(`SELECT * FROM tenants WHERE id IN ('${A}', '${B}') ORDER BY id`),
    users: await all(`SELECT * FROM users WHERE id = '${U}'`),
    forms: await all(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'tenant_brand%' ORDER BY name`),
  });

beforeAll(async () => {
  const existing = await db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'documents'").first<{ n: number }>();
  if ((existing?.n ?? 0) === 0) {
    expect(IDX).toBeGreaterThan(0);
    await runMigrations(db, { before: IDX });
  }
  // A rehearsal on a database 0140 already ran on proves nothing.
  expect(await all("SELECT name FROM sqlite_master WHERE name LIKE 'tenant_brand%'")).toEqual([]);

  await db.batch(
    [
      `INSERT INTO tenants (id, name, slug) VALUES ('${A}', 'Rehearsal A', 'rehearsal-0140-a')`,
      `INSERT INTO tenants (id, name, slug) VALUES ('${B}', 'Rehearsal B', 'rehearsal-0140-b')`,
      `INSERT INTO users (id, email, password_hash, name, role, tenant_id) VALUES ('${U}', 'r0140@example.com', 'x', 'R', 'org_admin', '${A}')`,
    ].map((s) => db.prepare(s)),
  );
  before = await snapshot();
  await db.batch(splitStatements(m0140).map((s) => db.prepare(s)));
});

describe('0140 on a populated database', () => {
  it('changes no existing row and gives no tenant a brand', async () => {
    expect(await snapshot()).toBe(before);
    expect(await all('SELECT tenant_id FROM tenant_brands')).toEqual([]);
    expect(await all('SELECT id FROM tenant_brand_logos')).toEqual([]);
  });

  it('adds two tables, one index and two triggers, and nothing else', async () => {
    expect((await all("SELECT name FROM pragma_table_info('tenant_brands')")).map((c) => c.name)).toEqual([
      'tenant_id', 'display_name', 'primary_color', 'accent_color',
      'support_text', 'support_email', 'support_phone', 'support_overrides',
      'logo_id', 'created_at', 'updated_at', 'updated_by',
    ]);
    expect((await all("SELECT name FROM pragma_table_info('tenant_brand_logos')")).map((c) => c.name)).toEqual([
      'id', 'tenant_id', 'url_token', 'sha256', 'r2_key', 'content_type',
      'size_bytes', 'width', 'height', 'created_at', 'created_by',
    ]);
    const made = (
      await all("SELECT name, type FROM sqlite_master WHERE tbl_name LIKE 'tenant_brand%' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    ).map((r) => `${r.type}:${r.name}`);
    expect(made).toEqual([
      'index:idx_tenant_brand_logos_tenant',
      'table:tenant_brand_logos',
      'table:tenant_brands',
      'trigger:trg_tenant_brands_logo_same_tenant_insert',
      'trigger:trg_tenant_brands_logo_same_tenant_update',
    ]);
  });

  it('the foreign keys are deliberate: both tables go with the tenant, nothing else acts', async () => {
    expect(await all("SELECT \"table\" AS t, \"from\" AS f, on_delete FROM pragma_foreign_key_list('tenant_brands') ORDER BY f")).toEqual([
      { t: 'tenant_brand_logos', f: 'logo_id', on_delete: 'NO ACTION' },
      { t: 'tenants', f: 'tenant_id', on_delete: 'CASCADE' },
      { t: 'users', f: 'updated_by', on_delete: 'NO ACTION' },
    ]);
    expect(await all("SELECT \"table\" AS t, \"from\" AS f, on_delete FROM pragma_foreign_key_list('tenant_brand_logos') ORDER BY f")).toEqual([
      { t: 'users', f: 'created_by', on_delete: 'NO ACTION' },
      { t: 'tenants', f: 'tenant_id', on_delete: 'CASCADE' },
    ]);
  });

  it('a colour is #RRGGBB in upper case, or the row is refused', async () => {
    for (const bad of ['red', '#fff', '#1a365d', '#1A365', '#1A365DD', '#1A365G', '#1A365D;x', ' #1A365D', '1A365D#']) {
      await expect(run(brand(A, { primary_color: `'${bad}'` })), bad).rejects.toThrow();
      await expect(run(brand(A, { accent_color: `'${bad}'` })), bad).rejects.toThrow();
    }
    expect(await all('SELECT tenant_id FROM tenant_brands')).toEqual([]);
  });

  it('text is capped and never an empty string', async () => {
    await expect(run(brand(A, { display_name: `''` }))).rejects.toThrow();
    await expect(run(brand(A, { display_name: `'${'x'.repeat(81)}'` }))).rejects.toThrow();
    await expect(run(brand(A, { support_text: `'${'x'.repeat(201)}'` }))).rejects.toThrow();
    await expect(run(brand(A, { support_email: `'${'x'.repeat(255)}'` }))).rejects.toThrow();
    await expect(run(brand(A, { support_phone: `'${'1'.repeat(41)}'` }))).rejects.toThrow();
    await expect(run(brand(A, { support_overrides: `'${'x'.repeat(8001)}'` }))).rejects.toThrow();
    expect(await all('SELECT tenant_id FROM tenant_brands')).toEqual([]);
  });

  it('a logo is PNG, JPEG or WebP with a well-formed token and hash', async () => {
    await expect(run(logo('l-bad-1', A, TOKEN_A, SHA_A, { content_type: `'image/svg+xml'` }))).rejects.toThrow();
    await expect(run(logo('l-bad-2', A, TOKEN_A, SHA_A, { content_type: `'text/html'` }))).rejects.toThrow();
    await expect(run(logo('l-bad-3', A, 'short', SHA_A))).rejects.toThrow();
    await expect(run(logo('l-bad-4', A, 'Z'.repeat(40), SHA_A))).rejects.toThrow();
    await expect(run(logo('l-bad-5', A, `${'a'.repeat(38)}/.`, SHA_A))).rejects.toThrow();
    await expect(run(logo('l-bad-6', A, TOKEN_A, 'nope'))).rejects.toThrow();
    await expect(run(logo('l-bad-7', A, TOKEN_A, SHA_A, { size_bytes: '0' }))).rejects.toThrow();
    await expect(run(logo('l-bad-8', 'no-such-tenant', TOKEN_A, SHA_A))).rejects.toThrow();
    expect(await all('SELECT id FROM tenant_brand_logos')).toEqual([]);

    await run(logo('l-a', A, TOKEN_A, SHA_A));
    await run(logo('l-b', B, TOKEN_B, SHA_B));
    // The same image twice for one tenant is one row; a token is one logo.
    await expect(run(logo('l-a-2', A, 'c'.repeat(40), SHA_A))).rejects.toThrow(/UNIQUE/);
    await expect(run(logo('l-a-3', A, TOKEN_A, '3'.repeat(64)))).rejects.toThrow(/UNIQUE/);
    // Two tenants may hold the same image.
    await run(logo('l-b-same', B, 'd'.repeat(40), SHA_A));
  });

  it('one brand per tenant, with defaults that mean "nothing set"', async () => {
    await run(brand(A, { display_name: `'Rehearsal Foods'`, primary_color: `'#0B6E4F'`, logo_id: `'l-a'`, updated_by: `'${U}'` }));
    await expect(run(brand(A))).rejects.toThrow(/UNIQUE/);
    await run(brand(B));
    const [b] = await all(`SELECT * FROM tenant_brands WHERE tenant_id = '${B}'`);
    expect(b).toMatchObject({
      display_name: null, primary_color: null, accent_color: null, support_text: null,
      support_email: null, support_phone: null, support_overrides: null, logo_id: null, updated_by: null,
    });
    expect(b.created_at).toBeTruthy();
  });

  it('a brand cannot point at another tenant\'s logo, on insert or on update', async () => {
    await expect(run(`UPDATE tenant_brands SET logo_id = 'l-b' WHERE tenant_id = '${A}'`)).rejects.toThrow(/same tenant/);
    await expect(run(`UPDATE tenant_brands SET logo_id = 'no-such-logo' WHERE tenant_id = '${A}'`)).rejects.toThrow();
    await run(`DELETE FROM tenant_brands WHERE tenant_id = '${B}'`);
    await expect(run(brand(B, { logo_id: `'l-a'` }))).rejects.toThrow(/same tenant/);
    await run(brand(B, { logo_id: `'l-b'` }));
    expect((await all(`SELECT logo_id FROM tenant_brands ORDER BY tenant_id`)).map((r) => r.logo_id)).toEqual(['l-a', 'l-b']);
    // Clearing it is always allowed.
    await run(`UPDATE tenant_brands SET logo_id = NULL WHERE tenant_id = '${B}'`);
  });

  it('a logo a brand still shows cannot be deleted out from under it', async () => {
    await expect(run(`DELETE FROM tenant_brand_logos WHERE id = 'l-a'`)).rejects.toThrow(/FOREIGN KEY/);
  });

  it('running the file again changes nothing', async () => {
    const snap = async () => JSON.stringify([await all('SELECT * FROM tenant_brands ORDER BY tenant_id'), await all('SELECT * FROM tenant_brand_logos ORDER BY id')]);
    const was = await snap();
    await db.batch(splitStatements(m0140).map((s) => db.prepare(s)));
    expect(await snap()).toBe(was);
  });

  it('both tables go with their tenant', async () => {
    await run(`DELETE FROM tenants WHERE id = '${B}'`);
    expect((await all('SELECT tenant_id FROM tenant_brands')).map((r) => r.tenant_id)).toEqual([A]);
    expect((await all('SELECT id FROM tenant_brand_logos ORDER BY id')).map((r) => r.id)).toEqual(['l-a']);
  });
});
