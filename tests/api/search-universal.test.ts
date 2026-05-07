/**
 * Integration tests for the NEW universal search endpoint —
 * GET /api/search (Phase 4d of the Document Search v2 plan).
 *
 * Plan ref: `/home/hexi/.claude/plans/peppy-coalescing-platypus.md` § 1.8.
 *
 * The endpoint fans out per-entity FTS scans via D1 batch() and returns
 * a grouped response:
 *
 *   {
 *     documents:  { total, results: [], facets? },
 *     suppliers:  { total, results: [] },
 *     products:   { total, results: [] },
 *     doc_types:  { total, results: [] },
 *     orders:     { total, results: [] },
 *     customers:  { total, results: [] },
 *     bundles:    { total, results: [] },
 *   }
 *
 * Documents block supports the same sort/facets params as
 * /api/documents/search (Phase 4a). All entities are top-N (default 5
 * for non-document entities, configurable via `limit_per_type`; 20 for
 * documents, with `limit` / `offset` for paging).
 *
 * Auth: any authenticated user. Tenant scoping mirrors the other
 * search endpoints — non-super_admin users are pinned to their tenant.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { seedTestData, generateTestId } from '../helpers/db';
import { onRequestGet as universalSearch } from '../../functions/api/search/index';

const db = env.DB;
let seed: Awaited<ReturnType<typeof seedTestData>>;

let supplierDarigoldId: string;
let productDarigoldButterId: string;
let customerDarigoldId: string;
let docTypeDarigoldId: string;
let bundleDarigoldId: string;
let orderDarigoldId: string;
let docDarigoldId: string;
let docCrossTenantId: string;

function makeContext(
  url: string,
  user: { id: string; role: string; tenant_id: string | null },
): any {
  return {
    request: new Request(url, { method: 'GET' }),
    env,
    data: { user },
    params: {},
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
    functionPath: '/api/search',
  };
}

async function searchAll(
  qs: string,
  user: { id: string; role: string; tenant_id: string | null },
) {
  const res = await universalSearch(makeContext(`http://localhost/api/search?${qs}`, user));
  return { status: res.status, body: (await res.json()) as any };
}

beforeAll(async () => {
  seed = await seedTestData(db);

  supplierDarigoldId = `srch4u-supD-${generateTestId().slice(0, 8)}`;
  productDarigoldButterId = `srch4u-prodD-${generateTestId().slice(0, 8)}`;
  customerDarigoldId = `srch4u-custD-${generateTestId().slice(0, 8)}`;
  docTypeDarigoldId = `srch4u-dtD-${generateTestId().slice(0, 8)}`;
  bundleDarigoldId = `srch4u-bunD-${generateTestId().slice(0, 8)}`;
  orderDarigoldId = `srch4u-ordD-${generateTestId().slice(0, 8)}`;
  docDarigoldId = `srch4u-docD-${generateTestId().slice(0, 8)}`;
  docCrossTenantId = `srch4u-docX-${generateTestId().slice(0, 8)}`;

  await db.prepare(
    `INSERT INTO suppliers (id, tenant_id, name, slug, active, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, datetime('now'), datetime('now'))`,
  ).bind(supplierDarigoldId, seed.tenantId, 'Darigold6', `darigold6-${supplierDarigoldId.slice(-6)}`).run();

  await db.prepare(
    `INSERT INTO products (id, tenant_id, name, slug, active, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, datetime('now'), datetime('now'))`,
  ).bind(productDarigoldButterId, seed.tenantId, 'Darigold6 Butter', `darigold6-butter-${productDarigoldButterId.slice(-6)}`).run();

  await db.prepare(
    `INSERT INTO customers (id, tenant_id, name, customer_number, created_at, updated_at)
     VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))`,
  ).bind(customerDarigoldId, seed.tenantId, 'Darigold6 Inc', `CUST-DAR-${customerDarigoldId.slice(-6)}`).run();

  await db.prepare(
    `INSERT INTO document_types (id, tenant_id, name, slug, active, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, datetime('now'), datetime('now'))`,
  ).bind(docTypeDarigoldId, seed.tenantId, 'Darigold6 Type', `dar6-type-${docTypeDarigoldId.slice(-6)}`).run();

  await db.prepare(
    `INSERT INTO document_bundles (id, tenant_id, name, description, status, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'draft', ?, datetime('now'), datetime('now'))`,
  ).bind(bundleDarigoldId, seed.tenantId, 'Darigold6 Compliance Pack', 'Bundle with darigold6 docs', seed.userId).run();

  await db.prepare(
    `INSERT INTO orders (id, tenant_id, order_number, customer_name, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'pending', datetime('now'), datetime('now'))`,
  ).bind(orderDarigoldId, seed.tenantId, `O-DAR-${orderDarigoldId.slice(-6)}`, 'Darigold6 Customer').run();

  // Doc whose title doesn't say "darigold6" — only its supplier link does.
  await db.prepare(
    `INSERT INTO documents (id, tenant_id, title, tags, current_version, status, created_by, supplier_id, created_at, updated_at)
     VALUES (?, ?, ?, '[]', 1, 'active', ?, ?, datetime('now'), datetime('now'))`,
  ).bind(docDarigoldId, seed.tenantId, 'Quarterly6 Report', seed.userId, supplierDarigoldId).run();

  await db.prepare(
    `INSERT INTO document_versions (id, document_id, version_number, file_name, file_size, mime_type, r2_key, checksum, uploaded_by)
     VALUES (?, ?, 1, ?, 1024, 'application/pdf', ?, 'deadbeef', ?)`,
  ).bind(generateTestId(), docDarigoldId, 'darigold6-q.pdf', `tenant/${docDarigoldId}/1/file.pdf`, seed.userId).run();

  // Cross-tenant doc with same word — must NOT appear for tenant A queries.
  await db.prepare(
    `INSERT INTO documents (id, tenant_id, title, tags, current_version, status, created_by, created_at, updated_at)
     VALUES (?, ?, ?, '[]', 1, 'active', ?, datetime('now'), datetime('now'))`,
  ).bind(docCrossTenantId, seed.tenantId2, 'Cross-tenant Darigold6 Doc', seed.orgAdmin2Id).run();

  await db.prepare(
    `INSERT INTO document_versions (id, document_id, version_number, file_name, file_size, mime_type, r2_key, checksum, uploaded_by)
     VALUES (?, ?, 1, ?, 1024, 'application/pdf', ?, 'deadbeef', ?)`,
  ).bind(generateTestId(), docCrossTenantId, 'cross.pdf', `tenant/${docCrossTenantId}/1/file.pdf`, seed.orgAdmin2Id).run();
}, 60_000);

describe('GET /api/search — universal', () => {
  const orgAdmin = {
    id: 'user-org-admin',
    role: 'org_admin',
    tenant_id: 'test-tenant-001',
  };
  const otherOrgAdmin = {
    id: 'user-org-admin-2',
    role: 'org_admin',
    tenant_id: 'test-tenant-002',
  };
  const superAdmin = {
    id: 'user-super-admin',
    role: 'super_admin',
    tenant_id: null,
  };

  describe('response shape', () => {
    it('returns the grouped { documents, suppliers, products, doc_types, orders, customers, bundles } shape', async () => {
      const { status, body } = await searchAll(
        `q=darigold6&tenant_id=${seed.tenantId}`,
        orgAdmin,
      );
      expect(status).toBe(200);
      for (const key of [
        'documents',
        'suppliers',
        'products',
        'doc_types',
        'orders',
        'customers',
        'bundles',
      ]) {
        expect(body).toHaveProperty(key);
        expect(body[key]).toHaveProperty('total');
        expect(body[key]).toHaveProperty('results');
        expect(typeof body[key].total).toBe('number');
        expect(Array.isArray(body[key].results)).toBe(true);
      }
    });
  });

  describe('per-entity matches for "darigold6"', () => {
    it('returns the supplier as a result', async () => {
      const { body } = await searchAll(`q=darigold6&tenant_id=${seed.tenantId}`, orgAdmin);
      const ids = body.suppliers.results.map((r: any) => r.id);
      expect(ids).toContain(supplierDarigoldId);
    });

    it('returns the matching docs (incl. those linked only via supplier)', async () => {
      const { body } = await searchAll(`q=darigold6&tenant_id=${seed.tenantId}`, orgAdmin);
      const ids = body.documents.results.map((r: any) => r.id);
      expect(ids).toContain(docDarigoldId);
    });

    it('returns matching products', async () => {
      const { body } = await searchAll(`q=darigold6&tenant_id=${seed.tenantId}`, orgAdmin);
      const ids = body.products.results.map((r: any) => r.id);
      expect(ids).toContain(productDarigoldButterId);
    });

    it('returns matching customers', async () => {
      const { body } = await searchAll(`q=darigold6&tenant_id=${seed.tenantId}`, orgAdmin);
      const ids = body.customers.results.map((r: any) => r.id);
      expect(ids).toContain(customerDarigoldId);
    });

    it('returns matching doc_types', async () => {
      const { body } = await searchAll(`q=darigold6&tenant_id=${seed.tenantId}`, orgAdmin);
      const ids = body.doc_types.results.map((r: any) => r.id);
      expect(ids).toContain(docTypeDarigoldId);
    });

    it('returns matching bundles', async () => {
      const { body } = await searchAll(`q=darigold6&tenant_id=${seed.tenantId}`, orgAdmin);
      const ids = body.bundles.results.map((r: any) => r.id);
      expect(ids).toContain(bundleDarigoldId);
    });

    it('returns matching orders', async () => {
      const { body } = await searchAll(`q=darigold6&tenant_id=${seed.tenantId}`, orgAdmin);
      const ids = body.orders.results.map((r: any) => r.id);
      expect(ids).toContain(orderDarigoldId);
    });
  });

  describe('tenant isolation', () => {
    it('does not return cross-tenant docs even for super_admin scoped to tenant A', async () => {
      const { body } = await searchAll(`q=darigold6&tenant_id=${seed.tenantId}`, superAdmin);
      const ids = body.documents.results.map((r: any) => r.id);
      expect(ids).not.toContain(docCrossTenantId);
    });

    it('non-super_admin is forced to their own tenant (cross-tenant param ignored)', async () => {
      const { body } = await searchAll(`q=darigold6&tenant_id=${seed.tenantId}`, otherOrgAdmin);
      // org_admin of tenant B should get tenant B's docs, not tenant A's
      const tenantADocs = body.documents.results.map((r: any) => r.id);
      expect(tenantADocs).not.toContain(docDarigoldId);
      expect(tenantADocs).toContain(docCrossTenantId);
    });
  });

  describe('paging + caps', () => {
    it('documents block accepts limit / offset', async () => {
      const { body } = await searchAll(
        `q=darigold6&tenant_id=${seed.tenantId}&limit=1`,
        orgAdmin,
      );
      expect(body.documents.results.length).toBeLessThanOrEqual(1);
    });

    it('non-document entities cap at top-N (default 5)', async () => {
      const { body } = await searchAll(`q=darigold6&tenant_id=${seed.tenantId}`, orgAdmin);
      for (const k of ['suppliers', 'products', 'doc_types', 'customers', 'bundles', 'orders'] as const) {
        expect(body[k].results.length).toBeLessThanOrEqual(5);
      }
    });
  });

  describe('empty / null query', () => {
    it('returns 200 with zero/empty per-entity blocks when q is empty', async () => {
      const { status, body } = await searchAll(`tenant_id=${seed.tenantId}`, orgAdmin);
      expect(status).toBe(200);
      // Every block must still exist with `total` and `results`.
      for (const k of ['documents', 'suppliers', 'products', 'doc_types', 'orders', 'customers', 'bundles']) {
        expect(body).toHaveProperty(k);
        expect(body[k]).toHaveProperty('total');
        expect(body[k]).toHaveProperty('results');
      }
    });
  });

  describe('auth', () => {
    it('returns 400 for super_admin with no tenant_id (no global universal scan in v1)', async () => {
      const { status } = await searchAll(`q=darigold6`, superAdmin);
      expect(status).toBe(400);
    });
  });
});
