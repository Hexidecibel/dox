/**
 * Migration 0110 REBUILDS `lots` (copy out, DROP, CREATE widened, copy back) to
 * widen the CHECK on `production_date_source`. Three tables point at lots(id) —
 * `document_lots.lot_id`, `order_items.lot_id`, `lot_match_suggestions.lot_id` —
 * and SQLite's DROP TABLE runs an implicit DELETE that would fire any ON DELETE
 * action and violate every NO ACTION reference. The migration relies on
 * `PRAGMA defer_foreign_keys` plus every row coming back with the same id.
 *
 * This is the rehearsal: an EMPTY D1 (MIGRATION_DB, never auto-migrated) is
 * migrated through 0109, populated with lots and every kind of row that
 * references one, and then 0110 is applied as ONE transaction (a D1 batch, the
 * way `wrangler d1 execute --file` applies a file). Nothing may be lost, nulled
 * or re-pointed, the FTS rows must be untouched, and the recreated trigger and
 * indexes must be the ones prod had.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { runMigrations, MIGRATIONS, splitStatements } from '../helpers/db';
import m0110 from '../../migrations/0110_supplier_lot_schemes.sql?raw';

const db = env.MIGRATION_DB;
const IDX_0110 = MIGRATIONS.indexOf(m0110);

const T = 'tenant-rehearsal';
const U = 'user-rehearsal';
const SUP = 'sup-darigold';
const PROD = 'prod-milk';
const LOTS = ['lot-a', 'lot-b', 'lot-c', 'lot-d'];
const DOCS = ['doc-1', 'doc-2', 'doc-3'];

type Row = Record<string, unknown>;
const all = async (sql: string): Promise<Row[]> => (await db.prepare(sql).all<Row>()).results ?? [];

async function snapshot() {
  return {
    lots: await all(
      `SELECT id, tenant_id, supplier_id, product_id, lot_number, lot_key, code_date, expiration_date, mfg_date,
              primary_metadata, first_seen_source, created_at, updated_at, sub_lot_code, production_date,
              production_date_raw, production_date_source, production_date_status, production_date_document_id
         FROM lots ORDER BY id`,
    ),
    documentLots: await all('SELECT id, document_id, lot_id, created_at FROM document_lots ORDER BY id'),
    orderItems: await all('SELECT id, order_id, lot_id, coa_match_status FROM order_items ORDER BY id'),
    suggestions: await all('SELECT id, order_item_id, document_id, lot_id, status FROM lot_match_suggestions ORDER BY id'),
    fts: await all('SELECT rowid, doc_id, lot_text FROM documents_fts ORDER BY rowid'),
    ftsMatch: await all(
      "SELECT (SELECT count(*) FROM documents_fts WHERE documents_fts MATCH 'darigold') AS darigold, (SELECT count(*) FROM documents_fts WHERE documents_fts MATCH 'lot_text:10426203') AS lot",
    ),
    trigger: await all("SELECT sql FROM sqlite_master WHERE name = 'trg_lots_au_fts'"),
    indexes: await all("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'lots' ORDER BY name"),
    view: await all("SELECT sql FROM sqlite_master WHERE name = 'documents_fts_source'"),
  };
}

beforeAll(async () => {
  const existing = await db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'lots'").first<{ n: number }>();
  // A rehearsal on an already-migrated database proves nothing.
  expect(existing?.n).toBe(0);
  expect(IDX_0110).toBeGreaterThan(0);
  await runMigrations(db, { before: IDX_0110 });

  const col = await db.prepare("SELECT count(*) AS n FROM pragma_table_info('lots') WHERE name = 'production_date_scheme_id'").first<{ n: number }>();
  expect(col?.n).toBe(0);

  const stmts = [
    `INSERT INTO tenants (id, name, slug) VALUES ('${T}', 'Rehearsal Dairy', 'rehearsal-dairy')`,
    `INSERT INTO users (id, email, password_hash, name, role, tenant_id) VALUES ('${U}', 'r@example.com', 'x', 'R', 'org_admin', '${T}')`,
    `INSERT INTO suppliers (id, tenant_id, name, slug) VALUES ('${SUP}', '${T}', 'Darigold, Inc.', 'darigold')`,
    `INSERT INTO products (id, tenant_id, name, slug) VALUES ('${PROD}', '${T}', 'Whole Milk', 'whole-milk')`,
    ...DOCS.map(
      (d, i) =>
        `INSERT INTO documents (id, tenant_id, title, created_by, supplier_id) VALUES ('${d}', '${T}', 'Darigold COA ${i}', '${U}', '${SUP}')`,
    ),
    ...DOCS.map(
      (d) =>
        `INSERT INTO document_versions (id, document_id, version_number, file_name, file_size, mime_type, r2_key, uploaded_by) VALUES ('v-${d}', '${d}', 1, '${d}.pdf', 1, 'application/pdf', 'k/${d}', '${U}')`,
    ),
    `INSERT INTO lots (id, tenant_id, supplier_id, product_id, lot_number, lot_key, sub_lot_code, production_date, production_date_raw, production_date_source, production_date_status, production_date_document_id, created_at, updated_at)
       VALUES ('lot-a', '${T}', '${SUP}', '${PROD}', '10426203', '10426203', '03', '2026-07-22', '07/22/26', 'extracted', 'resolved', 'doc-1', '2026-07-23 10:00:00', '2026-07-23 10:00:01')`,
    `INSERT INTO lots (id, tenant_id, supplier_id, product_id, lot_number, lot_key, sub_lot_code, production_date, production_date_raw, production_date_source, production_date_status, created_at, updated_at)
       VALUES ('lot-b', '${T}', '${SUP}', '${PROD}', '10426203', '10426203', '04', '2026-07-22', '26203', 'extracted_code_date_legacy', 'resolved', '2026-07-23 10:00:00', '2026-07-24 09:00:00')`,
    `INSERT INTO lots (id, tenant_id, supplier_id, product_id, lot_number, lot_key, production_date_raw, production_date_source, production_date_status)
       VALUES ('lot-c', '${T}', '${SUP}', NULL, '9-9-9', '999', '07/22 or 07/23', 'extracted_code_date_legacy', 'conflict')`,
    `INSERT INTO lots (id, tenant_id, supplier_id, product_id, lot_number, lot_key, primary_metadata, first_seen_source, code_date, expiration_date, mfg_date)
       VALUES ('lot-d', '${T}', NULL, '${PROD}', 'CMF 091526-A', 'CMF091526A', '{"k":"v"}', 'order', '2026-09-15', '2026-09-30', '2026-09-01')`,
    `INSERT INTO document_lots (id, document_id, lot_id) VALUES ('dl-1', 'doc-1', 'lot-a'), ('dl-2', 'doc-1', 'lot-b'), ('dl-3', 'doc-2', 'lot-c'), ('dl-4', 'doc-3', 'lot-d')`,
    `INSERT INTO orders (id, tenant_id, order_number, source_data) VALUES ('ord-1', '${T}', 'ORD-1', '{}')`,
    `INSERT INTO order_items (id, order_id, product_name, lot_id, coa_match_status) VALUES ('oi-1', 'ord-1', 'Whole Milk', 'lot-a', 'matched'), ('oi-2', 'ord-1', 'Whole Milk', 'lot-d', 'suggested'), ('oi-3', 'ord-1', 'Cream', NULL, 'unmatched')`,
    `INSERT INTO lot_match_suggestions (id, tenant_id, order_item_id, document_id, lot_id, status) VALUES ('lms-1', '${T}', 'oi-2', 'doc-3', 'lot-d', 'pending'), ('lms-2', '${T}', 'oi-1', 'doc-1', 'lot-a', 'accepted'), ('lms-3', '${T}', 'oi-3', 'doc-2', NULL, 'pending')`,
  ];
  for (const s of stmts) await db.prepare(s).run();
});

describe('migration 0110 — the lots rebuild on a populated database', () => {
  it('loses, nulls and re-points nothing, and leaves FTS, the trigger and the indexes as they were', async () => {
    // The harness enforces foreign keys: deleting a referenced lot outside the
    // migration must fail, or this rehearsal would pass for the wrong reason.
    await expect(db.prepare("DELETE FROM lots WHERE id = 'lot-a'").run()).rejects.toThrow(/FOREIGN KEY/i);

    const before = await snapshot();
    expect(before.lots).toHaveLength(LOTS.length);
    expect(before.documentLots).toHaveLength(4);
    expect(before.orderItems.filter((r) => r.lot_id !== null)).toHaveLength(2);
    expect(before.suggestions.filter((r) => r.lot_id !== null)).toHaveLength(2);
    expect(before.ftsMatch[0].darigold).toBe(3);
    expect(before.ftsMatch[0].lot).toBe(1);

    // Apply 0110 as one transaction, as `wrangler d1 execute --file` does.
    await db.batch(splitStatements(m0110).map((s) => db.prepare(s)));

    const after = await snapshot();
    expect(after.lots).toEqual(before.lots);
    expect(after.documentLots).toEqual(before.documentLots);
    expect(after.orderItems).toEqual(before.orderItems);
    expect(after.suggestions).toEqual(before.suggestions);
    expect(after.fts).toEqual(before.fts);
    expect(after.ftsMatch).toEqual(before.ftsMatch);
    expect(after.trigger).toEqual(before.trigger);
    expect(after.indexes).toEqual(before.indexes);
    expect(after.view).toEqual(before.view);

    expect(await all('SELECT * FROM pragma_foreign_key_check()')).toEqual([]);
    expect(await all("SELECT name FROM sqlite_master WHERE name = 'lots_pre0110'")).toEqual([]);

    // The new column exists and is NULL on every carried row.
    expect(await all('SELECT id FROM lots WHERE production_date_scheme_id IS NOT NULL')).toEqual([]);
    expect(await all("SELECT name FROM sqlite_master WHERE name = 'supplier_lot_schemes'")).toHaveLength(1);

    // The CHECK is widened, not dropped.
    await db.prepare("UPDATE lots SET production_date_source = 'lot_decode' WHERE id = 'lot-d'").run();
    await expect(
      db.prepare("UPDATE lots SET production_date_source = 'guessed' WHERE id = 'lot-d'").run(),
    ).rejects.toThrow(/CHECK/i);

    // Foreign keys still bite after the rebuild.
    await expect(db.prepare("DELETE FROM lots WHERE id = 'lot-a'").run()).rejects.toThrow(/FOREIGN KEY/i);

    // The recreated trigger still re-indexes a lot's documents on a lot edit.
    await db.prepare("UPDATE lots SET lot_number = '77777777' WHERE id = 'lot-c'").run();
    const hit = await all("SELECT doc_id FROM documents_fts WHERE documents_fts MATCH 'lot_text:77777777'");
    expect(hit).toEqual([{ doc_id: 'doc-2' }]);
  });
});
