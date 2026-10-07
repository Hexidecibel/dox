/**
 * Search honours the module toggles.
 *
 * `/api/search*` belongs to no module -- it is how documents are found whatever
 * else is switched on -- so the middleware gate never looks at it. But it reads
 * the fulfillment module's records: the universal search returns orders and
 * customers, and the executor follows an order number, a customer's PO and a
 * customer to the certificates on their lines. A tenant that had switched
 * Orders off still found every order and customer by typing.
 *
 * What is pinned, through the real handlers:
 *   - with the module ON nothing moves (and no `modules_not_applied` key appears);
 *   - OFF FOR THE ORGANIZATION: no order or customer hit; an `order` / `customer`
 *     clause is not run and is named in `not_applied`; a typed order number is
 *     not read as an order; a customer's PO is not followed, while the PO a
 *     document prints itself still answers; every response says
 *     `modules_not_applied: ['fulfillment']`;
 *   - HIDDEN FROM THE PERSON'S DEPARTMENT is the same answer for that person
 *     and no change for a colleague;
 *   - a super_admin is never narrowed (module-access's own rule).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { onRequestPost as queryHandler } from '../../functions/api/search/query';
import { onRequestPost as interpretHandler } from '../../functions/api/search/interpret';
import { onRequestGet as universalHandler } from '../../functions/api/search/index';
import { onRequestGet as examplesHandler } from '../../functions/api/search/examples';
import { clearExamplesCache } from '../../functions/lib/search/examples';
import type { Clause, SearchQuery } from '../../shared/searchQuery';

const db = env.DB;

/** Three tenants with the same data: module on, module off, module on but hidden from one department. */
const ON = 'smt-on';
const OFF = 'smt-off';
const DEPT = 'smt-dept';

const ORDER_NUMBER = '1650438';
const CUSTOMER_PO = 'PO-70017';
const OWN_PO = 'B 220417';

const user = (tenant: string, id = `${tenant}-admin`, role = 'org_admin') => ({ id, role, tenant_id: tenant });

async function seedTenant(t: string) {
  await db.prepare(`INSERT OR IGNORE INTO tenants (id, name, slug, active) VALUES (?, ?, ?, 1)`).bind(t, `Tenant ${t}`, t).run();
  for (const [id, role] of [[`${t}-admin`, 'org_admin'], [`${t}-sales`, 'user']]) {
    await db.prepare(
      `INSERT OR IGNORE INTO users (id, email, name, role, tenant_id, password_hash, active, force_password_change)
       VALUES (?, ?, ?, ?, ?, 'x', 1, 0)`,
    ).bind(id, `${id}@test.com`, id, role, t).run();
  }
  await db.prepare(`INSERT INTO suppliers (id, tenant_id, name, slug, active) VALUES (?, ?, 'Northfield Creamery', ?, 1)`).bind(`${t}-sup`, t, `${t}-sup`).run();
  await db.prepare(`INSERT INTO document_types (id, tenant_id, name, slug, active) VALUES (?, ?, 'COA', 'coa', 1)`).bind(`${t}-dt`, t).run();

  const doc = async (id: string, metadata: Record<string, unknown>, lot: string, text: string) => {
    await db.prepare(
      `INSERT INTO documents (id, tenant_id, title, tags, current_version, status, created_by, supplier_id, document_type_id, primary_metadata, created_at, updated_at)
       VALUES (?, ?, ?, '[]', 1, 'active', ?, ?, ?, ?, '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z')`,
    ).bind(id, t, `Doc ${id}`, `${t}-admin`, `${t}-sup`, `${t}-dt`, JSON.stringify(metadata)).run();
    await db.prepare(
      `INSERT INTO document_versions (id, document_id, version_number, file_name, file_size, mime_type, r2_key, checksum, extracted_text, uploaded_by)
       VALUES (?, ?, 1, ?, 10, 'application/pdf', ?, 'x', ?, ?)`,
    ).bind(`${id}-v1`, id, `${id}.pdf`, `r2/${id}.pdf`, text, `${t}-admin`).run();
    await db.prepare(`INSERT INTO lots (id, tenant_id, supplier_id, lot_number, sub_lot_code, lot_key) VALUES (?, ?, ?, ?, '01', ?)`)
      .bind(`${id}-lot`, t, `${t}-sup`, lot, `${lot}01`).run();
    await db.prepare(`INSERT INTO document_lots (id, document_id, lot_id) VALUES (?, ?, ?)`).bind(`${id}-dl`, id, `${id}-lot`).run();
  };
  // Reached only through the order: a person accepted the lot match.
  await doc(`${t}-doc-order`, { lot_number: '20726114', sub_lot_code: '01' }, '20726114', 'Zebrafinch certificate');
  // Prints our own PO to the supplier: answers a PO search with no order involved.
  await doc(`${t}-doc-po`, { po_number: OWN_PO, lot_number: '20726115', sub_lot_code: '01' }, '20726115', `PO ${OWN_PO}`);

  await db.prepare(`INSERT INTO customers (id, tenant_id, customer_number, name, active) VALUES (?, ?, 'P00417', 'Zebrafinch Bakery', 1)`).bind(`${t}-cust`, t).run();
  await db.prepare(
    `INSERT INTO orders (id, tenant_id, order_number, po_number, customer_id, customer_name, status)
     VALUES (?, ?, ?, ?, ?, 'Zebrafinch Bakery', 'pending')`,
  ).bind(`${t}-order`, t, ORDER_NUMBER, CUSTOMER_PO, `${t}-cust`).run();
  await db.prepare(`INSERT INTO order_items (id, order_id, product_code, product_name, lot_number) VALUES (?, ?, '4410', 'BUTTER', '2072611401')`)
    .bind(`${t}-item`, `${t}-order`).run();
  await db.prepare(
    `INSERT INTO lot_match_suggestions (id, tenant_id, order_item_id, document_id, match_basis, match_confidence, status)
     VALUES (?, ?, ?, ?, 'lot_exact', 0.9, 'accepted')`,
  ).bind(`${t}-sugg`, t, `${t}-item`, `${t}-doc-order`).run();
}

