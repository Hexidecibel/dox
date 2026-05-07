/**
 * Integration tests for POST /api/documents/search/natural — FTS5
 * backed (Phase 4b of the Document Search v2 plan).
 *
 * The handler keeps the LLM-parsed structured query path; Phase 4b
 * swaps the SQL build to use `documents_fts MATCH` for
 * `parsed.keywords` + `parsed.content_search`. Structured filters
 * (doc_type slug, supplier name, products, expiration, metadata
 * json_extract) remain as AND predicates on the joined documents
 * table. Snippets come from FTS5 `snippet()` instead of the
 * hand-rolled `generateSnippets()` helper.
 *
 * The LLM call is intercepted via vi.stubGlobal('fetch', ...) so we
 * don't depend on a running Qwen — only requests to
 * `/v1/chat/completions` are mocked; everything else passes through.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { seedTestData, generateTestId } from '../helpers/db';
import { onRequestPost as naturalSearch } from '../../functions/api/documents/search/natural';

const db = env.DB;
let seed: Awaited<ReturnType<typeof seedTestData>>;

let supplierDarigoldId: string;
let supplierAcmeId: string;
let docTypeCoaId: string;
let docTypeSdsId: string;
let productButterId: string;
let docDarigoldCoaId: string; // tenant A — supplier Darigold5, doc_type COA, product Butter
let docAcmeSdsId: string;     // tenant A — supplier Acme5,    doc_type SDS, no products
let docCrossTenantId: string; // tenant B — supplier "Darigold5" too

function makeContext(
  body: Record<string, unknown>,
  user: { id: string; role: string; tenant_id: string | null },
): any {
  return {
    request: new Request('http://localhost/api/documents/search/natural', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    env,
    data: { user },
    params: {},
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
    functionPath: '/api/documents/search/natural',
  };
}

interface ParsedQuery {
  keywords: string[];
  document_type_slug: string | null;
  product_names: string[];
  supplier_name: string | null;
  date_from: string | null;
  date_to: string | null;
  metadata_filters: Array<{ field: string; operator: string; value: string }>;
  expiration_filter: { operator: string; date1: string; date2?: string } | null;
  content_search: string | null;
  intent_summary: string;
}

const DEFAULT_PARSED: ParsedQuery = {
  keywords: [],
  document_type_slug: null,
  product_names: [],
  supplier_name: null,
  date_from: null,
  date_to: null,
  metadata_filters: [],
  expiration_filter: null,
  content_search: null,
  intent_summary: 'test',
};

function installLlmMock(parsedResponse: ParsedQuery | Error) {
  const original = globalThis.fetch;
  const mock = async (input: any, init: any) => {
    const url = typeof input === 'string'
      ? input
      : (input instanceof URL ? input.toString() : (input as Request).url);
    if (url.includes('/v1/chat/completions')) {
      if (parsedResponse instanceof Error) {
        // Throw to mimic a network failure / fetch rejection — this is
        // what the LLM module catches and re-throws as a "not reachable"
        // error, which the handler then surfaces as 503.
        throw parsedResponse;
      }
      const envelope = {
        choices: [{ message: { content: JSON.stringify(parsedResponse) } }],
      };
      return new Response(JSON.stringify(envelope), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return original.call(globalThis, input, init);
  };
  vi.stubGlobal('fetch', mock);
}

beforeAll(async () => {
  seed = await seedTestData(db);

  supplierDarigoldId = `srch4nat-supD-${generateTestId().slice(0, 8)}`;
  supplierAcmeId = `srch4nat-supA-${generateTestId().slice(0, 8)}`;
  docTypeCoaId = `srch4nat-dtC-${generateTestId().slice(0, 8)}`;
  docTypeSdsId = `srch4nat-dtS-${generateTestId().slice(0, 8)}`;
  productButterId = `srch4nat-prod-${generateTestId().slice(0, 8)}`;

  await db.prepare(
    `INSERT INTO suppliers (id, tenant_id, name, slug, active, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, datetime('now'), datetime('now'))`,
  ).bind(supplierDarigoldId, seed.tenantId, 'Darigold5', `darigold5-${supplierDarigoldId}`).run();
  await db.prepare(
    `INSERT INTO suppliers (id, tenant_id, name, slug, active, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, datetime('now'), datetime('now'))`,
  ).bind(supplierAcmeId, seed.tenantId, 'Acme5', `acme5-${supplierAcmeId}`).run();

  await db.prepare(
    `INSERT INTO document_types (id, tenant_id, name, slug, active, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, datetime('now'), datetime('now'))`,
  ).bind(docTypeCoaId, seed.tenantId, 'CoA5', `coa5-${docTypeCoaId.slice(-6)}`).run();
  await db.prepare(
    `INSERT INTO document_types (id, tenant_id, name, slug, active, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, datetime('now'), datetime('now'))`,
  ).bind(docTypeSdsId, seed.tenantId, 'Sds5', `sds5-${docTypeSdsId.slice(-6)}`).run();

  await db.prepare(
    `INSERT INTO products (id, tenant_id, name, slug, active, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, datetime('now'), datetime('now'))`,
  ).bind(productButterId, seed.tenantId, 'Butter5', `butter5-${productButterId.slice(-6)}`).run();

  docDarigoldCoaId = `srch4nat-docD-${generateTestId().slice(0, 8)}`;
  docAcmeSdsId = `srch4nat-docA-${generateTestId().slice(0, 8)}`;
  docCrossTenantId = `srch4nat-docX-${generateTestId().slice(0, 8)}`;

  await db.prepare(
    `INSERT INTO documents
       (id, tenant_id, title, tags, current_version, status, created_by,
        supplier_id, document_type_id, primary_metadata, created_at, updated_at)
     VALUES (?, ?, ?, '[]', 1, 'active', ?, ?, ?, ?, ?, ?)`,
  ).bind(
    docDarigoldCoaId,
    seed.tenantId,
    'Quarterly Darigold5 Report',
    seed.userId,
    supplierDarigoldId,
    docTypeCoaId,
    JSON.stringify({ lot_number: 'LOT-NAT-001' }),
    '2026-04-15T00:00:00Z',
    '2026-04-15T00:00:00Z',
  ).run();

  await db.prepare(
    `INSERT INTO documents
       (id, tenant_id, title, tags, current_version, status, created_by,
        supplier_id, document_type_id, primary_metadata, created_at, updated_at)
     VALUES (?, ?, ?, '[]', 1, 'active', ?, ?, ?, ?, ?, ?)`,
  ).bind(
    docAcmeSdsId,
    seed.tenantId,
    'Acme5 Safety Sheet',
    seed.userId,
    supplierAcmeId,
    docTypeSdsId,
    JSON.stringify({}),
    '2026-04-10T00:00:00Z',
    '2026-04-10T00:00:00Z',
  ).run();

  await db.prepare(
    `INSERT INTO documents
       (id, tenant_id, title, tags, current_version, status, created_by, primary_metadata, created_at, updated_at)
     VALUES (?, ?, ?, '[]', 1, 'active', ?, ?, datetime('now'), datetime('now'))`,
  ).bind(
    docCrossTenantId,
    seed.tenantId2,
    'Cross-tenant Darigold5 Doc',
    seed.orgAdmin2Id,
    '{}',
  ).run();

  // Versions for FTS coverage
  for (const [id, fileName, extracted] of [
    [docDarigoldCoaId, 'darigold5-coa.pdf', 'high coliform results detected during quarterly inspection'],
    [docAcmeSdsId, 'acme5-sds.pdf', null],
    [docCrossTenantId, 'cross.pdf', null],
  ] as const) {
    await db.prepare(
      `INSERT INTO document_versions (id, document_id, version_number, file_name, file_size, mime_type, r2_key, checksum, extracted_text, uploaded_by)
       VALUES (?, ?, 1, ?, 1024, 'application/pdf', ?, 'deadbeef', ?, ?)`,
    ).bind(generateTestId(), id, fileName, `tenant/${id}/1/${fileName}`, extracted, seed.userId).run();
  }

  // Link the Darigold COA to the Butter product
  await db.prepare(
    `INSERT INTO document_products (id, document_id, product_id, created_at, updated_at)
     VALUES (?, ?, ?, datetime('now'), datetime('now'))`,
  ).bind(generateTestId(), docDarigoldCoaId, productButterId).run();
}, 60_000);

beforeEach(() => {
  // Default mock: empty parsed response
  installLlmMock({ ...DEFAULT_PARSED });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('POST /api/documents/search/natural — FTS5', () => {
  const orgAdmin = {
    id: 'user-org-admin',
    role: 'org_admin',
    tenant_id: 'test-tenant-001',
  };

  it('rejects empty query with 400', async () => {
    const res = await naturalSearch(makeContext({ query: '' }, orgAdmin));
    expect(res.status).toBe(400);
  });

  it('returns parsed_query, results, total in the response shape', async () => {
    installLlmMock({
      ...DEFAULT_PARSED,
      keywords: ['darigold5'],
      intent_summary: 'docs from Darigold5',
    });
    const res = await naturalSearch(
      makeContext({ query: 'find darigold5 docs', tenant_id: seed.tenantId }, orgAdmin),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { parsed_query: any; results: any[]; total: number };
    expect(body).toHaveProperty('parsed_query');
    expect(body).toHaveProperty('results');
    expect(body).toHaveProperty('total');
    expect(Array.isArray(body.results)).toBe(true);
  });

  it('matches on supplier name via FTS (the "darigold" complaint)', async () => {
    installLlmMock({
      ...DEFAULT_PARSED,
      keywords: ['darigold5'],
      intent_summary: 'darigold5 lookups',
    });
    const res = await naturalSearch(
      makeContext({ query: 'darigold5', tenant_id: seed.tenantId }, orgAdmin),
    );
    const body = (await res.json()) as { results: Array<{ id: string }> };
    const ids = body.results.map((r) => r.id);
    expect(ids).toContain(docDarigoldCoaId);
  });

  it('respects tenant isolation (no cross-tenant matches)', async () => {
    installLlmMock({
      ...DEFAULT_PARSED,
      keywords: ['darigold5'],
      intent_summary: 'darigold5 lookups',
    });
    const res = await naturalSearch(
      makeContext({ query: 'darigold5', tenant_id: seed.tenantId }, orgAdmin),
    );
    const body = (await res.json()) as { results: Array<{ id: string }> };
    const ids = body.results.map((r) => r.id);
    expect(ids).not.toContain(docCrossTenantId);
  });

  it('applies document_type_slug filter as AND predicate', async () => {
    installLlmMock({
      ...DEFAULT_PARSED,
      document_type_slug: `coa5-${docTypeCoaId.slice(-6)}`,
      keywords: [],
      intent_summary: 'all CoA5 docs',
    });
    const res = await naturalSearch(
      makeContext({ query: 'coa5 only', tenant_id: seed.tenantId }, orgAdmin),
    );
    const body = (await res.json()) as { results: Array<{ id: string }> };
    const ids = body.results.map((r) => r.id);
    expect(ids).toContain(docDarigoldCoaId);
    expect(ids).not.toContain(docAcmeSdsId);
  });

  it('applies supplier_name filter (fuzzy supplier match still works)', async () => {
    installLlmMock({
      ...DEFAULT_PARSED,
      supplier_name: 'darigold5',
      intent_summary: 'darigold5 supplier docs',
    });
    const res = await naturalSearch(
      makeContext({ query: 'docs from darigold', tenant_id: seed.tenantId }, orgAdmin),
    );
    const body = (await res.json()) as { results: Array<{ id: string }> };
    const ids = body.results.map((r) => r.id);
    expect(ids).toContain(docDarigoldCoaId);
    expect(ids).not.toContain(docAcmeSdsId);
  });

  it('applies product_names filter via document_products', async () => {
    installLlmMock({
      ...DEFAULT_PARSED,
      product_names: ['butter5'],
      intent_summary: 'butter5 docs',
    });
    const res = await naturalSearch(
      makeContext({ query: 'butter products', tenant_id: seed.tenantId }, orgAdmin),
    );
    const body = (await res.json()) as { results: Array<{ id: string }> };
    const ids = body.results.map((r) => r.id);
    expect(ids).toContain(docDarigoldCoaId);
    expect(ids).not.toContain(docAcmeSdsId);
  });

  it('applies metadata_filters via json_extract', async () => {
    installLlmMock({
      ...DEFAULT_PARSED,
      metadata_filters: [
        { field: 'lot_number', operator: 'equals', value: 'LOT-NAT-001' },
      ],
      intent_summary: 'lot LOT-NAT-001',
    });
    const res = await naturalSearch(
      makeContext({ query: 'lot LOT-NAT-001', tenant_id: seed.tenantId }, orgAdmin),
    );
    const body = (await res.json()) as { results: Array<{ id: string }> };
    const ids = body.results.map((r) => r.id);
    expect(ids).toContain(docDarigoldCoaId);
    expect(ids).not.toContain(docAcmeSdsId);
  });

  it('applies content_search via FTS extracted_text column', async () => {
    installLlmMock({
      ...DEFAULT_PARSED,
      content_search: 'coliform',
      intent_summary: 'high coliform docs',
    });
    const res = await naturalSearch(
      makeContext({ query: 'high coliform results', tenant_id: seed.tenantId }, orgAdmin),
    );
    const body = (await res.json()) as { results: Array<{ id: string }> };
    const ids = body.results.map((r) => r.id);
    expect(ids).toContain(docDarigoldCoaId);
    expect(ids).not.toContain(docAcmeSdsId);
  });

  it('returns FTS5 snippets with <mark> tags (no hand-rolled generateSnippets)', async () => {
    installLlmMock({
      ...DEFAULT_PARSED,
      keywords: ['darigold5'],
      intent_summary: 'darigold5 docs',
    });
    const res = await naturalSearch(
      makeContext({ query: 'darigold5', tenant_id: seed.tenantId }, orgAdmin),
    );
    const body = (await res.json()) as { results: any[] };
    // At least one result should ship a snippet that contains <mark>.
    const hasMark = body.results.some(
      (d: any) => typeof d.snippet === 'string' && d.snippet.includes('<mark>'),
    );
    expect(hasMark).toBe(true);
  });

  it('gracefully degrades when LLM is unavailable (503)', async () => {
    installLlmMock(new Error('LLM down'));
    const res = await naturalSearch(
      makeContext({ query: 'find darigold5', tenant_id: seed.tenantId }, orgAdmin),
    );
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/Natural language parsing failed/);
  });
});
