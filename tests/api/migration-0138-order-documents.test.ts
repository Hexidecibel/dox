/**
 * Migration 0138 (document orders) rehearsed on a POPULATED pre-0138 schema,
 * applied as ONE batch the way `wrangler d1 execute --file` applies a file.
 *
 * What it must prove:
 *
 *   1. ADDITIVE. Every order, send and sent-file row that existed is exactly
 *      what it was, with the three new columns NULL -- and NULL reads as it
 *      always did: an ordinary send, and a link file that does not expire.
 *   2. THE NEW TABLE HOLDS ITS KEY AND ITS CLOSED VOCABULARIES: one line per
 *      (order, item, supplier, type); `resolution` and `release_status` take
 *      only their words; `rule_at_resolve` has no CHECK (a bad value there can
 *      only be display, never a decision).
 *   3. DELETING AN ORDER TAKES ITS DOCUMENT LINES WITH IT, and DELETING A
 *      SUPPLIER A LINE NAMES IS REFUSED -- there is no cascade, so a supplier
 *      merge has to move the lines rather than lose them.
 *   4. A second run changes nothing.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { runMigrations, MIGRATIONS, splitStatements } from '../helpers/db';
import m0138 from '../../migrations/0138_order_documents.sql?raw';

const db = env.MIGRATION_DB;
const IDX = MIGRATIONS.indexOf(m0138);
const T = 'tenant-0138';
const U = 'user-0138';
const S = 'sup-0138';
type Row = Record<string, unknown>;
const all = async (sql: string): Promise<Row[]> => (await db.prepare(sql).all<Row>()).results ?? [];
const run = (sql: string) => db.prepare(sql).run();

let sendsBefore = '';
let filesBefore = '';
let ordersBefore = '';

beforeAll(async () => {
  const existing = await db
    .prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'order_sends'")
    .first<{ n: number }>();
  if ((existing?.n ?? 0) === 0) {
    expect(IDX).toBeGreaterThan(0);
    await runMigrations(db, { before: IDX });
  }
  // A rehearsal on a database 0138 already ran on proves nothing.
  expect(await all("SELECT name FROM sqlite_master WHERE name = 'order_documents'")).toEqual([]);
  expect((await all("SELECT name FROM pragma_table_info('order_sends')")).map((c) => c.name)).not.toContain('kind');

  const stmts = [
    `INSERT INTO tenants (id, name, slug) VALUES ('${T}', 'Rehearsal', 'rehearsal-0138')`,
    `INSERT INTO users (id, email, password_hash, name, role, tenant_id) VALUES ('${U}', 'r0138@example.com', 'x', 'R', 'org_admin', '${T}')`,
    `INSERT INTO suppliers (id, tenant_id, name, slug) VALUES ('${S}', '${T}', 'Rehearsal Creamery', 'creamery-0138')`,
    `INSERT INTO suppliers (id, tenant_id, name, slug) VALUES ('sup-free', '${T}', 'Unused Dairy', 'unused-0138')`,
    `INSERT INTO products (id, tenant_id, name, slug) VALUES ('p-0138', '${T}', 'Whole Milk', 'whole-0138')`,
    `INSERT INTO document_types (id, tenant_id, name, slug) VALUES ('dt-0138', '${T}', 'Spec Sheet', 'spec-0138')`,
    `INSERT INTO documents (id, tenant_id, title, status, created_by, supplier_id, document_type_id) VALUES ('d-0138', '${T}', 'Whole Milk spec', 'active', '${U}', '${S}', 'dt-0138')`,
    `INSERT INTO orders (id, tenant_id, order_number, status, created_by) VALUES ('o-0138', '${T}', 'SO-1', 'delivered', '${U}')`,
    `INSERT INTO orders (id, tenant_id, order_number, status, created_by) VALUES ('o-0138-b', '${T}', 'SO-2', 'pending', '${U}')`,
    `INSERT INTO order_items (id, order_id, product_id, coa_document_id) VALUES ('oi-0138', 'o-0138', 'p-0138', 'd-0138')`,
    // A send from before 0138: one attachment, one oversize file on a link.
    `INSERT INTO order_sends (id, tenant_id, order_id, order_number, sent_by, recipients, subject, part_count, parts, status)
       VALUES ('os-0138', '${T}', 'o-0138', 'SO-1', '${U}', '["buyer@example.com"]', 'Documents', 1, '[]', 'sent')`,
    `INSERT INTO order_send_files (id, send_id, tenant_id, position, document_id, version_number, document_ids, file_name, bytes, part_number, delivery, source, sent_ok)
       VALUES ('osf-a', 'os-0138', '${T}', 0, 'd-0138', 1, '["d-0138"]', 'a.pdf', 10, 1, 'attachment', 'document', 1)`,
    `INSERT INTO order_send_files (id, send_id, tenant_id, position, document_id, version_number, document_ids, file_name, bytes, part_number, delivery, source, export_link_id, sent_ok)
       VALUES ('osf-l', 'os-0138', '${T}', 1, 'd-0138', 1, '["d-0138"]', 'big.pdf', 99999999, 1, 'link', 'document', 'link-old', 1)`,
  ];
  await db.batch(stmts.map((s) => db.prepare(s)));

  sendsBefore = JSON.stringify(await all(`SELECT * FROM order_sends WHERE tenant_id = '${T}'`));
  filesBefore = JSON.stringify(await all(`SELECT * FROM order_send_files WHERE tenant_id = '${T}' ORDER BY position`));
  ordersBefore = JSON.stringify(await all(`SELECT * FROM orders WHERE tenant_id = '${T}' ORDER BY id`));

  await db.batch(splitStatements(m0138).map((s) => db.prepare(s)));
});

describe('0138 on a populated database', () => {
  it('leaves every existing order, send and sent file exactly as it was', async () => {
    expect(JSON.stringify(await all(`SELECT * FROM orders WHERE tenant_id = '${T}' ORDER BY id`))).toBe(ordersBefore);

    const strip = (rows: Row[], keys: string[]) =>
      rows.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => !keys.includes(k))));
    const sends = await all(`SELECT * FROM order_sends WHERE tenant_id = '${T}'`);
    expect(JSON.stringify(strip(sends, ['kind']))).toBe(sendsBefore);
    // NULL = an ordinary send. Nothing was relabelled.
    expect(sends.map((s) => s.kind)).toEqual([null]);

    const sentFiles = await all(`SELECT * FROM order_send_files WHERE tenant_id = '${T}' ORDER BY position`);
    expect(JSON.stringify(strip(sentFiles, ['order_document_ids', 'link_days']))).toBe(filesBefore);
    // NULL link_days on a link file keeps 0134's meaning: it does not expire.
    expect(sentFiles.map((f) => [f.delivery, f.link_days, f.order_document_ids])).toEqual([
      ['attachment', null, null],
      ['link', null, null],
    ]);
  });

  it('starts with no document lines: nothing is backfilled or inferred', async () => {
    expect(await all('SELECT id FROM order_documents')).toEqual([]);
  });

  const insertLine = (id: string, over: Record<string, string> = {}) => {
    const v = {
      order_id: `'o-0138'`,
      product_id: `'p-0138'`,
      supplier_id: `'${S}'`,
      document_type_id: `'dt-0138'`,
      resolution: `'found'`,
      rule_at_resolve: `'free'`,
      release_status: `'none'`,
      ...over,
    };
    return run(
      `INSERT INTO order_documents (id, tenant_id, order_id, product_id, supplier_id, document_type_id, document_id, resolution, rule_at_resolve, release_status, added_by)
       VALUES ('${id}', '${T}', ${v.order_id}, ${v.product_id}, ${v.supplier_id}, ${v.document_type_id}, 'd-0138', ${v.resolution}, ${v.rule_at_resolve}, ${v.release_status}, '${U}')`,
    );
  };

  it('holds one line per (order, item, supplier, type), with the defaults a new line starts on', async () => {
    await run(
      `INSERT INTO order_documents (id, tenant_id, order_id, product_id, supplier_id, document_type_id, resolution, added_by)
       VALUES ('od-1', '${T}', 'o-0138', 'p-0138', '${S}', 'dt-0138', 'missing', '${U}')`,
    );
    const row = await db.prepare(`SELECT * FROM order_documents WHERE id = 'od-1'`).first<Row>();
    expect(row).toMatchObject({
      release_status: 'none',
      document_id: null,
      rule_at_resolve: null,
      qa_notified_at: null,
      pending_send_id: null,
      export_link_id: null,
      last_send_id: null,
    });
    expect(row?.resolved_at).toBeTruthy();
    // The same thing asked for twice on one order is refused...
    await expect(insertLine('od-dup')).rejects.toThrow(/UNIQUE/i);
    // ...and allowed on another order.
    await insertLine('od-other-order', { order_id: `'o-0138-b'` });
  });

  it('takes only its own words for resolution and release status, and anything for the display-only rule', async () => {
    await expect(insertLine('od-bad-res', { order_id: `'o-0138-b'`, product_id: `'p-0138'`, document_type_id: `'dt-0138'`, resolution: `'guessed'`, supplier_id: `'sup-free'` })).rejects.toThrow(/CHECK/i);
    await expect(insertLine('od-bad-rel', { supplier_id: `'sup-free'`, release_status: `'approved'` })).rejects.toThrow(/CHECK/i);
    // No CHECK on the snapshot: it is read through parseSharingRule, which
    // treats a word it does not know as "not stored", and it decides nothing.
    await insertLine('od-odd-rule', { supplier_id: `'sup-free'`, rule_at_resolve: `'whatever'` });
    await run(`DELETE FROM order_documents WHERE id = 'od-odd-rule'`);
  });

  it('refuses to delete a supplier a line names, and lets an unused one go', async () => {
    await expect(run(`DELETE FROM suppliers WHERE id = '${S}'`)).rejects.toThrow(/FOREIGN KEY/i);
    await run(`DELETE FROM suppliers WHERE id = 'sup-free'`);
    expect(await all(`SELECT id FROM order_documents WHERE id = 'od-1'`)).toHaveLength(1);
  });

  it('deleting an order takes its document lines with it, and only its own', async () => {
    await run(`DELETE FROM order_items WHERE order_id = 'o-0138-b'`);
    await run(`DELETE FROM orders WHERE id = 'o-0138-b'`);
    expect((await all('SELECT id FROM order_documents ORDER BY id')).map((r) => r.id)).toEqual(['od-1']);
  });

  it('a second run changes nothing it can, and fails loudly on what it cannot', async () => {
    // CREATE ... IF NOT EXISTS is a no-op; the ALTERs say the column is there.
    const [create, ...rest] = splitStatements(m0138);
    await run(create);
    const alters = rest.filter((s) => /^ALTER TABLE/i.test(s.trim()));
    expect(alters).toHaveLength(3);
    for (const stmt of alters) await expect(run(stmt)).rejects.toThrow(/duplicate column/i);
    expect((await all('SELECT id FROM order_documents')).map((r) => r.id)).toEqual(['od-1']);
  });
});
