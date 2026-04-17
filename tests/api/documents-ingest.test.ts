/**
 * Integration tests for POST /api/documents/ingest.
 *
 * Covers the upsert-by-external-ref contract used by the agentic AI + email
 * ingestion pipelines. Drives onRequestPost directly with a hand-rolled
 * context object — SELF.fetch isn't wired up in this project's
 * vitest-pool-workers config (see tests/api/extraction-instructions.test.ts
 * for the same pattern).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { seedTestData, generateTestId } from '../helpers/db';
import { onRequestPost as ingestPost } from '../../functions/api/documents/ingest';

const db = env.DB;
let seed: Awaited<ReturnType<typeof seedTestData>>;
let userCtxUser: { id: string; role: 'user'; tenant_id: string };

interface CallOpts {
  noUser?: boolean;
  tenantId?: string | null;
  externalRef?: string | null;
  fileName?: string;
  extra?: Record<string, string>;
  skipFile?: boolean;
}

function makeFakePdf(size = 256): Uint8Array {
  const bytes = new Uint8Array(size);
  const header = '%PDF-1.4\n';
  for (let i = 0; i < header.length; i++) bytes[i] = header.charCodeAt(i);
  for (let i = header.length; i < size; i++) bytes[i] = 0x20;
  return bytes;
}

function buildRequest(opts: CallOpts): Request {
  const form = new FormData();
  if (opts.tenantId !== null) {
    form.append('tenant_id', opts.tenantId ?? seed.tenantId);
  }
  if (opts.externalRef !== null) {
    form.append('external_ref', opts.externalRef ?? 'ext-default');
  }
  if (!opts.skipFile) {
    form.append(
      'file',
      new Blob([makeFakePdf()], { type: 'application/pdf' }),
      opts.fileName ?? 'fake.pdf',
    );
  }
  for (const [k, v] of Object.entries(opts.extra ?? {})) {
    form.append(k, v);
  }
  return new Request('http://localhost/api/documents/ingest', {
    method: 'POST',
    body: form,
  });
}

function makeContext(request: Request, opts: CallOpts): any {
  return {
    request,
    env,
    data: opts.noUser ? {} : { user: userCtxUser },
    params: {},
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
    functionPath: '/api/documents/ingest',
  };
}

async function callIngest(opts: CallOpts = {}): Promise<{
  status: number;
  body: any;
}> {
  const req = buildRequest(opts);
  const res = await ingestPost(makeContext(req, opts));
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

describe('POST /api/documents/ingest — upsert flow', () => {
  it('creates a new document on first POST with external_ref', async () => {
    const externalRef = `ext-${generateTestId()}`;
    const { status, body } = await callIngest({
      externalRef,
      fileName: 'coa-v1.pdf',
    });
    expect(status).toBe(201);
    expect(body.action).toBe('created');
    expect(body.document.external_ref).toBe(externalRef);
    expect(body.document.current_version).toBe(1);

    const row = await db
      .prepare('SELECT id, current_version FROM documents WHERE id = ?')
      .bind(body.document.id)
      .first<{ id: string; current_version: number }>();
    expect(row?.current_version).toBe(1);
  });

  it('reuses the same document and bumps version on repeat external_ref', async () => {
    const externalRef = `ext-${generateTestId()}`;
    const first = await callIngest({
      externalRef,
      fileName: 'coa-v1.pdf',
    });
    expect(first.status).toBe(201);
    const docId = first.body.document.id;

    const second = await callIngest({
      externalRef,
      fileName: 'coa-v2.pdf',
    });
    expect(second.status).toBe(200);
    expect(second.body.action).toBe('version_added');
    expect(second.body.document.id).toBe(docId);
    expect(second.body.document.current_version).toBe(2);

    const versions = await db
      .prepare(
        'SELECT version_number FROM document_versions WHERE document_id = ? ORDER BY version_number ASC',
      )
      .bind(docId)
      .all<{ version_number: number }>();
    expect(versions.results.map((v) => v.version_number)).toEqual([1, 2]);
  });

  it('persists source_metadata JSON', async () => {
    const externalRef = `ext-${generateTestId()}`;
    const sourceMetadata = JSON.stringify({
      source: 'mailgun',
      message_id: '<abc@example.com>',
    });
    const { status, body } = await callIngest({
      externalRef,
      extra: { source_metadata: sourceMetadata },
    });
    expect(status).toBe(201);
    expect(body.document.source_metadata).toBe(sourceMetadata);
  });

  it('creates document_products rows when product_ids is provided', async () => {
    const productId = generateTestId();
    await db
      .prepare(
        `INSERT INTO products (id, tenant_id, name, slug, active)
         VALUES (?, ?, ?, ?, 1)`,
      )
      .bind(productId, seed.tenantId, `Prod ${productId}`, `prod-${productId}`)
      .run();

    const externalRef = `ext-${generateTestId()}`;
    const productIdsRaw = JSON.stringify([{ product_id: productId }]);

    const { status, body } = await callIngest({
      externalRef,
      extra: { product_ids: productIdsRaw },
    });
    expect(status).toBe(201);

    const links = await db
      .prepare(
        'SELECT product_id FROM document_products WHERE document_id = ?',
      )
      .bind(body.document.id)
      .all<{ product_id: string }>();
    expect(links.results.map((r) => r.product_id)).toContain(productId);
  });

  it('returns 400 when file is missing', async () => {
    const { status } = await callIngest({
      externalRef: `ext-${generateTestId()}`,
      skipFile: true,
    });
    expect(status).toBe(400);
  });

  it('returns 400 when external_ref is missing', async () => {
    const { status } = await callIngest({
      externalRef: null,
    });
    expect(status).toBe(400);
  });

  it('returns 400 when tenant_id is missing', async () => {
    const { status } = await callIngest({
      tenantId: null,
    });
    expect(status).toBe(400);
  });
});
