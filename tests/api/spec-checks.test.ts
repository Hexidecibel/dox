/**
 * GET/POST /api/spec-checks — the register as the Out-of-Spec page reads it.
 *
 * What is pinned here is provenance (migration 0103): a result a reviewer had
 * in front of them at approval and one `bin/backfill-spec-register` computed
 * over history must never be served as the same thing.
 *
 *   1. Every row says who judged it and, for a bulk row, when the pass ran.
 *   2. `origin` filters on exactly that, and an unknown value is refused rather
 *      than silently meaning "everything".
 *   3. Acknowledgement works on both kinds, and never changes the origin.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { seedTestData, generateTestId } from '../helpers/db';
import { onRequestGet, onRequestPost } from '../../functions/api/spec-checks/index';

const db = env.DB;
let seed: Awaited<ReturnType<typeof seedTestData>>;

const BULK_RUN = '2026-09-14T18:00:00.000Z';
let approvalId = '';
let bulkId = '';
let foreignBulkId = '';

function ctx(url: string, method: string, user: Record<string, unknown>, body?: unknown): any {
  return {
    request: new Request(url, {
      method,
      ...(body !== undefined
        ? { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }
        : {}),
    }),
    env,
    data: { user },
    params: {},
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
    functionPath: '/api/spec-checks',
  };
}

async function list(query: string, user?: Record<string, unknown>) {
  const u = user ?? { id: seed.userId, role: 'user', tenant_id: seed.tenantId };
  const res = await onRequestGet(ctx(`http://localhost/api/spec-checks?${query}`, 'GET', u));
  return { status: res.status, body: (await res.json()) as any };
}

async function insertCheck(tenantId: string, documentId: string, over: Record<string, unknown>) {
  const id = generateTestId();
  const row = {
    judgement_origin: 'approval',
    bulk_run_at: null,
    result_key: null,
    result_location: null,
    ...over,
  };
  await db
    .prepare(
      `INSERT INTO document_spec_checks
         (id, tenant_id, document_id, version_number, test_name_raw, value_raw, unit_raw,
          verdict, source, judgement_origin, bulk_run_at, result_key, result_location)
       VALUES (?, ?, ?, 1, 'Coliform', '41.94', 'cfu/g', 'out_of_spec', 'limit', ?, ?, ?, ?)`
    )
    .bind(
      id,
      tenantId,
      documentId,
      row.judgement_origin,
      row.bulk_run_at,
      row.result_key,
      row.result_location
    )
    .run();
  return id;
}

async function makeDocument(tenantId: string, createdBy: string, title: string) {
  const id = generateTestId();
  await db
    .prepare(
      `INSERT INTO documents (id, tenant_id, title, current_version, status, created_by)
       VALUES (?, ?, ?, 1, 'active', ?)`
    )
    .bind(id, tenantId, title, createdBy)
    .run();
  return id;
}

beforeAll(async () => {
  seed = await seedTestData(db);
  const doc = await makeDocument(seed.tenantId, seed.orgAdminId, 'Edaleen COA');
  approvalId = await insertCheck(seed.tenantId, doc, {});
  bulkId = await insertCheck(seed.tenantId, doc, {
    judgement_origin: 'bulk_recheck',
    bulk_run_at: BULK_RUN,
    result_key: 'ai_fields::t0r1c4',
    result_location: 'Table 1, row 2 (042026)',
  });

  const foreignDoc = await makeDocument(seed.tenantId2, seed.superAdminId, 'Foreign COA');
  foreignBulkId = await insertCheck(seed.tenantId2, foreignDoc, {
    judgement_origin: 'bulk_recheck',
    bulk_run_at: BULK_RUN,
  });
}, 30_000);

describe('GET /api/spec-checks — who judged it', () => {
  it('serves origin, run stamp and result location on every row', async () => {
    const { status, body } = await list('');
    expect(status).toBe(200);
    const byId = new Map(body.specChecks.map((c: any) => [c.id, c]));
    expect(byId.get(approvalId)).toMatchObject({ judgement_origin: 'approval', bulk_run_at: null });
    expect(byId.get(bulkId)).toMatchObject({
      judgement_origin: 'bulk_recheck',
      bulk_run_at: BULK_RUN,
      result_key: 'ai_fields::t0r1c4',
      result_location: 'Table 1, row 2 (042026)',
    });
  });

  it('defaults to every origin', async () => {
    const ids = (await list('')).body.specChecks.map((c: any) => c.id);
    expect(ids).toEqual(expect.arrayContaining([approvalId, bulkId]));
    expect((await list('origin=all')).body.total).toBe((await list('')).body.total);
  });

  it('filters to results reviewed at approval', async () => {
    const { body } = await list('origin=approval');
    expect(body.specChecks.map((c: any) => c.id)).toEqual([approvalId]);
    expect(body.total).toBe(1);
  });

  it('filters to the bulk re-check, still inside the tenant', async () => {
    const { body } = await list('origin=bulk_recheck');
    expect(body.specChecks.map((c: any) => c.id)).toEqual([bulkId]);
    expect(body.specChecks.map((c: any) => c.id)).not.toContain(foreignBulkId);
  });

  it('refuses an origin it does not know instead of returning everything', async () => {
    const { status, body } = await list('origin=reviewer');
    expect(status).toBe(400);
    expect(body.error).toMatch(/origin/);
  });
});

describe('POST /api/spec-checks — acknowledgement on both origins', () => {
  it('acknowledges a bulk row and an approval row, and leaves the origin alone', async () => {
    const user = { id: seed.orgAdminId, role: 'org_admin', tenant_id: seed.tenantId };
    const res = await onRequestPost(
      ctx('http://localhost/api/spec-checks', 'POST', user, {
        ids: [approvalId, bulkId],
        note: 'Retest within limit.',
      })
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).acknowledged).toBe(2);

    const { body } = await list('acknowledged=1');
    const byId = new Map(body.specChecks.map((c: any) => [c.id, c]));
    expect(byId.get(bulkId)).toMatchObject({
      judgement_origin: 'bulk_recheck',
      bulk_run_at: BULK_RUN,
      acknowledged_by: seed.orgAdminId,
      acknowledgement_note: 'Retest within limit.',
    });
    expect(byId.get(approvalId)).toMatchObject({ judgement_origin: 'approval' });
  });
});
