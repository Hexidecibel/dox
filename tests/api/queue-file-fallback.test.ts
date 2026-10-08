/**
 * GET /api/queue/:id/file — fall back to the produced document's bytes.
 *
 * APPROVE MOVES THE FILE; IT DOES NOT DESTROY IT. functions/lib/kinds/coa.ts
 * downloads the staging object, re-uploads the same bytes under a permanent
 * document_versions key, and only then deletes the staging copy.
 *
 * Before this fallback, every consumer that fetched a queue item's file — the
 * parity replay harness, bin/reprocess-*, the accuracy measurement scripts —
 * got a 404 for anything already approved and read it as data loss. A whole
 * measurement session concluded "the corpus is evaporating by age" on that
 * basis; prod actually had live bytes for 451 of 457 approved items. These
 * tests pin the fallback so that misdiagnosis cannot recur.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { runMigrations, seedTestData, cleanTables, generateTestId } from '../helpers/db';
import { onRequestGet as getQueueFile } from '../../functions/api/queue/[id]/file';

const db = env.DB;
const files = env.FILES;
let seed: Awaited<ReturnType<typeof seedTestData>>;

beforeEach(async () => {
  await runMigrations(db);
  await cleanTables(db);
  seed = await seedTestData(db);
}, 30_000);

const ORIGINAL = '%PDF-1.4 original five-page bundle';
const SCOPED = '%PDF-1.4 one page';

/** A queue row whose staging object may or may not still exist. */
async function makeQueueItem(opts: { stagingExists: boolean }): Promise<string> {
  const id = generateTestId();
  const r2Key = `pending/${id}.pdf`;
  if (opts.stagingExists) {
    await files.put(r2Key, new TextEncoder().encode(ORIGINAL), {
      httpMetadata: { contentType: 'application/pdf' },
    });
  }
  await db
    .prepare(
      `INSERT INTO processing_queue
         (id, tenant_id, document_type_id, file_r2_key, file_name, file_size, mime_type,
          extracted_text, processing_status, output_kind, status, created_by, created_at)
       VALUES (?, ?, NULL, ?, ?, ?, 'application/pdf', NULL, 'ready', 'coa', 'approved', ?, datetime('now'))`
    )
    .bind(id, seed.tenantId, r2Key, `${id}.pdf`, ORIGINAL.length, seed.userId)
    .run();
  return id;
}

/** A produced document carrying `body` under `external_ref = queue-<queueId><suffix>`. */
async function makeProducedDocument(queueId: string, suffix: string, body: string) {
  const docId = generateTestId();
  const r2Key = `docs/${docId}/1.pdf`;
  await files.put(r2Key, new TextEncoder().encode(body), {
    httpMetadata: { contentType: 'application/pdf' },
  });
  await db
    .prepare(
      `INSERT INTO documents (id, tenant_id, title, tags, current_version, status, external_ref, created_by)
       VALUES (?, ?, ?, '[]', 1, 'active', ?, ?)`
    )
    .bind(docId, seed.tenantId, `doc ${suffix}`, `queue-${queueId}${suffix}`, seed.userId)
    .run();
  await db
    .prepare(
      `INSERT INTO document_versions (id, document_id, version_number, file_name, file_size, mime_type, r2_key, checksum, uploaded_by)
       VALUES (?, ?, 1, ?, ?, 'application/pdf', ?, 'sha', ?)`
    )
    .bind(generateTestId(), docId, `${docId}.pdf`, body.length, r2Key, seed.userId)
    .run();
}

function fileContext(queueId: string): any {
  return {
    request: new Request(`http://localhost/api/queue/${queueId}/file`),
    env,
    data: { user: { id: seed.orgAdminId, role: 'org_admin', tenant_id: seed.tenantId } },
    params: { id: queueId },
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
    functionPath: '/api/queue/[id]/file',
  };
}

