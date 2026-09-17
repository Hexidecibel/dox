/**
 * API tests for the packet split — propose / confirm / adjust / dismiss
 * (migration 0118).
 *
 * WHAT IS BEING DEFENDED:
 *
 *   1. NOTHING SPLITS WITHOUT A PERSON. The proposal is inert data on the
 *      queue row; only POST .../packet/split carves anything, and only a role
 *      that can already decide a queue item may hit it.
 *   2. A SPLIT PARENT IS NEVER APPROVED. Approving the container would produce
 *      exactly the document this feature exists to prevent — one record typed
 *      from one page of a file holding twenty-five. Reject stays open, because
 *      a container has to be clearable once its parts are handled.
 *   3. A CHILD IS ITS OWN DECISION. Rejecting one part leaves its siblings
 *      exactly where they were.
 *   4. TENANT ISOLATION on every one of the three routes.
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { PDFDocument } from 'pdf-lib';
import { seedTestData, generateTestId } from '../helpers/db';
import { onRequestGet as getPacket } from '../../functions/api/queue/[id]/packet';
import { onRequestPost as splitPacketRoute } from '../../functions/api/queue/[id]/packet/split';
import { onRequestPost as dismissPacketRoute } from '../../functions/api/queue/[id]/packet/dismiss';
import { onRequestPut as updateQueueItem } from '../../functions/api/queue/[id]';
import type { PacketProposal } from '../../shared/packetDetect';
import type { QueuePacketView } from '../../shared/types';

let seed: Awaited<ReturnType<typeof seedTestData>>;
const db = env.DB;

const ADMIN = () => ({ id: seed.orgAdminId, role: 'org_admin', tenant_id: seed.tenantId });
const READER = () => ({ id: seed.readerId, role: 'reader', tenant_id: seed.tenantId });
const OTHER_ADMIN = () => ({ id: seed.orgAdmin2Id, role: 'org_admin', tenant_id: seed.tenantId2 });

beforeAll(async () => {
  seed = await seedTestData(db);
}, 30_000);

function ctx(
  id: string,
  method: string,
  user: { id: string; role: string; tenant_id: string | null },
  body?: unknown,
  suffix = '',
) {
  const request = new Request(`http://localhost/api/queue/${id}/packet${suffix}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return {
    request,
    env,
    data: { user },
    params: { id },
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
    functionPath: `/api/queue/${id}/packet${suffix}`,
  } as unknown as Parameters<typeof getPacket>[0];
}

function putCtx(id: string, body: unknown, user: { id: string; role: string; tenant_id: string | null }) {
  const request = new Request(`http://localhost/api/queue/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return {
    request,
    env,
    data: { user },
    params: { id },
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
    functionPath: `/api/queue/${id}`,
  } as unknown as Parameters<typeof updateQueueItem>[0];
}

/** A real N-page PDF, so the carve is a real carve and not a stub. */
async function makePdf(pageCount: number): Promise<ArrayBuffer> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pageCount; i++) {
    const page = doc.addPage([300, 400]);
    page.drawText(`Page ${i + 1}`, { x: 20, y: 350, size: 24 });
  }
  const bytes = await doc.save();
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function proposalFor(pageCount: number): PacketProposal {
  return {
    looksLikePacket: true,
    confidence: 0.95,
    confidence_band: 'high',
    method: 'index',
    page_count: pageCount,
    declined: null,
    uncovered_pages: [pageCount],
    notes: ['Page 2 lists 3 documents with page numbers.'],
    parts: [
      { pages: [1, 2], label: null, evidence: 'front matter', preview: 'Cover' },
      { pages: [3, 3], label: 'Letter of Guarantee', evidence: 'index entry 1', preview: 'LETTER OF GUARANTEE' },
      { pages: [4, 5], label: 'Allergen Statement', evidence: 'index entry 2', preview: 'ALLERGEN STATEMENT' },
    ],
  };
}

