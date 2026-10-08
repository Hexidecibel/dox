/**
 * A customer's contacts and COA requirements by item (migration 0135; decision
 * C-004), and what the order send does with them.
 *
 *   1. CONTACTS are a list a person keeps: one per address, one primary, each
 *      flagged as receiving COAs or not. Every change is audited.
 *   2. A REQUIREMENT is one row per customer and item: required yes / no / on
 *      request, what it must show, when, and to whom.
 *   3. THE ORDER REVIEW GAINS INFORMATION AND A WARNING, AND NOTHING ELSE. The
 *      address box is pre-filled with the customer's COA contacts (the
 *      customer's own address when there are none); each line shows the
 *      customer's requirement; a required item with no certificate on the
 *      order is a warning. The send is never blocked, the plan's fingerprint
 *      does not move, and a customer with nothing recorded previews exactly as
 *      it did before.
 */

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { seedTestData, generateTestId } from '../helpers/db';
import { fnContext, readJson } from '../helpers/requests';
import type { TestUser } from '../helpers/requests';
import {
  onRequestGet as contactsGet,
  onRequestPost as contactsPost,
} from '../../functions/api/customers/[id]/contacts/index';
import {
  onRequestPut as contactPut,
  onRequestDelete as contactDelete,
} from '../../functions/api/customers/[id]/contacts/[contactId]';
import {
  onRequestGet as requirementsGet,
  onRequestPost as requirementsPost,
} from '../../functions/api/customers/[id]/item-requirements/index';
import {
  onRequestPut as requirementPut,
  onRequestDelete as requirementDelete,
} from '../../functions/api/customers/[id]/item-requirements/[requirementId]';
import { onRequestPost as createOrder } from '../../functions/api/orders/index';
import { onRequestPost as addItems } from '../../functions/api/orders/[id]/items/index';
import { onRequestGet as sendPreview } from '../../functions/api/orders/[id]/send-preview';
import { onRequestPost as sendOrder } from '../../functions/api/orders/[id]/send';
import type {
  CustomerContactsResponse,
  CustomerItemRequirementsResponse,
  OrderSendPreview,
} from '../../shared/types';

const db = env.DB;
const files = env.FILES;
let seed: Awaited<ReturnType<typeof seedTestData>>;
let supplierId = '';
let coaTypeId = '';

const admin = (): TestUser => ({ id: seed.orgAdminId, email: 'orgadmin@test.com', name: 'Org Admin', role: 'org_admin', tenant_id: seed.tenantId });
const regular = (): TestUser => ({ id: seed.userId, email: 'user@test.com', name: 'Regular User', role: 'user', tenant_id: seed.tenantId });
const reader = (): TestUser => ({ id: seed.readerId, email: 'reader@test.com', name: 'Reader User', role: 'reader', tenant_id: seed.tenantId });
const foreignAdmin = (): TestUser => ({ id: seed.orgAdmin2Id, email: 'orgadmin2@test.com', name: 'Org Admin 2', role: 'org_admin', tenant_id: seed.tenantId2 });

async function call(
  fn: PagesFunction<any>,
  opts: { method?: string; body?: unknown; params?: Record<string, string>; as?: TestUser; envOverride?: Record<string, unknown> } = {},
): Promise<{ status: number; body: any }> {
  const ctx = fnContext('http://localhost/api/x', {
    method: opts.method ?? 'GET',
    ...(opts.body !== undefined
      ? { body: JSON.stringify(opts.body), headers: { 'Content-Type': 'application/json' } }
      : {}),
    user: opts.as ?? admin(),
    params: opts.params ?? {},
  }) as any;
  if (opts.envOverride) ctx.env = { ...env, ...opts.envOverride };
  const res = await fn(ctx);
  return { status: res.status, body: await readJson(res) };
}

async function makeCustomer(name: string, email: string | null = 'qa@blueheron.example', tenantId = seed.tenantId): Promise<string> {
  const id = generateTestId();
  await db
    .prepare(`INSERT INTO customers (id, tenant_id, customer_number, name, email) VALUES (?, ?, ?, ?, ?)`)
    .bind(id, tenantId, `C-${id.slice(0, 8)}`, name, email)
    .run();
  return id;
}

