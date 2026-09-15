/**
 * Exact-duplicate detection at intake (migration 0107).
 *
 * The contract, per case, across the doors:
 *   1. identical to an APPROVED file -> no new review card; a ledger row links
 *      the arrival to the existing document; the document can list it.
 *   2. identical to a file WAITING in the queue -> no second card; the waiting
 *      card lists "also received".
 *   3. identical to a REJECTED file -> queued normally, with the rejection on
 *      the card.
 * Plus: "Review anyway" enqueues and audits; the supplier portal still tells
 * the supplier their file was received and links the arrival for staff; same
 * bytes in ANOTHER tenant are not a duplicate; the ingest API is unchanged.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { seedTestData, generateTestId } from '../helpers/db';
import { computeChecksum } from '../../functions/lib/r2';
import { onRequestPost as processPost } from '../../functions/api/documents/process';
import { onRequestPost as emailWebhookPost } from '../../functions/api/webhooks/email-ingest';
import { onRequestPost as dropPost } from '../../functions/api/sources/[id]/drop';
import { onRequestPost as ingestPost } from '../../functions/api/documents/ingest';
import { onRequestGet as duplicatesGet } from '../../functions/api/intake-duplicates/index';
import { onRequestPost as reviewAnywayPost } from '../../functions/api/intake-duplicates/[id]/review';
import { onRequestGet as queueGet } from '../../functions/api/queue/index';
import { onRequestGet as queueItemGet } from '../../functions/api/queue/[id]';
import {
  extractAndApprove,
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
import type {
  IntakeDuplicateListResponse,
  IntakeDuplicateReviewResponse,
  ProcessingQueueItem,
  QueuedResponse,
  SupplierUploadResult,
} from '../../shared/types';

// Audit tool (plain CJS) — exercised against the same seeded database.
// @ts-expect-error — plain CJS module, no types.
import auditLib from '../../bin/lib/duplicateDocumentsAudit.js';

const db = env.DB;
let seed: Awaited<ReturnType<typeof seedTestData>>;
let supplierId = '';
let requirementIds: string[] = [];
let userA: TestUser;

function uniquePdf(label = ''): Uint8Array {
  return new TextEncoder().encode(`%PDF-1.4\n%${label} ${crypto.randomUUID()}\n`);
}

async function checksumOf(bytes: Uint8Array): Promise<string> {
  return computeChecksum(bytes.slice().buffer as ArrayBuffer);
}

function fixture(): RequestFixture {
  return { tenantId: seed.tenantId, orgAdminId: seed.orgAdminId, supplierId, requirementIds };
}

/** An approved document in `tenantId` whose version is exactly these bytes. */
async function seedApprovedDocument(tenantId: string, createdBy: string, bytes: Uint8Array, title = 'Approved COA') {
  const docId = generateTestId();
  await db
    .prepare(
      `INSERT INTO documents (id, tenant_id, title, current_version, status, created_by)
       VALUES (?, ?, ?, 1, 'active', ?)`,
    )
    .bind(docId, tenantId, title, createdBy)
    .run();
  await db
    .prepare(
      `INSERT INTO document_versions (id, document_id, version_number, file_name, file_size, mime_type, r2_key, checksum, uploaded_by)
       VALUES (?, ?, 1, 'approved.pdf', ?, 'application/pdf', ?, ?, ?)`,
    )
    .bind(generateTestId(), docId, bytes.byteLength, `docs/${docId}/approved.pdf`, await checksumOf(bytes), createdBy)
    .run();
  return docId;
}

async function queueRowsFor(checksum: string) {
  const r = await db
    .prepare('SELECT id, status, source FROM processing_queue WHERE checksum = ? ORDER BY created_at, rowid')
    .bind(checksum)
    .all<{ id: string; status: string; source: string }>();
  return r.results ?? [];
}

async function ledgerFor(checksum: string) {
  const r = await db
    .prepare('SELECT * FROM intake_duplicates WHERE checksum = ? ORDER BY received_at, rowid')
    .bind(checksum)
    .all<Record<string, unknown>>();
  return r.results ?? [];
}

// ---- doors -----------------------------------------------------------------

