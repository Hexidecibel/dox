/**
 * Approved items and supplier facilities (migration 0135; decisions C-001 and
 * C-002). What is worth pinning is the set of rulings:
 *
 *   1. APPROVAL IS SEPARATE FROM "CURRENTLY SUPPLIED". Either can change
 *      without the other, and the list returns both.
 *   2. A NEW PAIR STARTS PENDING; `not_approved` NEEDS A NOTE; every decision
 *      is audited with who, and what it replaced.
 *   3. THE SUPPLIER LIST SETS APPROVAL AND NEVER OVERRIDES A PERSON. A dry run
 *      reports what would change and writes nothing.
 *   4. A FACILITY IS ADDED BY A PERSON. One per name under a supplier; removing
 *      one never removes the item that named it; a merge keeps which plant an
 *      item comes from.
 *   5. `private_label` IS A DISPLAY FLAG: brand owner and producer both
 *      recorded and different, ignoring case and spaces.
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { runMigrations, seedTestData, cleanTables, generateTestId } from '../helpers/db';
import { onRequestGet as approvedItemsGet } from '../../functions/api/approved-items/index';
import {
  onRequestGet as facilitiesGet,
  onRequestPost as facilitiesPost,
} from '../../functions/api/suppliers/[id]/facilities/index';
import {
  onRequestPut as facilityPut,
  onRequestDelete as facilityDelete,
} from '../../functions/api/suppliers/[id]/facilities/[facilityId]';
import { onRequestPut as linkPut } from '../../functions/api/suppliers/[id]/products/[productId]';
import { onRequestGet as productsGet } from '../../functions/api/products/index';
import { onRequestPost as importPost } from '../../functions/api/supplier-list/import';
import { applyStarterPack } from '../../functions/lib/starter-packs';
import { getStarterPack } from '../../functions/lib/starterPacks.generated';
import { linkProductToSupplier } from '../../functions/lib/entities/products';
import { mergeSuppliers } from '../../functions/lib/suppliers';
import type { ApprovedItem, ApprovedItemsResponse, SupplierFacilitiesResponse } from '../../shared/types';

const db = env.DB;
let seed: Awaited<ReturnType<typeof seedTestData>>;
let supplierId: string;

type Actor = { id: string; role: string; tenant_id: string | null };
const admin = (): Actor => ({ id: seed.orgAdminId, role: 'org_admin', tenant_id: seed.tenantId });
const regular = (): Actor => ({ id: seed.userId, role: 'user', tenant_id: seed.tenantId });
const reader = (): Actor => ({ id: seed.readerId, role: 'reader', tenant_id: seed.tenantId });
const foreignAdmin = (): Actor => ({ id: seed.orgAdmin2Id, role: 'org_admin', tenant_id: seed.tenantId2 });

async function call(
  fn: PagesFunction<any>,
  opts: { method?: string; body?: unknown; params?: Record<string, string>; as?: Actor; query?: string } = {},
): Promise<{ status: number; body: any }> {
  const init: RequestInit = { method: opts.method ?? 'GET' };
  if (opts.body !== undefined) {
    init.body = JSON.stringify(opts.body);
    init.headers = { 'Content-Type': 'application/json' };
  }
  const res = await fn({
    request: new Request(`http://localhost/api/x${opts.query ? `?${opts.query}` : ''}`, init),
    env,
    data: { user: opts.as ?? admin() },
    params: opts.params ?? {},
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
  } as any);
  return { status: res.status, body: await res.json() };
}

async function makeSupplier(name: string, tenantId = seed.tenantId): Promise<string> {
  const id = `sup-${generateTestId()}`;
  await db
    .prepare('INSERT INTO suppliers (id, tenant_id, name, slug) VALUES (?, ?, ?, ?)')
    .bind(id, tenantId, name, `${name.toLowerCase().replace(/\W+/g, '-')}-${generateTestId()}`)
    .run();
  return id;
}

async function makeProduct(
  name: string,
  opts: { brandOwner?: string | null; producer?: string | null; legacySupplierId?: string | null; tenantId?: string } = {},
): Promise<string> {
  const id = `prod-${generateTestId()}`;
  await db
    .prepare(
      `INSERT INTO products (id, tenant_id, name, slug, brand_owner, producer, supplier_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      opts.tenantId ?? seed.tenantId,
      name,
      `${name.toLowerCase().replace(/\W+/g, '-')}-${generateTestId()}`,
      opts.brandOwner ?? null,
      opts.producer ?? null,
      opts.legacySupplierId ?? null,
    )
    .run();
  return id;
}

/** A pair as it stood before 0135 ran: approved, and nobody decided it. */
async function linkOnFile(productId: string, supId = supplierId): Promise<void> {
  await linkProductToSupplier(db, seed.tenantId, productId, supId, { source: 'admin' });
  await db
    .prepare(
      `UPDATE product_suppliers SET approval_status = 'approved', approval_source = 'initial'
        WHERE product_id = ? AND supplier_id = ?`,
    )
    .bind(productId, supId)
    .run();
}