describe('queue file falls back to the produced document', () => {
  it('serves the staging object while it exists, and says so', async () => {
    const id = await makeQueueItem({ stagingExists: true });
    await makeProducedDocument(id, '', ORIGINAL);

    const res = await getQueueFile(fileContext(id));
    expect(res.status).toBe(200);
    expect(res.headers.get('X-File-Source')).toBe('queue');
    expect(await res.text()).toBe(ORIGINAL);
  });

  it('serves the document bytes once the staging copy is gone', async () => {
    const id = await makeQueueItem({ stagingExists: false });
    await makeProducedDocument(id, '', ORIGINAL);

    const res = await getQueueFile(fileContext(id));
    expect(res.status).toBe(200);
    expect(res.headers.get('X-File-Source')).toBe('document');
    // Not page-scoped: exactly one produced document.
    expect(res.headers.get('X-File-Scoped')).toBe('false');
    expect(await res.text()).toBe(ORIGINAL);
  });

  it('flags per-record items as scoped and prefers the largest slice', async () => {
    // The records/sublot path produces one page-scoped PDF per record, so the
    // bytes served are NOT the original bundle. A replay harness that graded
    // these as if they were the original would silently measure the wrong doc.
    const id = await makeQueueItem({ stagingExists: false });
    await makeProducedDocument(id, '-lot1', SCOPED);
    await makeProducedDocument(id, '-lot2', SCOPED + ' plus a little more');

    const res = await getQueueFile(fileContext(id));
    expect(res.status).toBe(200);
    expect(res.headers.get('X-File-Source')).toBe('document');
    expect(res.headers.get('X-File-Scoped')).toBe('true');
    // file_size DESC picks the larger slice.
    expect(await res.text()).toBe(SCOPED + ' plus a little more');
  });

  it('still 404s when neither the staging copy nor a document exists', async () => {
    const id = await makeQueueItem({ stagingExists: false });

    const res = await getQueueFile(fileContext(id));
    expect(res.status).toBe(404);
  });

  it('does not leak another tenant queue item via the fallback', async () => {
    const id = await makeQueueItem({ stagingExists: false });
    await makeProducedDocument(id, '', ORIGINAL);

    const ctx = fileContext(id);
    ctx.data.user = { id: seed.userId, role: 'user', tenant_id: 'some-other-tenant' };

    const res = await getQueueFile(ctx);
    expect([403, 404]).toContain(res.status);
  });
});

// ---------------------------------------------------------------------------
// The sharing rule (migration 0137): the fallback serves an APPROVED DOCUMENT,
// so an API key reads it only when that document is "send freely". The staging
// file is not a document and is what intake reads, so a key always reads that.
// ---------------------------------------------------------------------------
describe('the sharing rule on the queue file route', () => {
  function keyContext(queueId: string): any {
    const ctx = fileContext(queueId);
    ctx.data.authMethod = 'api_key';
    ctx.data.apiKeyId = 'worker-key';
    return ctx;
  }

  async function coaTypeId(): Promise<string> {
    const id = generateTestId();
    await db
      .prepare('INSERT INTO document_types (id, tenant_id, name, slug) VALUES (?, ?, ?, ?)')
      .bind(id, seed.tenantId, 'Certificate of Analysis', `coa-${id.slice(0, 6)}`)
      .run();
    return id;
  }

  it('a key always reads the staging file: that read is intake, whatever came of the item', async () => {
    const id = await makeQueueItem({ stagingExists: true });
    // Even with an untyped (locked) document already produced from it.
    await makeProducedDocument(id, '', ORIGINAL);

    const res = await getQueueFile(keyContext(id));
    expect(res.status).toBe(200);
    expect(res.headers.get('X-File-Source')).toBe('queue');
    expect(await res.text()).toBe(ORIGINAL);
  });

  it('a key is refused the fallback for a document that is not "send freely", and a person is not', async () => {
    const id = await makeQueueItem({ stagingExists: false });
    // makeProducedDocument writes no type: unclassified, so locked.
    await makeProducedDocument(id, '', ORIGINAL);

    const refused = await getQueueFile(keyContext(id));
    expect(refused.status).toBe(403);
    const body = (await refused.json()) as { code: string; reason: string };
    expect(body).toMatchObject({ code: 'sharing_rule_refused', reason: 'locked' });

    const person = await getQueueFile(fileContext(id));
    expect(person.status).toBe(200);
    expect(await person.text()).toBe(ORIGINAL);
  });

  it('a key reads the fallback once the document is a COA -- the replay harness keeps working', async () => {
    const id = await makeQueueItem({ stagingExists: false });
    await makeProducedDocument(id, '', ORIGINAL);
    await db
      .prepare(`UPDATE documents SET document_type_id = ? WHERE external_ref = ?`)
      .bind(await coaTypeId(), `queue-${id}`)
      .run();

    const res = await getQueueFile(keyContext(id));
    expect(res.status).toBe(200);
    expect(res.headers.get('X-File-Source')).toBe('document');
    expect(await res.text()).toBe(ORIGINAL);
  });

  it('one page-scoped slice is held to the strictest rule of every document cut from the item', async () => {
    const id = await makeQueueItem({ stagingExists: false });
    await makeProducedDocument(id, '-lot1', SCOPED);
    await makeProducedDocument(id, '-lot2', SCOPED + ' plus a little more');
    const coa = await coaTypeId();
    // Only ONE of the two is typed; the other is still unclassified.
    await db.prepare(`UPDATE documents SET document_type_id = ? WHERE external_ref = ?`).bind(coa, `queue-${id}-lot2`).run();
    expect((await getQueueFile(keyContext(id))).status).toBe(403);

    await db.prepare(`UPDATE documents SET document_type_id = ? WHERE external_ref = ?`).bind(coa, `queue-${id}-lot1`).run();
    const res = await getQueueFile(keyContext(id));
    expect(res.status).toBe(200);
    await res.text();
  });
});