async function smartUpload(bytes: Uint8Array, name = 'upload.pdf', tenantId = seed.tenantId, user = userA) {
  const form = new FormData();
  form.append('tenant_id', tenantId);
  form.append('files', new Blob([bytes], { type: 'application/pdf' }), name);
  const resp = await processPost(
    fnContext('/api/documents/process', { method: 'POST', body: form, user }),
  );
  return { status: resp.status, body: (await readJson(resp)) as QueuedResponse };
}

async function emailIngest(bytes: Uint8Array, name = 'mail.pdf') {
  const form = new FormData();
  form.append('sender', 'vendor@dupes.example.com');
  form.append('subject', 'FW: COA');
  form.append('attachment-1', new Blob([bytes], { type: 'application/pdf' }), name);
  const resp = await emailWebhookPost(fnContext('/api/webhooks/email-ingest', { method: 'POST', body: form }));
  return (await readJson(resp)) as { results: Array<{ status: string; queueId?: string; intakeDuplicateId?: string }> };
}

let connectorId = '';
async function drop(bytes: Uint8Array, name = 'drop.pdf') {
  const form = new FormData();
  form.append('file', new File([bytes], name, { type: 'application/pdf' }));
  const resp = await dropPost(
    fnContext(`/api/sources/${connectorId}/drop`, {
      method: 'POST',
      body: form,
      headers: { authorization: 'Bearer dupes-token' },
      params: { id: connectorId },
    }),
  );
  return { status: resp.status, body: (await readJson(resp)) as Record<string, any> };
}

async function listDuplicates(query: string, user = userA) {
  const resp = await duplicatesGet(fnContext(`/api/intake-duplicates?${query}`, { user }));
  return { status: resp.status, body: (await readJson(resp)) as IntakeDuplicateListResponse };
}

async function reviewAnyway(id: string, user = userA) {
  const resp = await reviewAnywayPost(
    fnContext(`/api/intake-duplicates/${id}/review`, { method: 'POST', user, params: { id } }),
  );
  return { status: resp.status, body: (await readJson(resp)) as IntakeDuplicateReviewResponse & { error?: string } };
}

async function getQueueItem(id: string, user = userA) {
  const resp = await queueItemGet(fnContext(`/api/queue/${id}`, { user, params: { id } }));
  return ((await readJson(resp)) as { item: ProcessingQueueItem }).item;
}

async function rejectQueueItem(id: string) {
  await db
    .prepare(
      `UPDATE processing_queue SET status = 'rejected', reviewed_at = datetime('now'),
              reviewed_by = ?, rejection_reason = 'wrong_document_type', rejection_note = 'not a COA'
        WHERE id = ?`,
    )
    .bind(seed.orgAdminId, id)
    .run();
}