async function seedPacketItem(
  tenantId: string,
  tenantSlug: string,
  pageCount = 6,
  proposal: PacketProposal | null = proposalFor(6),
): Promise<string> {
  const id = generateTestId();
  const r2Key = `pending/${tenantSlug}/${id}/packet.pdf`;
  const bytes = await makePdf(pageCount);
  await env.FILES.put(r2Key, bytes, { httpMetadata: { contentType: 'application/pdf' } });
  await db
    .prepare(
      `INSERT INTO processing_queue
         (id, tenant_id, file_r2_key, file_name, file_size, mime_type,
          processing_status, status, created_by, extracted_text, packet_proposal)
       VALUES (?, ?, ?, 'packet.pdf', ?, 'application/pdf', 'ready', 'pending', ?, 'text', ?)`,
    )
    .bind(id, tenantId, r2Key, bytes.byteLength, seed.orgAdminId, proposal ? JSON.stringify(proposal) : null)
    .run();
  return id;
}

async function readJson<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

beforeEach(async () => {
  await db.prepare("DELETE FROM audit_log WHERE action LIKE 'queue.packet%'").run();
});

describe('GET /api/queue/:id/packet — the proposal is read, not acted on', () => {
  it('returns the stored proposal with no decision recorded', async () => {
    const id = await seedPacketItem(seed.tenantId, 'test-corp');
    const view = await readJson<QueuePacketView>(await getPacket(ctx(id, 'GET', ADMIN())));
    expect(view.proposal?.looksLikePacket).toBe(true);
    expect(view.proposal?.parts).toHaveLength(3);
    expect(view.split_at).toBeNull();
    expect(view.dismissed_at).toBeNull();
    expect(view.children).toEqual([]);
  });

  it('a reader may SEE that a file holds several documents', async () => {
    const id = await seedPacketItem(seed.tenantId, 'test-corp');
    const res = await getPacket(ctx(id, 'GET', READER()));
    expect(res.status).toBe(200);
  });

  it('another tenant sees nothing', async () => {
    const id = await seedPacketItem(seed.tenantId, 'test-corp');
    const res = await getPacket(ctx(id, 'GET', OTHER_ADMIN()));
    expect([403, 404]).toContain(res.status);
  });

  it('an unreadable proposal column costs the caller nothing', async () => {
    const id = await seedPacketItem(seed.tenantId, 'test-corp');
    await db.prepare('UPDATE processing_queue SET packet_proposal = ? WHERE id = ?').bind('{not json', id).run();
    const view = await readJson<QueuePacketView>(await getPacket(ctx(id, 'GET', ADMIN())));
    expect(view.proposal).toBeNull();
  });
});