beforeAll(async () => {
  for (const t of [ON, OFF, DEPT]) await seedTenant(t);
  // OFF: the organization switched Orders off.
  await db.prepare(`INSERT INTO tenant_modules (tenant_id, module_key, enabled) VALUES (?, 'fulfillment', 0)`).bind(OFF).run();
  // DEPT: on for the organization; the Sales department sees the library only.
  await db.prepare(`INSERT INTO owner_labels (tenant_id, owner_key, owner_label) VALUES (?, 'sales', 'Sales')`).bind(DEPT).run();
  await db.prepare(`INSERT INTO owner_routes (id, tenant_id, owner_key, owner_label, user_id, active) VALUES (?, ?, 'sales', 'Sales', ?, 1)`)
    .bind(`${DEPT}-route`, DEPT, `${DEPT}-sales`).run();
  await db.prepare(`INSERT INTO module_visibility (tenant_id, owner_key, module_key) VALUES (?, 'sales', 'library')`).bind(DEPT).run();
  clearExamplesCache();
}, 60_000);

function ctx(url: string, who: unknown, body?: unknown): any {
  return {
    request: new Request(url, body === undefined ? { method: 'GET' } : { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }),
    env, data: { user: who }, params: {},
    waitUntil: () => {}, passThroughOnException: () => {}, next: async () => new Response(null), functionPath: new URL(url).pathname,
  };
}

async function run(who: any, clauses: Clause[], text = '', interpret = false, tenantId?: string) {
  const query: SearchQuery = { v: 1, text, clauses, view: { entity: 'documents' } };
  const res = await queryHandler(ctx('http://localhost/api/search/query', who, { query, limit: 50, interpret, tenant_id: tenantId }));
  expect(res.status).toBe(200);
  return (await res.json()) as any;
}

async function universal(who: any, q: string, tenantId?: string) {
  const res = await universalHandler(ctx(`http://localhost/api/search?q=${encodeURIComponent(q)}${tenantId ? `&tenant_id=${tenantId}` : ''}`, who));
  expect(res.status).toBe(200);
  return (await res.json()) as any;
}

async function interpret(who: any, text: string) {
  const res = await interpretHandler(ctx('http://localhost/api/search/interpret', who, { text }));
  expect(res.status).toBe(200);
  return (await res.json()) as any;
}

const clause = (field: Clause['field'], value: string): Clause => ({ id: `c-${field}`, field, op: 'is', values: [value], source: 'builder' });
const covering = (body: any) => body.documents.filter((d: any) => d.match_status === 'covering').map((d: any) => d.id).sort();

describe('module ON: nothing moves', () => {
  const who = user(ON);

  it('an order number, a customer PO and a customer are followed to the certificate', async () => {
    for (const c of [clause('order', ORDER_NUMBER), clause('po', CUSTOMER_PO), clause('customer', `${ON}-cust`)]) {
      const body = await run(who, [c]);
      expect(covering(body), c.field).toEqual([`${ON}-doc-order`]);
      expect(body.not_applied, c.field).toBeUndefined();
      expect('modules_not_applied' in body, c.field).toBe(false);
    }
  });

  it('a typed order number is read as an order', async () => {
    const body = await run(who, [], ORDER_NUMBER, true);
    expect(body.interpreted.clauses.map((c: Clause) => c.field)).toContain('order');
    expect((await interpret(who, ORDER_NUMBER)).clauses.map((c: Clause) => c.field)).toContain('order');
  });

  it('the universal search returns the order and the customer', async () => {
    const body = await universal(who, 'Zebrafinch');
    expect(body.orders.total).toBe(1);
    expect(body.customers.total).toBe(1);
    expect('modules_not_applied' in body).toBe(false);
  });
});

