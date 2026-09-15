/**
 * /api/request-uploads — the staff side of the supplier portal (migration 0104).
 *
 * What is pinned here is not "the screen has data". It is the set of
 * properties that make deciding a supplier's file defensible:
 *
 *   1. Nothing we record about the uploader (their IP) or where the bytes sit
 *      (the R2 key) is in any payload, and another tenant's arrival is a 404.
 *   2. A requirement is ACCEPTED only from a document someone approved. Before
 *      approval the answer is 409, and nothing moves.
 *   3. Accepting names the document on the line and on the claim, audits under
 *      the same action a hand edit uses, moves the supplier's progress number,
 *      and confirms the registry link — but never overrules a human rejection.
 *   4. Sending an item back is allowed at any stage, and the supplier reads
 *      `attention_reason`, never `status_note`.
 *   5. Readers read and do not decide; a cancelled ask cannot be decided.
 *   6. Amendments re-mint line ids; decisions follow line identity.
 *   7. A newer file reopens an accepted line and drops its document.
 *   8. The file stays readable after approval moves the bytes.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { seedTestData, generateTestId } from '../helpers/db';
import {
  INTERNAL_NOTE,
  extractAndApprove,
  fnContext,
  makeRequest as makeRequestFor,
  orgAdminUser,
  readJson,
  refsFor,
  upload,
  type RequestFixture,
  type TestUser,
} from '../helpers/requests';
import { onRequestGet as listGet } from '../../functions/api/request-uploads/index';
import { onRequestGet as oneGet } from '../../functions/api/request-uploads/[id]';
import { onRequestGet as fileGet } from '../../functions/api/request-uploads/[id]/file';
import { onRequestPost as decidePost } from '../../functions/api/request-uploads/[id]/decide';
import { onRequestPost as enqueuePost } from '../../functions/api/request-uploads/[id]/enqueue';
import { onRequestGet as portalGet } from '../../functions/api/supplier-requests/public/[token]';
import { onRequestGet as queueList } from '../../functions/api/queue/index';
import { onRequest as middleware } from '../../functions/api/_middleware';
import { amendRequest } from '../../functions/lib/document-requests';
import type {
  DecideArrivalResponse,
  RequestArrival,
  RequestArrivalListResponse,
  SupplierRequestView,
} from '../../shared/types';

const db = env.DB;
let seed: Awaited<ReturnType<typeof seedTestData>>;
let fx: RequestFixture;
let admin: TestUser;
let worker: TestUser;
let reader: TestUser;
let otherTenantAdmin: TestUser;

async function list(query: string, as: TestUser = admin) {
  const resp = await listGet(fnContext(`/api/request-uploads?${query}`, { user: as }));
  return { status: resp.status, body: (await readJson(resp)) as RequestArrivalListResponse & { error?: string } };
}

async function getOne(id: string, as: TestUser = admin) {
  const resp = await oneGet(fnContext(`/api/request-uploads/${id}`, { user: as, params: { id } }));
  return { status: resp.status, body: (await readJson(resp)) as { arrival: RequestArrival; error?: string } };
}

async function decide(id: string, decisions: unknown[], as: TestUser = admin) {
  const resp = await decidePost(
    fnContext(`/api/request-uploads/${id}/decide`, {
      method: 'POST',
      body: JSON.stringify({ decisions }),
      headers: { 'Content-Type': 'application/json' },
      user: as,
      params: { id },
    }),
  );
  return { status: resp.status, body: (await readJson(resp)) as DecideArrivalResponse & { error?: string } };
}

async function portal(token: string): Promise<SupplierRequestView> {
  const resp = await portalGet(
    fnContext(`/api/supplier-requests/public/${token}`, { params: { token } }),
  );
  return (await resp.json()) as SupplierRequestView;
}

/** One issued ask, one file through its link, claimed against `claim` line indexes. */
async function arrive(names: string[], claim: number[] = [0], fileName = 'cert.pdf') {
  const made = await makeRequestFor(fx, names);
  const res = await upload(made.token, await refsFor(made.token, claim.map((i) => made.lineIds[i])), {
    name: fileName,
  });
  expect(res.status).toBe(200);
  const up = await db
    .prepare(
      `SELECT id, queue_id, r2_key FROM request_uploads
        WHERE request_id = ? ORDER BY uploaded_at DESC, rowid DESC LIMIT 1`,
    )
    .bind(made.requestId)
    .first<{ id: string; queue_id: string; r2_key: string }>();
  return { ...made, uploadId: up!.id, queueId: up!.queue_id, r2Key: up!.r2_key };
}