describe('POST .../packet/split — confirm', () => {
  it('creates one child per part, each carrying only its own pages', async () => {
    const id = await seedPacketItem(seed.tenantId, 'test-corp');
    const res = await splitPacketRoute(ctx(id, 'POST', ADMIN(), {}, '/split'));
    expect(res.status).toBe(201);
    const body = await readJson<{ method: string; children: { id: string; pages: [number, number] }[] }>(res);
    expect(body.method).toBe('index');
    expect(body.children.map((c) => c.pages)).toEqual([[1, 2], [3, 3], [4, 5]]);

    const rows = await db
      .prepare(
        'SELECT id, file_r2_key, packet_pages, packet_part_index, packet_part_label, document_type_id, processing_status, status FROM processing_queue WHERE packet_parent_id = ? ORDER BY packet_part_index',
      )
      .bind(id)
      .all<{
        id: string;
        file_r2_key: string;
        packet_pages: string;
        packet_part_index: number;
        packet_part_label: string | null;
        document_type_id: string | null;
        processing_status: string;
        status: string;
      }>();
    expect(rows.results).toHaveLength(3);

    // Each child's PDF really holds only its own pages.
    for (const [i, expected] of [2, 1, 2].entries()) {
      const obj = await env.FILES.get(rows.results[i].file_r2_key);
      expect(obj, `child ${i} bytes`).not.toBeNull();
      const pdf = await PDFDocument.load(await obj!.arrayBuffer());
      expect(pdf.getPageCount()).toBe(expected);
    }

    // The type is NOT inherited — each part is classified on its own, which is
    // the whole point of splitting.
    expect(rows.results.every((r) => r.document_type_id === null)).toBe(true);
    // ...and each goes back to the worker rather than arriving pre-extracted.
    expect(rows.results.every((r) => r.processing_status === 'queued')).toBe(true);
    expect(rows.results[1].packet_part_label).toBe('Letter of Guarantee');
  });

  it('the parent keeps its own file and becomes a container', async () => {
    const id = await seedPacketItem(seed.tenantId, 'test-corp');
    const before = await db
      .prepare('SELECT file_r2_key FROM processing_queue WHERE id = ?')
      .bind(id)
      .first<{ file_r2_key: string }>();
    await splitPacketRoute(ctx(id, 'POST', ADMIN(), {}, '/split'));
    const after = await db
      .prepare('SELECT file_r2_key, packet_split_at, packet_split_by, packet_split_method, packet_part_count, status FROM processing_queue WHERE id = ?')
      .bind(id)
      .first<{
        file_r2_key: string;
        packet_split_at: string;
        packet_split_by: string;
        packet_split_method: string;
        packet_part_count: number;
        status: string;
      }>();
    expect(after?.file_r2_key).toBe(before?.file_r2_key);
    expect(await env.FILES.get(after!.file_r2_key)).not.toBeNull();
    expect(after?.packet_part_count).toBe(3);
    expect(after?.packet_split_by).toBe(seed.orgAdminId);
    expect(after?.status).toBe('pending');
  });

  it('writes one audit row naming who, which ranges and by what method', async () => {
    const id = await seedPacketItem(seed.tenantId, 'test-corp');
    await splitPacketRoute(ctx(id, 'POST', ADMIN(), {}, '/split'));
    const row = await db
      .prepare("SELECT user_id, tenant_id, details FROM audit_log WHERE action = 'queue.packet_split' AND resource_id = ?")
      .bind(id)
      .first<{ user_id: string; tenant_id: string; details: string }>();
    expect(row?.user_id).toBe(seed.orgAdminId);
    expect(row?.tenant_id).toBe(seed.tenantId);
    const details = JSON.parse(row!.details) as { method: string; parts: { pages: number[] }[] };
    expect(details.method).toBe('index');
    expect(details.parts.map((p) => p.pages)).toEqual([[1, 2], [3, 3], [4, 5]]);
  });

  it('another tenant cannot split it', async () => {
    const id = await seedPacketItem(seed.tenantId, 'test-corp');
    const res = await splitPacketRoute(ctx(id, 'POST', OTHER_ADMIN(), {}, '/split'));
    expect([403, 404]).toContain(res.status);
    const n = await db
      .prepare('SELECT COUNT(*) AS n FROM processing_queue WHERE packet_parent_id = ?')
      .bind(id)
      .first<{ n: number }>();
    expect(n?.n).toBe(0);
  });

  it('a reader cannot split it', async () => {
    const id = await seedPacketItem(seed.tenantId, 'test-corp');
    const res = await splitPacketRoute(ctx(id, 'POST', READER(), {}, '/split'));
    expect(res.status).toBe(403);
  });

  it('refuses a second split of the same file', async () => {
    const id = await seedPacketItem(seed.tenantId, 'test-corp');
    expect((await splitPacketRoute(ctx(id, 'POST', ADMIN(), {}, '/split'))).status).toBe(201);
    const again = await splitPacketRoute(ctx(id, 'POST', ADMIN(), {}, '/split'));
    expect(again.status).toBe(400);
    const n = await db
      .prepare('SELECT COUNT(*) AS n FROM processing_queue WHERE packet_parent_id = ?')
      .bind(id)
      .first<{ n: number }>();
    expect(n?.n).toBe(3);
  });

  it('refuses to split a file nothing proposed a split for', async () => {
    const id = await seedPacketItem(seed.tenantId, 'test-corp', 6, null);
    const res = await splitPacketRoute(ctx(id, 'POST', ADMIN(), {}, '/split'));
    expect(res.status).toBe(400);
  });

  it('refuses to split a part of a split file — one level only', async () => {
    const parent = await seedPacketItem(seed.tenantId, 'test-corp');
    await splitPacketRoute(ctx(parent, 'POST', ADMIN(), {}, '/split'));
    const child = await db
      .prepare('SELECT id FROM processing_queue WHERE packet_parent_id = ? LIMIT 1')
      .bind(parent)
      .first<{ id: string }>();
    await db
      .prepare('UPDATE processing_queue SET packet_proposal = ? WHERE id = ?')
      .bind(JSON.stringify(proposalFor(2)), child!.id)
      .run();
    const res = await splitPacketRoute(ctx(child!.id, 'POST', ADMIN(), {}, '/split'));
    expect(res.status).toBe(400);
  });
});

