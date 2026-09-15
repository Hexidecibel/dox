/**
 * GET /api/suppliers/:id/product-identifiers — the supplier-side view of the
 * product identifier graph (0107 / 0113), replacing GET/PUT /api/product-map.
 * Writes go through the Product page's identifier endpoints: one API, two views.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { runMigrations, seedTestData, cleanTables, generateTestId } from '../helpers/db';
import { onRequestGet as getSupplierIdentifiers } from '../../functions/api/suppliers/[id]/product-identifiers';
import { onRequestPost as addIdentifier } from '../../functions/api/products/[id]/identifiers';
import { onRequestPut as updateIdentifier, onRequestDelete as removeIdentifier } from '../../functions/api/product-identifiers/[id]';
import { insertProductIdentifier } from '../../functions/lib/product-identifiers';
import type { SupplierProductIdentifiersResponse, SupplierProductResolveResponse } from '../../shared/types';

const db = env.DB;
let seed: Awaited<ReturnType<typeof seedTestData>>;

beforeEach(async () => {
  await runMigrations(db);
  await cleanTables(db);
  seed = await seedTestData(db);
}, 30_000);

type U = { id: string; role: string; tenant_id: string | null };
const orgAdmin = (): U => ({ id: seed.orgAdminId, role: 'org_admin', tenant_id: seed.tenantId });
const reader = (): U => ({ id: seed.readerId, role: 'reader', tenant_id: seed.tenantId });
const otherAdmin = (): U => ({ id: seed.orgAdmin2Id, role: 'org_admin', tenant_id: seed.tenantId2 });

function ctx(url: string, user: U, params: Record<string, string>, init?: RequestInit): any {
  return {
    request: new Request(`http://localhost${url}`, init),
    env,
    data: { user },
    params,
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
    functionPath: url,
  };
}

async function fixture() {
  const supplierId = generateTestId();
  await db.prepare('INSERT INTO suppliers (id, tenant_id, name, slug) VALUES (?, ?, ?, ?)')
    .bind(supplierId, seed.tenantId, 'Country Morning Farms', `cmf-${supplierId.slice(0, 6)}`).run();
  const mk = async (name: string) => {
    const id = generateTestId();
    await db.prepare('INSERT INTO products (id, tenant_id, name, slug, active) VALUES (?, ?, ?, ?, 1)')
      .bind(id, seed.tenantId, name, `p-${id.slice(0, 8)}`).run();
    return id;
  };
  const tote = await mk('40% CREAM 300GL');
  const bag = await mk('WHIP 5 GL BAG (1/CS), M');
  const add = (p: string, kind: 'supplier_item' | 'supplier_name' | 'our_sku' | 'pack', value: string, confirmed = true) =>
    insertProductIdentifier(db, seed.tenantId, p, {
      kind, value, supplier_id: kind.startsWith('supplier') ? supplierId : null, confirmed, source: 'seed',
    }, null);
  await add(tote, 'supplier_item', '30904');
  await add(tote, 'supplier_name', 'Cream - Heavy Whipping 40%');
  await add(tote, 'our_sku', '10286');
  await add(tote, 'pack', '300 Gallon Tote');
  await add(bag, 'supplier_name', 'Cream - Heavy Whipping 40%', false);
  await add(bag, 'our_sku', '0801');

  const doc = async (metadata: Record<string, unknown>) => {
    const id = generateTestId();
    await db.prepare(
      `INSERT INTO documents (id, tenant_id, title, tags, current_version, status, created_by, supplier_id, primary_metadata)
       VALUES (?, ?, ?, '[]', 1, 'active', ?, ?, ?)`,
    ).bind(id, seed.tenantId, `COA ${id.slice(0, 6)}`, seed.userId, supplierId, JSON.stringify(metadata)).run();
  };
  await doc({ product_name: 'Cream - Heavy Whipping 40%', product_code: '30904', net_weight: '300 Gallon Tote' });
  await doc({ product_name: 'Cream - Heavy Whipping 40%', product_code: '50903', net_weight: '5 Gallon Bag' });
  await doc({ product_name: 'Cream - Heavy Whipping 40%', product_code: '50903', net_weight: '5 Gallon Bag' });
  await doc({ product_name: 'Half-and-Half', product_code: '64917' });
  return { supplierId, tote, bag };
}

describe('GET /api/suppliers/:id/product-identifiers', () => {
  it("lists this supplier's identifiers with the product each names, and the certificate products not yet identified", async () => {
    const f = await fixture();
    const res = await getSupplierIdentifiers(ctx(`/api/suppliers/${f.supplierId}/product-identifiers`, reader(), { id: f.supplierId }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as SupplierProductIdentifiersResponse;

    expect(body.supplier.name).toBe('Country Morning Farms');
    // Only supplier-scoped kinds for THIS supplier; our_sku/pack ride along as columns.
    expect(body.identifiers.map((i) => [i.product_name, i.kind, i.value]).sort()).toEqual([
      ['40% CREAM 300GL', 'supplier_item', '30904'],
      ['40% CREAM 300GL', 'supplier_name', 'Cream - Heavy Whipping 40%'],
      ['WHIP 5 GL BAG (1/CS), M', 'supplier_name', 'Cream - Heavy Whipping 40%'],
    ]);
    const toteItem = body.identifiers.find((i) => i.value === '30904')!;
    expect(toteItem.product_our_skus).toEqual(['10286']);
    expect(toteItem.product_pack).toBe('300 gal tote');

    // 30904 resolves (confirmed) → not listed. 50903 is unknown and the name is
    // shared → listed with the reason. Half-and-Half is unknown → listed.
    const un = body.unidentified.map((u) => [u.product_name, u.supplier_item, u.document_count]);
    expect(un).toContainEqual(['Cream - Heavy Whipping 40%', '50903', 2]);
    expect(un).toContainEqual(['Half-and-Half', '64917', 1]);
    expect(un.some((u) => u[1] === '30904')).toBe(false);
    const bagRow = body.unidentified.find((u) => u.supplier_item === '50903')!;
    expect(bagRow.resolution.product_id).toBe(f.bag);
    expect(bagRow.resolution.confirmed).toBe(false);
    expect(bagRow.resolution.note).toMatch(/via unconfirmed identifier/);
  });

  it('resolves one certificate product the way matching does (prefill for the review control)', async () => {
    const f = await fixture();
    const url = (q: string) => `/api/suppliers/${f.supplierId}/product-identifiers?${q}`;
    const byItem = (await (await getSupplierIdentifiers(ctx(url('coa_product=Cream%20-%20Heavy%20Whipping%2040%25&item=30904'), orgAdmin(), { id: f.supplierId }))).json()) as SupplierProductResolveResponse;
    expect(byItem.resolution).toMatchObject({ product_id: f.tote, route: 'supplier_item', confirmed: true, our_skus: ['10286'] });

    const byName = (await (await getSupplierIdentifiers(ctx(url('coa_product=Cream%20-%20Heavy%20Whipping%2040%25'), orgAdmin(), { id: f.supplierId }))).json()) as SupplierProductResolveResponse;
    expect(byName.resolution.product_id).toBeNull();
    expect(byName.resolution.candidates).toHaveLength(2);
    expect(byName.resolution.note).toMatch(/no product is assumed/);
  });

  it("another tenant's supplier is indistinguishable from a missing one", async () => {
    const f = await fixture();
    const res = await getSupplierIdentifiers(ctx(`/api/suppliers/${f.supplierId}/product-identifiers`, otherAdmin(), { id: f.supplierId }));
    expect(res.status).toBe(404);
  });

  it('writes go through the Product page endpoints with their permissions: add, confirm, remove, each audited', async () => {
    const f = await fixture();
    const json = { 'Content-Type': 'application/json' };

    // A reader cannot add.
    const denied = await addIdentifier(ctx(`/api/products/${f.bag}/identifiers`, reader(), { id: f.bag }, {
      method: 'POST', headers: json, body: JSON.stringify({ kind: 'supplier_item', value: '50903', supplier_id: f.supplierId }),
    }));
    expect(denied.status).toBe(403);

    // Another tenant's admin cannot attach to our product or our supplier.
    const cross = await addIdentifier(ctx(`/api/products/${f.bag}/identifiers`, otherAdmin(), { id: f.bag }, {
      method: 'POST', headers: json, body: JSON.stringify({ kind: 'supplier_item', value: '50903', supplier_id: f.supplierId }),
    }));
    expect(cross.status).toBe(404);

    const added = await addIdentifier(ctx(`/api/products/${f.bag}/identifiers`, orgAdmin(), { id: f.bag }, {
      method: 'POST', headers: json, body: JSON.stringify({ kind: 'supplier_item', value: '50903', supplier_id: f.supplierId }),
    }));
    expect(added.status).toBe(201);

    const list = (await (await getSupplierIdentifiers(ctx(`/api/suppliers/${f.supplierId}/product-identifiers`, orgAdmin(), { id: f.supplierId }))).json()) as SupplierProductIdentifiersResponse;
    expect(list.identifiers.some((i) => i.value === '50903' && i.product_id === f.bag)).toBe(true);
    // Once the bag's number is known, its certificates are identified (confirmed number).
    expect(list.unidentified.some((u) => u.supplier_item === '50903')).toBe(false);

    const unconfirmedName = list.identifiers.find((i) => i.product_id === f.bag && i.kind === 'supplier_name')!;
    const conf = await updateIdentifier(ctx(`/api/product-identifiers/${unconfirmedName.id}`, orgAdmin(), { id: unconfirmedName.id }, {
      method: 'PUT', headers: json, body: JSON.stringify({ confirmed: true }),
    }));
    expect(conf.status).toBe(200);
    const del = await removeIdentifier(ctx(`/api/product-identifiers/${unconfirmedName.id}`, orgAdmin(), { id: unconfirmedName.id }, { method: 'DELETE' }));
    expect(del.status).toBe(200);

    const audit = await db
      .prepare(`SELECT action FROM audit_log WHERE tenant_id = ? AND action LIKE 'product_identifier.%' ORDER BY id`)
      .bind(seed.tenantId)
      .all<{ action: string }>();
    expect((audit.results ?? []).map((a) => a.action)).toEqual([
      'product_identifier.added', 'product_identifier.confirmed', 'product_identifier.removed',
    ]);
  });
});
