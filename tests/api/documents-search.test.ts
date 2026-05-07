/**
 * Integration tests for GET /api/documents/search — FTS5 backed
 * (Phase 4a of the Document Search v2 plan).
 *
 * The handler used to do `LIKE '%term%'` over title / description /
 * tags / extracted_text / metadata. Phase 4a swaps the internals to
 * `documents_fts MATCH ?` against migration 0054's FTS5 backbone, while
 * preserving the existing query-string contract:
 *
 *   q                       — free-text search (FTS5 multi-token AND)
 *   tenant_id               — required for non-super_admin (taken from user)
 *   category                — `documents.category` literal match
 *   document_type_id        — `documents.document_type_id` literal match
 *   supplier_id             — `documents.supplier_id` literal match
 *   limit / offset          — paging, capped at 200 / unlimited
 *
 * Phase 4a additions:
 *   sort                    — relevance (default) | newest | oldest | name
 *   facets=1                — include faceted counts on the response
 *
 * The response shape stays `{ documents, total, limit, offset }` and now
 * also includes per-result `snippet` (FTS5 `snippet()` with `<mark>`)
 * and an optional top-level `facets` block when `facets=1` is passed.
 *
 * Drives onRequestGet directly — SELF.fetch isn't wired up in this
 * project's vitest-pool-workers config.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { seedTestData, generateTestId } from '../helpers/db';
import { onRequestGet as searchGet } from '../../functions/api/documents/search/index';

const db = env.DB;
let seed: Awaited<ReturnType<typeof seedTestData>>;

// The Phase 4 test bed — we keep it stable across describes by
// inserting once in a beforeAll. IDs use the `srch4-` prefix so they
// don't collide with the other suites running in the shared DB.
let supplierAId: string;
let supplierBId: string;
let supplierDarigoldId: string;
let docTypeCoaId: string;
let docTypeSdsId: string;
let docAId: string; // tenant A — title "Alpha COA Jan", supplier A, doc_type COA
let docBId: string; // tenant A — title "Alpha COA Feb", supplier A, doc_type SDS
let docCId: string; // tenant A — title "Beta COA Jan", supplier B, doc_type COA
let docDarigoldId: string; // tenant A — title "Quarterly Report", supplier "Darigold"
let docCrossTenantId: string; // tenant B — title "Darigold COA"

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
    functionPath: '/api/documents/search',
  };
}

async function search(
  qs: string,
  user: { id: string; role: string; tenant_id: string | null },
) {
  const res = await searchGet(makeContext(`http://localhost/api/documents/search?${qs}`, user));
  return { status: res.status, body: (await res.json()) as any };
}

beforeAll(async () => {
  seed = await seedTestData(db);

  supplierAId = `srch4-supA-${generateTestId().slice(0, 8)}`;
  supplierBId = `srch4-supB-${generateTestId().slice(0, 8)}`;
  supplierDarigoldId = `srch4-supD-${generateTestId().slice(0, 8)}`;
  docTypeCoaId = `srch4-dtC-${generateTestId().slice(0, 8)}`;
  docTypeSdsId = `srch4-dtS-${generateTestId().slice(0, 8)}`;

  await db
    .prepare(
      `INSERT INTO suppliers (id, tenant_id, name, slug, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, datetime('now'), datetime('now'))`,
    )
    .bind(supplierAId, seed.tenantId, 'Search4 Alpha Supplier', `srch4-alpha-${supplierAId}`)
    .run();
  await db
    .prepare(
      `INSERT INTO suppliers (id, tenant_id, name, slug, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, datetime('now'), datetime('now'))`,
    )
    .bind(supplierBId, seed.tenantId, 'Search4 Beta Supplier', `srch4-beta-${supplierBId}`)
    .run();
  await db
    .prepare(
      `INSERT INTO suppliers (id, tenant_id, name, slug, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, datetime('now'), datetime('now'))`,
    )
    .bind(supplierDarigoldId, seed.tenantId, 'Darigold4', `srch4-darigold-${supplierDarigoldId}`)
    .run();

  await db
    .prepare(
      `INSERT INTO document_types (id, tenant_id, name, slug, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, datetime('now'), datetime('now'))`,
    )
    .bind(docTypeCoaId, seed.tenantId, 'COA4', `coa4-${docTypeCoaId}`)
    .run();
  await db
    .prepare(
      `INSERT INTO document_types (id, tenant_id, name, slug, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, datetime('now'), datetime('now'))`,
    )
    .bind(docTypeSdsId, seed.tenantId, 'SDS4', `sds4-${docTypeSdsId}`)
    .run();

  docAId = `srch4-docA-${generateTestId().slice(0, 8)}`;
  docBId = `srch4-docB-${generateTestId().slice(0, 8)}`;
  docCId = `srch4-docC-${generateTestId().slice(0, 8)}`;
  docDarigoldId = `srch4-docD-${generateTestId().slice(0, 8)}`;
  docCrossTenantId = `srch4-docX-${generateTestId().slice(0, 8)}`;

  // Stagger created_at so sort=newest / sort=oldest are deterministic.
  // Tenant A docs:
  //   docA   (oldest)        – Alpha COA Jan
  //   docB                   – Alpha COA Feb
  //   docC                   – Beta  COA Jan
  //   docDarigold (newest)   – Quarterly Report (no "darigold" in title)
  for (const [docId, title, tags, supId, dtId, primaryMeta, createdAt] of [
    [docAId, 'Alpha4 COA Jan', '[]', supplierAId, docTypeCoaId,
      JSON.stringify({ lot_number: 'LOT-SRCH4-001' }), '2024-01-01T00:00:00Z'],
    [docBId, 'Alpha4 COA Feb', '[]', supplierAId, docTypeSdsId,
      JSON.stringify({ lot_number: 'LOT-SRCH4-002' }), '2024-02-01T00:00:00Z'],
    [docCId, 'Beta4 COA Jan', '[]', supplierBId, docTypeCoaId,
      JSON.stringify({ lot_number: 'LOT-SRCH4-003' }), '2024-03-01T00:00:00Z'],
    [docDarigoldId, 'Quarterly4 Report', '[]', supplierDarigoldId, docTypeCoaId,
      JSON.stringify({}), '2024-04-01T00:00:00Z'],
  ] as const) {
    await db
      .prepare(
        `INSERT INTO documents
           (id, tenant_id, title, tags, current_version, status, created_by,
            supplier_id, document_type_id, primary_metadata, created_at, updated_at)
         VALUES (?, ?, ?, ?, 1, 'active', ?, ?, ?, ?, ?, ?)`,
      )
      .bind(docId, seed.tenantId, title, tags, seed.userId, supId, dtId, primaryMeta, createdAt, createdAt)
      .run();
  }

  // Cross-tenant doc — same word ("darigold") appears in title to assert
  // the FTS query stays tenant-isolated.
  await db
    .prepare(
      `INSERT INTO documents
         (id, tenant_id, title, tags, current_version, status, created_by, primary_metadata, created_at, updated_at)
       VALUES (?, ?, ?, '[]', 1, 'active', ?, ?, datetime('now'), datetime('now'))`,
    )
    .bind(docCrossTenantId, seed.tenantId2, 'Darigold4 Cross-Tenant Doc', seed.orgAdmin2Id, '{}')
    .run();

  // Versions for every doc — supplies the file_name for FTS coverage.
  for (const [id, fileName] of [
    [docAId, 'alpha4-jan.pdf'],
    [docBId, 'alpha4-feb.pdf'],
    [docCId, 'beta4-jan.pdf'],
    [docDarigoldId, 'quarterly4.pdf'],
    [docCrossTenantId, 'cross-tenant.pdf'],
  ] as const) {
    await db
      .prepare(
        `INSERT INTO document_versions (id, document_id, version_number, file_name, file_size, mime_type, r2_key, checksum, uploaded_by)
         VALUES (?, ?, 1, ?, 1024, 'application/pdf', ?, 'deadbeef', ?)`,
      )
      .bind(generateTestId(), id, fileName, `tenant/${id}/1/${fileName}`, seed.userId)
      .run();
  }
}, 60_000);

describe('GET /api/documents/search — FTS5 backbone', () => {
  const superAdmin = {
    id: 'user-super-admin',
    role: 'super_admin',
    tenant_id: null,
  };

  describe('backwards-compat (existing query contract)', () => {
    it('returns the documents/total/limit/offset shape', async () => {
      const { status, body } = await search(
        `q=Alpha4&tenant_id=${seed.tenantId}`,
        superAdmin,
      );
      expect(status).toBe(200);
      expect(body).toHaveProperty('documents');
      expect(body).toHaveProperty('total');
      expect(body).toHaveProperty('limit');
      expect(body).toHaveProperty('offset');
      expect(Array.isArray(body.documents)).toBe(true);
      expect(typeof body.total).toBe('number');
    });

    it('matches on title substring (multi-token)', async () => {
      const { body } = await search(
        `q=Alpha4 COA&tenant_id=${seed.tenantId}`,
        superAdmin,
      );
      const ids = body.documents.map((d: { id: string }) => d.id);
      expect(ids).toContain(docAId);
      expect(ids).toContain(docBId);
      expect(ids).not.toContain(docCId);
    });

    it('matches on file_name', async () => {
      const { body } = await search(
        `q=alpha4-feb&tenant_id=${seed.tenantId}`,
        superAdmin,
      );
      const ids = body.documents.map((d: { id: string }) => d.id);
      expect(ids).toContain(docBId);
      expect(ids).not.toContain(docAId);
    });

    it('matches on primary_metadata lot number', async () => {
      const { body } = await search(
        `q=LOT-SRCH4-002&tenant_id=${seed.tenantId}`,
        superAdmin,
      );
      const ids = body.documents.map((d: { id: string }) => d.id);
      expect(ids).toEqual([docBId]);
    });

    it('supplier_id filter narrows the result set', async () => {
      const { body } = await search(
        `supplier_id=${supplierBId}&tenant_id=${seed.tenantId}`,
        superAdmin,
      );
      const ids = body.documents.map((d: { id: string }) => d.id);
      expect(ids).toContain(docCId);
      expect(ids).not.toContain(docAId);
      expect(ids).not.toContain(docBId);
    });

    it('document_type_id filter narrows the result set', async () => {
      const { body } = await search(
        `document_type_id=${docTypeSdsId}&tenant_id=${seed.tenantId}`,
        superAdmin,
      );
      const ids = body.documents.map((d: { id: string }) => d.id);
      expect(ids).toContain(docBId);
      expect(ids).not.toContain(docAId);
    });

    it('empty q with structured filters does not break (no MATCH applied)', async () => {
      const { status, body } = await search(
        `tenant_id=${seed.tenantId}&supplier_id=${supplierAId}`,
        superAdmin,
      );
      expect(status).toBe(200);
      const ids = body.documents.map((d: { id: string }) => d.id);
      expect(ids).toContain(docAId);
      expect(ids).toContain(docBId);
      expect(ids).not.toContain(docCId);
    });
  });

  describe('multi-token AND', () => {
    it('matches docs that contain BOTH tokens across the searched columns', async () => {
      const { body } = await search(
        `q=Alpha4 Feb&tenant_id=${seed.tenantId}`,
        superAdmin,
      );
      const ids = body.documents.map((d: { id: string }) => d.id);
      expect(ids).toContain(docBId);
      // docA has "Alpha4" but not "Feb"
      expect(ids).not.toContain(docAId);
      expect(ids).not.toContain(docCId);
    });

    it('does not match a doc that has only one of the tokens', async () => {
      const { body } = await search(
        `q=Alpha4 zzzthisneverappears&tenant_id=${seed.tenantId}`,
        superAdmin,
      );
      const ids = body.documents.map((d: { id: string }) => d.id);
      expect(ids).not.toContain(docAId);
      expect(ids).not.toContain(docBId);
    });
  });

  describe('supplier-name match (the "darigold" complaint)', () => {
    it('matches a doc by its linked supplier name even when the title does NOT contain it', async () => {
      const { body } = await search(
        `q=Darigold4&tenant_id=${seed.tenantId}`,
        superAdmin,
      );
      const ids = body.documents.map((d: { id: string }) => d.id);
      expect(ids).toContain(docDarigoldId);
    });
  });

  describe('tenant isolation', () => {
    it('does not return cross-tenant matches even for super_admin scoped to tenant A', async () => {
      const { body } = await search(
        `q=Darigold4&tenant_id=${seed.tenantId}`,
        superAdmin,
      );
      const ids = body.documents.map((d: { id: string }) => d.id);
      expect(ids).not.toContain(docCrossTenantId);
    });

    it('non-admin users are forced to their own tenant', async () => {
      const orgAdmin = {
        id: seed.orgAdminId,
        role: 'org_admin',
        tenant_id: seed.tenantId,
      };
      // tenantId2 is requested but the handler must overwrite with the user's tenant
      const { body } = await search(
        `q=Darigold4&tenant_id=${seed.tenantId2}`,
        orgAdmin,
      );
      const ids = body.documents.map((d: { id: string }) => d.id);
      expect(ids).not.toContain(docCrossTenantId);
      expect(ids).toContain(docDarigoldId);
    });
  });

  describe('sort param', () => {
    it('sort=newest orders by created_at DESC', async () => {
      const { body } = await search(
        `tenant_id=${seed.tenantId}&supplier_id=${supplierAId}&sort=newest`,
        superAdmin,
      );
      const ids = body.documents.map((d: { id: string }) => d.id);
      // docB (Feb) is newer than docA (Jan)
      expect(ids).toEqual([docBId, docAId]);
    });

    it('sort=oldest orders by created_at ASC', async () => {
      const { body } = await search(
        `tenant_id=${seed.tenantId}&supplier_id=${supplierAId}&sort=oldest`,
        superAdmin,
      );
      const ids = body.documents.map((d: { id: string }) => d.id);
      expect(ids).toEqual([docAId, docBId]);
    });

    it('sort=name orders by title ASC', async () => {
      const { body } = await search(
        `tenant_id=${seed.tenantId}&q=Alpha4&sort=name`,
        superAdmin,
      );
      const ids = body.documents.map((d: { id: string }) => d.id);
      // "Alpha4 COA Feb" < "Alpha4 COA Jan" alphabetically (F < J)
      expect(ids[0]).toBe(docBId);
      expect(ids[1]).toBe(docAId);
    });

    it('default sort (relevance) returns matches when q is provided', async () => {
      const { body } = await search(
        `tenant_id=${seed.tenantId}&q=Alpha4`,
        superAdmin,
      );
      const ids = body.documents.map((d: { id: string }) => d.id);
      expect(ids).toContain(docAId);
      expect(ids).toContain(docBId);
    });
  });

  describe('facets', () => {
    it('facets=1 returns a top-level facets block with per-facet arrays', async () => {
      const { status, body } = await search(
        `tenant_id=${seed.tenantId}&q=COA&facets=1`,
        superAdmin,
      );
      expect(status).toBe(200);
      expect(body).toHaveProperty('facets');
      expect(body.facets).toHaveProperty('supplier');
      expect(body.facets).toHaveProperty('doc_type');
      expect(body.facets).toHaveProperty('product');
      expect(body.facets).toHaveProperty('date_bucket');
      expect(Array.isArray(body.facets.supplier)).toBe(true);
    });

    it('each facet entry is { value, label, count }', async () => {
      const { body } = await search(
        `tenant_id=${seed.tenantId}&q=COA&facets=1`,
        superAdmin,
      );
      const supplierFacet = body.facets.supplier;
      expect(supplierFacet.length).toBeGreaterThan(0);
      for (const entry of supplierFacet) {
        expect(entry).toHaveProperty('value');
        expect(entry).toHaveProperty('label');
        expect(entry).toHaveProperty('count');
        expect(typeof entry.count).toBe('number');
      }
    });

    it('facet counts respect sticky-filter exclusion (supplier facet computed without supplier filter)', async () => {
      // Apply supplier_id filter; the SUPPLIER facet should still show
      // counts for *all* matching suppliers in the corpus (the filter
      // narrows the visible result list but not its own facet).
      const { body } = await search(
        `tenant_id=${seed.tenantId}&q=COA&supplier_id=${supplierAId}&facets=1`,
        superAdmin,
      );
      const supplierFacet = body.facets.supplier as Array<{ value: string; count: number }>;
      const supplierIds = supplierFacet.map((f) => f.value);
      // Supplier B's COA doc (docC) should still appear in the supplier
      // facet even though it's filtered OUT of the result set.
      expect(supplierIds).toContain(supplierAId);
      expect(supplierIds).toContain(supplierBId);
    });

    it('facets are NOT included by default', async () => {
      const { body } = await search(
        `tenant_id=${seed.tenantId}&q=COA`,
        superAdmin,
      );
      expect(body.facets).toBeUndefined();
    });
  });

  describe('FTS5 operator sanitization', () => {
    it('q=*"():- returns without SQL error', async () => {
      const { status } = await search(
        `q=${encodeURIComponent('*"():-')}&tenant_id=${seed.tenantId}`,
        superAdmin,
      );
      expect(status).toBe(200);
    });

    it('q=NEAR returns without SQL error (treated as literal)', async () => {
      const { status } = await search(
        `q=NEAR&tenant_id=${seed.tenantId}`,
        superAdmin,
      );
      expect(status).toBe(200);
    });

    it('q=foo OR bar returns without SQL error (treated as plain tokens)', async () => {
      const { status } = await search(
        `q=${encodeURIComponent('foo OR bar')}&tenant_id=${seed.tenantId}`,
        superAdmin,
      );
      expect(status).toBe(200);
    });
  });

  describe('snippets', () => {
    it('returns a snippet field with <mark> tags around matched text', async () => {
      const { body } = await search(
        `q=Alpha4&tenant_id=${seed.tenantId}`,
        superAdmin,
      );
      expect(body.documents.length).toBeGreaterThan(0);
      // At least one result should ship a snippet that contains <mark>.
      const hasMark = body.documents.some((d: { snippet?: string }) =>
        typeof d.snippet === 'string' && d.snippet.includes('<mark>'),
      );
      expect(hasMark).toBe(true);
    });

    it('does not include a snippet field when no q is provided', async () => {
      const { body } = await search(
        `tenant_id=${seed.tenantId}&supplier_id=${supplierAId}`,
        superAdmin,
      );
      // No-query mode falls back to listing; snippet may be null/empty
      // string but should not contain <mark> tags.
      for (const d of body.documents) {
        if (typeof d.snippet === 'string') {
          expect(d.snippet.includes('<mark>')).toBe(false);
        }
      }
    });
  });
});