beforeAll(async () => {
  seed = await seedTestData(db);
  userA = orgAdminUser({ tenantId: seed.tenantId, orgAdminId: seed.orgAdminId });

  supplierId = generateTestId();
  await db
    .prepare('INSERT INTO suppliers (id, tenant_id, name, slug) VALUES (?, ?, ?, ?)')
    .bind(supplierId, seed.tenantId, 'Edaleen Dairy', `edaleen-${supplierId.slice(0, 6)}`)
    .run();
  requirementIds = [];
  for (let i = 0; i < 3; i += 1) {
    const id = generateTestId();
    requirementIds.push(id);
    await db
      .prepare('INSERT INTO requirements (id, tenant_id, slug, name, active) VALUES (?, ?, ?, ?, 1)')
      .bind(id, seed.tenantId, `req-dup-${i}-${id.slice(0, 6)}`, `Requirement ${i}`)
      .run();
  }

  // Legacy email webhook: its mapping table is recreated by its own test too.
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS email_domain_mappings (
        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
        domain TEXT NOT NULL,
        tenant_id TEXT NOT NULL REFERENCES tenants(id),
        default_user_id TEXT REFERENCES users(id),
        default_document_type_id TEXT,
        active INTEGER DEFAULT 1,
        created_at TEXT DEFAULT (datetime('now')),
        UNIQUE(domain)
      )`,
    )
    .run();
  const docTypeId = generateTestId();
  await db
    .prepare(`INSERT INTO document_types (id, tenant_id, name, slug, active) VALUES (?, ?, 'Dupes DocType', ?, 1)`)
    .bind(docTypeId, seed.tenantId, `dupes-dt-${docTypeId.slice(0, 6)}`)
    .run();
  await db
    .prepare(
      `INSERT INTO email_domain_mappings (id, tenant_id, domain, default_user_id, default_document_type_id, active)
       VALUES (?, ?, 'dupes.example.com', ?, ?, 1)`,
    )
    .bind(generateTestId(), seed.tenantId, seed.userId, docTypeId)
    .run();

  connectorId = generateTestId();
  await db
    .prepare(
      `INSERT INTO connectors (id, tenant_id, name, slug, config, field_mappings, active, api_token, created_at, updated_at)
       VALUES (?, ?, 'Dupes Feed', ?, '{}', '{}', 1, 'dupes-token', datetime('now'), datetime('now'))`,
    )
    .bind(connectorId, seed.tenantId, `dupes-${connectorId.slice(0, 8)}`)
    .run();
}, 30_000);

// ---------------------------------------------------------------------------

describe('smart upload', () => {
  it('case 1: a file identical to an approved document makes no card and links to it', async () => {
    const bytes = uniquePdf('smart-1');
    const docId = await seedApprovedDocument(seed.tenantId, seed.orgAdminId, bytes, 'Edaleen 2.5-Gal COA');
    const ck = await checksumOf(bytes);

    const { status, body } = await smartUpload(bytes, 'again.pdf');
    expect(status).toBe(200);
    expect(body.items[0].id).toBe('');
    expect(body.items[0].intake_duplicate?.match_kind).toBe('already_approved');
    expect(body.items[0].intake_duplicate?.matched_document_id).toBe(docId);
    expect(body.items[0].duplicate?.document_title).toBe('Edaleen 2.5-Gal COA');
    expect(await queueRowsFor(ck)).toHaveLength(0);

    const ledger = await ledgerFor(ck);
    expect(ledger).toHaveLength(1);
    expect(ledger[0].matched_document_id).toBe(docId);
    expect(ledger[0].queue_id).toBeNull();
    expect(ledger[0].created_by).toBe(seed.orgAdminId);

    const audit = await db
      .prepare(`SELECT details FROM audit_log WHERE action = 'intake.duplicate_suppressed' AND resource_id = ?`)
      .bind(ledger[0].id)
      .first<{ details: string }>();
    expect(JSON.parse(audit!.details).matched_document_id).toBe(docId);

    // The document page's list.
    const list = await listDuplicates(`document_id=${docId}`);
    expect(list.status).toBe(200);
    expect(list.body.duplicates.map((d) => d.id)).toEqual([ledger[0].id]);
    expect(list.body.duplicates[0].matched_document_title).toBe('Edaleen 2.5-Gal COA');
    expect(list.body.duplicates[0].file_name).toBe('again.pdf');
  });

  it('case 2: a file identical to one waiting makes no second card and the waiting card says so', async () => {
    const bytes = uniquePdf('smart-2');
    const ck = await checksumOf(bytes);
    const first = await smartUpload(bytes, 'first.pdf');
    const firstId = first.body.items[0].id;
    expect(firstId).toBeTruthy();

    const second = await smartUpload(bytes, 'second.pdf');
    expect(second.body.items[0].id).toBe('');
    expect(second.body.items[0].intake_duplicate?.match_kind).toBe('already_waiting');
    expect(second.body.items[0].intake_duplicate?.matched_queue_id).toBe(firstId);
    expect(await queueRowsFor(ck)).toHaveLength(1);

    const item = await getQueueItem(firstId);
    expect(item.intake_history?.also_received).toHaveLength(1);
    expect(item.intake_history?.also_received[0].file_name).toBe('second.pdf');
    expect(item.intake_history?.also_received[0].source).toBe('import');

    // Same on the list read the Review Queue uses.
    const resp = await queueGet(fnContext('/api/queue?status=pending&limit=200', { user: userA }));
    const listed = ((await readJson(resp)) as { items: ProcessingQueueItem[] }).items.find((i) => i.id === firstId);
    expect(listed?.intake_history?.also_received).toHaveLength(1);
  });

  it('case 3: a file identical to a rejected one is queued, carrying the rejection', async () => {
    const bytes = uniquePdf('smart-3');
    const ck = await checksumOf(bytes);
    const first = await smartUpload(bytes, 'rejected.pdf');
    await rejectQueueItem(first.body.items[0].id);

    const again = await smartUpload(bytes, 'resent.pdf');
    const newId = again.body.items[0].id;
    expect(newId).toBeTruthy();
    expect(again.body.items[0].previously_rejected?.rejection_reason).toBe('wrong_document_type');
    expect(await queueRowsFor(ck)).toHaveLength(2);
    expect(await ledgerFor(ck)).toHaveLength(0);

    const item = await getQueueItem(newId);
    expect(item.intake_history?.previously_rejected?.queue_id).toBe(first.body.items[0].id);
    expect(item.intake_history?.previously_rejected?.rejection_note).toBe('not a COA');

    const audit = await db
      .prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'intake.previously_rejected_file' AND resource_id = ?`)
      .bind(newId)
      .first<{ n: number }>();
    expect(audit?.n).toBe(1);
  });

  it('an approved queue item with page-scoped documents still counts as approved (records COA)', async () => {
    const bytes = uniquePdf('records');
    const ck = await checksumOf(bytes);
    const queueId = generateTestId();
    await db
      .prepare(
        `INSERT INTO processing_queue (id, tenant_id, file_r2_key, file_name, file_size, mime_type, status, processing_status, checksum)
         VALUES (?, ?, 'pending/x/records.pdf', 'records.pdf', 10, 'application/pdf', 'approved', 'ready', ?)`,
      )
      .bind(queueId, seed.tenantId, ck)
      .run();
    // The sublot document carries ITS OWN page's checksum, not the file's.
    const docId = await seedApprovedDocument(seed.tenantId, seed.orgAdminId, uniquePdf('page'), 'Sublot 2614A');
    await db.prepare('UPDATE documents SET external_ref = ? WHERE id = ?').bind(`queue-${queueId}-2614A`, docId).run();

    const again = await smartUpload(bytes, 'records-again.pdf');
    expect(again.body.items[0].intake_duplicate?.match_kind).toBe('already_approved');
    expect(again.body.items[0].intake_duplicate?.matched_document_id).toBe(docId);
    expect(again.body.items[0].intake_duplicate?.matched_queue_id).toBe(queueId);
    expect(await queueRowsFor(ck)).toHaveLength(1);
  });
});

