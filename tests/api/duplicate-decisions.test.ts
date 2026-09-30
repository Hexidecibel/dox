/**
 * "You already have this" -- a PERSON decides (migration 0132).
 *
 * The contract:
 *   - a pending card that is an approved document (byte-identical, or the same
 *     document in a newer revision: same supplier + type + document number /
 *     certificate number / exact lot set, different bytes) carries
 *     `intake_history.already_have`;
 *   - approving it WITHOUT `duplicate_decision` is a 400 that writes nothing;
 *   - replace   -> a new version of the SAME document, earlier versions kept;
 *   - keep_both -> a separate document;
 *   - discard   -> the card closes as rejected ('duplicate_discarded'), the
 *                  file is retained, the document is untouched;
 *   - every decision is on the ledger and in the audit log;
 *   - a different supplier with the same number is NOT a match.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { seedTestData, generateTestId } from '../helpers/db';
import { computeChecksum } from '../../functions/lib/r2';
import { onRequestPost as processPost } from '../../functions/api/documents/process';
import { onRequestGet as queueItemGet } from '../../functions/api/queue/[id]';
import { fnContext, orgAdminUser, queuePut, readJson, type TestUser } from '../helpers/requests';
import type { DuplicateProposal, ProcessingQueueItem, QueuedResponse } from '../../shared/types';
import {
  identityNumbers,
  keptVersionsLabel,
  pairRecordsToDocuments,
  pickRevisionMatch,
  replaceButtonLabel,
} from '../../shared/duplicateProposal';

const db = env.DB;
let seed: Awaited<ReturnType<typeof seedTestData>>;
let userA: TestUser;
let supplierA = '';
let supplierB = '';
let specType = '';
let coaType = '';

function uniquePdf(label = ''): Uint8Array {
  return new TextEncoder().encode(`%PDF-1.4\n%${label} ${crypto.randomUUID()}\n`);
}
async function checksumOf(bytes: Uint8Array): Promise<string> {
  return computeChecksum(bytes.slice().buffer as ArrayBuffer);
}

async function smartUpload(bytes: Uint8Array, name = 'upload.pdf') {
  const form = new FormData();
  form.append('tenant_id', seed.tenantId);
  form.append('files', new Blob([bytes], { type: 'application/pdf' }), name);
  const resp = await processPost(fnContext('/api/documents/process', { method: 'POST', body: form, user: userA }));
  return (await readJson(resp)) as QueuedResponse;
}

async function getItem(id: string): Promise<ProcessingQueueItem> {
  const resp = await queueItemGet(fnContext(`/api/queue/${id}`, { user: userA, params: { id } }));
  return ((await readJson(resp)) as { item: ProcessingQueueItem }).item;
}

/** A pending, extracted queue item whose file is in R2 -- the worker's output, stood in for. */
async function pendingItem(opts: {
  bytes?: Uint8Array;
  supplierId?: string | null;
  typeId?: string | null;
  aiFields?: Record<string, string>;
  name?: string;
}): Promise<string> {
  const id = generateTestId();
  const bytes = opts.bytes ?? uniquePdf('pending');
  const name = opts.name ?? 'arrival.pdf';
  const key = `pending/test/${id}/${name}`;
  await env.FILES.put(key, bytes);
  await db
    .prepare(
      `INSERT INTO processing_queue (id, tenant_id, document_type_id, file_r2_key, file_name, file_size, mime_type,
         status, processing_status, checksum, supplier_id, ai_fields, extracted_text, source, created_by)
       VALUES (?, ?, ?, ?, ?, ?, 'application/pdf', 'pending', 'ready', ?, ?, ?, 'text', 'import', ?)`,
    )
    .bind(
      id,
      seed.tenantId,
      opts.typeId ?? null,
      key,
      name,
      bytes.byteLength,
      await checksumOf(bytes),
      opts.supplierId ?? null,
      JSON.stringify(opts.aiFields ?? {}),
      seed.orgAdminId,
    )
    .run();
  return id;
}

