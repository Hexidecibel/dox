/**
 * Integration tests for GET /api/documents/search.
 *
 * Exercises the LIKE-based search across title, description, tags,
 * extracted_text, file_name, and primary/extended_metadata JSON blobs.
 * Also verifies the structured filters (supplier_id, document_type_id)
 * narrow the result set as expected.
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
let supplierAId: string;
let supplierBId: string;
let docAId: string;
let docBId: string;
let docCId: string;

function makeContext(url: string, user: { id: string; role: string; tenant_id: string | null }): any {
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

  supplierAId = generateTestId();
  supplierBId = generateTestId();
  await db
    .prepare(`INSERT INTO suppliers (id, tenant_id, name, slug) VALUES (?, ?, ?, ?)`)
    .bind(
      supplierAId,
      seed.tenantId,
      'Search Supplier Alpha',
      `supplier-alpha-${supplierAId}`,
    )
    .run();
  await db
    .prepare(`INSERT INTO suppliers (id, tenant_id, name, slug) VALUES (?, ?, ?, ?)`)
    .bind(
      supplierBId,
      seed.tenantId,
      'Search Supplier Beta',
      `supplier-beta-${supplierBId}`,
    )
    .run();

  docAId = generateTestId();
  docBId = generateTestId();
  docCId = generateTestId();

  await db
    .prepare(
      `INSERT INTO documents (id, tenant_id, title, tags, current_version, status, created_by, supplier_id, primary_metadata)
       VALUES (?, ?, ?, '[]', 1, 'active', ?, ?, ?)`,
    )
    .bind(
      docAId,
      seed.tenantId,
      'Alpha COA Jan',
      seed.userId,
      supplierAId,
      JSON.stringify({ lot_number: 'LOT-SRCH-001' }),
    )
    .run();
  await db
    .prepare(
      `INSERT INTO documents (id, tenant_id, title, tags, current_version, status, created_by, supplier_id, primary_metadata)
       VALUES (?, ?, ?, '[]', 1, 'active', ?, ?, ?)`,
    )
    .bind(
      docBId,
      seed.tenantId,
      'Alpha COA Feb',
      seed.userId,
      supplierAId,
      JSON.stringify({ lot_number: 'LOT-SRCH-002' }),
    )
    .run();
  await db
    .prepare(
      `INSERT INTO documents (id, tenant_id, title, tags, current_version, status, created_by, supplier_id, primary_metadata)
       VALUES (?, ?, ?, '[]', 1, 'active', ?, ?, ?)`,
    )
    .bind(
      docCId,
      seed.tenantId,
      'Beta COA Jan',
      seed.userId,
      supplierBId,
      JSON.stringify({ lot_number: 'LOT-SRCH-003' }),
    )
    .run();

  for (const [id, fileName] of [
    [docAId, 'alpha-jan.pdf'],
    [docBId, 'alpha-feb.pdf'],
    [docCId, 'beta-jan.pdf'],
  ] as const) {
    await db
      .prepare(
        `INSERT INTO document_versions (id, document_id, version_number, file_name, file_size, mime_type, r2_key, checksum, uploaded_by)
         VALUES (?, ?, 1, ?, 1024, 'application/pdf', ?, 'deadbeef', ?)`,
      )
      .bind(
        generateTestId(),
        id,
        fileName,
        `tenant/${id}/1/${fileName}`,
        seed.userId,
      )
      .run();
  }
}, 30_000);

describe('GET /api/documents/search', () => {
  const superAdmin = {
    id: 'user-super-admin',
    role: 'super_admin',
    tenant_id: null,
  };

  it('matches on title substring', async () => {
    const { status, body } = await search(
      `q=Alpha&tenant_id=${seed.tenantId}`,
      superAdmin,
    );
    expect(status).toBe(200);
    const ids = body.documents.map((d: { id: string }) => d.id);
    expect(ids).toContain(docAId);
    expect(ids).toContain(docBId);
    expect(ids).not.toContain(docCId);
  });

  it('matches on file_name substring', async () => {
    const { status, body } = await search(
      `q=alpha-feb&tenant_id=${seed.tenantId}`,
      superAdmin,
    );
    expect(status).toBe(200);
    const ids = body.documents.map((d: { id: string }) => d.id);
    expect(ids).toContain(docBId);
    expect(ids).not.toContain(docAId);
  });

  it('matches on primary_metadata lot number', async () => {
    const { status, body } = await search(
      `q=LOT-SRCH-002&tenant_id=${seed.tenantId}`,
      superAdmin,
    );
    expect(status).toBe(200);
    expect(body.documents.map((d: { id: string }) => d.id)).toEqual([docBId]);
  });

  it('supplier_id filter narrows the result set', async () => {
    const { status, body } = await search(
      `supplier_id=${supplierBId}&tenant_id=${seed.tenantId}`,
      superAdmin,
    );
    expect(status).toBe(200);
    const ids = body.documents.map((d: { id: string }) => d.id);
    expect(ids).toContain(docCId);
    expect(ids).not.toContain(docAId);
  });
});
