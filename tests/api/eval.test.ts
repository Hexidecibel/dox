/**
 * API tests for the /api/eval flow — next / submit / report.
 *
 * Drives each PagesFunction directly with a fake context (same pattern as
 * tests/api/extraction-instructions.test.ts). Covers:
 *   1. next() only returns queue items with both extractions populated and
 *      no VLM error.
 *   2. submit() upserts keyed on (queue_item, evaluator) — second pick by
 *      the same reviewer overwrites the first.
 *   3. After the user evaluates every eligible item, next() returns a null
 *      item with remaining=0.
 *   4. The report unblinds the Method A/B label using `a_side` — an "a" win
 *      on an a_side=vlm doc is counted as a VLM win.
 *   5. Tenant isolation: an org_admin in another tenant cannot evaluate
 *      items from this tenant (and vice versa).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { runMigrations, seedTestData, generateTestId } from '../helpers/db';
import { onRequestGet as getNext } from '../../functions/api/eval/next';
import { onRequestPost as submitEval } from '../../functions/api/eval/[id]';
import { onRequestGet as getReport } from '../../functions/api/eval/report';
import type {
  EvalNextResponse,
  EvalReportResponse,
  EvalSubmitRequest,
  EvalSubmitResponse,
} from '../../shared/types';

const db = env.DB;
let seed: Awaited<ReturnType<typeof seedTestData>>;
let docTypeCoaId = '';
let docTypeSdsId = '';

function makeContext(
  path: string,
  method: string,
  user: { id: string; role: string; tenant_id: string | null },
  body?: unknown,
  params?: Record<string, string>
): any {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { 'Content-Type': 'application/json' };
  }
  return {
    request: new Request(`http://localhost${path}`, init),
    env,
    data: { user },
    params: params ?? {},
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
    functionPath: path,
  };
}

async function ensureDocType(tenantId: string, slug: string, name: string): Promise<string> {
  const existing = await db
    .prepare('SELECT id FROM document_types WHERE tenant_id = ? AND slug = ?')
    .bind(tenantId, slug)
    .first<{ id: string }>();
  if (existing) return existing.id;
  const id = generateTestId();
  await db
    .prepare('INSERT INTO document_types (id, tenant_id, name, slug, active) VALUES (?, ?, ?, ?, 1)')
    .bind(id, tenantId, name, slug)
    .run();
  return id;
}

interface SeedQueueOpts {
  tenantId: string;
  userId: string;
  supplier?: string;
  documentTypeId?: string;
  fileName?: string;
  /** If set, prevent the item from being eval-eligible (null ai_fields or vlm). */
  missingTextExtraction?: boolean;
  missingVlmExtraction?: boolean;
  vlmError?: string;
}

