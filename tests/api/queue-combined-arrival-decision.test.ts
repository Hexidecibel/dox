/**
 * PUT /api/queue/:id with `arrival_decision` — approve (or reject) a
 * supplier-portal file and decide what it satisfies in ONE action.
 *
 * Pinned here:
 *   1. Approve + accept writes everything the two-step path writes (document,
 *      upload link, line, claim, registry link), and every decision audit row
 *      says `via: 'review_queue_combined'` with the queue item.
 *   2. Approve + send back, and reject + send back with the sales-sheet reason.
 *   3. A decision that could never save is refused BEFORE the approval: the
 *      queue item is still pending and nothing moved.
 *   4. A decision refused AFTER the approval (a human rejected the registry
 *      link in between) reports `applied: false` with the approval standing
 *      and the arrival untouched, and the two-step Decide still works on it.
 *   5. Items that did not come through a request link are unaffected, and
 *      neither a reader nor a plain user can use it.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { seedTestData, generateTestId } from '../helpers/db';
import {
  fnContext,
  makeRequest as makeRequestFor,
  markExtracted,
  orgAdminUser,
  queuePut,
  readJson,
  refsFor,
  upload,
  type RequestFixture,
  type TestUser,
} from '../helpers/requests';
import { onRequestPost as decidePost } from '../../functions/api/request-uploads/[id]/decide';
import { onRequestGet as portalGet } from '../../functions/api/supplier-requests/public/[token]';
import { ATTENTION_REASON_PRESETS } from '../../shared/types';
import type { QueueArrivalDecisionOutcome, SupplierRequestView } from '../../shared/types';

const db = env.DB;
let seed: Awaited<ReturnType<typeof seedTestData>>;
let fx: RequestFixture;
let admin: TestUser;
let worker: TestUser;
let reader: TestUser;

type CombinedBody = {
  item?: { id: string; status: string };
  document?: { id: string };
  arrival_decision?: QueueArrivalDecisionOutcome;
  error?: string;
};

async function arrive(names: string[], claim: number[] = [0], fileName = 'cert.pdf') {
  const made = await makeRequestFor(fx, names);
  const res = await upload(made.token, await refsFor(made.token, claim.map((i) => made.lineIds[i])), {
    name: fileName,
  });
  expect(res.status).toBe(200);
  const up = await db
    .prepare(
      `SELECT id, queue_id FROM request_uploads
        WHERE request_id = ? ORDER BY uploaded_at DESC, rowid DESC LIMIT 1`,
    )
    .bind(made.requestId)
    .first<{ id: string; queue_id: string }>();
  await markExtracted(fx, up!.queue_id);
  return { ...made, uploadId: up!.id, queueId: up!.queue_id };
}

async function combined(queueId: string, body: Record<string, unknown>, as: TestUser = admin) {
  const res = await queuePut(queueId, body, as);
  return { status: res.status, body: res.body as CombinedBody };
}

const approveBody = (decisions: unknown[]) => ({
  status: 'approved',
  fields: { lot_number: 'L-1' },
  supplier_id: fx.supplierId,
  arrival_decision: { decisions },
});

async function lineRow(lineId: string) {
  return db.prepare('SELECT * FROM request_lines WHERE id = ?').bind(lineId).first<Record<string, any>>();
}

async function queueRow(queueId: string) {
  return db
    .prepare('SELECT status, rejection_reason FROM processing_queue WHERE id = ?')
    .bind(queueId)
    .first<{ status: string; rejection_reason: string | null }>();
}

async function uploadDoc(uploadId: string) {
  return (
    await db
      .prepare('SELECT document_id FROM request_uploads WHERE id = ?')
      .bind(uploadId)
      .first<{ document_id: string | null }>()
  )?.document_id ?? null;
}

async function auditRows(action: string, resourceId: string) {
  const rows = await db
    .prepare('SELECT details FROM audit_log WHERE action = ? AND resource_id = ? ORDER BY id')
    .bind(action, resourceId)
    .all<{ details: string }>();
  return (rows.results ?? []).map((r) => JSON.parse(r.details));
}

async function portal(token: string): Promise<SupplierRequestView> {
  const resp = await portalGet(fnContext(`/api/supplier-requests/public/${token}`, { params: { token } }));
  return (await resp.json()) as SupplierRequestView;
}

beforeAll(async () => {
  seed = await seedTestData(db);
  const supplierId = generateTestId();
  await db
    .prepare('INSERT INTO suppliers (id, tenant_id, name, slug) VALUES (?, ?, ?, ?)')
    .bind(supplierId, seed.tenantId, 'Combined Dairy', `combined-${supplierId.slice(0, 6)}`)
    .run();
  const requirementIds: string[] = [];
  for (let i = 0; i < 4; i += 1) {
    const id = generateTestId();
    requirementIds.push(id);
    await db
      .prepare('INSERT INTO requirements (id, tenant_id, slug, name, active) VALUES (?, ?, ?, ?, 1)')
      .bind(id, seed.tenantId, `req-cq-${i}-${id.slice(0, 6)}`, `Requirement ${i}`)
      .run();
  }
  fx = { tenantId: seed.tenantId, orgAdminId: seed.orgAdminId, supplierId, requirementIds };
  admin = orgAdminUser(fx);
  worker = { id: seed.userId, email: 'user@test.com', name: 'Regular User', role: 'user', tenant_id: seed.tenantId };
  reader = { id: seed.readerId, email: 'reader@test.com', name: 'Reader User', role: 'reader', tenant_id: seed.tenantId };
}, 30_000);

describe('combined approve and decide', () => {
  it('approves and accepts in one action, including a requirement the supplier did not tick', async () => {
    const a = await arrive(['Allergen Statement', 'Kosher Letter'], [0]);

    const { status, body } = await combined(
      a.queueId,
      approveBody([
        { line_id: a.lineIds[0], decision: 'accepted', status_note: 'Signature checked' },
        { line_id: a.lineIds[1], decision: 'accepted' },
      ]),
    );
    expect(status).toBe(200);
    expect(body.item!.status).toBe('approved');
    const docId = body.document!.id;
    expect(docId).toBeTruthy();
    expect(body.arrival_decision!.applied).toBe(true);
    if (body.arrival_decision!.applied) {
      expect(body.arrival_decision!.counts.by_status.accepted).toBe(2);
      expect(body.arrival_decision!.arrival.pending_count).toBe(0);
    }

    expect(await uploadDoc(a.uploadId)).toBe(docId);
    for (const lineId of a.lineIds) {
      const line = await lineRow(lineId);
      expect(line!.status).toBe('accepted');
      expect(line!.accepted_document_id).toBe(docId);
    }
    const links = await db
      .prepare(`SELECT requirement_id, status, source FROM document_requirements WHERE document_id = ? ORDER BY requirement_id`)
      .bind(docId)
      .all<{ requirement_id: string; status: string; source: string }>();
    expect(links.results!.filter((l) => l.status === 'confirmed').map((l) => l.requirement_id).sort()).toEqual(
      [fx.requirementIds[0], fx.requirementIds[1]].sort(),
    );

    // Identifiable as the combined action, on every decision row.
    const moved = await auditRows('request_line_status_changed', a.requestId);
    expect(moved.length).toBe(2);
    for (const m of moved) {
      expect(m).toMatchObject({ via: 'review_queue_combined', queue_item_id: a.queueId, to: 'accepted', document_id: docId });
    }
    expect((await auditRows('request_upload.decided', a.uploadId))[0]).toMatchObject({
      via: 'review_queue_combined',
      queue_item_id: a.queueId,
    });
    expect((await auditRows('request_upload.document_linked', a.uploadId))[0]).toMatchObject({
      via: 'review_queue_combined',
      line_status_unchanged: true,
    });
    expect((await auditRows('request_upload.claim_added', a.uploadId)).length).toBe(1);
    // The queue half's own audit row is still written.
    expect((await auditRows('queue_item.approved', a.queueId)).length).toBe(1);

    expect((await portal(a.token)).progress.required_satisfied).toBe(2);
  });

  it('approves and sends back in one action', async () => {
    const a = await arrive(['Allergen Statement']);
    const reason = 'This statement is from 2023; we need one signed this year.';
    const { status, body } = await combined(
      a.queueId,
      approveBody([{ line_id: a.lineIds[0], decision: 'needs_attention', attention_reason: reason }]),
    );
    expect(status).toBe(200);
    expect(body.item!.status).toBe('approved');
    expect(body.arrival_decision!.applied).toBe(true);

    const line = await lineRow(a.lineIds[0]);
    expect(line!.status).toBe('needs_attention');
    expect(line!.attention_reason).toBe(reason);
    expect(line!.accepted_document_id).toBeNull();
    expect(await uploadDoc(a.uploadId)).toBe(body.document!.id);
    expect((await portal(a.token)).items[0].attention_reason).toBe(reason);
  });

  it('rejects a sales sheet and sends it back with the preset reason', async () => {
    const a = await arrive(['Specification Sheet'], [0], 'sales-sheet.pdf');
    const preset = ATTENTION_REASON_PRESETS.find((p) => p.key === 'sales_sheet')!;
    const { status, body } = await combined(a.queueId, {
      status: 'rejected',
      rejection_reason: 'sales_sheet',
      arrival_decision: {
        decisions: [{ line_id: a.lineIds[0], decision: 'needs_attention', attention_reason: preset.text }],
      },
    });
    expect(status).toBe(200);
    expect(body.item!.status).toBe('rejected');
    expect(body.arrival_decision!.applied).toBe(true);
    expect(await queueRow(a.queueId)).toMatchObject({ status: 'rejected', rejection_reason: 'sales_sheet' });
    const line = await lineRow(a.lineIds[0]);
    expect(line!.status).toBe('needs_attention');
    expect(line!.attention_reason).toBe(preset.text);
    expect(await uploadDoc(a.uploadId)).toBeNull();
  });

  it('refuses a decision that could never save before approving anything', async () => {
    const a = await arrive(['Allergen Statement']);

    const stale = await combined(a.queueId, approveBody([{ line_id: 'not-a-line', decision: 'accepted' }]));
    expect(stale.status).toBe(400);
    expect((await queueRow(a.queueId))!.status).toBe('pending');
    expect(await uploadDoc(a.uploadId)).toBeNull();

    const chosenDoc = await combined(
      a.queueId,
      approveBody([{ line_id: a.lineIds[0], decision: 'accepted', document_id: 'some-doc' }]),
    );
    expect(chosenDoc.status).toBe(400);

    const acceptOnReject = await combined(a.queueId, {
      status: 'rejected',
      rejection_reason: 'other',
      arrival_decision: { decisions: [{ line_id: a.lineIds[0], decision: 'accepted' }] },
    });
    expect(acceptOnReject.status).toBe(400);
    expect((await queueRow(a.queueId))!.status).toBe('pending');

    await db.prepare(`UPDATE document_requests SET status = 'cancelled' WHERE id = ?`).bind(a.requestId).run();
    const cancelled = await combined(a.queueId, approveBody([{ line_id: a.lineIds[0], decision: 'accepted' }]));
    expect(cancelled.status).toBe(409);
    expect((await queueRow(a.queueId))!.status).toBe('pending');
    expect((await lineRow(a.lineIds[0]))!.status).toBe('received');
  });

  it('keeps the approval and leaves the arrival pending when a registry rejection lands in between', async () => {
    const a = await arrive(['Allergen Statement', 'Kosher Letter'], [0, 1]);
    // Stand in for a person recording, between the two halves, that the new
    // document does NOT satisfy the second requirement.
    const trigger = `trg_test_reject_${a.queueId.replace(/[^a-z0-9]/gi, '')}`;
    await db
      .prepare(
        `CREATE TRIGGER ${trigger} AFTER INSERT ON documents
         WHEN NEW.external_ref = 'queue-${a.queueId}'
         BEGIN
           INSERT INTO document_requirements (id, document_id, requirement_id, status, source)
           VALUES (lower(hex(randomblob(8))), NEW.id, '${fx.requirementIds[1]}', 'rejected', 'human');
         END`,
      )
      .run();
    let docId: string;
    try {
      const { status, body } = await combined(
        a.queueId,
        approveBody([
          { line_id: a.lineIds[0], decision: 'accepted' },
          { line_id: a.lineIds[1], decision: 'accepted' },
        ]),
      );
      expect(status).toBe(200);
      expect(body.item!.status).toBe('approved');
      docId = body.document!.id;
      const outcome = body.arrival_decision!;
      expect(outcome.applied).toBe(false);
      if (!outcome.applied) {
        expect(outcome.status).toBe(409);
        expect(outcome.error).toMatch(/does not satisfy/);
        expect(outcome.upload_id).toBe(a.uploadId);
      }
    } finally {
      await db.prepare(`DROP TRIGGER IF EXISTS ${trigger}`).run();
    }

    // The approval stands; the decision half wrote nothing.
    expect((await queueRow(a.queueId))!.status).toBe('approved');
    expect(await uploadDoc(a.uploadId)).toBe(docId);
    expect((await lineRow(a.lineIds[0]))!.status).toBe('received');
    expect((await lineRow(a.lineIds[1]))!.status).toBe('received');
    const decided = await db
      .prepare('SELECT COUNT(*) AS n FROM request_upload_lines WHERE upload_id = ? AND decision IS NOT NULL')
      .bind(a.uploadId)
      .first<{ n: number }>();
    expect(decided!.n).toBe(0);
    expect((await auditRows('request_upload.combined_decision_failed', a.uploadId))[0]).toMatchObject({
      queue_item_id: a.queueId,
      status: 409,
    });

    // The two-step path still works on what is left.
    const resp = await decidePost(
      fnContext(`/api/request-uploads/${a.uploadId}/decide`, {
        method: 'POST',
        body: JSON.stringify({ decisions: [{ line_id: a.lineIds[0], decision: 'accepted' }] }),
        headers: { 'Content-Type': 'application/json' },
        user: admin,
        params: { id: a.uploadId },
      }),
    );
    expect(resp.status).toBe(200);
    const after = (await readJson(resp)) as { arrival: { claims: Array<{ line_id: string; decision: string | null }> } };
    expect(after.arrival.claims.find((c) => c.line_id === a.lineIds[0])!.decision).toBe('accepted');
    expect((await lineRow(a.lineIds[0]))!.accepted_document_id).toBe(docId!);
  });

  it('a plain approve of a portal file still decides nothing', async () => {
    const a = await arrive(['Allergen Statement']);
    const { status, body } = await combined(a.queueId, {
      status: 'approved',
      fields: { lot_number: 'L-1' },
      supplier_id: fx.supplierId,
    });
    expect(status).toBe(200);
    expect(body.arrival_decision).toBeUndefined();
    expect((await lineRow(a.lineIds[0]))!.status).toBe('received');
  });

  it('leaves items from other doors alone, and refuses a decision on them', async () => {
    const id = generateTestId();
    const r2Key = `pending/${id}.pdf`;
    await env.FILES.put(r2Key, new TextEncoder().encode('%PDF-1.4 fake'), {
      httpMetadata: { contentType: 'application/pdf' },
    });
    await db
      .prepare(
        `INSERT INTO processing_queue
           (id, tenant_id, file_r2_key, file_name, file_size, mime_type, extracted_text, ai_fields,
            processing_status, output_kind, status, source, created_by, created_at)
         VALUES (?, ?, ?, 'upload.pdf', 13, 'application/pdf', 'text', '{}', 'ready', 'coa', 'pending', 'email', ?, datetime('now'))`,
      )
      .bind(id, seed.tenantId, r2Key, seed.userId)
      .run();

    const refused = await combined(id, {
      status: 'approved',
      fields: { lot_number: 'L-9' },
      supplier_id: fx.supplierId,
      arrival_decision: { decisions: [{ line_id: 'x', decision: 'accepted' }] },
    });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toMatch(/request link/);
    expect((await queueRow(id))!.status).toBe('pending');

    const plain = await combined(id, { status: 'approved', fields: { lot_number: 'L-9' }, supplier_id: fx.supplierId });
    expect(plain.status).toBe(200);
    expect(plain.body.arrival_decision).toBeUndefined();
  });

  it('refuses a reader and a plain user', async () => {
    const a = await arrive(['Allergen Statement']);
    const decisions = [{ line_id: a.lineIds[0], decision: 'accepted' }];
    expect((await combined(a.queueId, approveBody(decisions), reader)).status).toBe(403);
    expect((await combined(a.queueId, approveBody(decisions), worker)).status).toBe(403);
    expect((await queueRow(a.queueId))!.status).toBe('pending');
    expect((await lineRow(a.lineIds[0]))!.status).toBe('received');
  });
});