async function lineRow(lineId: string) {
  return db
    .prepare('SELECT * FROM request_lines WHERE id = ?')
    .bind(lineId)
    .first<Record<string, any>>();
}

async function auditRows(action: string, resourceId: string) {
  const rows = await db
    .prepare('SELECT details FROM audit_log WHERE action = ? AND resource_id = ? ORDER BY id')
    .bind(action, resourceId)
    .all<{ details: string }>();
  return (rows.results ?? []).map((r) => JSON.parse(r.details));
}

beforeAll(async () => {
  seed = await seedTestData(db);

  const supplierId = generateTestId();
  await db
    .prepare('INSERT INTO suppliers (id, tenant_id, name, slug) VALUES (?, ?, ?, ?)')
    .bind(supplierId, seed.tenantId, 'Andersen Dairy', `andersen-ra-${supplierId.slice(0, 6)}`)
    .run();

  const requirementIds: string[] = [];
  for (let i = 0; i < 4; i += 1) {
    const id = generateTestId();
    requirementIds.push(id);
    await db
      .prepare('INSERT INTO requirements (id, tenant_id, slug, name, active) VALUES (?, ?, ?, ?, 1)')
      .bind(id, seed.tenantId, `req-ra-${i}-${id.slice(0, 6)}`, `Requirement ${i}`)
      .run();
  }

  fx = { tenantId: seed.tenantId, orgAdminId: seed.orgAdminId, supplierId, requirementIds };
  admin = orgAdminUser(fx);
  worker = { id: seed.userId, email: 'user@test.com', name: 'Regular User', role: 'user', tenant_id: seed.tenantId };
  reader = { id: seed.readerId, email: 'reader@test.com', name: 'Reader User', role: 'reader', tenant_id: seed.tenantId };
  otherTenantAdmin = {
    id: seed.orgAdmin2Id,
    email: 'orgadmin2@test.com',
    name: 'Org Admin 2',
    role: 'org_admin',
    tenant_id: seed.tenantId2,
  };
}, 30_000);