async function approve(id: string, body: Record<string, unknown>) {
  return queuePut(id, { status: 'approved', ...body }, userA) as Promise<{ status: number; body: any }>;
}

/** Approve an item as a brand-new document (keep_both when it happens to match). */
async function approvedDocFrom(itemId: string, fields: Record<string, string>, supplierId: string): Promise<string> {
  const res = await approve(itemId, { fields, supplier_id: supplierId });
  if (res.status !== 200) throw new Error(`seed approve failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.document.id as string;
}

async function versionsOf(docId: string) {
  const r = await db
    .prepare('SELECT version_number, r2_key, checksum, change_notes FROM document_versions WHERE document_id = ? ORDER BY version_number')
    .bind(docId)
    .all<{ version_number: number; r2_key: string; checksum: string; change_notes: string | null }>();
  return r.results ?? [];
}

async function ledgerForQueue(queueId: string) {
  return db
    .prepare('SELECT * FROM intake_duplicates WHERE queue_id = ?')
    .bind(queueId)
    .first<Record<string, unknown>>();
}

async function auditFor(action: string, resourceId: string) {
  const r = await db
    .prepare('SELECT user_id, details FROM audit_log WHERE action = ? AND resource_id = ? ORDER BY rowid DESC')
    .bind(action, resourceId)
    .first<{ user_id: string; details: string }>();
  return r ? { user_id: r.user_id, details: JSON.parse(r.details) as Record<string, any> } : null;
}

beforeAll(async () => {
  seed = await seedTestData(db);
  userA = orgAdminUser({ tenantId: seed.tenantId, orgAdminId: seed.orgAdminId });
  supplierA = generateTestId();
  supplierB = generateTestId();
  for (const [id, name] of [[supplierA, 'Darigold Inc'], [supplierB, 'Country Morning Farms']]) {
    await db
      .prepare('INSERT INTO suppliers (id, tenant_id, name, slug) VALUES (?, ?, ?, ?)')
      .bind(id, seed.tenantId, name, `${name.toLowerCase().replace(/\W+/g, '-')}-${id.slice(0, 6)}`)
      .run();
  }
  specType = generateTestId();
  coaType = generateTestId();
  await db
    .prepare(`INSERT INTO document_types (id, tenant_id, name, slug, active) VALUES (?, ?, 'Specification Sheet', ?, 1)`)
    .bind(specType, seed.tenantId, `spec-${specType.slice(0, 6)}`)
    .run();
  await db
    .prepare(`INSERT INTO document_types (id, tenant_id, name, slug, active, renewal_policy) VALUES (?, ?, 'Certificate of Analysis', ?, 1, 'none')`)
    .bind(coaType, seed.tenantId, `coa-${coaType.slice(0, 6)}`)
    .run();
}, 30_000);

// ---------------------------------------------------------------------------

describe('a byte-identical arrival', () => {
  async function identicalPair(label: string) {
    const bytes = uniquePdf(label);
    const first = await smartUpload(bytes, `${label}.pdf`);
    const docId = await approvedDocFrom(first.items[0].id, { title: `${label} original`, lot_number: `LOT-${label}` }, supplierA);
    const again = await smartUpload(bytes, `${label}-again.pdf`);
    const queueId = again.items[0].id;
    expect(queueId).toBeTruthy();
    return { bytes, docId, queueId, notice: again.items[0].already_have as DuplicateProposal };
  }

  it('is queued with the proposal, named in the upload response', async () => {
    const { docId, queueId, notice } = await identicalPair('byte-1');
    expect(notice.document_id).toBe(docId);
    expect(notice.document_title).toBe('byte-1 original');
    expect(notice.supplier_name).toBe('Darigold Inc');
    expect(notice.basis).toBe('identical_bytes');
    expect(notice.reason).toContain('byte for byte');
    expect(notice.current_version).toBe(1);
    expect(notice.next_version).toBe(2);
    expect(notice.approved_at).toBeTruthy();
    const item = await getItem(queueId);
    expect(item.intake_history?.already_have?.document_id).toBe(docId);
  });

  it('cannot be approved without a decision -- 400, nothing written', async () => {
    const { docId, queueId } = await identicalPair('byte-400');
    const res = await approve(queueId, { fields: { title: 'x' }, supplier_id: supplierA });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('duplicate_decision_required');
    expect(res.body.error).toContain('You already have this');
    expect(res.body.error).toContain('v2');
    expect(res.body.already_have.document_id).toBe(docId);
    const q = await db.prepare('SELECT status FROM processing_queue WHERE id = ?').bind(queueId).first<{ status: string }>();
    expect(q?.status).toBe('pending');
    expect(await versionsOf(docId)).toHaveLength(1);

    const bad = await approve(queueId, { fields: {}, supplier_id: supplierA, duplicate_decision: 'merge' });
    expect(bad.status).toBe(400);
  });

  it('replace: a new version of the SAME document, v1 kept, ledger + audit', async () => {
    const { docId, queueId } = await identicalPair('byte-replace');
    const before = await versionsOf(docId);
    const res = await approve(queueId, {
      fields: { title: 'byte-replace reissued', lot_number: 'LOT-byte-replace' },
      supplier_id: supplierA,
      duplicate_decision: 'replace',
    });
    expect(res.status).toBe(200);
    expect(res.body.document.id).toBe(docId);
    expect(res.body.document.current_version).toBe(2);
    expect(res.body.duplicate_decision.decision).toBe('replace');
    expect(res.body.duplicate_decision.version_number).toBe(2);
    expect(res.body.duplicate_decision.summary).toContain('now v2');
    expect(res.body.duplicate_decision.summary).toContain('v1 stays in version history');

    const versions = await versionsOf(docId);
    expect(versions.map((v) => v.version_number)).toEqual([1, 2]);
    expect(versions[0].r2_key).toBe(before[0].r2_key);
    expect(await env.FILES.head(before[0].r2_key)).not.toBeNull();
    expect(versions[1].change_notes).toContain('Replaced from the Review Queue');
    const doc = await db
      .prepare('SELECT title, current_version, status FROM documents WHERE id = ?')
      .bind(docId)
      .first<{ title: string; current_version: number; status: string }>();
    expect(doc).toEqual({ title: 'byte-replace reissued', current_version: 2, status: 'active' });
    // No second document was made.
    const extra = await db
      .prepare(`SELECT COUNT(*) AS n FROM documents WHERE external_ref = ?`)
      .bind(`queue-${queueId}`)
      .first<{ n: number }>();
    expect(extra?.n).toBe(0);

    const ledger = await ledgerForQueue(queueId);
    expect(ledger?.decision).toBe('replace');
    expect(ledger?.decided_by).toBe(seed.orgAdminId);
    expect(ledger?.decision_document_id).toBe(docId);
    expect(ledger?.decision_version_number).toBe(2);

    const decided = await auditFor('queue_item.duplicate_decided', queueId);
    expect(decided?.user_id).toBe(seed.orgAdminId);
    expect(decided?.details.decision).toBe('replace');
    expect(decided?.details.summary).toContain('v1 stays in version history');
    expect(decided?.details.replaced).toEqual([{ document_id: docId, previous_version: 1, new_version: 2 }]);
    const replaced = await auditFor('document.version_replaced', docId);
    expect(replaced?.details.previous_version).toBe(1);
    expect(replaced?.details.new_version).toBe(2);
  });

  it('replace with no renewal answer keeps the renewal decision already on the document', async () => {
    const { docId, queueId } = await identicalPair('byte-renewal');
    await db
      .prepare(`UPDATE documents SET renewal_due_date = '2027-03-01', renewal_decision = 'accepted', renewal_decided_by = ? WHERE id = ?`)
      .bind(seed.orgAdminId, docId)
      .run();
    const res = await approve(queueId, { fields: { title: 'byte-renewal v2' }, supplier_id: supplierA, duplicate_decision: 'replace' });
    expect(res.status).toBe(200);
    const doc = await db
      .prepare('SELECT current_version, renewal_due_date, renewal_decision, renewal_decided_by FROM documents WHERE id = ?')
      .bind(docId)
      .first<{ current_version: number; renewal_due_date: string | null; renewal_decision: string | null; renewal_decided_by: string | null }>();
    expect(doc).toEqual({ current_version: 2, renewal_due_date: '2027-03-01', renewal_decision: 'accepted', renewal_decided_by: seed.orgAdminId });
  });

  it('keep_both: a separate document, the original untouched', async () => {
    const { docId, queueId } = await identicalPair('byte-keep');
    const res = await approve(queueId, { fields: { title: 'kept copy' }, supplier_id: supplierA, duplicate_decision: 'keep_both' });
    expect(res.status).toBe(200);
    const newId = res.body.document.id as string;
    expect(newId).not.toBe(docId);
    expect(res.body.duplicate_decision.decision).toBe('keep_both');
    expect(await versionsOf(docId)).toHaveLength(1);
    const ledger = await ledgerForQueue(queueId);
    expect(ledger?.decision).toBe('keep_both');
    expect(ledger?.decision_document_id).toBe(newId);
    expect(ledger?.matched_document_id).toBe(docId);
    expect((await auditFor('queue_item.duplicate_decided', queueId))?.details.decision).toBe('keep_both');
  });

  it('discard: closed as rejected (duplicate_discarded), file retained, document untouched', async () => {
    const { docId, queueId } = await identicalPair('byte-discard');
    const docBefore = await db.prepare('SELECT title, current_version, updated_at FROM documents WHERE id = ?').bind(docId).first();
    const res = await approve(queueId, { duplicate_decision: 'discard' });
    expect(res.status).toBe(200);
    expect(res.body.item.status).toBe('rejected');
    expect(res.body.item.rejection_reason).toBe('duplicate_discarded');
    expect(res.body.duplicate_decision.decision).toBe('discard');

    const q = await db
      .prepare('SELECT status, rejection_reason, file_retain_until, file_r2_key FROM processing_queue WHERE id = ?')
      .bind(queueId)
      .first<{ status: string; rejection_reason: string; file_retain_until: string | null; file_r2_key: string }>();
    expect(q?.status).toBe('rejected');
    expect(q?.rejection_reason).toBe('duplicate_discarded');
    expect(q?.file_retain_until).toBeTruthy();
    expect(await env.FILES.head(q!.file_r2_key)).not.toBeNull();

    expect(await db.prepare('SELECT title, current_version, updated_at FROM documents WHERE id = ?').bind(docId).first()).toEqual(docBefore);
    expect(await versionsOf(docId)).toHaveLength(1);

    const ledger = await ledgerForQueue(queueId);
    expect(ledger?.decision).toBe('discard');
    expect(ledger?.matched_document_id).toBe(docId);
    expect(ledger?.decision_document_id).toBeNull();
    const decided = await auditFor('queue_item.duplicate_decided', queueId);
    expect(decided?.details.decision).toBe('discard');
    expect(decided?.details.summary).toContain('unchanged');
    expect((await auditFor('queue_item.rejected', queueId))?.details.rejection_reason).toBe('duplicate_discarded');
  });

  it('discard / replace without a match is refused; keep_both without one is harmless', async () => {
    const id = await pendingItem({ supplierId: supplierA, typeId: specType, aiFields: { title: 'lonely' } });
    expect((await approve(id, { duplicate_decision: 'discard' })).status).toBe(400);
    expect((await approve(id, { fields: { title: 'lonely' }, supplier_id: supplierA, duplicate_decision: 'replace' })).status).toBe(400);
    expect((await approve(id, { fields: { title: 'lonely' }, supplier_id: supplierA, duplicate_decision: 'keep_both' })).status).toBe(200);
  });

  it('replace is refused (nothing written) when this approval would make several documents', async () => {
    const { docId, queueId } = await identicalPair('byte-multi');
    const res = await approve(queueId, {
      shared_fields: { title: 'multi' },
      products: [
        { product_name: 'Cream', fields: {} },
        { product_name: 'Milk', fields: {} },
      ],
      supplier_id: supplierA,
      duplicate_decision: 'replace',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Replace existing');
    expect(await versionsOf(docId)).toHaveLength(1);
  });
});

describe('the same document, newer revision (after extraction)', () => {
  it('matches on supplier + type + document number with a different file, and replace versions it', async () => {
    const seedItem = await pendingItem({ supplierId: supplierA, typeId: specType, aiFields: { document_number: 'SPEC-114' } });
    const docId = await approvedDocFrom(seedItem, { title: 'Butter spec', document_number: 'SPEC-114' }, supplierA);

    const newer = await pendingItem({
      supplierId: supplierA,
      typeId: specType,
      aiFields: { title: 'Butter spec rev B', document_number: 'spec 114' },
    });
    const item = await getItem(newer);
    expect(item.intake_history?.already_have?.basis).toBe('document_number');
    expect(item.intake_history?.already_have?.document_id).toBe(docId);
    expect(item.intake_history?.already_have?.matched_value).toBe('SPEC114');
    expect(item.intake_history?.already_have?.reason).toContain('newer revision');

    expect((await approve(newer, { fields: { title: 'Butter spec rev B' }, supplier_id: supplierA })).status).toBe(400);
    const res = await approve(newer, {
      fields: { title: 'Butter spec rev B', document_number: 'SPEC-114' },
      supplier_id: supplierA,
      duplicate_decision: 'replace',
    });
    expect(res.status).toBe(200);
    expect(res.body.document.id).toBe(docId);
    expect((await versionsOf(docId)).map((v) => v.version_number)).toEqual([1, 2]);
    // A revision was only knowable after extraction, so its ledger row is written at the decision.
    const ledger = await ledgerForQueue(newer);
    expect(ledger?.match_basis).toBe('document_number');
    expect(ledger?.decision).toBe('replace');
    expect(ledger?.matched_document_id).toBe(docId);
  });

  it('matches on certificate number', async () => {
    const seedItem = await pendingItem({ supplierId: supplierA, typeId: specType, aiFields: {} });
    const docId = await approvedDocFrom(seedItem, { title: 'Kosher cert', certificate_number: 'OU-77812' }, supplierA);
    const newer = await pendingItem({ supplierId: supplierA, typeId: specType, aiFields: { certificate_number: 'OU-77812' } });
    const item = await getItem(newer);
    expect(item.intake_history?.already_have?.basis).toBe('certificate_number');
    expect(item.intake_history?.already_have?.document_id).toBe(docId);
  });

  it('a DIFFERENT supplier printing the same number is not a match', async () => {
    const seedItem = await pendingItem({ supplierId: supplierA, typeId: specType, aiFields: {} });
    await approvedDocFrom(seedItem, { title: 'A spec', document_number: 'DOC-5500' }, supplierA);
    const other = await pendingItem({ supplierId: supplierB, typeId: specType, aiFields: { document_number: 'DOC-5500' } });
    const item = await getItem(other);
    expect(item.intake_history?.already_have ?? null).toBeNull();
    expect((await approve(other, { fields: { title: 'B spec', document_number: 'DOC-5500' }, supplier_id: supplierB })).status).toBe(200);
  });

  it('a different TYPE or a title that merely looks alike is not a match', async () => {
    const seedItem = await pendingItem({ supplierId: supplierA, typeId: specType, aiFields: {} });
    await approvedDocFrom(seedItem, { title: 'Allergen statement 2026', document_number: 'AL-900' }, supplierA);
    const otherType = await pendingItem({ supplierId: supplierA, typeId: coaType, aiFields: { document_number: 'AL-900' } });
    expect((await getItem(otherType)).intake_history?.already_have ?? null).toBeNull();
    const sameTitle = await pendingItem({ supplierId: supplierA, typeId: specType, aiFields: { title: 'Allergen statement 2026' } });
    expect((await getItem(sameTitle)).intake_history?.already_have ?? null).toBeNull();
  });

  it('a lot-scoped type (COA) matches on exactly the same lot set', async () => {
    const seedItem = await pendingItem({ supplierId: supplierA, typeId: coaType, aiFields: {} });
    const docId = await approvedDocFrom(seedItem, { title: 'COA lot 104262', lot_number: '104262-A' }, supplierA);
    const lots = await db
      .prepare('SELECT COUNT(*) AS n FROM document_lots WHERE document_id = ?')
      .bind(docId)
      .first<{ n: number }>();
    expect(lots?.n).toBe(1);

    const corrected = await pendingItem({ supplierId: supplierA, typeId: coaType, aiFields: { lot_number: '104262-A' } });
    const item = await getItem(corrected);
    expect(item.intake_history?.already_have?.basis).toBe('lot_set');
    expect(item.intake_history?.already_have?.document_id).toBe(docId);

    const otherLot = await pendingItem({ supplierId: supplierA, typeId: coaType, aiFields: { lot_number: '104262-B' } });
    expect((await getItem(otherLot)).intake_history?.already_have ?? null).toBeNull();
  });
});

describe('pure rule (shared/duplicateProposal.ts)', () => {
  it('normalizes numbers conservatively and ignores tiny ones', () => {
    expect(identityNumbers([{ document_number: 'Spec-114', certificate_number: '7' }])).toEqual({
      document_numbers: ['SPEC114'],
      certificate_numbers: [],
    });
  });

  it('prefers document number, then certificate, then an EQUAL lot set (a superset is not equal)', () => {
    const c = (id: string, origin: string, extra: Partial<Parameters<typeof pickRevisionMatch>[1][number]>) => ({
      document_id: id,
      origin,
      lot_keys: [],
      approved_at: '2026-01-01',
      document_numbers: [],
      certificate_numbers: [],
      ...extra,
    });
    const arrival = { document_numbers: [], certificate_numbers: [], lot_keys: ['A', 'B'] };
    expect(pickRevisionMatch(arrival, [c('d1', 'q1', { lot_keys: ['A', 'B', 'C'] })], { lotScoped: true })).toBeNull();
    expect(pickRevisionMatch(arrival, [c('d1', 'q1', { lot_keys: ['A'] }), c('d2', 'q1', { lot_keys: ['B'] })], { lotScoped: true })?.document_ids).toEqual(['d1', 'd2']);
    expect(pickRevisionMatch(arrival, [c('d1', 'q1', { lot_keys: ['A', 'B'] })], { lotScoped: false })).toBeNull();
    const num = { document_numbers: ['X100'], certificate_numbers: [], lot_keys: [] };
    const hit = pickRevisionMatch(num, [c('old', 'q0', { document_numbers: ['X100'], approved_at: '2025-01-01' }), c('new', 'q9', { document_numbers: ['X100'], approved_at: '2026-06-01' })], { lotScoped: false });
    expect(hit?.document_ids).toEqual(['new']);
  });

  it('pairs records to documents only exactly', () => {
    const docs = [{ id: 'd1', lot_keys: ['L1'] }, { id: 'd2', lot_keys: ['L2'] }];
    expect([...(pairRecordsToDocuments([{ record_index: 0, lot_key: 'L2' }, { record_index: 1, lot_key: 'L1' }], docs) ?? [])]).toEqual([[0, 'd2'], [1, 'd1']]);
    expect(pairRecordsToDocuments([{ record_index: 0, lot_key: 'L3' }], docs)).toBeNull();
    expect(pairRecordsToDocuments([{ record_index: 0, lot_key: 'L1' }, { record_index: 1, lot_key: 'L1' }], docs)).toBeNull();
    expect([...(pairRecordsToDocuments([{ record_index: 4, lot_key: null }], [docs[0]]) ?? [])]).toEqual([[4, 'd1']]);
  });

  it("says the owner's words", () => {
    expect(replaceButtonLabel(3)).toBe('Replace existing (becomes v3)');
    expect(keptVersionsLabel(2)).toBe('v1–v2 stay in version history');
    expect(keptVersionsLabel(1)).toBe('v1 stays in version history');
  });
});