async function makeProduct(name: string, tenantId = seed.tenantId): Promise<string> {
  const id = generateTestId();
  await db
    .prepare(`INSERT INTO products (id, tenant_id, name, slug) VALUES (?, ?, ?, ?)`)
    .bind(id, tenantId, name, `p-${id.slice(0, 10)}`)
    .run();
  return id;
}

/** An approved document with a file and one lot row of `productId`. */
async function makeDocument(productId: string, lotNumber: string): Promise<string> {
  const id = generateTestId();
  await db
    .prepare(
      `INSERT INTO documents (id, tenant_id, title, tags, current_version, status, created_by, supplier_id, document_type_id)
       VALUES (?, ?, ?, '[]', 1, 'active', ?, ?, ?)`,
    )
    // TYPED as a certificate of analysis. A document with no type at all reads
    // "locked" under the sharing rule (migration 0137, C-038) and would not
    // leave on an order -- which is not what these tests are about.
    .bind(id, seed.tenantId, `COA ${id.slice(0, 5)}`, seed.orgAdminId, supplierId, coaTypeId)
    .run();
  const key = `docs/${id}/v1.pdf`;
  const body = `PDF-${id}`;
  await db
    .prepare(
      `INSERT INTO document_versions (id, document_id, version_number, file_name, file_size, mime_type, r2_key, uploaded_by)
       VALUES (?, ?, 1, 'coa.pdf', ?, 'application/pdf', ?, ?)`,
    )
    .bind(generateTestId(), id, body.length, key, seed.orgAdminId)
    .run();
  await files.put(key, new TextEncoder().encode(body));
  const lotId = generateTestId();
  await db
    .prepare(
      `INSERT INTO lots (id, tenant_id, supplier_id, product_id, lot_number, lot_key, sub_lot_code)
       VALUES (?, ?, ?, ?, ?, ?, '')`,
    )
    .bind(lotId, seed.tenantId, supplierId, productId, lotNumber, `${lotNumber}-${lotId.slice(0, 4)}`)
    .run();
  await db.prepare('INSERT INTO document_lots (id, document_id, lot_id) VALUES (?, ?, ?)').bind(generateTestId(), id, lotId).run();
  return id;
}

async function makeOrder(customerId: string): Promise<string> {
  const res = await call(createOrder, {
    method: 'POST',
    body: { order_number: `SO-${generateTestId().slice(0, 8)}`, customer_id: customerId },
    as: regular(),
  });
  expect(res.status).toBe(201);
  return res.body.order.id as string;
}

const pickDocs = (order: string, ids: string[]) =>
  call(addItems, { method: 'POST', body: { document_ids: ids }, params: { id: order }, as: regular() });
const typeLine = (order: string, item: Record<string, unknown>) =>
  call(addItems, { method: 'POST', body: { item }, params: { id: order }, as: regular() });

async function preview(order: string, as: TestUser = regular()): Promise<OrderSendPreview> {
  const res = await call(sendPreview, { params: { id: order }, as });
  expect(res.status).toBe(200);
  return res.body as OrderSendPreview;
}

function stubMail(): Array<{ to: string[] }> {
  const sent: Array<{ to: string[] }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).includes('resend.com')) sent.push(JSON.parse(String(init?.body)));
      return new Response('{}', { status: 200 });
    }),
  );
  return sent;
}

async function audits(action: string, customerId: string): Promise<any[]> {
  const res = await db
    .prepare('SELECT details FROM audit_log WHERE action = ? AND resource_id = ? ORDER BY rowid')
    .bind(action, customerId)
    .all<{ details: string }>();
  return (res.results ?? []).map((r) => JSON.parse(r.details));
}

const addContact = (customerId: string, body: unknown, as?: TestUser) =>
  call(contactsPost, { method: 'POST', body, params: { id: customerId }, as });
const addRequirement = (customerId: string, body: unknown, as?: TestUser) =>
  call(requirementsPost, { method: 'POST', body, params: { id: customerId }, as });