describe('POST .../packet/split — adjust', () => {
  it('takes the reviewer\'s edited ranges and records the method as adjusted', async () => {
    const id = await seedPacketItem(seed.tenantId, 'test-corp');
    // Merge the first two parts and drop the last.
    const res = await splitPacketRoute(
      ctx(id, 'POST', ADMIN(), { parts: [{ pages: [1, 3], label: null }, { pages: [4, 6], label: 'Everything else' }] }, '/split'),
    );
    expect(res.status).toBe(201);
    const body = await readJson<{ method: string; children: { pages: [number, number] }[] }>(res);
    expect(body.method).toBe('adjusted');
    expect(body.children.map((c) => c.pages)).toEqual([[1, 3], [4, 6]]);
    const parent = await db
      .prepare('SELECT packet_split_method, packet_part_count FROM processing_queue WHERE id = ?')
      .bind(id)
      .first<{ packet_split_method: string; packet_part_count: number }>();
    expect(parent?.packet_split_method).toBe('adjusted');
    expect(parent?.packet_part_count).toBe(2);
  });

  it('identical ranges are a CONFIRM, not an adjustment', async () => {
    const id = await seedPacketItem(seed.tenantId, 'test-corp');
    const res = await splitPacketRoute(
      ctx(id, 'POST', ADMIN(), { parts: proposalFor(6).parts.map((p) => ({ pages: p.pages, label: p.label })) }, '/split'),
    );
    expect((await readJson<{ method: string }>(res)).method).toBe('index');
  });

  it('refuses overlapping or out-of-range edits, and writes nothing', async () => {
    const id = await seedPacketItem(seed.tenantId, 'test-corp');
    const overlap = await splitPacketRoute(
      ctx(id, 'POST', ADMIN(), { parts: [{ pages: [1, 4] }, { pages: [3, 6] }] }, '/split'),
    );
    expect(overlap.status).toBe(400);
    expect((await readJson<{ error: string }>(overlap)).error).toMatch(/overlaps/);

    const outside = await splitPacketRoute(
      ctx(id, 'POST', ADMIN(), { parts: [{ pages: [1, 2] }, { pages: [3, 99] }] }, '/split'),
    );
    expect(outside.status).toBe(400);

    const n = await db
      .prepare('SELECT COUNT(*) AS n FROM processing_queue WHERE packet_parent_id = ?')
      .bind(id)
      .first<{ n: number }>();
    expect(n?.n).toBe(0);
  });
});

describe('POST .../packet/dismiss — "not a packet"', () => {
  it('remembers the answer and audits it, changing nothing else', async () => {
    const id = await seedPacketItem(seed.tenantId, 'test-corp');
    const res = await dismissPacketRoute(ctx(id, 'POST', ADMIN(), {}, '/dismiss'));
    expect(res.status).toBe(200);

    const view = await readJson<QueuePacketView>(await getPacket(ctx(id, 'GET', ADMIN())));
    expect(view.dismissed_at).toBeTruthy();
    expect(view.split_at).toBeNull();
    // The proposal is kept: dismissing is an answer to it, not a deletion of it.
    expect(view.proposal?.looksLikePacket).toBe(true);

    const row = await db
      .prepare("SELECT user_id FROM audit_log WHERE action = 'queue.packet_dismissed' AND resource_id = ?")
      .bind(id)
      .first<{ user_id: string }>();
    expect(row?.user_id).toBe(seed.orgAdminId);

    // ...and the item is still an ordinary pending queue item.
    const item = await db.prepare('SELECT status FROM processing_queue WHERE id = ?').bind(id).first<{ status: string }>();
    expect(item?.status).toBe('pending');
  });

  it('dismissing twice is not an error and does not move the first stamp', async () => {
    const id = await seedPacketItem(seed.tenantId, 'test-corp');
    await dismissPacketRoute(ctx(id, 'POST', ADMIN(), {}, '/dismiss'));
    const first = await db
      .prepare('SELECT packet_dismissed_at FROM processing_queue WHERE id = ?')
      .bind(id)
      .first<{ packet_dismissed_at: string }>();
    const res = await dismissPacketRoute(ctx(id, 'POST', ADMIN(), {}, '/dismiss'));
    expect(res.status).toBe(200);
    const second = await db
      .prepare('SELECT packet_dismissed_at FROM processing_queue WHERE id = ?')
      .bind(id)
      .first<{ packet_dismissed_at: string }>();
    expect(second?.packet_dismissed_at).toBe(first?.packet_dismissed_at);
  });

  it('another tenant cannot dismiss it', async () => {
    const id = await seedPacketItem(seed.tenantId, 'test-corp');
    const res = await dismissPacketRoute(ctx(id, 'POST', OTHER_ADMIN(), {}, '/dismiss'));
    expect([403, 404]).toContain(res.status);
  });
});