describe('email ingest (webhook)', () => {
  it('cases 1, 2 and 3', async () => {
    // 1
    const approvedBytes = uniquePdf('email-1');
    const docId = await seedApprovedDocument(seed.tenantId, seed.orgAdminId, approvedBytes);
    const r1 = await emailIngest(approvedBytes);
    expect(r1.results[0].status).toBe('duplicate');
    expect(await queueRowsFor(await checksumOf(approvedBytes))).toHaveLength(0);
    const l1 = await ledgerFor(await checksumOf(approvedBytes));
    expect(l1[0].matched_document_id).toBe(docId);
    expect(l1[0].source).toBe('email');

    // 2 — the forwarded-twice case this exists for.
    const fwd = uniquePdf('email-2');
    const a = await emailIngest(fwd, 'COA.pdf');
    expect(a.results[0].status).toBe('queued');
    const b = await emailIngest(fwd, 'COA.pdf');
    expect(b.results[0].status).toBe('duplicate');
    const rows = await queueRowsFor(await checksumOf(fwd));
    expect(rows).toHaveLength(1);
    expect((await ledgerFor(await checksumOf(fwd)))[0].matched_queue_id).toBe(rows[0].id);

    // 3
    const rej = uniquePdf('email-3');
    const c = await emailIngest(rej);
    await rejectQueueItem(c.results[0].queueId!);
    const d = await emailIngest(rej);
    expect(d.results[0].status).toBe('queued');
    expect(await queueRowsFor(await checksumOf(rej))).toHaveLength(2);
  });
});

