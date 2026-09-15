/**
 * Migration 0113 copies supplier_product_map (0075) into product_identifiers
 * (0107) and REBUILDS product_identifiers to widen its `source` CHECK with
 * 'migrated_product_map'.
 *
 * Rehearsed the way 0110 was: an EMPTY D1 (MIGRATION_DB) is migrated up to the
 * migration before 0113, populated with the prod shape (Country Morning's three
 * map rows, two of them already seeded as identifiers), and 0113 is applied as
 * ONE batch, the way `wrangler d1 execute --file` applies a file.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { runMigrations, MIGRATIONS, splitStatements } from '../helpers/db';
import m0113 from '../../migrations/0113_product_identity_one_store.sql?raw';

const db = env.MIGRATION_DB;
const IDX = MIGRATIONS.indexOf(m0113);

const T = 'tenant-0113';
const U = 'user-0113';
const CMF = 'sup-cmf';
type Row = Record<string, unknown>;
const all = async (sql: string): Promise<Row[]> => (await db.prepare(sql).all<Row>()).results ?? [];

let before: Row[] = [];

beforeAll(async () => {
  const existing = await db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'product_identifiers'").first<{ n: number }>();
  if ((existing?.n ?? 0) === 0) {
    expect(IDX).toBeGreaterThan(0);
    await runMigrations(db, { before: IDX });
  }
  // A rehearsal on a database 0113 already ran on proves nothing.
  const widened = await db.prepare("SELECT sql FROM sqlite_master WHERE name = 'product_identifiers'").first<{ sql: string }>();
  expect(widened!.sql).not.toContain('migrated_product_map');

  const stmts = [
    `INSERT INTO tenants (id, name, slug) VALUES ('${T}', 'Rehearsal Distributor', 'rehearsal-0113')`,
    `INSERT INTO users (id, email, password_hash, name, role, tenant_id) VALUES ('${U}', 'r0113@example.com', 'x', 'R', 'org_admin', '${T}')`,
    `INSERT INTO suppliers (id, tenant_id, name, slug) VALUES ('${CMF}', '${T}', 'Country Morning Farms', 'cmf-0113')`,
    `INSERT INTO products (id, tenant_id, name, slug) VALUES ('p-bag', '${T}', 'WHIP 5 GL BAG  (1/CS), M', 'bag-0113')`,
    `INSERT INTO products (id, tenant_id, name, slug) VALUES ('p-whole', '${T}', 'MS WHOLE 5 GL BAG', 'whole-0113')`,
    `INSERT INTO products (id, tenant_id, name, slug) VALUES ('p-hh', '${T}', 'H&H 5 GL DISP', 'hh-0113')`,
    `INSERT INTO products (id, tenant_id, name, slug) VALUES ('p-sour', '${T}', 'MS NATURAL SOUR CREAM', 'sour-0113')`,
    // Already seeded (prod has these): the name with its '%', and our SKU 0801.
    `INSERT INTO product_identifiers (id, tenant_id, product_id, kind, value, value_norm, supplier_id, confirmed, source, note)
       VALUES ('seed-bag-name', '${T}', 'p-bag', 'supplier_name', 'Cream - Heavy Whipping 40%', 'cream heavy whipping 40%', '${CMF}', 1, 'seed', 'seeded')`,
    `INSERT INTO product_identifiers (id, tenant_id, product_id, kind, value, value_norm, supplier_id, confirmed, source, note)
       VALUES ('seed-bag-sku', '${T}', 'p-bag', 'our_sku', '0801', '0801', NULL, 1, 'seed', 'seeded')`,
    `INSERT INTO product_identifiers (id, tenant_id, product_id, kind, value, value_norm, supplier_id, confirmed, source, note)
       VALUES ('seed-whole-name', '${T}', 'p-whole', 'supplier_name', 'Milk - Whole', 'milk whole', '${CMF}', 1, 'seed', 'seeded')`,
    // The three prod map rows, plus two edge rows.
    `INSERT INTO supplier_product_map (id, tenant_id, supplier_id, coa_product_name_key, order_product_id, distributor_sku, created_by, created_at, updated_at)
       VALUES ('map-cream', '${T}', '${CMF}', 'CREAM HEAVY WHIPPING 40', 'p-bag', '0801', '${U}', '2026-06-24 08:29:23', '2026-06-24 08:57:25')`,
    `INSERT INTO supplier_product_map (id, tenant_id, supplier_id, coa_product_name_key, order_product_id, distributor_sku, created_by, created_at, updated_at)
       VALUES ('map-whole', '${T}', '${CMF}', 'MILK WHOLE', 'p-whole', '30417', '${U}', '2026-06-24 08:36:58', '2026-06-24 08:57:25')`,
    `INSERT INTO supplier_product_map (id, tenant_id, supplier_id, coa_product_name_key, order_product_id, distributor_sku, created_by, created_at, updated_at)
       VALUES ('map-hh', '${T}', '${CMF}', 'HALF AND HALF', 'p-hh', '0708', '${U}', '2026-06-24 08:37:04', '2026-06-24 08:57:25')`,
    `INSERT INTO supplier_product_map (id, tenant_id, supplier_id, coa_product_name_key, order_product_id, distributor_sku, created_by)
       VALUES ('map-sour', '${T}', '${CMF}', 'SOUR CREAM NATURAL', 'p-sour', '08-29', NULL)`,
  ];
  for (const s of stmts) await db.prepare(s).run();
  before = await all(`SELECT * FROM product_identifiers ORDER BY id`);

  // Apply 0113 as one transaction.
  await db.batch(splitStatements(m0113).map((s) => db.prepare(s)));
  // The whole chain runs first; under a full-suite load that is not a 10 s job.
}, 120_000);

describe('migration 0113', () => {
  it('keeps every pre-existing identifier byte-identical', async () => {
    const ids = before.map((r) => `'${r.id}'`).join(',');
    expect(await all(`SELECT * FROM product_identifiers WHERE id IN (${ids}) ORDER BY id`)).toEqual(before);
  });

  it('copies each map row as a confirmed supplier_name, skipping exact duplicates of what is already there', async () => {
    const copied = await all(
      `SELECT product_id, kind, value, value_norm, supplier_id, confirmed, source, created_by, confirmed_by, created_at, confirmed_at, note
         FROM product_identifiers WHERE source = 'migrated_product_map' ORDER BY kind, product_id`,
    );
    expect(copied.map((r) => [r.kind, r.product_id, r.value])).toEqual([
      ['our_sku', 'p-hh', '0708'],
      ['our_sku', 'p-whole', '30417'],
      ['supplier_name', 'p-hh', 'HALF AND HALF'],
      ['supplier_name', 'p-sour', 'SOUR CREAM NATURAL'],
    ]);
    const hh = copied.find((r) => r.kind === 'supplier_name' && r.product_id === 'p-hh')!;
    expect(hh).toMatchObject({
      value_norm: 'half and half', supplier_id: CMF, confirmed: 1, created_by: U, confirmed_by: U,
      created_at: '2026-06-24 08:37:04', confirmed_at: '2026-06-24 08:57:25',
    });
    expect(String(hh.note)).toContain('supplier_product_map row map-hh');
    const sour = copied.find((r) => r.product_id === 'p-sour')!;
    expect(sour).toMatchObject({ created_by: null, confirmed_by: null, confirmed: 1 });
    // "CREAM HEAVY WHIPPING 40" = seeded "cream heavy whipping 40%"; "MILK WHOLE" = "milk whole"; 0801 exists; "08-29" is not a plain code.
    expect((await all(`SELECT id FROM product_identifiers WHERE product_id = 'p-bag'`)).length).toBe(2);
    expect((await all(`SELECT id FROM product_identifiers WHERE kind = 'our_sku' AND product_id = 'p-sour'`)).length).toBe(0);
  });

  it('widens the source CHECK and nothing else', async () => {
    const sql = (await db.prepare("SELECT sql FROM sqlite_master WHERE name = 'product_identifiers'").first<{ sql: string }>())!.sql;
    expect(sql).toContain("'migrated_product_map'");
    await expect(
      db.prepare(`INSERT INTO product_identifiers (id, tenant_id, product_id, kind, value, value_norm, source) VALUES ('bad', '${T}', 'p-bag', 'alias', 'x', 'x', 'bogus')`).run(),
    ).rejects.toThrow(/CHECK/);
    await expect(
      db.prepare(`INSERT INTO product_identifiers (id, tenant_id, product_id, kind, value, value_norm, source) VALUES ('bad2', '${T}', 'p-bag', 'supplier_item', 'x', 'x', 'seed')`).run(),
    ).rejects.toThrow(/CHECK/);
    const idx = await all("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'product_identifiers' AND name NOT LIKE 'sqlite_%' ORDER BY name");
    expect(idx.map((r) => r.name)).toEqual([
      'idx_product_identifiers_lookup', 'idx_product_identifiers_product',
      'idx_product_identifiers_unique_plain', 'idx_product_identifiers_unique_supplier',
    ]);
    expect(await all("SELECT name FROM sqlite_master WHERE name = 'product_identifiers_pre0113'")).toEqual([]);
  });

  it('leaves supplier_product_map in place, and adds lot_match_suggestions.match_note', async () => {
    expect((await all('SELECT id FROM supplier_product_map')).length).toBe(4);
    expect((await all("SELECT name FROM pragma_table_info('lot_match_suggestions') WHERE name = 'match_note'")).length).toBe(1);
  });

  it('the copy is idempotent: re-running it writes nothing', async () => {
    const count = async () => (await db.prepare('SELECT count(*) AS n FROM product_identifiers').first<{ n: number }>())!.n;
    const n = await count();
    const copies = splitStatements(m0113).filter((s) => /FROM supplier_product_map/.test(s));
    expect(copies).toHaveLength(2);
    for (const s of copies) await db.prepare(s).run();
    expect(await count()).toBe(n);
  });
});
