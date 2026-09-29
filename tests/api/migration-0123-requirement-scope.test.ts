/**
 * Migration 0123 (requirement scope) rehearsed on a POPULATED pre-0123 schema,
 * applied as ONE batch the way `wrangler d1 execute --file` applies a file.
 *
 * What it must prove: every existing requirement reads 'supplier' (so every
 * existing gap is unchanged), every existing product_suppliers row keeps its
 * data with the new facts NULL (nobody recorded them), nothing is rebuilt, and
 * product_requirements enforces its closed vocabulary and its key.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { runMigrations, MIGRATIONS, splitStatements } from '../helpers/db';
import m0123 from '../../migrations/0123_requirement_scope.sql?raw';

const db = env.MIGRATION_DB;
const IDX = MIGRATIONS.indexOf(m0123);
const T = 'tenant-0123';
type Row = Record<string, unknown>;

beforeAll(async () => {
  const existing = await db
    .prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'requirements'")
    .first<{ n: number }>();
  if ((existing?.n ?? 0) === 0) {
    expect(IDX).toBeGreaterThan(0);
    await runMigrations(db, { before: IDX });
  }
  const cols = await db.prepare("SELECT name FROM pragma_table_info('requirements')").all<Row>();
  // A rehearsal on a database 0123 already ran on proves nothing.
  expect((cols.results ?? []).map((c) => c.name)).not.toContain('scope');

  const stmts = [
    `INSERT INTO tenants (id, name, slug) VALUES ('${T}', 'Rehearsal', 'rehearsal-0123')`,
    `INSERT INTO suppliers (id, tenant_id, name, slug) VALUES ('sup-0123', '${T}', 'CMF', 'cmf-0123')`,
    `INSERT INTO products (id, tenant_id, name, slug) VALUES ('p-0123', '${T}', 'MS WHOLE', 'ms-whole-0123')`,
    `INSERT INTO product_suppliers (id, tenant_id, product_id, supplier_id, supplier_sku) VALUES ('ps-0123', '${T}', 'p-0123', 'sup-0123', '30417')`,
    `INSERT INTO requirements (id, tenant_id, slug, name) VALUES ('r-spec-0123', '${T}', 'spec-sheet', 'Spec Sheet')`,
    `INSERT INTO requirements (id, tenant_id, slug, name) VALUES ('r-coi-0123', '${T}', 'coi', 'COI')`,
  ];
  await db.batch(stmts.map((s) => db.prepare(s)));
  await db.batch(splitStatements(m0123).map((s) => db.prepare(s)));
});

describe('0123 on a populated database', () => {
  it('every existing requirement reads supplier scope', async () => {
    const rows = await db.prepare(`SELECT id, scope FROM requirements WHERE tenant_id = '${T}' ORDER BY id`).all<Row>();
    expect(rows.results).toEqual([
      { id: 'r-coi-0123', scope: 'supplier' },
      { id: 'r-spec-0123', scope: 'supplier' },
    ]);
  });

  it('keeps every product_suppliers row, with the new facts NULL', async () => {
    const row = await db.prepare(`SELECT * FROM product_suppliers WHERE id = 'ps-0123'`).first<Row>();
    expect(row).toMatchObject({
      supplier_sku: '30417',
      source: null,
      discontinued_at: null,
      discontinued_by: null,
      nothing_owed_reason: null,
      nothing_owed_at: null,
      nothing_owed_by: null,
    });
  });

  it('product_requirements: closed mode, default tier, one row per (tenant, supplier, product, requirement)', async () => {
    await db
      .prepare(
        `INSERT INTO product_requirements (id, tenant_id, supplier_id, product_id, requirement_id, mode, reason)
         VALUES ('pr-1', '${T}', 'sup-0123', 'p-0123', 'r-spec-0123', 'exempt', 'packaging')`,
      )
      .run();
    const row = await db.prepare(`SELECT tier, source FROM product_requirements WHERE id = 'pr-1'`).first<Row>();
    expect(row).toEqual({ tier: 'required', source: null });
    await expect(
      db
        .prepare(
          `INSERT INTO product_requirements (id, tenant_id, supplier_id, product_id, requirement_id, mode)
           VALUES ('pr-2', '${T}', 'sup-0123', 'p-0123', 'r-spec-0123', 'add')`,
        )
        .run(),
    ).rejects.toThrow(/UNIQUE/);
    await expect(
      db
        .prepare(
          `INSERT INTO product_requirements (id, tenant_id, supplier_id, product_id, requirement_id, mode)
           VALUES ('pr-3', '${T}', 'sup-0123', 'p-0123', 'r-coi-0123', 'remove')`,
        )
        .run(),
    ).rejects.toThrow(/CHECK/);
  });

  it('did not rebuild requirements (no CHECK on scope; widening later needs no rebuild)', async () => {
    const sql = await db
      .prepare("SELECT sql FROM sqlite_master WHERE name = 'requirements'")
      .first<{ sql: string }>();
    expect(sql!.sql).not.toMatch(/scope[^,]*CHECK/i);
    // A stored value the code does not know is accepted by SQL; the code reads it as 'supplier'.
    await db.prepare(`UPDATE requirements SET scope = 'facility' WHERE id = 'r-coi-0123'`).run();
  });
});