describe('connector drop', () => {
  it('cases 1, 2 and 3, and a suppressed run does not stay running', async () => {
    const approvedBytes = uniquePdf('drop-1');
    await seedApprovedDocument(seed.tenantId, seed.orgAdminId, approvedBytes);
    const d1 = await drop(approvedBytes);
    expect(d1.status).toBe(200);
    expect(d1.body.queued).toBe(true);
    expect(d1.body.queue_id).toBeNull();
    expect(d1.body.duplicate).toEqual({ received_again: true, match_kind: 'already_approved' });
    // No document title crosses to a partner.
    expect(JSON.stringify(d1.body)).not.toContain('Approved COA');
    const run = await db
      .prepare('SELECT status FROM connector_runs WHERE id = ?')
      .bind(d1.body.run_id)
      .first<{ status: string }>();
    expect(run?.status).toBe('success');

    const waitingBytes = uniquePdf('drop-2');
    const w1 = await drop(waitingBytes);
    expect(w1.body.queue_id).toBeTruthy();
    const w2 = await drop(waitingBytes);
    expect(w2.body.queue_id).toBeNull();
    expect(w2.body.duplicate.match_kind).toBe('already_waiting');
    expect(await queueRowsFor(await checksumOf(waitingBytes))).toHaveLength(1);

    const rejBytes = uniquePdf('drop-3');
    const x1 = await drop(rejBytes);
    await rejectQueueItem(x1.body.queue_id);
    const x2 = await drop(rejBytes);
    expect(x2.body.queue_id).toBeTruthy();
    expect(x2.body.duplicate).toBeUndefined();
  });

  it('"Review anyway" replays the connector enqueue into the same run and reopens it', async () => {
    const bytes = uniquePdf('drop-review');
    await seedApprovedDocument(seed.tenantId, seed.orgAdminId, bytes);
    const d = await drop(bytes, 'replay.pdf');
    const ledger = await ledgerFor(await checksumOf(bytes));
    const res = await reviewAnyway(String(ledger[0].id));
    expect(res.status).toBe(200);
    const q = await db
      .prepare('SELECT source, source_id, connector_run_id, file_r2_key FROM processing_queue WHERE id = ?')
      .bind(res.body.queue_id)
      .first<Record<string, string>>();
    expect(q?.source).toBe('api');
    expect(q?.source_id).toBe(connectorId);
    expect(q?.connector_run_id).toBe(d.body.run_id);
    expect(q?.file_r2_key).toBe(d.body.file_key);
    const run = await db
      .prepare('SELECT status FROM connector_runs WHERE id = ?')
      .bind(d.body.run_id)
      .first<{ status: string }>();
    expect(run?.status).toBe('running');
  });
});

describe('"Review anyway"', () => {
  it('enqueues the file, stamps who and when, audits, and refuses a second time', async () => {
    const bytes = uniquePdf('review');
    const docId = await seedApprovedDocument(seed.tenantId, seed.orgAdminId, bytes);
    await smartUpload(bytes, 'look-again.pdf');
    const [row] = await ledgerFor(await checksumOf(bytes));

    const open = await listDuplicates('state=open&limit=200');
    expect(open.body.duplicates.some((d) => d.id === row.id)).toBe(true);

    const res = await reviewAnyway(String(row.id));
    expect(res.status).toBe(200);
    expect(res.body.queue_id).toBeTruthy();
    expect(res.body.duplicate.queue_id).toBe(res.body.queue_id);
    expect(res.body.duplicate.overridden_by).toBe(seed.orgAdminId);
    expect(res.body.duplicate.overridden_at).toBeTruthy();

    const q = await db
      .prepare('SELECT status, checksum, file_name FROM processing_queue WHERE id = ?')
      .bind(res.body.queue_id)
      .first<Record<string, string>>();
    expect(q?.status).toBe('pending');
    expect(q?.file_name).toBe('look-again.pdf');

    const audit = await db
      .prepare(`SELECT user_id, details FROM audit_log WHERE action = 'intake_duplicate.review_anyway' AND resource_id = ?`)
      .bind(row.id)
      .first<{ user_id: string; details: string }>();
    expect(audit?.user_id).toBe(seed.orgAdminId);
    expect(JSON.parse(audit!.details).queue_id).toBe(res.body.queue_id);

    // The new card knows why it exists.
    const item = await getQueueItem(res.body.queue_id);
    expect(item.intake_history?.sent_anyway?.matched_document_id).toBe(docId);
    expect(item.intake_history?.identical_documents.map((d) => d.id)).toContain(docId);

    const again = await reviewAnyway(String(row.id));
    expect(again.status).toBe(409);
    const reviewed = await listDuplicates('state=reviewed&limit=200');
    expect(reviewed.body.duplicates.some((d) => d.id === row.id)).toBe(true);
  });

  it('is refused to a reader, and 410s when the stored file is gone', async () => {
    const bytes = uniquePdf('gone');
    await seedApprovedDocument(seed.tenantId, seed.orgAdminId, bytes);
    await smartUpload(bytes);
    const [row] = await ledgerFor(await checksumOf(bytes));

    const reader: TestUser = { id: seed.readerId, email: 'r@test.com', name: 'Reader', role: 'reader', tenant_id: seed.tenantId };
    expect((await reviewAnyway(String(row.id), reader)).status).toBe(403);

    await env.FILES.delete(String(row.file_r2_key));
    expect((await reviewAnyway(String(row.id))).status).toBe(410);
    const still = await db.prepare('SELECT queue_id, overridden_at FROM intake_duplicates WHERE id = ?').bind(row.id).first<Record<string, unknown>>();
    expect(still?.queue_id).toBeNull();
    expect(still?.overridden_at).toBeNull();
  });
});