describe('the container is never approved, and its parts are their own decisions', () => {
  it('approving a split parent is refused', async () => {
    const id = await seedPacketItem(seed.tenantId, 'test-corp');
    await splitPacketRoute(ctx(id, 'POST', ADMIN(), {}, '/split'));
    const res = await updateQueueItem(putCtx(id, { status: 'approved', fields: {} }, ADMIN()));
    expect(res.status).toBe(400);
    expect((await readJson<{ error: string }>(res)).error).toMatch(/split/i);
    const item = await db.prepare('SELECT status FROM processing_queue WHERE id = ?').bind(id).first<{ status: string }>();
    expect(item?.status).toBe('pending');
  });

  it('rejecting the container is allowed and leaves every part alone', async () => {
    const id = await seedPacketItem(seed.tenantId, 'test-corp');
    await splitPacketRoute(ctx(id, 'POST', ADMIN(), {}, '/split'));
    const res = await updateQueueItem(putCtx(id, { status: 'rejected', rejection_reason: 'other' }, ADMIN()));
    expect(res.status).toBe(200);
    const kids = await db
      .prepare('SELECT status FROM processing_queue WHERE packet_parent_id = ?')
      .bind(id)
      .all<{ status: string }>();
    expect(kids.results).toHaveLength(3);
    expect(kids.results.every((k) => k.status === 'pending')).toBe(true);
  });

  it('rejecting ONE part leaves its siblings pending', async () => {
    const id = await seedPacketItem(seed.tenantId, 'test-corp');
    await splitPacketRoute(ctx(id, 'POST', ADMIN(), {}, '/split'));
    const kids = await db
      .prepare('SELECT id FROM processing_queue WHERE packet_parent_id = ? ORDER BY packet_part_index')
      .bind(id)
      .all<{ id: string }>();
    const res = await updateQueueItem(
      putCtx(kids.results[1].id, { status: 'rejected', rejection_reason: 'wrong_document' }, ADMIN()),
    );
    expect(res.status).toBe(200);
    const after = await db
      .prepare('SELECT id, status FROM processing_queue WHERE packet_parent_id = ? ORDER BY packet_part_index')
      .bind(id)
      .all<{ id: string; status: string }>();
    expect(after.results.map((r) => r.status)).toEqual(['pending', 'rejected', 'pending']);
  });

  it('a part knows which file and which pages it came from', async () => {
    const id = await seedPacketItem(seed.tenantId, 'test-corp');
    await splitPacketRoute(ctx(id, 'POST', ADMIN(), {}, '/split'));
    const child = await db
      .prepare('SELECT id FROM processing_queue WHERE packet_parent_id = ? AND packet_part_index = 2')
      .bind(id)
      .first<{ id: string }>();
    const view = await readJson<QueuePacketView>(await getPacket(ctx(child!.id, 'GET', ADMIN())));
    expect(view.parent?.id).toBe(id);
    expect(view.parent?.file_name).toBe('packet.pdf');
    expect(view.part_of_pages).toEqual([4, 5]);
    expect(view.part_label).toBe('Allergen Statement');
  });

  it('the container lists its parts with their current state', async () => {
    const id = await seedPacketItem(seed.tenantId, 'test-corp');
    await splitPacketRoute(ctx(id, 'POST', ADMIN(), {}, '/split'));
    const view = await readJson<QueuePacketView>(await getPacket(ctx(id, 'GET', ADMIN())));
    expect(view.split_at).toBeTruthy();
    expect(view.part_count).toBe(3);
    expect(view.children.map((c) => c.pages)).toEqual([[1, 2], [3, 3], [4, 5]]);
    expect(view.children.every((c) => c.status === 'pending')).toBe(true);
  });
});
