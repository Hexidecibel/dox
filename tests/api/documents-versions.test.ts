/**
 * Integration tests for document versioning through the ingest API.
 *
 * Verifies that:
 *  - uploading the same external_ref twice creates v1 + v2
 *  - GET /api/documents/:id/versions lists both versions, newest first
 *  - GET /api/documents/:id/download?version=N returns the right bytes
 *
 * Drives onRequest handlers directly.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { seedTestData, generateTestId } from '../helpers/db';
import { onRequestPost as ingestPost } from '../../functions/api/documents/ingest';
import { onRequestGet as versionsGet } from '../../functions/api/documents/[id]/versions';
import { onRequestGet as downloadGet } from '../../functions/api/documents/[id]/download';

const db = env.DB;
let seed: Awaited<ReturnType<typeof seedTestData>>;
let userCtxUser: { id: string; role: 'user'; tenant_id: string };

function pdfBytes(marker: string): Uint8Array {
  const body = `%PDF-1.4\n%${marker}\n` + ' '.repeat(128);
  return new TextEncoder().encode(body);
}

async function ingest(
  externalRef: string,
  marker: string,
  fileName: string,
): Promise<{ status: number; body: any }> {
  const form = new FormData();
  form.append('tenant_id', seed.tenantId);
  form.append('external_ref', externalRef);
  form.append(
    'file',
    new Blob([pdfBytes(marker)], { type: 'application/pdf' }),
    fileName,
  );
  const req = new Request('http://localhost/api/documents/ingest', {
    method: 'POST',
    body: form,
  });
  const res = await ingestPost({
    request: req,
    env,
    data: { user: userCtxUser },
    params: {},
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
    functionPath: '/api/documents/ingest',
  } as any);
  return { status: res.status, body: await res.json() };
}

async function getVersions(
  docId: string,
): Promise<{ status: number; body: any }> {
  const req = new Request(
    `http://localhost/api/documents/${docId}/versions`,
    { method: 'GET' },
  );
  const res = await versionsGet({
    request: req,
    env,
    data: { user: userCtxUser },
    params: { id: docId },
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
    functionPath: `/api/documents/${docId}/versions`,
  } as any);
  return { status: res.status, body: await res.json() };
}

async function download(
  docId: string,
  version?: number,
): Promise<{ status: number; bodyText: string }> {
  const url = version
    ? `http://localhost/api/documents/${docId}/download?version=${version}`
    : `http://localhost/api/documents/${docId}/download`;
  const req = new Request(url, { method: 'GET' });
  const res = await downloadGet({
    request: req,
    env,
    data: { user: userCtxUser },
    params: { id: docId },
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
    functionPath: `/api/documents/${docId}/download`,
  } as any);
  const buf = await res.arrayBuffer();
  return { status: res.status, bodyText: new TextDecoder().decode(buf) };
}

beforeAll(async () => {
  seed = await seedTestData(db);
  userCtxUser = {
    id: seed.userId,
    role: 'user' as const,
    tenant_id: seed.tenantId,
  };
}, 30_000);

describe('document versioning', () => {
  it('ingests v1 and v2 for the same external_ref', async () => {
    const externalRef = `ver-${generateTestId()}`;

    const v1 = await ingest(externalRef, 'VERSION-ONE', 'version.pdf');
    expect(v1.status).toBe(201);
    expect(v1.body.document.current_version).toBe(1);
    const docId = v1.body.document.id;

    const v2 = await ingest(externalRef, 'VERSION-TWO', 'version.pdf');
    expect(v2.status).toBe(200);
    expect(v2.body.document.id).toBe(docId);
    expect(v2.body.document.current_version).toBe(2);
  });

  it('GET /api/documents/:id/versions lists both versions newest-first', async () => {
    const externalRef = `ver-${generateTestId()}`;
    const v1 = await ingest(externalRef, 'LIST-ONE', 'list.pdf');
    const docId = v1.body.document.id;
    await ingest(externalRef, 'LIST-TWO', 'list.pdf');

    const listed = await getVersions(docId);
    expect(listed.status).toBe(200);
    expect(
      listed.body.versions.map((v: { version_number: number }) => v.version_number),
    ).toEqual([2, 1]);
  });

  it('download?version=1 and version=2 return their respective bytes', async () => {
    const externalRef = `ver-${generateTestId()}`;
    const v1 = await ingest(externalRef, 'DOWNLOAD-ONE', 'dl.pdf');
    const docId = v1.body.document.id;
    await ingest(externalRef, 'DOWNLOAD-TWO', 'dl.pdf');

    const dl1 = await download(docId, 1);
    expect(dl1.status).toBe(200);
    expect(dl1.bodyText).toContain('DOWNLOAD-ONE');
    expect(dl1.bodyText).not.toContain('DOWNLOAD-TWO');

    const dl2 = await download(docId, 2);
    expect(dl2.status).toBe(200);
    expect(dl2.bodyText).toContain('DOWNLOAD-TWO');

    const dlCurrent = await download(docId);
    expect(dlCurrent.status).toBe(200);
    expect(dlCurrent.bodyText).toContain('DOWNLOAD-TWO');
  });
});