async function seedQueueItem(opts: SeedQueueOpts): Promise<string> {
  const id = generateTestId();
  const aiFields = opts.missingTextExtraction
    ? null
    : JSON.stringify({ supplier_name: opts.supplier ?? 'ACME', lot_number: 'L-TEXT' });
  const vlmFields = opts.missingVlmExtraction
    ? null
    : JSON.stringify({ supplier_name: opts.supplier ?? 'ACME CORPORATION', lot_number: 'L-VLM' });
  await db
    .prepare(
      `INSERT INTO processing_queue
        (id, tenant_id, document_type_id, file_r2_key, file_name, file_size, mime_type,
         processing_status, status, created_by, supplier,
         extracted_text, ai_fields, ai_confidence, confidence_score, tables,
         vlm_extracted_fields, vlm_extracted_tables, vlm_confidence, vlm_error,
         vlm_model, vlm_duration_ms, vlm_extracted_at)
       VALUES (?, ?, ?, ?, ?, 100, 'application/pdf',
               'ready', 'pending', ?, ?,
               ?, ?, ?, ?, ?,
               ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      id,
      opts.tenantId,
      opts.documentTypeId ?? null,
      `queue/${id}/test.pdf`,
      opts.fileName ?? 'test.pdf',
      opts.userId,
      opts.supplier ?? null,
      'raw text',
      aiFields,
      'medium',
      0.7,
      JSON.stringify([]),
      vlmFields,
      JSON.stringify([]),
      0.9,
      opts.vlmError ?? null,
      'qwen2.5-vl-7b',
      1000,
      '2026-04-17T00:00:00.000Z'
    )
    .run();
  return id;
}

beforeAll(async () => {
  await runMigrations(db);
  seed = await seedTestData(db);
  docTypeCoaId = await ensureDocType(seed.tenantId, 'coa', 'COA');
  docTypeSdsId = await ensureDocType(seed.tenantId, 'sds', 'SDS');
  // Ensure a doctype exists in tenant2 so we can seed a cross-tenant item.
  await ensureDocType(seed.tenantId2, 'coa', 'COA');
}, 30_000);

// ---------- next() ----------

describe('GET /api/eval/next — eligibility filter', () => {
  it('only offers items that have both extractions and no VLM error', async () => {
    // Seed one eligible + three ineligible items in a brand-new tenant so
    // the count math is deterministic regardless of other tests.
    const tenantId = `eval-tenant-${generateTestId().slice(0, 8)}`;
    await db
      .prepare(
        `INSERT INTO tenants (id, name, slug, active, created_at, updated_at)
         VALUES (?, 'Eval Tenant', 'eval-tenant', 1, datetime('now'), datetime('now'))`
      )
      .bind(tenantId)
      .run();
    const userId = `eval-user-${generateTestId().slice(0, 8)}`;
    await db
      .prepare(
        `INSERT INTO users (id, email, name, role, tenant_id, password_hash, active, force_password_change)
         VALUES (?, ?, 'Eval User', 'user', ?, 'x:y', 1, 0)`
      )
      .bind(userId, `${userId}@test.com`, tenantId)
      .run();
    const dt = await ensureDocType(tenantId, 'coa', 'COA');

    const eligibleId = await seedQueueItem({ tenantId, userId, documentTypeId: dt });
    await seedQueueItem({ tenantId, userId, missingTextExtraction: true });
    await seedQueueItem({ tenantId, userId, missingVlmExtraction: true });
    await seedQueueItem({ tenantId, userId, vlmError: 'timeout' });

    const user = { id: userId, role: 'user', tenant_id: tenantId };
    const res = await getNext(makeContext('/api/eval/next', 'GET', user));
    expect(res.status).toBe(200);
    const body = (await res.json()) as EvalNextResponse;
    expect(body.total).toBe(1);
    expect(body.remaining).toBe(1);
    expect(body.item?.id).toBe(eligibleId);
    expect(body.a_side === 'text' || body.a_side === 'vlm').toBe(true);
  });
});

// ---------- submit + report ----------

describe('POST /api/eval/:id and GET /api/eval/report', () => {
  it('upserts one evaluation per (queue_item, user), then aggregates into a report that unblinds A/B', async () => {
    // Fresh tenant to keep counts clean.
    const tenantId = `eval-tenant2-${generateTestId().slice(0, 8)}`;
    await db
      .prepare(
        `INSERT INTO tenants (id, name, slug, active, created_at, updated_at)
         VALUES (?, 'Eval Tenant 2', 'eval-tenant-2', 1, datetime('now'), datetime('now'))`
      )
      .bind(tenantId)
      .run();
    const userId = `eval-user2-${generateTestId().slice(0, 8)}`;
    await db
      .prepare(
        `INSERT INTO users (id, email, name, role, tenant_id, password_hash, active, force_password_change)
         VALUES (?, ?, 'Eval User 2', 'user', ?, 'x:y', 1, 0)`
      )
      .bind(userId, `${userId}@test.com`, tenantId)
      .run();
    const dtCoa = await ensureDocType(tenantId, 'coa', 'COA');
    const dtSds = await ensureDocType(tenantId, 'sds', 'SDS');

    const item1 = await seedQueueItem({ tenantId, userId, supplier: 'ACME', documentTypeId: dtCoa, fileName: 'acme-coa.pdf' });
    const item2 = await seedQueueItem({ tenantId, userId, supplier: 'ACME', documentTypeId: dtCoa, fileName: 'acme-coa-2.pdf' });
    const item3 = await seedQueueItem({ tenantId, userId, supplier: 'GLOBEX', documentTypeId: dtSds, fileName: 'globex-sds.pdf' });

    const user = { id: userId, role: 'user', tenant_id: tenantId };

    // Evaluate item1: say "A wins" with a_side='text' — that's a text win
    let res = await submitEval(
      makeContext(`/api/eval/${item1}`, 'POST', user, {
        winner: 'a',
        a_side: 'text',
        comment: 'A had the lot number right',
      } satisfies EvalSubmitRequest, { id: item1 })
    );
    expect(res.status).toBe(200);
    const r1 = (await res.json()) as EvalSubmitResponse;
    expect(r1.evaluation.winner).toBe('a');
    expect(r1.evaluation.a_side).toBe('text');
    expect(r1.total).toBe(3);
    expect(r1.remaining).toBe(2);

    // Re-submit item1 as a tie — should overwrite, not create a duplicate.
    res = await submitEval(
      makeContext(`/api/eval/${item1}`, 'POST', user, {
        winner: 'tie',
        a_side: 'text',
      } satisfies EvalSubmitRequest, { id: item1 })
    );
    expect(res.status).toBe(200);
    const countRow = await db
      .prepare('SELECT COUNT(*) as c FROM extraction_evaluations WHERE queue_item_id = ?')
      .bind(item1)
      .first<{ c: number }>();
    expect(countRow?.c).toBe(1);

    // Evaluate item2: "B wins" with a_side='text' → unblind: VLM wins
    res = await submitEval(
      makeContext(`/api/eval/${item2}`, 'POST', user, {
        winner: 'b',
        a_side: 'text',
      } satisfies EvalSubmitRequest, { id: item2 })
    );
    expect(res.status).toBe(200);

    // Evaluate item3: "A wins" with a_side='vlm' → unblind: VLM wins
    res = await submitEval(
      makeContext(`/api/eval/${item3}`, 'POST', user, {
        winner: 'a',
        a_side: 'vlm',
        comment: '',
      } satisfies EvalSubmitRequest, { id: item3 })
    );
    expect(res.status).toBe(200);

    // After evaluating all 3 items, next() should return a null item.
    const nextRes = await getNext(makeContext('/api/eval/next', 'GET', user));
    const nextBody = (await nextRes.json()) as EvalNextResponse;
    expect(nextBody.item).toBeNull();
    expect(nextBody.remaining).toBe(0);
    expect(nextBody.total).toBe(3);

    // Report: 0 text wins, 2 vlm wins, 1 tie.
    const reportRes = await getReport(makeContext('/api/eval/report', 'GET', user));
    expect(reportRes.status).toBe(200);
    const report = (await reportRes.json()) as EvalReportResponse;
    expect(report.totals.evaluated).toBe(3);
    expect(report.totals.text_wins).toBe(0);
    expect(report.totals.vlm_wins).toBe(2);
    expect(report.totals.ties).toBe(1);

    // Supplier breakdown — ACME: 1 tie, 1 vlm. GLOBEX: 1 vlm.
    const acme = report.by_supplier.find((s) => s.key === 'ACME');
    expect(acme).toMatchObject({ key: 'ACME', text_wins: 0, vlm_wins: 1, ties: 1 });
    const globex = report.by_supplier.find((s) => s.key === 'GLOBEX');
    expect(globex).toMatchObject({ key: 'GLOBEX', text_wins: 0, vlm_wins: 1, ties: 0 });

    // Doctype breakdown.
    const coa = report.by_doctype.find((d) => d.key === 'COA');
    expect(coa).toMatchObject({ key: 'COA', text_wins: 0, vlm_wins: 1, ties: 1 });
    const sds = report.by_doctype.find((d) => d.key === 'SDS');
    expect(sds).toMatchObject({ key: 'SDS', text_wins: 0, vlm_wins: 1, ties: 0 });

    // The re-submit on item1 cleared the initial comment (upsert overwrote
    // everything); item2 and item3 were submitted without comments. So after
    // all three evaluations, zero non-empty comments survive — prove that.
    expect(report.comments).toHaveLength(0);

    // But the unblinded per-evaluation list still has all three rows.
    expect(report.evaluations).toHaveLength(3);
  });
});

// ---------- tenant isolation ----------

describe('tenant isolation', () => {
  it('does not surface queue items from another tenant to a non-super_admin', async () => {
    // Seed an eligible item in tenant2.
    const t2DocType = await ensureDocType(seed.tenantId2, 'coa', 'COA');
    await seedQueueItem({
      tenantId: seed.tenantId2,
      userId: seed.orgAdmin2Id,
      supplier: 'CROSS-TENANT',
      documentTypeId: t2DocType,
    });

    // An org_admin in tenant1 should only see tenant1 items.
    const user1 = { id: seed.orgAdminId, role: 'org_admin', tenant_id: seed.tenantId };
    const res = await getNext(makeContext('/api/eval/next', 'GET', user1));
    const body = (await res.json()) as EvalNextResponse;
    // If the item happens to be from tenant2, that's a bug. Its supplier
    // won't match "CROSS-TENANT" and its tenant_id won't match tenantId.
    if (body.item) {
      expect(body.item.tenant_id).toBe(seed.tenantId);
      expect(body.item.supplier).not.toBe('CROSS-TENANT');
    }
  });

  it('rejects submit for a queue item in another tenant', async () => {
    // Seed an item in tenant2, try to submit as a user in tenant1.
    const t2DocType = await ensureDocType(seed.tenantId2, 'coa', 'COA');
    const itemId = await seedQueueItem({
      tenantId: seed.tenantId2,
      userId: seed.orgAdmin2Id,
      supplier: 'OTHER',
      documentTypeId: t2DocType,
      fileName: 'other.pdf',
    });
    const user1 = { id: seed.orgAdminId, role: 'org_admin', tenant_id: seed.tenantId };
    const res = await submitEval(
      makeContext(`/api/eval/${itemId}`, 'POST', user1, {
        winner: 'a',
        a_side: 'text',
      } satisfies EvalSubmitRequest, { id: itemId })
    );
    expect(res.status).toBe(403);
  });
});

// ---------- validation ----------

describe('input validation', () => {
  it('rejects unknown winner values', async () => {
    const tenantId = `eval-tenant3-${generateTestId().slice(0, 8)}`;
    await db
      .prepare(
        `INSERT INTO tenants (id, name, slug, active, created_at, updated_at)
         VALUES (?, 'Eval Tenant 3', 'eval-tenant-3', 1, datetime('now'), datetime('now'))`
      )
      .bind(tenantId)
      .run();
    const userId = `eval-user3-${generateTestId().slice(0, 8)}`;
    await db
      .prepare(
        `INSERT INTO users (id, email, name, role, tenant_id, password_hash, active, force_password_change)
         VALUES (?, ?, 'Eval User 3', 'user', ?, 'x:y', 1, 0)`
      )
      .bind(userId, `${userId}@test.com`, tenantId)
      .run();
    const dt = await ensureDocType(tenantId, 'coa', 'COA');
    const itemId = await seedQueueItem({ tenantId, userId, documentTypeId: dt });
    const user = { id: userId, role: 'user', tenant_id: tenantId };

    const res = await submitEval(
      makeContext(`/api/eval/${itemId}`, 'POST', user, {
        winner: 'banana',
        a_side: 'text',
      } as unknown as EvalSubmitRequest, { id: itemId })
    );
    expect(res.status).toBe(400);
  });

  it('rejects unknown a_side values', async () => {
    const tenantId = `eval-tenant4-${generateTestId().slice(0, 8)}`;
    await db
      .prepare(
        `INSERT INTO tenants (id, name, slug, active, created_at, updated_at)
         VALUES (?, 'Eval Tenant 4', 'eval-tenant-4', 1, datetime('now'), datetime('now'))`
      )
      .bind(tenantId)
      .run();
    const userId = `eval-user4-${generateTestId().slice(0, 8)}`;
    await db
      .prepare(
        `INSERT INTO users (id, email, name, role, tenant_id, password_hash, active, force_password_change)
         VALUES (?, ?, 'Eval User 4', 'user', ?, 'x:y', 1, 0)`
      )
      .bind(userId, `${userId}@test.com`, tenantId)
      .run();
    const dt = await ensureDocType(tenantId, 'coa', 'COA');
    const itemId = await seedQueueItem({ tenantId, userId, documentTypeId: dt });
    const user = { id: userId, role: 'user', tenant_id: tenantId };

    const res = await submitEval(
      makeContext(`/api/eval/${itemId}`, 'POST', user, {
        winner: 'a',
        a_side: 'other',
      } as unknown as EvalSubmitRequest, { id: itemId })
    );
    expect(res.status).toBe(400);
  });
});