function offBehaviour(label: string, who: any, tenant: string) {
  describe(label, () => {
    it('an order clause is not run, is named, and nothing is reached through the order', async () => {
      const body = await run(who, [clause('order', ORDER_NUMBER)]);
      expect(body.not_applied).toEqual(['c-order']);
      expect(body.modules_not_applied).toEqual(['fulfillment']);
      expect(covering(body)).toEqual([]);
      expect(JSON.stringify(body)).not.toContain('Zebrafinch Bakery');
    });

    it('a customer clause is not run and the customer is not named', async () => {
      const body = await run(who, [clause('customer', `${tenant}-cust`)]);
      expect(body.not_applied).toEqual(['c-customer']);
      expect(covering(body)).toEqual([]);
      expect(JSON.stringify(body.labels ?? {})).not.toContain('Zebrafinch');
    });

    it("a customer's PO is not followed: nothing on file covers it, and no order is mentioned", async () => {
      const body = await run(who, [clause('po', CUSTOMER_PO)]);
      expect(covering(body)).toEqual([]);
      expect(body.coverage).toBe('none');
      expect(body.not_applied).toBeUndefined();
      expect(body.modules_not_applied).toEqual(['fulfillment']);
      expect(JSON.stringify(body)).not.toContain(ORDER_NUMBER);
    });

    it('the PO a document prints itself still answers', async () => {
      const body = await run(who, [clause('po', OWN_PO)]);
      expect(covering(body)).toEqual([`${tenant}-doc-po`]);
    });

    it('a typed order number is not read as an order, in the executor or the reader', async () => {
      const body = await run(who, [], ORDER_NUMBER, true);
      expect((body.interpreted?.clauses ?? []).map((c: Clause) => c.field)).not.toContain('order');
      expect(covering(body)).toEqual([]);
      const read = await interpret(who, ORDER_NUMBER);
      expect(read.clauses.map((c: Clause) => c.field)).not.toContain('order');
      expect(read.modules_not_applied).toEqual(['fulfillment']);
    });

    it('the universal search returns no order and no customer, and says so', async () => {
      const body = await universal(who, 'Zebrafinch');
      expect(body.orders).toEqual({ total: 0, results: [] });
      expect(body.customers).toEqual({ total: 0, results: [] });
      expect(body.modules_not_applied).toEqual(['fulfillment']);
      // Documents are not the module's: the certificate is still found.
      expect(body.documents.results.map((d: any) => d.id)).toContain(`${tenant}-doc-order`);
    });

    it('an order number typed into the universal search is not followed either', async () => {
      const body = await universal(who, ORDER_NUMBER);
      expect((body.constraints ?? []).map((c: any) => c.kind)).not.toContain('order');
      expect(JSON.stringify(body)).not.toContain('Zebrafinch Bakery');
    });

    it('the examples are built without orders, and say so', async () => {
      const res = await examplesHandler(ctx('http://localhost/api/search/examples', who));
      expect(res.status).toBe(200);
      expect(((await res.json()) as any).modules_not_applied).toEqual(['fulfillment']);
    });
  });
}

offBehaviour('module OFF for the organization', user(OFF), OFF);
offBehaviour('module on, but hidden from this person\'s department', user(DEPT, `${DEPT}-sales`, 'user'), DEPT);

describe('who is NOT narrowed', () => {
  it('a colleague outside the scoped department, in the same organization', async () => {
    const body = await run(user(DEPT), [clause('order', ORDER_NUMBER)]);
    expect(covering(body)).toEqual([`${DEPT}-doc-order`]);
    expect('modules_not_applied' in body).toBe(false);
  });

  it('a super_admin, even inside an organization that switched the module off', async () => {
    const admin = { id: 'smt-super', role: 'super_admin', tenant_id: null };
    const body = await run(admin, [clause('order', ORDER_NUMBER)], '', false, OFF);
    expect(covering(body)).toEqual([`${OFF}-doc-order`]);
    expect('modules_not_applied' in body).toBe(false);
    expect((await universal(admin, 'Zebrafinch', OFF)).orders.total).toBe(1);
  });

  it('the examples of an organization with the module on carry no such note', async () => {
    const res = await examplesHandler(ctx('http://localhost/api/search/examples', user(ON)));
    expect('modules_not_applied' in ((await res.json()) as any)).toBe(false);
  });
});