async function audits(action: string): Promise<any[]> {
  const res = await db
    .prepare('SELECT user_id, details FROM audit_log WHERE action = ? ORDER BY rowid')
    .bind(action)
    .all<{ user_id: string; details: string }>();
  return (res.results ?? []).map((r) => ({ user_id: r.user_id, ...JSON.parse(r.details) }));
}

const pair = (productId: string, supId = supplierId) =>
  db
    .prepare(
      `SELECT approval_status, approval_source, approval_note, approval_decided_by, approval_decided_at,
              facility_id, discontinued_at
         FROM product_suppliers WHERE product_id = ? AND supplier_id = ?`,
    )
    .bind(productId, supId)
    .first<Record<string, unknown>>();

const decide = (productId: string, body: unknown, as?: Actor, supId = supplierId) =>
  call(linkPut, { method: 'PUT', body, params: { id: supId, productId }, as });
const items = (query = '', as?: Actor) =>
  call(approvedItemsGet, { query, as }) as Promise<{ status: number; body: ApprovedItemsResponse }>;
const addFacility = (body: unknown, as?: Actor, supId = supplierId) =>
  call(facilitiesPost, { method: 'POST', body, params: { id: supId }, as });

beforeAll(async () => {
  await runMigrations(db);
}, 30_000);

beforeEach(async () => {
  // cleanTables clears products BEFORE product_suppliers, so a product that
  // has a pair survives it (the delete fails on the foreign key and is
  // swallowed). This file lists every pair in the tenant, so the pairs go
  // first.
  await db.prepare('DELETE FROM product_suppliers').run();
  await cleanTables(db);
  seed = await seedTestData(db);
  supplierId = await makeSupplier('Acme Creamery');
});

