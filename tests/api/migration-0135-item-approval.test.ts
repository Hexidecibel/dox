/**
 * Migration 0135 (item approval, facilities, customer COA contacts and
 * requirements) rehearsed on a POPULATED pre-0135 schema, applied as ONE batch
 * the way `wrangler d1 execute --file` applies a file.
 *
 * What it must prove:
 *
 *   1. EVERYTHING ON FILE STARTS APPROVED (decision C-001), and as 'initial'
 *      -- never 'person'. No row claims somebody decided it.
 *   2. A pair that exists only through the legacy `products.supplier_id`
 *      column gets a `product_suppliers` row to carry that approval, with its
 *      link `source` left NULL (nobody recorded how it was linked).
 *   3. A PAIR CREATED AFTERWARDS STARTS PENDING, with no source at all.
 *   4. THE GAP ENGINE'S ANSWER DOES NOT MOVE. Computed for a supplier with a
 *      supplier-scope and a per-product requirement, a graph-linked product and
 *      a legacy-only one, before and after: equal, to the byte.
 *   5. Existing customer contacts become COA recipients; the new table holds
 *      its key and its closed vocabulary. Nothing is rebuilt, and a second run
 *      of the backfill changes nothing.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { runMigrations, MIGRATIONS, splitStatements } from '../helpers/db';
import { computeGapsForSuppliers } from '../../functions/lib/requirement-gaps';
import m0135 from '../../migrations/0135_item_approval_facilities_customers.sql?raw';

const db = env.MIGRATION_DB;
const IDX = MIGRATIONS.indexOf(m0135);
const T = 'tenant-0135';
const U = 'user-0135';
const S = 'sup-0135';
type Row = Record<string, unknown>;
const all = async (sql: string): Promise<Row[]> => (await db.prepare(sql).all<Row>()).results ?? [];

const gaps = () => computeGapsForSuppliers(db, T, [{ id: S, name: 'Rehearsal Creamery' }]);
let gapsBefore = '';

beforeAll(async () => {
  const existing = await db
    .prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'product_suppliers'")
    .first<{ n: number }>();
  if ((existing?.n ?? 0) === 0) {
    expect(IDX).toBeGreaterThan(0);
    await runMigrations(db, { before: IDX });
  }
  // A rehearsal on a database 0135 already ran on proves nothing.
  const cols = await all("SELECT name FROM pragma_table_info('product_suppliers')");
  expect(cols.map((c) => c.name)).not.toContain('approval_status');

  const stmts = [
    `INSERT INTO tenants (id, name, slug) VALUES ('${T}', 'Rehearsal', 'rehearsal-0135')`,
    `INSERT INTO users (id, email, password_hash, name, role, tenant_id) VALUES ('${U}', 'r0135@example.com', 'x', 'R', 'org_admin', '${T}')`,
    `INSERT INTO suppliers (id, tenant_id, name, slug) VALUES ('${S}', '${T}', 'Rehearsal Creamery', 'creamery-0135')`,
    // Linked through the graph, with facts recorded on the link.
    `INSERT INTO products (id, tenant_id, name, slug) VALUES ('p-graph', '${T}', 'Whole Milk', 'whole-0135')`,
    `INSERT INTO product_suppliers (id, tenant_id, product_id, supplier_id, supplier_sku, source) VALUES ('ps-graph', '${T}', 'p-graph', '${S}', '30417', 'import')`,
    // No longer supplied: approval is a separate fact and must not read it.
    `INSERT INTO products (id, tenant_id, name, slug) VALUES ('p-gone', '${T}', 'Old Cream', 'old-0135')`,
    `INSERT INTO product_suppliers (id, tenant_id, product_id, supplier_id, source, discontinued_at, discontinued_by) VALUES ('ps-gone', '${T}', 'p-gone', '${S}', 'admin', '2026-08-01 00:00:00', '${U}')`,
    // Linked ONLY through the legacy column: no product_suppliers row.
    `INSERT INTO products (id, tenant_id, name, slug, supplier_id) VALUES ('p-legacy', '${T}', 'Half and Half', 'hh-0135', '${S}')`,
    // Legacy column AND a graph row: must not be duplicated.
    `INSERT INTO products (id, tenant_id, name, slug, supplier_id) VALUES ('p-both', '${T}', 'Butter', 'butter-0135', '${S}')`,
    `INSERT INTO product_suppliers (id, tenant_id, product_id, supplier_id) VALUES ('ps-both', '${T}', 'p-both', '${S}')`,
    // No supplier at all: never becomes a pair.
    `INSERT INTO products (id, tenant_id, name, slug) VALUES ('p-none', '${T}', 'Unlinked', 'none-0135')`,

    // One supplier-scope requirement (closed) and one per-product (closed for
    // the graph product only), so the gap answer has both shapes in it.
    `INSERT INTO requirements (id, tenant_id, slug, name, scope) VALUES ('r-coi', '${T}', 'coi-0135', 'Certificate of Insurance', 'supplier')`,
    `INSERT INTO requirements (id, tenant_id, slug, name, scope) VALUES ('r-spec', '${T}', 'spec-0135', 'Spec Sheet', 'product')`,
    `INSERT INTO supplier_requirements (id, tenant_id, supplier_id, requirement_id, tier) VALUES ('sr-coi', '${T}', '${S}', 'r-coi', 'required')`,
    `INSERT INTO supplier_requirements (id, tenant_id, supplier_id, requirement_id, tier) VALUES ('sr-spec', '${T}', '${S}', 'r-spec', 'required')`,
    `INSERT INTO documents (id, tenant_id, title, status, created_by, supplier_id, classification_status) VALUES ('d-coi', '${T}', 'COI 2026', 'active', '${U}', '${S}', 'classified')`,
    `INSERT INTO documents (id, tenant_id, title, status, created_by, supplier_id, classification_status) VALUES ('d-spec', '${T}', 'Whole Milk spec', 'active', '${U}', '${S}', 'classified')`,
    `INSERT INTO document_requirements (id, document_id, requirement_id, status) VALUES ('dr-coi', 'd-coi', 'r-coi', 'confirmed')`,
    `INSERT INTO document_requirements (id, document_id, requirement_id, status) VALUES ('dr-spec', 'd-spec', 'r-spec', 'confirmed')`,
    `INSERT INTO document_products (id, document_id, product_id) VALUES ('dp-spec', 'd-spec', 'p-graph')`,

    // A customer with the contacts the order connector wrote.
    `INSERT INTO customers (id, tenant_id, customer_number, name, email) VALUES ('c-0135', '${T}', 'C-1', 'Blue Heron Foods', 'qa@blueheron.example')`,
    `INSERT INTO customer_contacts (id, customer_id, tenant_id, name, email, is_primary) VALUES ('cc-1', 'c-0135', '${T}', 'Quinn', 'qa@blueheron.example', 1)`,
    `INSERT INTO customer_contacts (id, customer_id, tenant_id, name, email, is_primary) VALUES ('cc-2', 'c-0135', '${T}', 'Buyer', 'buyer@blueheron.example', 0)`,
  ];
  await db.batch(stmts.map((s) => db.prepare(s)));

  gapsBefore = JSON.stringify(await gaps());
  await db.batch(splitStatements(m0135).map((s) => db.prepare(s)));
});

describe('0135 on a populated database', () => {
  it('every pair on file is approved as "initial", and nobody is said to have decided it', async () => {
    const rows = await all(
      `SELECT product_id, approval_status, approval_source, approval_decided_at, approval_decided_by, approval_note, facility_id
         FROM product_suppliers WHERE tenant_id = '${T}' ORDER BY product_id`,
    );
    expect(rows.map((r) => r.product_id)).toEqual(['p-both', 'p-gone', 'p-graph', 'p-legacy']);
    for (const r of rows) {
      expect(r).toMatchObject({
        approval_status: 'approved',
        approval_source: 'initial',
        approval_decided_at: null,
        approval_decided_by: null,
        approval_note: null,
        facility_id: null,
      });
    }
  });

  it('a legacy-only link gets ONE row to carry the approval, with no invented link source', async () => {
    const legacy = await all(`SELECT * FROM product_suppliers WHERE product_id = 'p-legacy'`);
    expect(legacy).toHaveLength(1);
    expect(legacy[0]).toMatchObject({ tenant_id: T, supplier_id: S, source: null, supplier_sku: null, discontinued_at: null });
    // The pair that had both paths is not duplicated, and keeps its id.
    expect(await all(`SELECT id FROM product_suppliers WHERE product_id = 'p-both'`)).toEqual([{ id: 'ps-both' }]);
    // A product with no supplier never becomes a pair.
    expect(await all(`SELECT id FROM product_suppliers WHERE product_id = 'p-none'`)).toEqual([]);
  });

  it('approval is separate from "currently supplied": existing link facts are untouched', async () => {
    expect(await db.prepare(`SELECT * FROM product_suppliers WHERE id = 'ps-gone'`).first<Row>()).toMatchObject({
      source: 'admin',
      discontinued_at: '2026-08-01 00:00:00',
      discontinued_by: U,
      approval_status: 'approved',
    });
    expect(await db.prepare(`SELECT * FROM product_suppliers WHERE id = 'ps-graph'`).first<Row>()).toMatchObject({
      source: 'import',
      supplier_sku: '30417',
      discontinued_at: null,
    });
  });

  it('THE GAP ENGINE ANSWERS THE SAME, to the byte', async () => {
    const after = JSON.stringify(await gaps());
    expect(after).toBe(gapsBefore);
    // And the answer is not vacuous: a closed supplier-scope requirement, a
    // per-product one closed for one product and open for the others.
    const gap = JSON.parse(after)[0];
    expect(JSON.stringify(gap)).toContain('Half and Half');
    expect(JSON.stringify(gap)).toContain('Whole Milk');
  });

  it('a pair created after the migration starts pending, with no source', async () => {
    await db
      .prepare(`INSERT INTO products (id, tenant_id, name, slug) VALUES ('p-new', '${T}', 'New Item', 'new-0135')`)
      .run();
    await db
      .prepare(`INSERT INTO product_suppliers (id, tenant_id, product_id, supplier_id, source) VALUES ('ps-new', '${T}', 'p-new', '${S}', 'certificate')`)
      .run();
    expect(
      await db.prepare(`SELECT approval_status, approval_source FROM product_suppliers WHERE id = 'ps-new'`).first<Row>(),
    ).toEqual({ approval_status: 'pending', approval_source: null });
  });

  it('the approval vocabulary is closed', async () => {
    await expect(
      db.prepare(`UPDATE product_suppliers SET approval_status = 'maybe' WHERE id = 'ps-graph'`).run(),
    ).rejects.toThrow();
  });

  it('running the backfill again changes nothing', async () => {
    await db.prepare(`UPDATE product_suppliers SET approval_status = 'not_approved', approval_source = 'person', approval_note = 'failed audit' WHERE id = 'ps-graph'`).run();
    const before = await all(`SELECT id, approval_status, approval_source FROM product_suppliers WHERE tenant_id = '${T}' ORDER BY id`);
    const backfill = splitStatements(m0135).filter(
      (s) => /^INSERT INTO product_suppliers/i.test(s.trim()) || /^UPDATE product_suppliers/i.test(s.trim()),
    );
    expect(backfill).toHaveLength(2);
    await db.batch(backfill.map((s) => db.prepare(s)));
    const after = await all(`SELECT id, approval_status, approval_source FROM product_suppliers WHERE tenant_id = '${T}' ORDER BY id`);
    // The person's decision stands, and the pending pair is NOT swept up into
    // "approved" by a second run -- only a row nobody has said anything about
    // (source NULL) is, which after the first run means a pair made since.
    expect(after.find((r) => r.id === 'ps-graph')).toEqual({ id: 'ps-graph', approval_status: 'not_approved', approval_source: 'person' });
    expect(after.filter((r) => r.id !== 'ps-new')).toEqual(before.filter((r) => r.id !== 'ps-new'));
  });

  it('existing (machine-read) customer contacts are NOT made COA recipients; facilities and item requirements hold their keys', async () => {
    expect(await all(`SELECT id, coa_recipient FROM customer_contacts WHERE customer_id = 'c-0135' ORDER BY id`)).toEqual([
      { id: 'cc-1', coa_recipient: 0 },
      { id: 'cc-2', coa_recipient: 0 },
    ]);

    await db.prepare(`INSERT INTO supplier_facilities (id, tenant_id, supplier_id, name, name_norm) VALUES ('f-1', '${T}', '${S}', 'Lynden Plant', 'lynden plant')`).run();
    await expect(
      db.prepare(`INSERT INTO supplier_facilities (id, tenant_id, supplier_id, name, name_norm) VALUES ('f-2', '${T}', '${S}', 'LYNDEN PLANT', 'lynden plant')`).run(),
    ).rejects.toThrow();
    // Removing a facility never removes the pair that named it.
    await db.prepare(`UPDATE product_suppliers SET facility_id = 'f-1' WHERE id = 'ps-both'`).run();
    await db.prepare(`DELETE FROM supplier_facilities WHERE id = 'f-1'`).run();
    expect(await db.prepare(`SELECT facility_id FROM product_suppliers WHERE id = 'ps-both'`).first<Row>()).toEqual({ facility_id: null });

    await db.prepare(`INSERT INTO customer_item_requirements (id, tenant_id, customer_id, product_id, delivery_contact_id) VALUES ('cir-1', '${T}', 'c-0135', 'p-graph', 'cc-2')`).run();
    expect(await db.prepare(`SELECT coa_required, source FROM customer_item_requirements WHERE id = 'cir-1'`).first<Row>()).toEqual({ coa_required: 'yes', source: null });
    await expect(
      db.prepare(`INSERT INTO customer_item_requirements (id, tenant_id, customer_id, product_id) VALUES ('cir-2', '${T}', 'c-0135', 'p-graph')`).run(),
    ).rejects.toThrow();
    await expect(
      db.prepare(`INSERT INTO customer_item_requirements (id, tenant_id, customer_id, product_id, coa_required) VALUES ('cir-3', '${T}', 'c-0135', 'p-both', 'sometimes')`).run(),
    ).rejects.toThrow();
    // A removed contact leaves the requirement, with no delivery contact.
    await db.prepare(`DELETE FROM customer_contacts WHERE id = 'cc-2'`).run();
    expect(await db.prepare(`SELECT delivery_contact_id FROM customer_item_requirements WHERE id = 'cir-1'`).first<Row>()).toEqual({ delivery_contact_id: null });
  });
});
