/**
 * Requirement scope over D1 (migration 0123): the loader, the API surface and
 * the request composer's closure read.
 *
 * The arithmetic is unit-tested in tests/unit/requirementScopeGap.test.ts.
 * What is tested HERE is what SQL can get wrong: both supplier->product link
 * paths, inactive / discontinued products becoming caveats, product links
 * read through document_products, the scope PUT + its audit row + its
 * preview, the product_requirements guards, and the composer agreeing with
 * the gap report.
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { seedTestData, generateTestId } from '../helpers/db';
import { onRequestGet as gapsGet } from '../../functions/api/supplier-gaps/index';
import { onRequestPut as requirementPut } from '../../functions/api/requirements/[id]';
import { onRequestPost as requirementPost } from '../../functions/api/requirements/index';
import { onRequestGet as scopePreview } from '../../functions/api/requirements/[id]/scope-preview';
import {
  onRequestGet as prGet,
  onRequestPost as prPost,
} from '../../functions/api/product-requirements/index';
import {
  onRequestPut as prPut,
  onRequestDelete as prDelete,
} from '../../functions/api/product-requirements/[id]';
import { onRequestPut as supplierProductPut } from '../../functions/api/suppliers/[id]/products/[productId]';
import { onRequestGet as productsGet } from '../../functions/api/products/index';
import { loadClosures } from '../../functions/lib/document-requests';
import { linkProductToSupplier } from '../../functions/lib/entities/products';

const db = env.DB;
let seed: Awaited<ReturnType<typeof seedTestData>>;
let admin: { id: string; role: 'org_admin'; tenant_id: string };
let reader: { id: string; role: 'reader'; tenant_id: string };
let otherAdmin: { id: string; role: 'org_admin'; tenant_id: string };

let supplier: string;
let reqSpec: string;
let reqCoi: string;

const id = (p: string) => `${p}-${generateTestId()}`;

async function makeSupplier(name: string, tenantId = seed.tenantId): Promise<string> {
  const sid = id('sup');
  await db
    .prepare('INSERT INTO suppliers (id, tenant_id, name, slug) VALUES (?, ?, ?, ?)')
    .bind(sid, tenantId, name, `${name.toLowerCase().replace(/\W+/g, '-')}-${generateTestId()}`)
    .run();
  return sid;
}

async function makeRequirement(name: string, scope = 'supplier'): Promise<string> {
  const rid = id('req');
  await db
    .prepare('INSERT INTO requirements (id, tenant_id, slug, name, scope) VALUES (?, ?, ?, ?, ?)')
    .bind(rid, seed.tenantId, `${name.toLowerCase().replace(/\W+/g, '-')}-${generateTestId()}`, name, scope)
    .run();
  return rid;
}

async function makeProduct(
  name: string,
  opts: { legacySupplier?: string | null; active?: number } = {},
): Promise<string> {
  const pid = id('prod');
  await db
    .prepare('INSERT INTO products (id, tenant_id, name, slug, active, supplier_id) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(pid, seed.tenantId, name, `${name.toLowerCase().replace(/\W+/g, '-')}-${generateTestId()}`, opts.active ?? 1, opts.legacySupplier ?? null)
    .run();
  return pid;
}

async function linkM2M(productId: string, supplierId: string, source: string | null = 'admin') {
  await db
    .prepare('INSERT INTO product_suppliers (id, tenant_id, product_id, supplier_id, source) VALUES (?, ?, ?, ?, ?)')
    .bind(id('ps'), seed.tenantId, productId, supplierId, source)
    .run();
}

async function applies(supplierId: string, requirementId: string) {
  await db
    .prepare('INSERT INTO supplier_requirements (id, tenant_id, supplier_id, requirement_id, tier) VALUES (?, ?, ?, ?, ?)')
    .bind(id('sr'), seed.tenantId, supplierId, requirementId, 'required')
    .run();
}

async function makeDocument(supplierId: string, title: string): Promise<string> {
  const did = id('doc');
  await db
    .prepare(
      `INSERT INTO documents (id, tenant_id, title, current_version, status, created_by, supplier_id, classification_status)
       VALUES (?, ?, ?, 1, 'active', ?, ?, 'classified')`,
    )
    .bind(did, seed.tenantId, title, seed.userId, supplierId)
    .run();
  return did;
}

async function closes(documentId: string, requirementId: string) {
  await db
    .prepare(`INSERT INTO document_requirements (id, document_id, requirement_id, status) VALUES (?, ?, ?, 'confirmed')`)
    .bind(id('dr'), documentId, requirementId)
    .run();
}

async function linkDocProduct(documentId: string, productId: string) {
  await db
    .prepare('INSERT INTO document_products (id, document_id, product_id) VALUES (?, ?, ?)')
    .bind(id('dp'), documentId, productId)
    .run();
}

function ctx(url: string, user: unknown, opts: { method?: string; body?: unknown; params?: Record<string, string> } = {}) {
  return {
    request: new Request(`http://localhost${url}`, {
      method: opts.method ?? 'GET',
      headers: { 'Content-Type': 'application/json' },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    }),
    env,
    data: { user },
    params: opts.params ?? {},
  } as any;
}

async function gapFor(supplierId: string) {
  const res = await gapsGet(ctx(`/api/supplier-gaps?supplier_id=${supplierId}`, admin));
  const body = (await res.json()) as any;
  expect(body.gaps).toHaveLength(1);
  return body.gaps[0];
}

beforeAll(async () => {
  seed = await seedTestData(db);
  admin = { id: seed.orgAdminId, role: 'org_admin', tenant_id: seed.tenantId };
  reader = { id: seed.readerId, role: 'reader', tenant_id: seed.tenantId };
  otherAdmin = { id: seed.orgAdmin2Id, role: 'org_admin', tenant_id: seed.tenantId2 };
}, 30_000);

beforeEach(async () => {
  for (const t of [
    'product_requirements',
    'supplier_requirements',
    'document_requirements',
    'document_products',
    'documents',
    'product_suppliers',
    'products',
  ]) {
    await db.prepare(`DELETE FROM ${t}`).run();
  }
  supplier = await makeSupplier('Country Morning Farms');
  reqSpec = await makeRequirement('Specification Sheet', 'product');
  reqCoi = await makeRequirement('Certificate of Insurance');
});

describe('the loader: what an active product of S is', () => {
  it('reads BOTH link paths — product_suppliers and the legacy products.supplier_id', async () => {
    const m2m = await makeProduct('MS WHOLE 5 GL BAG');
    await linkM2M(m2m, supplier);
    await makeProduct('HEAVY CREAM TOTE', { legacySupplier: supplier });
    await applies(supplier, reqSpec);

    const gap = await gapFor(supplier);
    expect(gap.products.map((p: any) => p.name).sort()).toEqual(['HEAVY CREAM TOTE', 'MS WHOLE 5 GL BAG']);
    expect(gap.applicable[0].subjects_total).toBe(2);
    const legacy = gap.products.find((p: any) => p.name === 'HEAVY CREAM TOTE');
    expect(legacy.source).toBeNull();
  });

  it('inactive and discontinued products are named in a caveat, never silently dropped', async () => {
    const live = await makeProduct('MS WHOLE');
    await linkM2M(live, supplier);
    const inactive = await makeProduct('Milk - Whole', { active: 0 });
    await linkM2M(inactive, supplier);
    const gone = await makeProduct('Half-and-Half');
    await linkM2M(gone, supplier);
    await db
      .prepare(`UPDATE product_suppliers SET discontinued_at = datetime('now') WHERE product_id = ?`)
      .bind(gone)
      .run();
    await applies(supplier, reqSpec);

    const gap = await gapFor(supplier);
    expect(gap.products.map((p: any) => p.name)).toEqual(['MS WHOLE']);
    const caveat = gap.caveats.find((c: any) => c.code === 'products_excluded');
    expect(caveat.message).toContain('Milk - Whole (inactive)');
    expect(caveat.message).toContain('Half-and-Half (no longer supplied)');
  });

  it('a certificate-created product with no confirmed identifier is a possible duplicate', async () => {
    const certProduct = await makeProduct('Milk - Whole');
    await linkM2M(certProduct, supplier, 'certificate');
    await applies(supplier, reqSpec);
    const gap = await gapFor(supplier);
    expect(gap.products[0].possible_duplicate).toBe(true);
    expect(gap.caveats.map((c: any) => c.code)).toContain('possible_duplicate_products');

    await db
      .prepare(
        `INSERT INTO product_identifiers (id, tenant_id, product_id, kind, value, value_norm, confirmed, source)
         VALUES (?, ?, ?, 'our_sku', '0417', '0417', 1, 'reviewer')`,
      )
      .bind(id('pi'), seed.tenantId, certProduct)
      .run();
    const after = await gapFor(supplier);
    expect(after.products[0].possible_duplicate).toBe(false);
  });

  it('closes a pair through document_products; an unattributed spec sheet closes nothing', async () => {
    const milk = await makeProduct('MS WHOLE');
    const cream = await makeProduct('HEAVY CREAM');
    await linkM2M(milk, supplier);
    await linkM2M(cream, supplier);
    await applies(supplier, reqSpec);
    const linked = await makeDocument(supplier, 'Spec - Whole');
    await closes(linked, reqSpec);
    await linkDocProduct(linked, milk);
    const orphan = await makeDocument(supplier, 'Spec - unknown product');
    await closes(orphan, reqSpec);

    const gap = await gapFor(supplier);
    const item = gap.applicable.find((a: any) => a.requirement_id === reqSpec);
    expect(item.subjects_satisfied).toBe(1);
    expect(item.open_subjects.map((s: any) => s.name)).toEqual(['HEAVY CREAM']);
    expect(item.unattributed.map((d: any) => d.document_title)).toEqual(['Spec - unknown product']);
    expect(gap.status).toBe('open');
  });

  it('zero active products: open with no_products', async () => {
    await applies(supplier, reqSpec);
    const gap = await gapFor(supplier);
    expect(gap.applicable[0].gap_reason).toBe('no_products');
    expect(gap.status).toBe('open');
  });

  it('a supplier on supplier scope only is not judged per product', async () => {
    const milk = await makeProduct('MS WHOLE');
    await linkM2M(milk, supplier);
    await applies(supplier, reqCoi);
    const doc = await makeDocument(supplier, 'COI');
    await closes(doc, reqCoi);
    const gap = await gapFor(supplier);
    expect(gap.status).toBe('satisfied');
    expect(gap.products.map((p: any) => p.status)).toEqual(['not_checked']);
    expect(gap.caveats).toEqual([]);
    expect(gap.applicable[0].scope).toBeUndefined();
  });
});

describe('the request composer reads the same closures', () => {
  it('does not offer an unattributed document as closing a per-product ask', async () => {
    const milk = await makeProduct('MS WHOLE');
    await linkM2M(milk, supplier);
    const linked = await makeDocument(supplier, 'Spec - Whole');
    await closes(linked, reqSpec);
    await linkDocProduct(linked, milk);
    const orphan = await makeDocument(supplier, 'Spec - orphan');
    await closes(orphan, reqSpec);
    const coi = await makeDocument(supplier, 'COI');
    await closes(coi, reqCoi);

    const out = await loadClosures(db, seed.tenantId, supplier, [reqSpec, reqCoi]);
    expect(out.get(reqSpec)?.map((d) => d.document_title)).toEqual(['Spec - Whole']);
    expect(out.get(reqCoi)?.map((d) => d.document_title)).toEqual(['COI']);
  });
});

describe('scope on /api/requirements', () => {
  it('POST accepts a scope and validates it in code', async () => {
    const bad = await requirementPost(ctx('/api/requirements', admin, { method: 'POST', body: { name: 'X', scope: 'facility' } }));
    expect(bad.status).toBe(400);
    const res = await requirementPost(
      ctx('/api/requirements', admin, { method: 'POST', body: { name: `Ingredient Statement ${generateTestId()}`, scope: 'product' } }),
    );
    expect(res.status).toBe(201);
    expect(((await res.json()) as any).requirement.scope).toBe('product');
  });

  it('PUT changes scope and writes requirement.scope_changed with the previous value', async () => {
    const res = await requirementPut(
      ctx(`/api/requirements/${reqCoi}`, admin, { method: 'PUT', body: { scope: 'product' }, params: { id: reqCoi } }),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).requirement.scope).toBe('product');
    const audit = await db
      .prepare(`SELECT details FROM audit_log WHERE action = 'requirement.scope_changed' AND resource_id = ?`)
      .bind(reqCoi)
      .first<{ details: string }>();
    expect(JSON.parse(audit!.details)).toMatchObject({ from: 'supplier', to: 'product' });

    const bad = await requirementPut(
      ctx(`/api/requirements/${reqCoi}`, admin, { method: 'PUT', body: { scope: 'site' }, params: { id: reqCoi } }),
    );
    expect(bad.status).toBe(400);
  });

  it('the preview says what would change, and writes nothing', async () => {
    const milk = await makeProduct('MS WHOLE');
    const cream = await makeProduct('HEAVY CREAM');
    await linkM2M(milk, supplier);
    await linkM2M(cream, supplier);
    await applies(supplier, reqCoi);
    const doc = await makeDocument(supplier, 'COI');
    await closes(doc, reqCoi);

    const res = await scopePreview(
      ctx(`/api/requirements/${reqCoi}/scope-preview?scope=product`, admin, { params: { id: reqCoi } }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.suppliers_considered).toBe(1);
    expect(body.transitions).toEqual({ 'satisfied->open': 1 });
    expect(body.product_obligations).toBe(2);
    expect(body.unattributed_documents).toBe(1);
    const stored = await db.prepare('SELECT scope FROM requirements WHERE id = ?').bind(reqCoi).first<{ scope: string }>();
    expect(stored!.scope).toBe('supplier');

    const readerRes = await scopePreview(
      ctx(`/api/requirements/${reqCoi}/scope-preview?scope=product`, reader, { params: { id: reqCoi } }),
    );
    expect(readerRes.status).toBe(403);
  });
});

describe('/api/product-requirements', () => {
  let milk: string;
  beforeEach(async () => {
    milk = await makeProduct('MS WHOLE');
    await linkM2M(milk, supplier);
    await applies(supplier, reqSpec);
  });

  it('an exemption needs a reason, and moves the product out', async () => {
    const noReason = await prPost(
      ctx('/api/product-requirements', admin, {
        method: 'POST',
        body: { supplier_id: supplier, product_id: milk, requirement_id: reqSpec, mode: 'exempt' },
      }),
    );
    expect(noReason.status).toBe(400);

    const res = await prPost(
      ctx('/api/product-requirements', admin, {
        method: 'POST',
        body: { supplier_id: supplier, product_id: milk, requirement_id: reqSpec, mode: 'exempt', reason: 'packaging SKU' },
      }),
    );
    expect(res.status).toBe(201);
    const row = ((await res.json()) as any).product_requirement;
    expect(row.source).toBe('human');

    const gap = await gapFor(supplier);
    expect(gap.applicable[0].subjects_total).toBe(0);
    expect(gap.products[0].exempt[0].reason).toBe('packaging SKU');
    expect(gap.products[0].status).toBe('not_configured');

    const dup = await prPost(
      ctx('/api/product-requirements', admin, {
        method: 'POST',
        body: { supplier_id: supplier, product_id: milk, requirement_id: reqSpec, mode: 'add' },
      }),
    );
    expect(dup.status).toBe(409);

    const put = await prPut(ctx(`/api/product-requirements/${row.id}`, admin, { method: 'PUT', body: { mode: 'add' }, params: { id: row.id } }));
    expect(put.status).toBe(200);
    const del = await prDelete(ctx(`/api/product-requirements/${row.id}`, admin, { method: 'DELETE', params: { id: row.id } }));
    expect(del.status).toBe(200);
    const audits = await db
      .prepare(`SELECT action FROM audit_log WHERE resource_id = ? ORDER BY rowid`)
      .bind(row.id)
      .all<{ action: string }>();
    expect(audits.results.map((a) => a.action)).toEqual([
      'product_requirement.exempted',
      'product_requirement.updated',
      'product_requirement.removed',
    ]);
  });

  it('refuses a supplier-scope requirement, a product the supplier does not ship, and readers', async () => {
    const onSupplierScope = await prPost(
      ctx('/api/product-requirements', admin, {
        method: 'POST',
        body: { supplier_id: supplier, product_id: milk, requirement_id: reqCoi, mode: 'add' },
      }),
    );
    expect(onSupplierScope.status).toBe(400);

    const stranger = await makeProduct('Not theirs');
    const notShipped = await prPost(
      ctx('/api/product-requirements', admin, {
        method: 'POST',
        body: { supplier_id: supplier, product_id: stranger, requirement_id: reqSpec, mode: 'add' },
      }),
    );
    expect(notShipped.status).toBe(400);

    const asReader = await prPost(
      ctx('/api/product-requirements', reader, {
        method: 'POST',
        body: { supplier_id: supplier, product_id: milk, requirement_id: reqSpec, mode: 'add' },
      }),
    );
    expect(asReader.status).toBe(403);
  });

  it("another tenant's row is a 404 and is not listed", async () => {
    const res = await prPost(
      ctx('/api/product-requirements', admin, {
        method: 'POST',
        body: { supplier_id: supplier, product_id: milk, requirement_id: reqSpec, mode: 'add' },
      }),
    );
    const row = ((await res.json()) as any).product_requirement;
    const del = await prDelete(ctx(`/api/product-requirements/${row.id}`, otherAdmin, { method: 'DELETE', params: { id: row.id } }));
    expect(del.status).toBe(404);
    const list = (await (await prGet(ctx('/api/product-requirements', otherAdmin))).json()) as any;
    expect(list.product_requirements).toEqual([]);
  });
});

describe('PUT /api/suppliers/:id/products/:productId', () => {
  it('marks a product no longer supplied, and back, with audit rows', async () => {
    const milk = await makeProduct('MS WHOLE');
    await linkM2M(milk, supplier);
    await applies(supplier, reqSpec);
    const put = (body: unknown, user: unknown = admin) =>
      supplierProductPut(
        ctx(`/api/suppliers/${supplier}/products/${milk}`, user, { method: 'PUT', body, params: { id: supplier, productId: milk } }),
      );

    expect((await put({ discontinued: true })).status).toBe(200);
    let gap = await gapFor(supplier);
    expect(gap.products).toEqual([]);
    expect(gap.caveats.find((c: any) => c.code === 'products_excluded').message).toContain('no longer supplied');

    expect((await put({ discontinued: false })).status).toBe(200);
    gap = await gapFor(supplier);
    expect(gap.products).toHaveLength(1);

    const actions = await db
      .prepare(`SELECT action FROM audit_log WHERE resource_id = ? AND action LIKE 'supplier_product.%' ORDER BY rowid`)
      .bind(supplier)
      .all<{ action: string }>();
    expect(actions.results.map((a) => a.action)).toEqual([
      'supplier_product.discontinued',
      'supplier_product.resupplied',
    ]);
    expect((await put({ discontinued: true }, reader)).status).toBe(403);
    expect((await put({ discontinued: true }, otherAdmin)).status).toBe(404);
  });

  it('declares nothing owed (reason required), creating a link row for a legacy-only product', async () => {
    const legacy = await makeProduct('LID 38MM', { legacySupplier: supplier });
    await applies(supplier, reqSpec);
    const put = (body: unknown) =>
      supplierProductPut(
        ctx(`/api/suppliers/${supplier}/products/${legacy}`, admin, { method: 'PUT', body, params: { id: supplier, productId: legacy } }),
      );
    expect((await put({ nothing_owed_reason: '   ' })).status).toBe(400);
    const res = await put({ nothing_owed_reason: 'packaging component' });
    expect(res.status).toBe(200);
    const link = ((await res.json()) as any).link;
    expect(link.source).toBeNull();
    expect(link.nothing_owed_reason).toBe('packaging component');

    const gap = await gapFor(supplier);
    expect(gap.products[0].status).toBe('satisfied');
    expect(gap.products[0].nothing_owed.reason).toBe('packaging component');
    // The one product owes nothing, so the per-product requirement has no subject.
    expect(gap.applicable[0].gap_reason).toBe('no_products');

    const listed = (await (await productsGet(ctx(`/api/products?supplier_id=${supplier}`, admin))).json()) as any;
    expect(listed.products[0].link_nothing_owed_reason).toBe('packaging component');
  });
});

describe('source stamping on product_suppliers', () => {
  it('stamps a NEW link and never rewrites an existing one', async () => {
    const p = await makeProduct('MS WHOLE');
    await linkProductToSupplier(db, seed.tenantId, p, supplier, { source: 'certificate' });
    await linkProductToSupplier(db, seed.tenantId, p, supplier, { source: 'admin' });
    const row = await db
      .prepare('SELECT source FROM product_suppliers WHERE product_id = ? AND supplier_id = ?')
      .bind(p, supplier)
      .first<{ source: string }>();
    expect(row!.source).toBe('certificate');
  });
});