// ---------------------------------------------------------------------------
describe('reading arrivals', () => {
  it('lists a pending arrival with its claims, and never the uploader IP or R2 key', async () => {
    const a = await arrive(['Allergen Statement', 'Kosher Letter'], [0, 1]);

    const { status, body } = await list('pending=1');
    expect(status).toBe(200);
    const hit = body.arrivals.find((x) => x.id === a.uploadId)!;
    expect(hit).toBeTruthy();
    // Enqueued on arrival and not yet read by the worker.
    expect(hit.pipeline_state).toBe('extracting');
    expect(hit.queue_id).toBe(a.queueId);
    expect(hit.document_id).toBeNull();
    expect(hit.supplier_name).toBe('Andersen Dairy');
    expect(hit.claims.map((c) => c.line_name)).toEqual(['Allergen Statement', 'Kosher Letter']);
    expect(hit.claims.every((c) => c.claimed_by === 'supplier' && c.decision === null)).toBe(true);
    expect(hit.claims[0].line_id).toBe(a.lineIds[0]);
    expect(hit.pending_count).toBe(2);
    expect(body.pending_total).toBeGreaterThanOrEqual(1);

    const text = JSON.stringify(body) + JSON.stringify((await getOne(a.uploadId)).body);
    expect(text).not.toContain('uploader_ip');
    expect(text).not.toContain('r2_key');
    expect(text).not.toContain(a.r2Key);
  });

  it('lets a reader read, scopes request_id to any version, and 404s another tenant', async () => {
    const a = await arrive(['Organic Certificate']);

    const asReader = await list(`request_id=${a.requestId}`, reader);
    expect(asReader.status).toBe(200);
    expect(asReader.body.arrivals.map((x) => x.id)).toEqual([a.uploadId]);
    expect((await getOne(a.uploadId, reader)).status).toBe(200);

    expect((await getOne(a.uploadId, otherTenantAdmin)).status).toBe(404);
    const fileResp = await fileGet(
      fnContext(`/api/request-uploads/${a.uploadId}/file`, { user: otherTenantAdmin, params: { id: a.uploadId } }),
    );
    expect(fileResp.status).toBe(404);
    const foreignDecide = await decide(
      a.uploadId,
      [{ line_id: a.lineIds[0], decision: 'needs_attention' }],
      otherTenantAdmin,
    );
    expect(foreignDecide.status).toBe(404);
    // Another tenant's request id is not a way in either.
    expect((await list(`request_id=${a.requestId}`, otherTenantAdmin)).status).toBe(404);
  });

  it('finds the arrival a Review Queue item came from', async () => {
    const a = await arrive(['Halal Certificate']);
    const { status, body } = await list(`queue_id=${a.queueId}`, worker);
    expect(status).toBe(200);
    expect(body.arrivals.map((x) => x.id)).toEqual([a.uploadId]);
    expect(body.arrivals[0].claims[0].line_name).toBe('Halal Certificate');
  });

  it('filters the Review Queue by the door an item came through', async () => {
    const a = await arrive(['SQF Certificate']);
    const call = async (q: string) => {
      const resp = await queueList(fnContext(`/api/queue?${q}`, { user: admin }));
      return (await resp.json()) as { items: Array<{ id: string; source: string }> };
    };
    const portalOnly = await call('source=request_link&status=all&limit=200');
    expect(portalOnly.items.some((i) => i.id === a.queueId)).toBe(true);
    expect(portalOnly.items.every((i) => i.source === 'request_link')).toBe(true);
    const emailOnly = await call('source=email&status=all&limit=200');
    expect(emailOnly.items.some((i) => i.id === a.queueId)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('accepting', () => {
  it('refuses to accept before the file is approved, and moves nothing', async () => {
    const a = await arrive(['Allergen Statement']);
    const { status, body } = await decide(a.uploadId, [{ line_id: a.lineIds[0], decision: 'accepted' }]);
    expect(status).toBe(409);
    expect(body.error).toMatch(/Approve this file in the Review Queue first/);

    expect((await lineRow(a.lineIds[0]))!.status).toBe('received');
    const claim = await db
      .prepare('SELECT decision FROM request_upload_lines WHERE upload_id = ?')
      .bind(a.uploadId)
      .first<{ decision: string | null }>();
    expect(claim!.decision).toBeNull();
  });

  it('accepts from the approved document: line, claim, registry link, audits and the supplier count', async () => {
    const a = await arrive(['Allergen Statement', 'Kosher Letter'], [0]);
    const docId = await extractAndApprove(fx, a.queueId, admin);

    expect((await portal(a.token)).progress.required_satisfied).toBe(0);
    const linked = (await getOne(a.uploadId)).body.arrival;
    expect(linked.pipeline_state).toBe('document_linked');
    expect(linked.documents.map((d) => d.id)).toContain(docId);

    const { status, body } = await decide(
      a.uploadId,
      [{ line_id: a.lineIds[0], decision: 'accepted', status_note: 'Signature checked' }],
      worker,
    );
    expect(status).toBe(200);
    expect(body.counts.by_status.accepted).toBe(1);
    expect(body.arrival.pending_count).toBe(0);
    expect(body.arrival.claims[0].decision).toBe('accepted');

    const line = await lineRow(a.lineIds[0]);
    expect(line!.status).toBe('accepted');
    expect(line!.accepted_document_id).toBe(docId);
    expect(line!.status_changed_by).toBe(worker.id);
    expect(line!.status_note).toBe('Signature checked');

    const claim = await db
      .prepare('SELECT * FROM request_upload_lines WHERE upload_id = ? AND line_id = ?')
      .bind(a.uploadId, a.lineIds[0])
      .first<Record<string, any>>();
    expect(claim!.decision).toBe('accepted');
    expect(claim!.decision_document_id).toBe(docId);
    expect(claim!.decided_by).toBe(worker.id);
    expect(claim!.decided_at).toBeTruthy();
    expect(claim!.claimed_by).toBe('supplier');

    const link = await db
      .prepare('SELECT * FROM document_requirements WHERE document_id = ? AND requirement_id = ?')
      .bind(docId, fx.requirementIds[0])
      .first<Record<string, any>>();
    expect(link!.status).toBe('confirmed');
    expect(link!.source).toBe('request_accept');
    expect(link!.confirmed_by).toBe(worker.id);

    const moved = await auditRows('request_line_status_changed', a.requestId);
    expect(moved.at(-1)).toMatchObject({
      line_id: a.lineIds[0],
      from: 'received',
      to: 'accepted',
      via: 'arrival',
      upload_id: a.uploadId,
      document_id: docId,
    });
    expect((await auditRows('request_upload.decided', a.uploadId)).length).toBe(1);
    expect((await auditRows('document_requirement.confirmed_via_request', docId)).length).toBe(1);

    // The supplier's number moves ONLY now, and by exactly one.
    expect((await portal(a.token)).progress.required_satisfied).toBe(1);
  });

  it('promotes a suggested registry link to confirmed', async () => {
    const a = await arrive(['Allergen Statement']);
    const docId = await extractAndApprove(fx, a.queueId, admin);
    await db
      .prepare(
        `INSERT OR REPLACE INTO document_requirements (id, document_id, requirement_id, status, source)
         VALUES (?, ?, ?, 'suggested', 'rule')`,
      )
      .bind(generateTestId(), docId, fx.requirementIds[0])
      .run();

    expect((await decide(a.uploadId, [{ line_id: a.lineIds[0], decision: 'accepted' }])).status).toBe(200);

    const link = await db
      .prepare('SELECT status, source, confirmed_by FROM document_requirements WHERE document_id = ? AND requirement_id = ?')
      .bind(docId, fx.requirementIds[0])
      .first<Record<string, any>>();
    expect(link).toMatchObject({ status: 'confirmed', source: 'rule', confirmed_by: admin.id });
  });

  it('never overrules a human rejection of the registry link — 409, and nothing is written', async () => {
    const a = await arrive(['Allergen Statement', 'Kosher Letter'], [0, 1]);
    const docId = await extractAndApprove(fx, a.queueId, admin);
    // The SECOND line's requirement was rejected for this document by a person.
    await db
      .prepare(
        `INSERT INTO document_requirements (id, document_id, requirement_id, status, source)
         VALUES (?, ?, ?, 'rejected', 'human')`,
      )
      .bind(generateTestId(), docId, fx.requirementIds[1])
      .run();

    const { status, body } = await decide(a.uploadId, [
      { line_id: a.lineIds[0], decision: 'accepted' },
      { line_id: a.lineIds[1], decision: 'accepted' },
    ]);
    expect(status).toBe(409);
    expect(body.error).toMatch(/does not satisfy/);

    // Not even the first, valid line moved.
    expect((await lineRow(a.lineIds[0]))!.status).toBe('received');
    expect((await lineRow(a.lineIds[1]))!.status).toBe('received');
    const links = await db
      .prepare('SELECT requirement_id, status FROM document_requirements WHERE document_id = ?')
      .bind(docId)
      .all<{ requirement_id: string; status: string }>();
    expect(links.results).toEqual([{ requirement_id: fx.requirementIds[1], status: 'rejected' }]);
    const decided = await db
      .prepare('SELECT COUNT(*) AS n FROM request_upload_lines WHERE upload_id = ? AND decision IS NOT NULL')
      .bind(a.uploadId)
      .first<{ n: number }>();
    expect(decided!.n).toBe(0);
  });

  it('records a staff claim for a requirement the supplier did not tick', async () => {
    const a = await arrive(['Allergen Statement', 'Kosher Letter'], [0]);
    await extractAndApprove(fx, a.queueId, admin);

    const { status, body } = await decide(a.uploadId, [{ line_id: a.lineIds[1], decision: 'accepted' }]);
    expect(status).toBe(200);
    const staff = body.arrival.claims.find((c) => c.line_id === a.lineIds[1])!;
    expect(staff.claimed_by).toBe('staff');
    expect(staff.added_by_name).toBe('Org Admin');
    expect(staff.decision).toBe('accepted');
    // The supplier's own claim is still there, still undecided.
    expect(body.arrival.claims.find((c) => c.line_id === a.lineIds[0])!.decision).toBeNull();
    expect((await auditRows('request_upload.claim_added', a.uploadId)).length).toBe(1);
  });

  it('drops an undecided claim out of the inbox once the requirement is settled from another file', async () => {
    const made = await makeRequestFor(fx, ['Allergen Statement']);
    const refs = await refsFor(made.token, made.lineIds);
    await upload(made.token, refs, { name: 'first.pdf' });
    await upload(made.token, refs, { name: 'second.pdf' });
    const ups = await db
      .prepare('SELECT id, queue_id, file_name FROM request_uploads WHERE request_id = ? ORDER BY rowid')
      .bind(made.requestId)
      .all<{ id: string; queue_id: string; file_name: string }>();
    const [first, second] = ups.results!;
    await extractAndApprove(fx, second.queue_id, admin);
    expect((await decide(second.id, [{ line_id: made.lineIds[0], decision: 'accepted' }])).status).toBe(200);

    const inbox = await list('pending=1');
    expect(inbox.body.arrivals.some((x) => x.id === first.id)).toBe(false);
    const history = await list(`request_id=${made.requestId}`);
    const firstInHistory = history.body.arrivals.find((x) => x.id === first.id)!;
    expect(firstInHistory.claims[0].decided_elsewhere).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('sending back and permissions', () => {
  it('sends an item back before approval, and the supplier reads the reason, never the internal note', async () => {
    const a = await arrive(['Allergen Statement']);
    const SUPPLIER_SENTENCE = 'This is the 2023 statement; we need one signed this year.';
    const { status } = await decide(a.uploadId, [
      {
        line_id: a.lineIds[0],
        decision: 'needs_attention',
        attention_reason: SUPPLIER_SENTENCE,
        status_note: INTERNAL_NOTE,
      },
    ]);
    expect(status).toBe(200);

    const line = await lineRow(a.lineIds[0]);
    expect(line!.status).toBe('needs_attention');
    expect(line!.accepted_document_id).toBeNull();

    const view = await portal(a.token);
    expect(view.items[0].status).toBe('needs_attention');
    expect(view.items[0].attention_reason).toBe(SUPPLIER_SENTENCE);
    expect(JSON.stringify(view)).not.toContain(INTERNAL_NOTE);
    expect(view.progress.required_satisfied).toBe(0);
  });

  it('falls back to a composed sentence when the reason is left blank', async () => {
    const a = await arrive(['Allergen Statement']);
    expect(
      (await decide(a.uploadId, [{ line_id: a.lineIds[0], decision: 'needs_attention', attention_reason: '  ' }])).status,
    ).toBe(200);
    const view = await portal(a.token);
    expect(view.items[0].attention_reason).toMatch(/not able to accept/);
  });

  it('refuses a reader, allows a user, and refuses a cancelled ask', async () => {
    const a = await arrive(['Allergen Statement']);
    const asReader = await decide(a.uploadId, [{ line_id: a.lineIds[0], decision: 'needs_attention' }], reader);
    expect(asReader.status).toBe(403);
    const asUser = await decide(a.uploadId, [{ line_id: a.lineIds[0], decision: 'needs_attention' }], worker);
    expect(asUser.status).toBe(200);

    const b = await arrive(['Kosher Letter']);
    await db
      .prepare(`UPDATE document_requests SET status = 'cancelled' WHERE id = ?`)
      .bind(b.requestId)
      .run();
    const cancelled = await decide(b.uploadId, [{ line_id: b.lineIds[0], decision: 'needs_attention' }]);
    expect(cancelled.status).toBe(409);
    // And a cancelled ask is not in the inbox.
    expect((await list('pending=1')).body.arrivals.some((x) => x.id === b.uploadId)).toBe(false);
  });

  it('403s the new prefix when the library module is switched off', async () => {
    const [, , gate] = middleware;
    await db
      .prepare('INSERT INTO tenant_modules (tenant_id, module_key, enabled) VALUES (?, ?, 0)')
      .bind(seed.tenantId, 'library')
      .run();
    try {
      const resp = await gate({
        request: new Request('http://localhost/api/request-uploads?pending=1'),
        env,
        data: { user: worker },
        params: {},
        waitUntil: () => {},
        passThroughOnException: () => {},
        next: async () => new Response('reached', { status: 200 }),
        functionPath: '/api/request-uploads',
      } as never);
      expect(resp.status).toBe(403);
    } finally {
      await db.prepare('DELETE FROM tenant_modules WHERE tenant_id = ?').bind(seed.tenantId).run();
    }
  });
});

// ---------------------------------------------------------------------------
describe('amendments, re-uploads and files', () => {
  it('decides with a current-version line id after an amendment, and carries the document through another', async () => {
    const a = await arrive(['Allergen Statement', 'Kosher Letter'], [0]);
    const docId = await extractAndApprove(fx, a.queueId, admin);

    const v2 = await amendRequest(db, fx.tenantId, a.requestId, admin as never, {
      amendment_reason: 'Deadline moved',
      due_date: '2027-02-01',
    });
    const v2Lines = await db
      .prepare('SELECT id, requirement_id FROM request_lines WHERE request_id = ?')
      .bind(v2)
      .all<{ id: string; requirement_id: string }>();
    const v2Allergen = v2Lines.results!.find((l) => l.requirement_id === fx.requirementIds[0])!;
    expect(v2Allergen.id).not.toBe(a.lineIds[0]);

    // The OLD id is not on the current version any more.
    expect((await decide(a.uploadId, [{ line_id: a.lineIds[0], decision: 'accepted' }])).status).toBe(400);

    const arrival = (await getOne(a.uploadId)).body.arrival;
    expect(arrival.current_request_id).toBe(v2);
    expect(arrival.claims[0].line_id).toBe(v2Allergen.id);
    expect(arrival.claims[0].claimed_line_id).toBe(a.lineIds[0]);

    const res = await decide(a.uploadId, [{ line_id: v2Allergen.id, decision: 'accepted' }]);
    expect(res.status).toBe(200);
    // The decision was written to the claim the supplier actually made.
    const claim = await db
      .prepare('SELECT decision FROM request_upload_lines WHERE upload_id = ? AND line_id = ?')
      .bind(a.uploadId, a.lineIds[0])
      .first<{ decision: string }>();
    expect(claim!.decision).toBe('accepted');

    const v3 = await amendRequest(db, fx.tenantId, v2, admin as never, { amendment_reason: 'Title typo' });
    const v3Allergen = await db
      .prepare('SELECT status, accepted_document_id FROM request_lines WHERE request_id = ? AND requirement_id = ?')
      .bind(v3, fx.requirementIds[0])
      .first<{ status: string; accepted_document_id: string | null }>();
    expect(v3Allergen).toEqual({ status: 'accepted', accepted_document_id: docId });
  });

  it('reopens an accepted line when the supplier sends a newer file, and drops its document', async () => {
    const a = await arrive(['Allergen Statement']);
    await extractAndApprove(fx, a.queueId, admin);
    expect((await decide(a.uploadId, [{ line_id: a.lineIds[0], decision: 'accepted' }])).status).toBe(200);
    expect((await lineRow(a.lineIds[0]))!.accepted_document_id).toBeTruthy();

    await upload(a.token, await refsFor(a.token, a.lineIds), { name: 'newer.pdf' });
    const line = await lineRow(a.lineIds[0]);
    expect(line!.status).toBe('received');
    expect(line!.accepted_document_id).toBeNull();
  });

  it('serves the file from the document once approval has moved the bytes, and 410s when there are none', async () => {
    const a = await arrive(['Allergen Statement']);
    await extractAndApprove(fx, a.queueId, admin);
    // Approval copies the upload's object under a document key, then deletes it.
    expect(await env.FILES.head(a.r2Key)).toBeNull();

    const resp = await fileGet(
      fnContext(`/api/request-uploads/${a.uploadId}/file`, { user: reader, params: { id: a.uploadId } }),
    );
    expect(resp.status).toBe(200);
    expect(resp.headers.get('X-File-Source')).toBe('document');
    expect((await resp.arrayBuffer()).byteLength).toBeGreaterThan(0);

    const b = await arrive(['Kosher Letter']);
    const fromUpload = await fileGet(
      fnContext(`/api/request-uploads/${b.uploadId}/file`, { user: admin, params: { id: b.uploadId } }),
    );
    expect(fromUpload.status).toBe(200);
    expect(fromUpload.headers.get('X-File-Source')).toBe('upload');
    await fromUpload.arrayBuffer();

    await env.FILES.delete(b.r2Key);
    const gone = await fileGet(
      fnContext(`/api/request-uploads/${b.uploadId}/file`, { user: admin, params: { id: b.uploadId } }),
    );
    expect(gone.status).toBe(410);
  });

  it('enqueues a file nobody read, once', async () => {
    const a = await arrive(['Allergen Statement']);
    // Simulate the enqueue failure the upload door tolerates: no queue item
    // was ever made. (Leaving the original item in place would make this file
    // an exact duplicate of one already waiting, which since 0107 links the
    // arrival to that item instead of queueing it again.)
    await db.prepare('UPDATE request_uploads SET queue_id = NULL WHERE id = ?').bind(a.uploadId).run();
    await db.prepare('DELETE FROM processing_queue WHERE id = ?').bind(a.queueId).run();
    expect((await getOne(a.uploadId)).body.arrival.pipeline_state).toBe('not_read');

    const call = (as: TestUser) =>
      enqueuePost(
        fnContext(`/api/request-uploads/${a.uploadId}/enqueue`, { method: 'POST', user: as, params: { id: a.uploadId } }),
      );
    expect((await call(worker)).status).toBe(403);

    const first = await call(admin);
    expect(first.status).toBe(200);
    const body = (await first.json()) as { arrival: RequestArrival };
    expect(body.arrival.queue_id).toBeTruthy();
    expect(body.arrival.queue_id).not.toBe(a.queueId);
    expect(body.arrival.pipeline_state).toBe('extracting');

    expect((await call(admin)).status).toBe(409);
  });
});