// ───────────────────────────────────────────────────────────────────────────
describe('approval on the item-and-supplier pair', () => {
  it('a new pair starts pending, with no source: nobody has said anything about it', async () => {
    const p = await makeProduct('Whole Milk');
    await linkProductToSupplier(db, seed.tenantId, p, supplierId, { source: 'certificate' });
    expect(await pair(p)).toMatchObject({ approval_status: 'pending', approval_source: null, approval_decided_by: null });
  });

  it('a person approves: stamped person, who and when, audited with what it replaced', async () => {
    const p = await makeProduct('Whole Milk');
    await linkProductToSupplier(db, seed.tenantId, p, supplierId, { source: 'certificate' });

    const res = await decide(p, { approval_status: 'approved' });
    expect(res.status).toBe(200);
    expect(res.body.link).toMatchObject({ approval_status: 'approved', approval_source: 'person', approval_decided_by: seed.orgAdminId });
    expect(res.body.link.approval_decided_at).toBeTruthy();

    const log = await audits('product_supplier.approval_decided');
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      user_id: seed.orgAdminId,
      product_id: p,
      product_name: 'Whole Milk',
      supplier_name: 'Acme Creamery',
      approval_status: 'approved',
      approval_source: 'person',
      previous: { approval_status: 'pending', approval_source: null },
    });
  });

  it('not approved needs a note, and a refused decision writes nothing', async () => {
    const p = await makeProduct('Whole Milk');
    await linkOnFile(p);

    const bare = await decide(p, { approval_status: 'not_approved', discontinued: true });
    expect(bare.status).toBe(400);
    expect(bare.body.error).toMatch(/note/i);
    // Refused BEFORE anything was applied: the other half of the request did not land either.
    expect(await pair(p)).toMatchObject({ approval_status: 'approved', approval_source: 'initial', discontinued_at: null });

    const blank = await decide(p, { approval_status: 'not_approved', approval_note: '   ' });
    expect(blank.status).toBe(400);

    const ok = await decide(p, { approval_status: 'not_approved', approval_note: 'Failed the 2026 audit' });
    expect(ok.status).toBe(200);
    expect(await pair(p)).toMatchObject({
      approval_status: 'not_approved',
      approval_source: 'person',
      approval_note: 'Failed the 2026 audit',
    });
    expect(await audits('product_supplier.approval_decided')).toHaveLength(1);

    expect((await decide(p, { approval_status: 'sort_of' })).status).toBe(400);
    expect((await decide(p, { approval_note: 'a note with no decision' })).status).toBe(400);
  });

  it('re-affirming an "initial" approval makes it a person\'s; saying the same thing twice writes nothing', async () => {
    const p = await makeProduct('Whole Milk');
    await linkOnFile(p);

    await decide(p, { approval_status: 'approved' });
    expect(await pair(p)).toMatchObject({ approval_status: 'approved', approval_source: 'person' });
    expect(await audits('product_supplier.approval_decided')).toHaveLength(1);

    await decide(p, { approval_status: 'approved' });
    expect(await audits('product_supplier.approval_decided')).toHaveLength(1);
  });

  it('APPROVAL IS NOT "SUPPLIED": each moves without the other', async () => {
    const p = await makeProduct('Whole Milk');
    await linkOnFile(p);

    await decide(p, { discontinued: true });
    expect(await pair(p)).toMatchObject({ approval_status: 'approved', approval_source: 'initial' });
    expect((await pair(p))!.discontinued_at).toBeTruthy();

    await decide(p, { approval_status: 'pending' });
    const row = await pair(p);
    expect(row).toMatchObject({ approval_status: 'pending', approval_source: 'person' });
    expect(row!.discontinued_at).toBeTruthy();

    const listed = (await items(`supplier_id=${supplierId}`)).body.items[0];
    expect(listed).toMatchObject({ approval_status: 'pending', supplied: false });
  });

  it('a legacy-only link is given a row to hold the decision', async () => {
    const p = await makeProduct('Half and Half', { legacySupplierId: supplierId });
    expect(await pair(p)).toBeNull();
    const res = await decide(p, { approval_status: 'approved' });
    expect(res.status).toBe(200);
    expect(await pair(p)).toMatchObject({ approval_status: 'approved', approval_source: 'person' });
  });

  it('only an admin decides; another organization\'s supplier is a 404', async () => {
    const p = await makeProduct('Whole Milk');
    await linkOnFile(p);
    expect((await decide(p, { approval_status: 'pending' }, regular())).status).toBe(403);
    expect((await decide(p, { approval_status: 'pending' }, reader())).status).toBe(403);
    expect((await decide(p, { approval_status: 'pending' }, foreignAdmin())).status).toBe(404);
    expect(await pair(p)).toMatchObject({ approval_status: 'approved', approval_source: 'initial' });
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('GET /api/approved-items', () => {
  let milk: string;
  let cream: string;
  let legacy: string;
  let otherSupplier: string;

  beforeEach(async () => {
    otherSupplier = await makeSupplier('Birch Dairy');
    milk = await makeProduct('Whole Milk', { brandOwner: 'Northwind Foods', producer: 'Acme Creamery' });
    cream = await makeProduct('Heavy Cream', { brandOwner: 'Acme  Creamery', producer: 'ACME CREAMERY' });
    legacy = await makeProduct('Half and Half', { legacySupplierId: otherSupplier });
    await linkOnFile(milk);
    await linkOnFile(milk, otherSupplier);
    await linkOnFile(cream);
    await db
      .prepare(
        `INSERT INTO product_identifiers (id, tenant_id, product_id, kind, value, value_norm, confirmed, source)
         VALUES (?, ?, ?, 'our_sku', '30417', '30417', 1, 'seed')`,
      )
      .bind(generateTestId(), seed.tenantId, milk)
      .run();
  });

  it('one row per pair, ordered by supplier then item, with the flat shape', async () => {
    const res = await items('', reader());
    expect(res.status).toBe(200);
    expect(res.body.items.map((i) => [i.supplier_name, i.product_name])).toEqual([
      ['Acme Creamery', 'Heavy Cream'],
      ['Acme Creamery', 'Whole Milk'],
      ['Birch Dairy', 'Half and Half'],
      ['Birch Dairy', 'Whole Milk'],
    ]);
    expect(res.body.total).toBe(4);
    expect(res.body.counts).toEqual({ approved: 3, pending: 1, not_approved: 0 });

    const row = res.body.items[1];
    const expected: ApprovedItem = {
      link_id: row.link_id,
      product_id: milk,
      product_name: 'Whole Milk',
      product_active: true,
      our_sku: '30417',
      supplier_id: supplierId,
      supplier_name: 'Acme Creamery',
      facility: null,
      approval_status: 'approved',
      approval_source: 'initial',
      approval_decided_at: null,
      approval_decided_by: null,
      approval_decided_by_name: null,
      approval_note: null,
      supplied: true,
      discontinued_at: null,
      link_source: 'admin',
      brand_owner: 'Northwind Foods',
      producer: 'Acme Creamery',
      plant_code: null,
      private_label: true,
    };
    expect(row).toEqual(expected);
    expect(row.link_id).toBeTruthy();
  });

  it('private label: both recorded and different, ignoring case and spaces', async () => {
    const byName = Object.fromEntries((await items(`supplier_id=${supplierId}`)).body.items.map((i) => [i.product_name, i]));
    expect(byName['Whole Milk'].private_label).toBe(true);
    // "Acme  Creamery" and "ACME CREAMERY" are one party.
    expect(byName['Heavy Cream'].private_label).toBe(false);
    // One of them missing is "not known", not private label.
    const half = (await items(`product_id=${legacy}`)).body.items[0];
    expect(half).toMatchObject({ brand_owner: null, producer: null, private_label: false });
  });

  it('a legacy-only pair made since is listed pending with no record, not left off', async () => {
    const row = (await items(`product_id=${legacy}`)).body.items[0];
    expect(row).toMatchObject({
      link_id: null,
      supplier_id: otherSupplier,
      approval_status: 'pending',
      approval_source: null,
      supplied: true,
      link_source: null,
    });
  });

  it('filters: supplier, approval, supplied, text; the counts ignore the approval filter', async () => {
    await decide(cream, { approval_status: 'not_approved', approval_note: 'Spec not met' });
    await decide(milk, { discontinued: true });

    const bySupplier = await items(`supplier_id=${supplierId}`);
    expect(bySupplier.body.items).toHaveLength(2);
    expect(bySupplier.body.counts).toEqual({ approved: 1, pending: 0, not_approved: 1 });

    const notApproved = await items(`supplier_id=${supplierId}&approval=not_approved`);
    expect(notApproved.body.items.map((i) => i.product_name)).toEqual(['Heavy Cream']);
    expect(notApproved.body.total).toBe(1);
    expect(notApproved.body.items[0]).toMatchObject({ approval_note: 'Spec not met', approval_decided_by_name: 'Org Admin' });
    // Tabs still count the rest of what was asked.
    expect(notApproved.body.counts).toEqual({ approved: 1, pending: 0, not_approved: 1 });

    expect((await items('supplied=0')).body.items.map((i) => [i.supplier_name, i.product_name])).toEqual([
      ['Acme Creamery', 'Whole Milk'],
    ]);
    expect((await items('supplied=1')).body.items).toHaveLength(3);

    // Text reaches the item, the supplier, the brand owner and an identifier.
    expect((await items('q=birch')).body.items).toHaveLength(2);
    expect((await items('q=northwind')).body.items.map((i) => i.product_name)).toEqual(['Whole Milk', 'Whole Milk']);
    expect((await items('q=30417')).body.items).toHaveLength(2);
    expect((await items('q=heavy')).body.items).toHaveLength(1);
    // A LIKE wildcard typed by a person is a character, not a pattern.
    expect((await items('q=%25')).body.items).toHaveLength(0);

    expect((await items('approval=sometimes')).status).toBe(400);
    expect((await items('supplied=yes')).status).toBe(400);
  });

  it('is scoped to the caller\'s organization', async () => {
    const res = await items('', foreignAdmin());
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
    expect(res.body.total).toBe(0);
  });

  it('the supplier\'s Products payload carries approval and facility for that supplier', async () => {
    const f = (await addFacility({ name: 'Lynden Plant', plant_code: '53-104' })).body.facility;
    await decide(milk, { facility_id: f.id });
    const res = await call(productsGet, { query: `supplier_id=${supplierId}` });
    const row = res.body.products.find((p: any) => p.id === milk);
    expect(row).toMatchObject({
      link_approval_status: 'approved',
      link_approval_source: 'initial',
      link_facility_id: f.id,
      link_facility_name: 'Lynden Plant',
    });
    // The other supplier's link to the same item is its own fact.
    const other = await call(productsGet, { query: `supplier_id=${otherSupplier}` });
    expect(other.body.products.find((p: any) => p.id === milk)).toMatchObject({ link_facility_id: null });
    // A legacy-only link has nothing recorded.
    expect(other.body.products.find((p: any) => p.id === legacy)).toMatchObject({ link_approval_status: null });
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('/api/suppliers/:id/facilities', () => {
  it('a person adds a facility; one per name under a supplier, however it is typed', async () => {
    const first = await addFacility({ name: 'Lynden Plant', plant_code: '53-104', notes: 'Fluid milk' });
    expect(first.status).toBe(201);
    expect(first.body.facility).toMatchObject({ name: 'Lynden Plant', plant_code: '53-104', notes: 'Fluid milk', active: true, item_count: 0 });

    const dup = await addFacility({ name: '  lynden   PLANT ' });
    expect(dup.status).toBe(409);
    expect(dup.body.error).toContain('Lynden Plant');

    expect((await addFacility({ name: '   ' })).status).toBe(400);
    // The same name under ANOTHER supplier is a different place.
    const other = await makeSupplier('Birch Dairy');
    expect((await addFacility({ name: 'Lynden Plant' }, undefined, other)).status).toBe(201);

    const list = (await call(facilitiesGet, { params: { id: supplierId }, as: reader() })).body as SupplierFacilitiesResponse;
    expect(list.facilities.map((f) => f.name)).toEqual(['Lynden Plant']);
    expect((await audits('supplier.facility_added')).map((a) => a.name)).toEqual(['Lynden Plant', 'Lynden Plant']);
  });

  it('writes are admin-only; another organization\'s supplier is a 404', async () => {
    expect((await addFacility({ name: 'X' }, regular())).status).toBe(403);
    expect((await addFacility({ name: 'X' }, reader())).status).toBe(403);
    expect((await addFacility({ name: 'X' }, foreignAdmin())).status).toBe(404);
    expect((await call(facilitiesGet, { params: { id: supplierId }, as: foreignAdmin() })).status).toBe(404);
  });

  it('an item names a facility of ITS supplier; a retired facility takes no new items', async () => {
    const p = await makeProduct('Whole Milk');
    const q = await makeProduct('Heavy Cream');
    await linkOnFile(p);
    await linkOnFile(q);
    const f = (await addFacility({ name: 'Lynden Plant' })).body.facility;
    const other = await makeSupplier('Birch Dairy');
    const foreign = (await addFacility({ name: 'Birch Plant' }, undefined, other)).body.facility;

    expect((await decide(p, { facility_id: foreign.id })).status).toBe(400);
    expect((await decide(p, { facility_id: 'no-such-facility' })).status).toBe(400);

    const set = await decide(p, { facility_id: f.id });
    expect(set.status).toBe(200);
    expect(set.body.link.facility_id).toBe(f.id);
    // Setting a facility decides nothing about approval.
    expect(await pair(p)).toMatchObject({ approval_status: 'approved', approval_source: 'initial', facility_id: f.id });
    expect(await audits('product_supplier.facility_set')).toMatchObject([
      { product_id: p, facility_id: f.id, facility_name: 'Lynden Plant', previous: { facility_id: null } },
    ]);
    expect((await items(`facility_id=${f.id}`)).body.items.map((i) => i.product_name)).toEqual(['Whole Milk']);
    expect((await items(`supplier_id=${supplierId}`)).body.items.find((i) => i.product_id === p)!.facility).toEqual({
      id: f.id,
      name: 'Lynden Plant',
      plant_code: null,
      active: true,
    });

    // Retire it: the item keeps it, a second item cannot take it.
    const retired = await call(facilityPut, { method: 'PUT', body: { active: false }, params: { id: supplierId, facilityId: f.id } });
    expect(retired.body.facility).toMatchObject({ active: false, item_count: 1 });
    expect((await decide(q, { facility_id: f.id })).status).toBe(400);
    expect((await pair(p))!.facility_id).toBe(f.id);

    // Clearing is "no facility recorded".
    await decide(p, { facility_id: null });
    expect((await pair(p))!.facility_id).toBeNull();
  });

  it('rename, and a save that changes nothing writes no audit row', async () => {
    const f = (await addFacility({ name: 'Lynden Plant' })).body.facility;
    await addFacility({ name: 'Sunnyside Plant' });
    const put = (body: unknown) => call(facilityPut, { method: 'PUT', body, params: { id: supplierId, facilityId: f.id } });

    expect((await put({ name: 'sunnyside plant' })).status).toBe(409);
    expect((await put({ name: 'Lynden Plant' })).status).toBe(200);
    expect(await audits('supplier.facility_updated')).toHaveLength(0);

    const renamed = await put({ name: 'Lynden North', plant_code: '53-104' });
    expect(renamed.body.facility).toMatchObject({ name: 'Lynden North', plant_code: '53-104' });
    expect(await audits('supplier.facility_updated')).toMatchObject([
      { previous: { name: 'Lynden Plant', plant_code: null }, current: { name: 'Lynden North', plant_code: '53-104' } },
    ]);
    // The old name is free again.
    expect((await addFacility({ name: 'Lynden Plant' })).status).toBe(201);
  });

  it('removing a facility never removes the item: it goes back to "no facility recorded", and the audit says which', async () => {
    const p = await makeProduct('Whole Milk');
    await linkOnFile(p);
    const f = (await addFacility({ name: 'Lynden Plant' })).body.facility;
    await decide(p, { facility_id: f.id });

    const res = await call(facilityDelete, { method: 'DELETE', params: { id: supplierId, facilityId: f.id } });
    expect(res.status).toBe(200);
    expect(res.body.cleared_items).toBe(1);
    expect(res.body.facilities).toEqual([]);
    expect(await pair(p)).toMatchObject({ facility_id: null, approval_status: 'approved' });
    expect(await audits('supplier.facility_removed')).toMatchObject([
      { removed: { facility_id: f.id, name: 'Lynden Plant' }, cleared_product_ids: [p] },
    ]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('a supplier merge keeps facilities and which plant an item comes from', () => {
  it('moves the loser\'s facilities; one both have is kept once and its items re-pointed', async () => {
    const winner = supplierId;
    const loser = await makeSupplier('Acme Creamery LLC');
    const wShared = (await addFacility({ name: 'Lynden Plant' }, undefined, winner)).body.facility;
    const lShared = (await addFacility({ name: 'LYNDEN  plant', plant_code: '53-104' }, undefined, loser)).body.facility;
    const lOnly = (await addFacility({ name: 'Sunnyside Plant' }, undefined, loser)).body.facility;

    const a = await makeProduct('Whole Milk');
    const b = await makeProduct('Heavy Cream');
    await linkOnFile(a, loser);
    await linkOnFile(b, loser);
    await decide(a, { facility_id: lShared.id }, undefined, loser);
    await decide(b, { facility_id: lOnly.id }, undefined, loser);
    await decide(b, { approval_status: 'not_approved', approval_note: 'On hold' }, undefined, loser);

    await mergeSuppliers(db, seed.tenantId, { winnerId: winner, loserIds: [loser], actor: { userId: seed.orgAdminId, ip: null } });

    const facilities = await db
      .prepare('SELECT id, name FROM supplier_facilities WHERE supplier_id = ? ORDER BY name')
      .bind(winner)
      .all<{ id: string; name: string }>();
    expect(facilities.results).toEqual([
      { id: wShared.id, name: 'Lynden Plant' },
      { id: lOnly.id, name: 'Sunnyside Plant' },
    ]);
    const left = await db.prepare('SELECT COUNT(*) AS n FROM supplier_facilities WHERE supplier_id = ?').bind(loser).first<{ n: number }>();
    expect(left?.n).toBe(0);

    // The items followed the supplier, each still naming its plant, and the
    // person's decision came with it.
    expect(await pair(a, winner)).toMatchObject({ facility_id: wShared.id, approval_status: 'approved' });
    expect(await pair(b, winner)).toMatchObject({
      facility_id: lOnly.id,
      approval_status: 'not_approved',
      approval_source: 'person',
      approval_note: 'On hold',
    });
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('the verified supplier list sets approval, and never overrides a person', () => {
  let milk: string;
  let cream: string;
  let butter: string;
  const post = (body: unknown) => call(importPost, { method: 'POST', body });
  const rows = [
    { supplier_name: 'Acme Creamery', supplier_category: 'ingredient', approved: 'Y', product_name: 'Whole Milk' },
    { supplier_name: 'Acme Creamery', supplier_category: 'ingredient', approved: 'N', product_name: 'Heavy Cream' },
    { supplier_name: 'Acme Creamery', supplier_category: 'ingredient', approved: 'Y', product_name: 'Butter' },
    { supplier_name: 'Acme Creamery', supplier_category: 'ingredient', approved: 'Y', product_name: 'Mystery Powder' },
  ];
  const byItem = (body: any) => Object.fromEntries(body.approvals.map((a: any) => [a.product_label, a]));

  beforeEach(async () => {
    await applyStarterPack(db, getStarterPack('fsqa')!, seed.tenantId, 'test-corp');
    milk = await makeProduct('Whole Milk');
    cream = await makeProduct('Heavy Cream');
    butter = await makeProduct('Butter');
    // Milk: on file since before approvals. Cream: a brand-new pair.
    // Butter: a person has said no.
    await linkOnFile(milk);
    await linkOnFile(butter);
    await decide(butter, { approval_status: 'not_approved', approval_note: 'Failed the 2026 audit' });
  });

  it('a dry run reports every outcome and writes nothing', async () => {
    const auditsBefore = (await audits('product_supplier.approval_decided')).length;
    const preview = await post({ rows, dry_run: true });
    expect(preview.status).toBe(200);
    const a = byItem(preview.body);

    expect(a['Whole Milk']).toMatchObject({ listed: 'approved', current: 'approved', current_source: 'initial', action: 'unchanged' });
    expect(a['Heavy Cream']).toMatchObject({ listed: 'not_approved', current: null, action: 'set', lines: [2] });
    expect(a['Butter']).toMatchObject({ listed: 'approved', current: 'not_approved', current_source: 'person', action: 'kept_person' });
    expect(a['Butter'].reason).toMatch(/does not override/);
    expect(a['Mystery Powder']).toMatchObject({ product_id: null, action: 'unresolved' });
    expect(a['Mystery Powder'].reason).toMatch(/approval was not recorded/);
    expect(preview.body.counts).toMatchObject({
      approvals_set: 1,
      approvals_unchanged: 1,
      approvals_kept_person_set: 1,
      approvals_unresolved: 1,
      approvals_conflicting: 0,
    });

    // Read-only: no pair made, nothing decided, nothing audited.
    expect(await pair(cream)).toBeNull();
    expect(await pair(milk)).toMatchObject({ approval_status: 'approved', approval_source: 'initial' });
    expect(await pair(butter)).toMatchObject({ approval_status: 'not_approved', approval_source: 'person' });
    expect((await audits('product_supplier.approval_decided')).length).toBe(auditsBefore);
  });

  it('apply writes exactly what the dry run reported', async () => {
    const preview = await post({ rows, dry_run: true });
    const applied = await post({ rows, dry_run: false, file_name: 'approved-list.csv' });
    expect(applied.status).toBe(201);
    expect(applied.body.approvals).toEqual(preview.body.approvals);

    expect(await pair(cream)).toMatchObject({
      approval_status: 'not_approved',
      approval_source: 'import',
      approval_decided_by: seed.orgAdminId,
    });
    expect((await pair(cream))!.approval_note).toMatch(/line 2: Approved = N/);
    // Unchanged is unchanged: still 'initial', not restamped as an import.
    expect(await pair(milk)).toMatchObject({ approval_status: 'approved', approval_source: 'initial', approval_decided_by: null });
    // The person's "no" stands against the list's "Y".
    expect(await pair(butter)).toMatchObject({
      approval_status: 'not_approved',
      approval_source: 'person',
      approval_note: 'Failed the 2026 audit',
    });

    const log = (await audits('product_supplier.approval_decided')).filter((a) => a.via === 'supplier_list_import');
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      product_id: cream,
      approval_status: 'not_approved',
      approval_source: 'import',
      run_id: applied.body.run_id,
      lines: [2],
      previous: { approval_status: 'pending', approval_source: null },
    });

    // The same list again changes nothing and audits nothing.
    const again = await post({ rows, dry_run: false });
    expect(again.body.counts).toMatchObject({ approvals_set: 0, approvals_unchanged: 2, approvals_kept_person_set: 1 });
    expect((await audits('product_supplier.approval_decided')).filter((a) => a.via === 'supplier_list_import')).toHaveLength(1);
  });

  it('the list can move an import or initial answer, and a later person decision is then protected', async () => {
    await post({ rows, dry_run: false });
    const flipped = rows.map((r) => (r.product_name === 'Whole Milk' ? { ...r, approved: 'N' } : r.product_name === 'Heavy Cream' ? { ...r, approved: 'Y' } : r));
    const res = await post({ rows: flipped, dry_run: false });
    expect(res.body.counts.approvals_set).toBe(2);
    expect(await pair(milk)).toMatchObject({ approval_status: 'not_approved', approval_source: 'import' });
    expect(await pair(cream)).toMatchObject({ approval_status: 'approved', approval_source: 'import' });

    await decide(milk, { approval_status: 'approved' });
    await post({ rows: flipped, dry_run: false });
    expect(await pair(milk)).toMatchObject({ approval_status: 'approved', approval_source: 'person' });
  });

  it('rows that disagree about one item change nothing, and say so', async () => {
    const conflicted = [
      { supplier_name: 'Acme Creamery', supplier_category: 'ingredient', approved: 'Y', product_name: 'Heavy Cream' },
      { supplier_name: 'Acme Creamery', supplier_category: 'ingredient', approved: 'N', product_name: 'Heavy Cream' },
    ];
    const res = await post({ rows: conflicted, dry_run: false });
    expect(byItem(res.body)['Heavy Cream']).toMatchObject({ action: 'conflict', listed: null, lines: [1, 2] });
    expect(res.body.counts.approvals_conflicting).toBe(1);
    // The pair was linked (the list says the supplier ships it) and left pending.
    expect(await pair(cream)).toMatchObject({ approval_status: 'pending', approval_source: null });
  });
});