beforeAll(async () => {
  seed = await seedTestData(db);
  supplierId = generateTestId();
  await db
    .prepare('INSERT INTO suppliers (id, tenant_id, name, slug) VALUES (?, ?, ?, ?)')
    .bind(supplierId, seed.tenantId, 'Acme Creamery', `acme-${supplierId.slice(0, 6)}`)
    .run();
  coaTypeId = generateTestId();
  await db
    .prepare('INSERT INTO document_types (id, tenant_id, name, slug) VALUES (?, ?, ?, ?)')
    .bind(coaTypeId, seed.tenantId, 'Certificate of Analysis', `coa-${coaTypeId.slice(0, 6)}`)
    .run();
}, 30_000);

afterEach(async () => {
  vi.unstubAllGlobals();
  await db.prepare(`DELETE FROM rate_limits WHERE key LIKE 'order_send:%'`).run();
});

// ───────────────────────────────────────────────────────────────────────────
describe('/api/customers/:id/contacts', () => {
  it('the first contact is the primary and receives COAs; a second does not displace it', async () => {
    const c = await makeCustomer('Blue Heron Foods');
    const first = await addContact(c, { email: 'QA@BlueHeron.example', name: 'Quinn', role: 'QA' });
    expect(first.status).toBe(201);
    expect(first.body.contact).toMatchObject({
      email: 'QA@BlueHeron.example',
      name: 'Quinn',
      role: 'QA',
      is_primary: true,
      coa_recipient: true,
    });
    const second = await addContact(c, { email: 'buyer@blueheron.example', coa_recipient: false });
    expect(second.body.contact).toMatchObject({ is_primary: false, coa_recipient: false });

    const list = (await call(contactsGet, { params: { id: c }, as: reader() })).body as CustomerContactsResponse;
    expect(list.customer).toMatchObject({ name: 'Blue Heron Foods', email: 'qa@blueheron.example' });
    expect(list.contacts.map((x) => x.email)).toEqual(['QA@BlueHeron.example', 'buyer@blueheron.example']);
    expect((await audits('customer.contact_added', c)).map((a) => a.email)).toEqual([
      'QA@BlueHeron.example',
      'buyer@blueheron.example',
    ]);
  });

  it('one contact per address, however it is cased; a bad address is refused', async () => {
    const c = await makeCustomer('Blue Heron Foods');
    await addContact(c, { email: 'qa@blueheron.example' });
    const dup = await addContact(c, { email: 'QA@BLUEHERON.EXAMPLE' });
    expect(dup.status).toBe(409);
    expect((await addContact(c, { email: 'not-an-address' })).status).toBe(400);
    expect((await addContact(c, { name: 'No Address' })).status).toBe(400);
  });

  it('naming a new primary steps the previous one down; a no-op save audits nothing', async () => {
    const c = await makeCustomer('Blue Heron Foods');
    const a = (await addContact(c, { email: 'a@blueheron.example' })).body.contact;
    const b = (await addContact(c, { email: 'b@blueheron.example' })).body.contact;

    const put = (id: string, body: unknown) => call(contactPut, { method: 'PUT', body, params: { id: c, contactId: id } });
    expect((await put(b.id, { name: null })).status).toBe(200);
    expect(await audits('customer.contact_updated', c)).toHaveLength(0);

    const res = await put(b.id, { is_primary: true, coa_recipient: false, name: 'Bea' });
    const byId = Object.fromEntries((res.body.contacts as any[]).map((x) => [x.id, x]));
    expect(byId[a.id].is_primary).toBe(false);
    expect(byId[b.id]).toMatchObject({ is_primary: true, coa_recipient: false, name: 'Bea' });
    expect(await audits('customer.contact_updated', c)).toMatchObject([
      { previous: { is_primary: false, coa_recipient: true, name: null }, current: { is_primary: true, coa_recipient: false, name: 'Bea' } },
    ]);

    expect((await put(b.id, { email: 'a@blueheron.example' })).status).toBe(409);
  });

  it('writes are admin-only; another organization\'s customer is a 404', async () => {
    const c = await makeCustomer('Blue Heron Foods');
    expect((await addContact(c, { email: 'x@blueheron.example' }, regular())).status).toBe(403);
    expect((await addContact(c, { email: 'x@blueheron.example' }, reader())).status).toBe(403);
    expect((await addContact(c, { email: 'x@blueheron.example' }, foreignAdmin())).status).toBe(404);
    expect((await call(contactsGet, { params: { id: c }, as: foreignAdmin() })).status).toBe(404);
  });

  it('removing a contact leaves a requirement that named it, with no delivery contact, and says so', async () => {
    const c = await makeCustomer('Blue Heron Foods');
    const p = await makeProduct('Whole Milk');
    const contact = (await addContact(c, { email: 'docs@blueheron.example' })).body.contact;
    const req = (await addRequirement(c, { product_id: p, delivery_contact_id: contact.id })).body.requirement;

    const res = await call(contactDelete, { method: 'DELETE', params: { id: c, contactId: contact.id } });
    expect(res.status).toBe(200);
    expect(res.body.contacts).toEqual([]);
    const left = (await call(requirementsGet, { params: { id: c } })).body as CustomerItemRequirementsResponse;
    expect(left.requirements).toHaveLength(1);
    expect(left.requirements[0]).toMatchObject({ delivery_contact_id: null, delivery_contact: null });
    expect(await audits('customer.contact_removed', c)).toMatchObject([
      { removed: { email: 'docs@blueheron.example' }, cleared_delivery_contact_on: [req.id] },
    ]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('/api/customers/:id/item-requirements', () => {
  it('one row per customer and item, defaulting to required', async () => {
    const c = await makeCustomer('Blue Heron Foods');
    const milk = await makeProduct('Whole Milk');
    const contact = (await addContact(c, { email: 'docs@blueheron.example', name: 'Dee' })).body.contact;

    const res = await addRequirement(c, {
      product_id: milk,
      must_show: 'lot number and best-by date',
      timing: 'with the shipment',
      delivery_contact_id: contact.id,
      notes: 'Per their supplier manual',
    });
    expect(res.status).toBe(201);
    expect(res.body.requirement).toMatchObject({
      product_id: milk,
      product_name: 'Whole Milk',
      coa_required: 'yes',
      must_show: 'lot number and best-by date',
      timing: 'with the shipment',
      delivery_contact: { id: contact.id, name: 'Dee', email: 'docs@blueheron.example' },
      source: 'admin',
      notes: 'Per their supplier manual',
    });

    const dup = await addRequirement(c, { product_id: milk, coa_required: 'no' });
    expect(dup.status).toBe(409);
    expect(dup.body.error).toContain('Whole Milk');
    // The same item for another customer is its own row.
    const other = await makeCustomer('Cedar Bakery');
    expect((await addRequirement(other, { product_id: milk, coa_required: 'on_request' })).status).toBe(201);

    expect(await audits('customer.item_requirement_added', c)).toMatchObject([
      { product_id: milk, product_name: 'Whole Milk', coa_required: 'yes' },
    ]);
  });

  it('refuses what cannot mean one thing', async () => {
    const c = await makeCustomer('Blue Heron Foods');
    const other = await makeCustomer('Cedar Bakery');
    const milk = await makeProduct('Whole Milk');
    const foreignProduct = await makeProduct('Elsewhere Milk', seed.tenantId2);
    const otherContact = (await addContact(other, { email: 'x@cedar.example' })).body.contact;

    expect((await addRequirement(c, {})).status).toBe(400);
    expect((await addRequirement(c, { product_id: foreignProduct })).status).toBe(400);
    expect((await addRequirement(c, { product_id: milk, coa_required: 'sometimes' })).status).toBe(400);
    // A delivery contact must be THIS customer's.
    expect((await addRequirement(c, { product_id: milk, delivery_contact_id: otherContact.id })).status).toBe(400);
    expect((await addRequirement(c, { product_id: milk }, regular())).status).toBe(403);
    expect((await addRequirement(c, { product_id: milk }, foreignAdmin())).status).toBe(404);
  });

  it('edit and remove, audited with the previous value; the item itself cannot be swapped', async () => {
    const c = await makeCustomer('Blue Heron Foods');
    const milk = await makeProduct('Whole Milk');
    const cream = await makeProduct('Heavy Cream');
    const req = (await addRequirement(c, { product_id: milk })).body.requirement;
    const put = (body: unknown) => call(requirementPut, { method: 'PUT', body, params: { id: c, requirementId: req.id } });

    expect((await put({ product_id: cream })).status).toBe(400);
    expect((await put({ coa_required: 'yes' })).status).toBe(200);
    expect(await audits('customer.item_requirement_updated', c)).toHaveLength(0);

    const res = await put({ coa_required: 'on_request', must_show: 'micro results' });
    expect(res.body.requirement).toMatchObject({ coa_required: 'on_request', must_show: 'micro results' });
    expect(await audits('customer.item_requirement_updated', c)).toMatchObject([
      { previous: { coa_required: 'yes', must_show: null }, current: { coa_required: 'on_request', must_show: 'micro results' } },
    ]);

    const del = await call(requirementDelete, { method: 'DELETE', params: { id: c, requirementId: req.id } });
    expect(del.body.requirements).toEqual([]);
    expect(await audits('customer.item_requirement_removed', c)).toMatchObject([
      { removed: { requirement_id: req.id, product_name: 'Whole Milk', coa_required: 'on_request' } },
    ]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('the order review reads the customer\'s record', () => {
  it('a customer with nothing recorded previews exactly as before: its own address, no requirement, no new warning', async () => {
    const c = await makeCustomer('Plain Customer', 'orders@plain.example');
    const milk = await makeProduct('Whole Milk');
    const order = await makeOrder(c);
    await pickDocs(order, [await makeDocument(milk, 'L-100')]);

    const plan = await preview(order);
    expect(plan.recipient).toBe('orders@plain.example');
    expect(plan.recipients).toEqual(['orders@plain.example']);
    expect(plan.recipient_source).toBe('customer_email');
    expect(plan.recipients_over_cap).toBe(0);
    expect(plan.item_requirements).toEqual([]);
    expect(plan.warnings).toEqual([]);
    expect(plan.blocked).toBeNull();
  });

  it('recipients default to the COA contacts, primary first, then a delivery contact an item on the order names', async () => {
    const c = await makeCustomer('Blue Heron Foods', 'general@blueheron.example');
    const milk = await makeProduct('Whole Milk');
    const cream = await makeProduct('Heavy Cream');
    await addContact(c, { email: 'buyer@blueheron.example', is_primary: false });
    await addContact(c, { email: 'qa@blueheron.example', is_primary: true });
    await addContact(c, { email: 'accounts@blueheron.example', coa_recipient: false });
    const lab = (await addContact(c, { email: 'lab@blueheron.example', coa_recipient: false })).body.contact;
    const warehouse = (await addContact(c, { email: 'warehouse@blueheron.example', coa_recipient: false })).body.contact;
    await addRequirement(c, { product_id: milk, delivery_contact_id: lab.id });
    // An item that is NOT on this order: its delivery contact is not addressed.
    await addRequirement(c, { product_id: cream, delivery_contact_id: warehouse.id });

    const order = await makeOrder(c);
    await pickDocs(order, [await makeDocument(milk, 'L-200')]);
    const plan = await preview(order);

    expect(plan.recipients).toEqual(['qa@blueheron.example', 'buyer@blueheron.example', 'lab@blueheron.example']);
    expect(plan.recipient_source).toBe('coa_contacts');
    // The customer's own address is still reported, and is not silently added.
    expect(plan.recipient).toBe('general@blueheron.example');
  });

  it('more COA contacts than one send reaches: capped, and the number left off is said', async () => {
    const c = await makeCustomer('Many Contacts Co', null);
    for (let i = 0; i < 12; i++) await addContact(c, { email: `person${i}@many.example` });
    const milk = await makeProduct('Whole Milk');
    const order = await makeOrder(c);
    await pickDocs(order, [await makeDocument(milk, 'L-300')]);

    const plan = await preview(order);
    expect(plan.recipients).toHaveLength(10);
    expect(plan.recipients_over_cap).toBe(2);
    expect(plan.warnings.join(' ')).toMatch(/12 addresses.*at most 10.*2 were left off/);
    expect(plan.blocked).toBeNull();
  });

  it('each line shows the requirement; a required item with no certificate is a WARNING and never a block', async () => {
    const c = await makeCustomer('Blue Heron Foods');
    const milk = await makeProduct('Whole Milk');
    const cream = await makeProduct('Heavy Cream');
    const butter = await makeProduct('Butter');
    const salt = await makeProduct('Salt');
    await addRequirement(c, { product_id: milk, must_show: 'lot number and best-by date', timing: 'with the shipment' });
    await addRequirement(c, { product_id: cream });
    await addRequirement(c, { product_id: butter, coa_required: 'on_request' });

    const order = await makeOrder(c);
    await pickDocs(order, [await makeDocument(milk, 'L-400')]);
    await typeLine(order, { product_id: cream, product_name: 'Heavy Cream' });
    await typeLine(order, { product_id: butter, product_name: 'Butter' });
    await typeLine(order, { product_id: salt, product_name: 'Salt' });

    const plan = await preview(order);
    const byName = Object.fromEntries(plan.item_requirements.map((r) => [r.product_name, r]));
    // Salt has no requirement on record: silence is not a requirement.
    expect(Object.keys(byName).sort()).toEqual(['Butter', 'Heavy Cream', 'Whole Milk']);
    expect(byName['Whole Milk']).toMatchObject({
      coa_required: 'yes',
      summary: 'COA required - must show lot number and best-by date - with the shipment',
      lot_label: 'L-400',
      document_on_line: true,
      missing: false,
    });
    expect(byName['Heavy Cream']).toMatchObject({ coa_required: 'yes', document_on_line: false, missing: true });
    // "On request" with nothing on the line is not a miss.
    expect(byName['Butter']).toMatchObject({ coa_required: 'on_request', summary: 'COA on request', missing: false });

    const warning = plan.warnings.find((w) => w.includes('requires a COA'));
    expect(warning).toContain('Heavy Cream');
    expect(warning).not.toContain('Butter');
    expect(warning).toMatch(/Nothing stops the send/);
    expect(plan.blocked).toBeNull();
  });

  it('the fingerprint covers what leaves, so recording a requirement or a contact does not invalidate a review', async () => {
    const c = await makeCustomer('Blue Heron Foods');
    const milk = await makeProduct('Whole Milk');
    const order = await makeOrder(c);
    await pickDocs(order, [await makeDocument(milk, 'L-500')]);
    const before = await preview(order);

    await addContact(c, { email: 'docs@blueheron.example' });
    await addRequirement(c, { product_id: milk, must_show: 'micro results' });
    const after = await preview(order);

    expect(after.fingerprint).toBe(before.fingerprint);
    expect(after.files).toEqual(before.files);
    expect(after.parts).toEqual(before.parts);
    expect(after.recipients).toEqual(['docs@blueheron.example']);
  });

  it('sends to the COA contacts when the sender leaves the box alone, to the typed addresses when they do not, and with a requirement unmet', async () => {
    const mail = stubMail();
    const c = await makeCustomer('Blue Heron Foods', 'general@blueheron.example');
    const milk = await makeProduct('Whole Milk');
    const cream = await makeProduct('Heavy Cream');
    await addContact(c, { email: 'qa@blueheron.example' });
    await addContact(c, { email: 'buyer@blueheron.example' });
    await addRequirement(c, { product_id: cream });

    const order = await makeOrder(c);
    await pickDocs(order, [await makeDocument(milk, 'L-600')]);
    await typeLine(order, { product_id: cream, product_name: 'Heavy Cream' });
    const plan = await preview(order);
    expect(plan.item_requirements.some((r) => r.missing)).toBe(true);

    const withKey = { RESEND_API_KEY: 're_test_key' };
    const first = await call(sendOrder, {
      method: 'POST',
      body: { fingerprint: plan.fingerprint },
      params: { id: order },
      as: regular(),
      envOverride: withKey,
    });
    // The unmet requirement did not stop it.
    expect(first.status).toBe(200);
    expect(first.body.send.recipients).toEqual(['qa@blueheron.example', 'buyer@blueheron.example']);
    expect(mail[0].to).toEqual(['qa@blueheron.example', 'buyer@blueheron.example']);

    const second = await call(sendOrder, {
      method: 'POST',
      body: { fingerprint: plan.fingerprint, recipients: ['only@blueheron.example'] },
      params: { id: order },
      as: regular(),
      envOverride: withKey,
    });
    expect(second.status).toBe(200);
    expect(second.body.send.recipients).toEqual(['only@blueheron.example']);
  });
});