describe('tenant isolation', () => {
  it('the same bytes in another tenant are not a duplicate, and its ledger is invisible', async () => {
    const bytes = uniquePdf('tenant');
    const ck = await checksumOf(bytes);
    await seedApprovedDocument(seed.tenantId2, seed.orgAdmin2Id, bytes);

    const { body } = await smartUpload(bytes, 'mine.pdf');
    expect(body.items[0].id).toBeTruthy();
    expect(body.items[0].intake_duplicate).toBeNull();
    expect(await ledgerFor(ck)).toHaveLength(0);

    // A tenant-2 duplicate row is not listed or reviewable from tenant 1.
    const user2: TestUser = { id: seed.orgAdmin2Id, email: 'o2@test.com', name: 'Org Admin 2', role: 'org_admin', tenant_id: seed.tenantId2 };
    await smartUpload(bytes, 'theirs.pdf', seed.tenantId2, user2);
    const [row] = await ledgerFor(ck);
    expect(row.tenant_id).toBe(seed.tenantId2);
    const mine = await listDuplicates('limit=200');
    expect(mine.body.duplicates.some((d) => d.id === row.id)).toBe(false);
    expect((await reviewAnyway(String(row.id))).status).toBe(404);
  });
});

describe('supplier portal', () => {
  it('case 1: the supplier sees it received; the arrival is linked to the existing document for staff', async () => {
    const content = uniquePdf('portal-1');
    const { token, lineIds } = await makeRequestFor(fixture(), ['Allergen statement']);
    const refs = await refsFor(token, lineIds);
    await upload(token, refs, { content, name: 'allergen.pdf' });
    const firstUpload = await db
      .prepare('SELECT queue_id FROM request_uploads WHERE r2_key LIKE ? ORDER BY rowid DESC LIMIT 1')
      .bind('%allergen.pdf')
      .first<{ queue_id: string }>();
    const docId = await extractAndApprove(fixture(), firstUpload!.queue_id, userA);

    // A later ask, the same file sent again.
    const second = await makeRequestFor(fixture(), ['Allergen statement']);
    const resp = await upload(second.token, await refsFor(second.token, second.lineIds), { content, name: 'allergen-again.pdf' });
    expect(resp.status).toBe(200);
    expect((resp.body as SupplierUploadResult).covered_count).toBe(1);
    // Nothing about our records crosses to the supplier.
    expect(JSON.stringify(resp.body)).not.toContain(docId);

    const arrival = await db
      .prepare('SELECT id, document_id, queue_id FROM request_uploads WHERE request_id = ?')
      .bind(second.requestId)
      .first<{ id: string; document_id: string | null; queue_id: string | null }>();
    expect(arrival?.document_id).toBe(docId);
    expect(arrival?.queue_id).toBeNull();
    const line = await db.prepare('SELECT status FROM request_lines WHERE id = ?').bind(second.lineIds[0]).first<{ status: string }>();
    expect(line?.status).toBe('received');
    expect(await queueRowsFor(await checksumOf(content))).toHaveLength(1);

    const [row] = await ledgerFor(await checksumOf(content));
    expect(row.request_upload_id).toBe(arrival!.id);
    expect(row.source).toBe('request_link');

    // "Review anyway" re-points the arrival at the new review, since nobody has decided it.
    const res = await reviewAnyway(String(row.id));
    expect(res.status).toBe(200);
    const after = await db
      .prepare('SELECT document_id, queue_id FROM request_uploads WHERE id = ?')
      .bind(arrival!.id)
      .first<{ document_id: string | null; queue_id: string | null }>();
    expect(after?.queue_id).toBe(res.body.queue_id);
    expect(after?.document_id).toBeNull();
  });

  it('case 2: a second arrival follows the waiting item and is linked when it is approved', async () => {
    const content = uniquePdf('portal-2');
    const { token, lineIds } = await makeRequestFor(fixture(), ['Insurance']);
    const refs = await refsFor(token, lineIds);
    await upload(token, refs, { content, name: 'coi.pdf' });
    await upload(token, refs, { content, name: 'coi.pdf' });
    const ups = await db
      .prepare('SELECT id, queue_id FROM request_uploads WHERE link_id IN (SELECT id FROM request_links WHERE root_request_id = (SELECT root_request_id FROM request_lines rl JOIN document_requests dr ON dr.id = rl.request_id WHERE rl.id = ?)) ORDER BY uploaded_at, rowid')
      .bind(lineIds[0])
      .all<{ id: string; queue_id: string }>();
    const rows = ups.results ?? [];
    expect(rows).toHaveLength(2);
    expect(rows[0].queue_id).toBeTruthy();
    expect(rows[1].queue_id).toBe(rows[0].queue_id);
    expect(await queueRowsFor(await checksumOf(content))).toHaveLength(1);

    await markExtracted(fixture(), rows[0].queue_id);
    const approved = await queuePut(rows[0].queue_id, { status: 'approved', fields: { lot_number: 'L-1' }, supplier_id: supplierId }, userA);
    expect(approved.status).toBe(200);
    const linked = await db
      .prepare('SELECT document_id FROM request_uploads WHERE id IN (?, ?)')
      .bind(rows[0].id, rows[1].id)
      .all<{ document_id: string | null }>();
    expect((linked.results ?? []).every((r) => !!r.document_id)).toBe(true);
  });

  it('case 3: a file identical to a rejected one is queued, and the card carries the rejection', async () => {
    const content = uniquePdf('portal-3');
    const { token, lineIds } = await makeRequestFor(fixture(), ['Spec sheet']);
    const refs = await refsFor(token, lineIds);
    await upload(token, refs, { content, name: 'sales-sheet.pdf' });
    const [first] = await queueRowsFor(await checksumOf(content));
    await rejectQueueItem(first.id);

    await upload(token, refs, { content, name: 'sales-sheet.pdf' });
    const rows = await queueRowsFor(await checksumOf(content));
    expect(rows).toHaveLength(2);
    const item = await getQueueItem(rows[1].id);
    expect(item.intake_history?.previously_rejected?.queue_id).toBe(first.id);
  });
});

