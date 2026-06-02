/**
 * Integration tests for POST /api/documents/process.
 *
 * Focus: intake routing via the optional `output_kind` form field. Verifies the
 * value is persisted on the processing_queue row, defaults to 'coa' when
 * omitted (the historical behavior), and is rejected when invalid.
 *
 * Drives onRequestPost directly with a hand-rolled context object — SELF.fetch
 * isn't wired up in this project's vitest-pool-workers config (mirrors
 * tests/api/documents-ingest.test.ts).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { seedTestData } from '../helpers/db';
import { onRequestPost as processPost } from '../../functions/api/documents/process';

const db = env.DB;
let seed: Awaited<ReturnType<typeof seedTestData>>;
let userCtxUser: { id: string; role: 'user'; tenant_id: string };

interface CallOpts {
  tenantId?: string | null;
  fileName?: string;
  /** Content-Type to stamp on the uploaded Blob. Defaults to application/pdf. */
  fileType?: string;
  extra?: Record<string, string>;
  skipFile?: boolean;
}

function makeFakePdf(size = 256): Uint8Array {
  // Pad with an index byte so each call produces a unique checksum (avoids the
  // duplicate-detection path coupling tests together).
  const bytes = new Uint8Array(size);
  const header = '%PDF-1.4\n';
  for (let i = 0; i < header.length; i++) bytes[i] = header.charCodeAt(i);
  for (let i = header.length; i < size; i++) bytes[i] = Math.floor(Math.random() * 256);
  return bytes;
}

function buildRequest(opts: CallOpts): Request {
  const form = new FormData();
  if (opts.tenantId !== null) {
    form.append('tenant_id', opts.tenantId ?? seed.tenantId);
  }
  if (!opts.skipFile) {
    form.append(
      'files',
      new Blob([makeFakePdf()], { type: opts.fileType ?? 'application/pdf' }),
      opts.fileName ?? 'fake.pdf',
    );
  }
  for (const [k, v] of Object.entries(opts.extra ?? {})) {
    form.append(k, v);
  }
  return new Request('http://localhost/api/documents/process', {
    method: 'POST',
    body: form,
  });
}

function makeContext(request: Request): any {
  return {
    request,
    env,
    data: { user: userCtxUser },
    params: {},
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
    functionPath: '/api/documents/process',
  };
}

async function callProcess(opts: CallOpts = {}): Promise<{ status: number; body: any }> {
  const req = buildRequest(opts);
  const res = await processPost(makeContext(req));
  return { status: res.status, body: await res.json() };
}

beforeAll(async () => {
  seed = await seedTestData(db);
  userCtxUser = {
    id: seed.userId,
    role: 'user' as const,
    tenant_id: seed.tenantId,
  };
}, 30_000);

describe('POST /api/documents/process — intake routing', () => {
  it("sets output_kind='order' on the queue row when provided", async () => {
    const { status, body } = await callProcess({
      fileName: 'order.pdf',
      extra: { output_kind: 'order' },
    });
    expect(status).toBe(200);
    const queueId = body.items.find((i: any) => i.id)?.id;
    expect(queueId).toBeTruthy();

    const row = await db
      .prepare('SELECT output_kind FROM processing_queue WHERE id = ?')
      .bind(queueId)
      .first<{ output_kind: string }>();
    expect(row?.output_kind).toBe('order');
  });

  it("sets output_kind='shipment' and passes through source_id", async () => {
    const { status, body } = await callProcess({
      fileName: 'shipment.pdf',
      extra: { output_kind: 'shipment', source_id: 'src-abc' },
    });
    expect(status).toBe(200);
    const queueId = body.items.find((i: any) => i.id)?.id;

    const row = await db
      .prepare('SELECT output_kind, source_id FROM processing_queue WHERE id = ?')
      .bind(queueId)
      .first<{ output_kind: string; source_id: string }>();
    expect(row?.output_kind).toBe('shipment');
    expect(row?.source_id).toBe('src-abc');
  });

  it("defaults output_kind to 'coa' when omitted", async () => {
    const { status, body } = await callProcess({ fileName: 'coa.pdf' });
    expect(status).toBe(200);
    const queueId = body.items.find((i: any) => i.id)?.id;

    const row = await db
      .prepare('SELECT output_kind, source_id FROM processing_queue WHERE id = ?')
      .bind(queueId)
      .first<{ output_kind: string; source_id: string | null }>();
    expect(row?.output_kind).toBe('coa');
    expect(row?.source_id).toBeNull();
  });

  it('returns 400 for an invalid output_kind', async () => {
    const { status } = await callProcess({
      fileName: 'bad.pdf',
      extra: { output_kind: 'invoice' },
    });
    expect(status).toBe(400);
  });
});

describe('POST /api/documents/process — docx intake', () => {
  const DOCX_MIME =
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

  it('creates a queue row with a real id for a .docx with the openxml mime', async () => {
    const { status, body } = await callProcess({
      fileName: 'order.docx',
      fileType: DOCX_MIME,
      extra: { output_kind: 'order' },
    });
    expect(status).toBe(200);
    const item = body.items.find((i: any) => i.id);
    expect(item?.id).toBeTruthy();

    const row = await db
      .prepare('SELECT output_kind, mime_type FROM processing_queue WHERE id = ?')
      .bind(item.id)
      .first<{ output_kind: string; mime_type: string }>();
    expect(row?.output_kind).toBe('order');
    expect(row?.mime_type).toBe(DOCX_MIME);
  });

  it('creates a queue row for a .docx sent as application/octet-stream', async () => {
    // Regression: browsers often send Office files with no/octet-stream type,
    // which used to fail the allowlist and silently drop the file (id: '').
    const { status, body } = await callProcess({
      fileName: 'shipment.docx',
      fileType: 'application/octet-stream',
      extra: { output_kind: 'shipment' },
    });
    expect(status).toBe(200);
    const item = body.items.find((i: any) => i.id);
    expect(item?.id).toBeTruthy();

    const row = await db
      .prepare('SELECT output_kind, mime_type FROM processing_queue WHERE id = ?')
      .bind(item.id)
      .first<{ output_kind: string; mime_type: string }>();
    expect(row?.output_kind).toBe('shipment');
    // Recovered the canonical docx mime from the extension.
    expect(row?.mime_type).toBe(DOCX_MIME);
  });
});
