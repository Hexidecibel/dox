/**
 * Migration 0139 (holds) rehearsed on a POPULATED pre-0139 schema, applied as
 * ONE batch the way `wrangler d1 execute --file` applies a file.
 *
 * What it must prove:
 *
 *   1. ADDITIVE. No existing row changes, and NO existing document is put on
 *      hold by the migration -- including one whose stored register rows say a
 *      Critical result failed. (bin/propose-spec-holds is how those are found.)
 *   2. The table holds its own rules: a reason is required; the three sources
 *      and nothing else; a person's hold names a person and carries no result
 *      key, an automatic one the reverse; a release is all three columns or
 *      none.
 *   3. ONE ACTIVE hold per (document, lot, source, result), and an automatic
 *      hold ONCE per judged result ever, released or not.
 *   4. APPEND-ONLY in the database: an edit aborts, a release stamps once.
 *   5. A hold refuses to vanish with its document or its lot, and goes with its
 *      tenant. Running the file twice changes nothing.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { runMigrations, MIGRATIONS, splitStatements } from '../helpers/db';
import m0139 from '../../migrations/0139_document_holds.sql?raw';

const db = env.MIGRATION_DB;
const IDX = MIGRATIONS.indexOf(m0139);
const T = 'tenant-0139';
const U = 'user-0139';
type Row = Record<string, unknown>;
const all = async (sql: string): Promise<Row[]> => (await db.prepare(sql).all<Row>()).results ?? [];
const run = (sql: string) => db.prepare(sql).run();

let before = '';
const snapshot = async () =>
  JSON.stringify({
    documents: await all(`SELECT * FROM documents WHERE tenant_id = '${T}' ORDER BY id`),
    lots: await all(`SELECT * FROM lots WHERE tenant_id = '${T}' ORDER BY id`),
    checks: await all(`SELECT * FROM document_spec_checks WHERE tenant_id = '${T}' ORDER BY id`),
    document_lots: await all(`SELECT * FROM document_lots WHERE document_id IN ('d-1', 'd-2') ORDER BY id`),
  });

const hold = (id: string, cols: Record<string, string | null>) => {
  const row: Record<string, string | null> = { id: `'${id}'`, tenant_id: `'${T}'`, document_id: `'d-1'`, reason: `'why'`, source: `'person'`, placed_by: `'${U}'`, ...cols };
  const keys = Object.keys(row).filter((k) => row[k] !== null);
  return `INSERT INTO document_holds (${keys.join(', ')}) VALUES (${keys.map((k) => row[k]).join(', ')})`;
};

beforeAll(async () => {
  const existing = await db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'documents'").first<{ n: number }>();
  if ((existing?.n ?? 0) === 0) {
    expect(IDX).toBeGreaterThan(0);
    await runMigrations(db, { before: IDX });
  }
  // A rehearsal on a database 0139 already ran on proves nothing.
  expect(await all("SELECT name FROM sqlite_master WHERE name = 'document_holds'")).toEqual([]);

  await db.batch(
    [
      `INSERT INTO tenants (id, name, slug) VALUES ('${T}', 'Rehearsal', 'rehearsal-0139')`,
      `INSERT INTO users (id, email, password_hash, name, role, tenant_id) VALUES ('${U}', 'r0139@example.com', 'x', 'R', 'org_admin', '${T}')`,
      `INSERT INTO suppliers (id, tenant_id, name, slug) VALUES ('s-1', '${T}', 'Rehearsal Creamery', 'creamery-0139')`,
      `INSERT INTO documents (id, tenant_id, title, status, created_by, supplier_id) VALUES ('d-1', '${T}', 'COA lot 1', 'active', '${U}', 's-1')`,
      `INSERT INTO documents (id, tenant_id, title, status, created_by, supplier_id) VALUES ('d-2', '${T}', 'COA lot 2', 'active', '${U}', 's-1')`,
      `INSERT INTO lots (id, tenant_id, supplier_id, lot_number, lot_key) VALUES ('l-1', '${T}', 's-1', '5501', '5501')`,
      `INSERT INTO lots (id, tenant_id, supplier_id, lot_number, lot_key) VALUES ('l-2', '${T}', 's-1', '5502', '5502')`,
      `INSERT INTO document_lots (id, document_id, lot_id) VALUES ('dl-1', 'd-1', 'l-1')`,
      `INSERT INTO document_lots (id, document_id, lot_id) VALUES ('dl-2', 'd-2', 'l-2')`,
      // A stored approval-time Critical failure. The migration must NOT hold it.
      `INSERT INTO document_spec_checks (id, tenant_id, document_id, version_number, test_name_raw, value_raw, verdict, source, limit_id, limit_snapshot, judgement_origin, result_key)
       VALUES ('c-1', '${T}', 'd-1', 1, 'Coliform', '40', 'out_of_spec', 'limit', 'lim-1', '{"criticality":"high"}', 'approval', 'ai_fields::t0r0')`,
    ].map((s) => db.prepare(s)),
  );
  before = await snapshot();
  await db.batch(splitStatements(m0139).map((s) => db.prepare(s)));
});

describe('0139 on a populated database', () => {
  it('changes no existing row, and puts nothing on hold', async () => {
    expect(await snapshot()).toBe(before);
    expect(await all('SELECT id FROM document_holds')).toEqual([]);
  });

  it('adds one table, its indexes and its trigger, and nothing else', async () => {
    const cols = (await all("SELECT name FROM pragma_table_info('document_holds')")).map((c) => c.name);
    expect(cols).toEqual([
      'id', 'tenant_id', 'document_id', 'lot_id', 'reason', 'source', 'source_key', 'spec_check_id',
      'document_version', 'detail', 'placed_by', 'placed_at', 'qa_notified_at',
      'released_by', 'released_at', 'release_reason',
    ]);
    // No supplier column: a hold's supplier is its document's, so a supplier
    // merge has nothing to move.
    expect(cols).not.toContain('supplier_id');
    const made = (await all("SELECT name, type FROM sqlite_master WHERE tbl_name = 'document_holds' AND name NOT LIKE 'sqlite_%' ORDER BY name")).map((r) => `${r.type}:${r.name}`);
    expect(made).toEqual([
      'table:document_holds',
      'index:idx_document_holds_auto_once',
      'index:idx_document_holds_document',
      'index:idx_document_holds_lot',
      'index:idx_document_holds_one_active',
      'index:idx_document_holds_tenant_active',
      'trigger:trg_document_holds_immutable',
    ].sort((a, b) => a.split(':')[1].localeCompare(b.split(':')[1])));
  });

  it('the foreign keys are deliberate: tenant cascades, document and lot and users do nothing', async () => {
    const fks = await all("SELECT \"table\" AS t, \"from\" AS f, on_delete FROM pragma_foreign_key_list('document_holds') ORDER BY f");
    expect(fks).toEqual([
      { t: 'documents', f: 'document_id', on_delete: 'NO ACTION' },
      { t: 'lots', f: 'lot_id', on_delete: 'NO ACTION' },
      { t: 'users', f: 'placed_by', on_delete: 'NO ACTION' },
      { t: 'users', f: 'released_by', on_delete: 'NO ACTION' },
      { t: 'tenants', f: 'tenant_id', on_delete: 'CASCADE' },
    ]);
  });

  it('requires a reason, a known source, and the right shape for each source', async () => {
    await expect(run(hold('h-bad-1', { reason: `''` }))).rejects.toThrow();
    await expect(run(hold('h-bad-2', { reason: `'   '` }))).rejects.toThrow();
    await expect(run(hold('h-bad-3', { source: `'supplier_probation'` }))).rejects.toThrow();
    // A person's hold names a person and carries no result key.
    await expect(run(hold('h-bad-4', { placed_by: null }))).rejects.toThrow();
    await expect(run(hold('h-bad-5', { source_key: `'v1:limit:k'` }))).rejects.toThrow();
    // An automatic hold must say which judged result placed it.
    await expect(run(hold('h-bad-6', { source: `'spec_critical'`, placed_by: null }))).rejects.toThrow();
    // A release is all three columns or none.
    await expect(run(hold('h-bad-7', { released_at: `datetime('now')` }))).rejects.toThrow();
    await expect(run(hold('h-bad-8', { released_at: `datetime('now')`, released_by: `'${U}'`, release_reason: `' '` }))).rejects.toThrow();
    // Another organization's ids cannot be invented.
    await expect(run(hold('h-bad-9', { document_id: `'no-such-document'` }))).rejects.toThrow();
    await expect(run(hold('h-bad-10', { lot_id: `'no-such-lot'` }))).rejects.toThrow();
    expect(await all('SELECT id FROM document_holds')).toEqual([]);
  });

  it('one active hold per (document, lot, source); a released one makes room', async () => {
    await run(hold('h-whole', {}));
    await expect(run(hold('h-whole-2', {}))).rejects.toThrow(/UNIQUE/);
    await run(hold('h-lot', { lot_id: `'l-1'` }));
    await expect(run(hold('h-lot-2', { lot_id: `'l-1'` }))).rejects.toThrow(/UNIQUE/);
    await run(`UPDATE document_holds SET released_by = '${U}', released_at = datetime('now'), release_reason = 'clean' WHERE id = 'h-lot'`);
    await run(hold('h-lot-3', { lot_id: `'l-1'` }));
    expect((await all(`SELECT id FROM document_holds WHERE document_id = 'd-1' AND released_at IS NULL ORDER BY id`)).map((r) => r.id)).toEqual(['h-lot-3', 'h-whole']);
  });

  it('an automatic hold is placed once per judged result EVER, released or not', async () => {
    const auto = (id: string, key: string) => hold(id, { source: `'spec_critical'`, source_key: `'${key}'`, placed_by: null, lot_id: `'l-1'` });
    await run(auto('a-1', 'v1:limit:ai_fields::t0r0'));
    await expect(run(auto('a-2', 'v1:limit:ai_fields::t0r0'))).rejects.toThrow(/UNIQUE/);
    await run(`UPDATE document_holds SET released_by = '${U}', released_at = datetime('now'), release_reason = 'retest clean' WHERE id = 'a-1'`);
    // Released, and still not placed again for the same result.
    await expect(run(auto('a-3', 'v1:limit:ai_fields::t0r0'))).rejects.toThrow(/UNIQUE/);
    const ignored = await run(auto('a-4', 'v1:limit:ai_fields::t0r0').replace('INSERT INTO', 'INSERT OR IGNORE INTO'));
    expect(ignored.meta.changes).toBe(0);
    // Another result, and the same place on a NEW version, are new.
    await run(auto('a-5', 'v1:limit:ai_fields::t0r1'));
    await run(auto('a-6', 'v2:limit:ai_fields::t0r0'));
  });

  it('is append-only: an edit aborts, a release is stamped once', async () => {
    for (const set of [`reason = 'rewritten'`, `document_id = 'd-2'`, `placed_at = '2020-01-01'`, `placed_by = NULL`, `detail = '{}'`, `document_version = 9`, `tenant_id = 'x'`]) {
      await expect(run(`UPDATE document_holds SET ${set} WHERE id = 'h-whole'`), set).rejects.toThrow();
    }
    await expect(run(`UPDATE document_holds SET release_reason = 'second thoughts' WHERE id = 'h-lot'`)).rejects.toThrow(/append-only/);
    await expect(run(`UPDATE document_holds SET released_at = NULL, released_by = NULL, release_reason = NULL WHERE id = 'h-lot'`)).rejects.toThrow(/append-only/);
    // What IS allowed: recording that QA was told, and following a merged lot.
    await run(`UPDATE document_holds SET qa_notified_at = datetime('now') WHERE id = 'h-whole'`);
    await run(`UPDATE document_holds SET lot_id = 'l-2' WHERE id = 'h-lot-3'`);
    await run(`UPDATE document_holds SET lot_id = 'l-1' WHERE id = 'h-lot-3'`);
    expect((await db.prepare(`SELECT reason FROM document_holds WHERE id = 'h-whole'`).first<Row>())!.reason).toBe('why');
  });

  it('a held document or lot cannot be deleted out from under its hold; the tenant takes its holds with it', async () => {
    await expect(run(`DELETE FROM document_lots WHERE document_id = 'd-1'`).then(() => run(`DELETE FROM lots WHERE id = 'l-1'`))).rejects.toThrow(/FOREIGN KEY/);
    await expect(run(`DELETE FROM documents WHERE id = 'd-1'`)).rejects.toThrow(/FOREIGN KEY/);
    expect((await all('SELECT count(*) AS n FROM document_holds'))[0].n).toBeGreaterThan(0);
  });

  it('running the file again changes nothing', async () => {
    const holdsBefore = JSON.stringify(await all('SELECT * FROM document_holds ORDER BY id'));
    await db.batch(splitStatements(m0139).map((s) => db.prepare(s)));
    expect(JSON.stringify(await all('SELECT * FROM document_holds ORDER BY id'))).toBe(holdsBefore);
  });
});