describe('POST /api/documents/ingest is not an intake-queue door', () => {
  it('still adds a version for an identical file, and records no duplicate', async () => {
    const bytes = uniquePdf('ingest');
    const call = async () => {
      const form = new FormData();
      form.append('tenant_id', seed.tenantId);
      form.append('external_ref', 'dupes-ext-1');
      form.append('file', new Blob([bytes], { type: 'application/pdf' }), 'ingest.pdf');
      const resp = await ingestPost(fnContext('/api/documents/ingest', { method: 'POST', body: form, user: userA }));
      return { status: resp.status, body: (await readJson(resp)) as Record<string, any> };
    };
    const a = await call();
    const b = await call();
    expect([200, 201]).toContain(a.status);
    expect([200, 201]).toContain(b.status);
    const versions = await db
      .prepare(`SELECT COUNT(*) AS n FROM document_versions dv JOIN documents d ON d.id = dv.document_id WHERE d.external_ref = 'dupes-ext-1'`)
      .first<{ n: number }>();
    expect(versions?.n).toBe(2);
    expect(await ledgerFor(await checksumOf(bytes))).toHaveLength(0);
  });
});

describe('bin/audit-duplicate-documents grouping', () => {
  it('reports same-file copies from different arrivals, with their links, and not one-file splits', async () => {
    const t = seed.tenantId2;
    const by = seed.orgAdmin2Id;
    // Two arrivals of one file, both approved into documents.
    const bytes = uniquePdf('audit');
    const ck = await checksumOf(bytes);
    const q1 = generateTestId();
    const q2 = generateTestId();
    for (const [qid, at] of [[q1, '2026-06-01 10:00:00'], [q2, '2026-06-01 10:20:00']]) {
      await db
        .prepare(
          `INSERT INTO processing_queue (id, tenant_id, file_r2_key, file_name, file_size, mime_type, status, processing_status, checksum, reviewed_at, source)
           VALUES (?, ?, 'k', '042026-14OLY.pdf', 1, 'application/pdf', 'approved', 'ready', ?, ?, 'email')`,
        )
        .bind(qid, t, ck, at)
        .run();
    }
    const docFirst = await seedApprovedDocument(t, by, bytes, '042026-14OLY 2.5-Gal COA');
    const docLater = await seedApprovedDocument(t, by, bytes, '042026-14OLY 2.5-Gal COA');
    await db.prepare('UPDATE documents SET external_ref = ? WHERE id = ?').bind(`queue-${q1}`, docFirst).run();
    await db.prepare('UPDATE documents SET external_ref = ? WHERE id = ?').bind(`queue-${q2}`, docLater).run();
    await db
      .prepare(
        `INSERT INTO document_spec_checks (id, tenant_id, document_id, version_number, spec_test_id, test_name_raw, value_raw, verdict, reason, source)
         VALUES (?, ?, ?, 1, NULL, 'Coliform', '<10', 'in_spec', 'ok', 'printed')`,
      )
      .bind(generateTestId(), t, docLater)
      .run();

    // One arrival split into two sublot documents that share a checksum: NOT a duplicate.
    const splitBytes = uniquePdf('split');
    const q3 = generateTestId();
    await db
      .prepare(
        `INSERT INTO processing_queue (id, tenant_id, file_r2_key, file_name, file_size, mime_type, status, processing_status, checksum, reviewed_at)
         VALUES (?, ?, 'k', 'split.pdf', 1, 'application/pdf', 'approved', 'ready', ?, '2026-06-02 00:00:00')`,
      )
      .bind(q3, t, await checksumOf(splitBytes))
      .run();
    const s1 = await seedApprovedDocument(t, by, splitBytes, 'Sublot A');
    const s2 = await seedApprovedDocument(t, by, splitBytes, 'Sublot B');
    await db.prepare('UPDATE documents SET external_ref = ? WHERE id = ?').bind(`queue-${q3}-A`, s1).run();
    await db.prepare('UPDATE documents SET external_ref = ? WHERE id = ?').bind(`queue-${q3}-B`, s2).run();

    const all = async (sql: string) => (await db.prepare(sql).all<Record<string, unknown>>()).results ?? [];
    const versionRows = await all(auditLib.versionGroupsSql(t));
    const queueRows = await all(auditLib.queueGroupsSql(t));
    const docIds = [...new Set([...versionRows, ...queueRows].map((r) => r.document_id as string))];
    const queueIds = [...new Set([...versionRows, ...queueRows].map((r) => auditLib.queueIdFromExternalRef(r.external_ref)).filter(Boolean))] as string[];
    const linkRows = await all(auditLib.linksSql(docIds));
    const queueItems = await all(auditLib.queueItemsSql(queueIds));

    const report = auditLib.buildReport({ versionRows, queueRows, queueItems, linkRows });
    const group = report.groups.find((g: any) => g.documents.some((d: any) => d.document_id === docFirst));
    expect(group).toBeTruthy();
    expect(group.same_title).toBe(true);
    expect(group.documents.map((d: any) => [d.document_id, d.role])).toEqual([
      [docFirst, 'first'],
      [docLater, 'later_copy'],
    ]);
    expect(group.documents[1].links.spec_checks).toBe(1);
    expect(report.groups.some((g: any) => g.documents.some((d: any) => d.document_id === s1))).toBe(false);
    expect(report.splits.some((s: any) => s.documents.some((d: any) => d.document_id === s1))).toBe(true);
    expect(report.summary.surplus_documents).toBeGreaterThanOrEqual(1);
    expect(report.summary.surplus_with_links).toBeGreaterThanOrEqual(1);

    const text = auditLib.renderText(report);
    expect(text).toContain('later copy');
    expect(text).toContain('042026-14OLY 2.5-Gal COA');
    expect(text).toContain('1 spec results');
  });
});
