/**
 * Integration tests for POST /api/webhooks/email-ingest.
 *
 * The webhook accepts Mailgun- and SendGrid-shaped multipart payloads and:
 *  - maps the sender domain to a tenant via email_domain_mappings
 *  - extracts each attachment and queues it for review
 *  - gracefully ignores senders from unmapped domains (200 + explanatory body)
 *
 * Note: the endpoint is unauthenticated (webhooks can't authenticate
 * themselves) and ALWAYS returns 200 so the mail provider doesn't retry on
 * transient errors. We assert on the response body instead of the status
 * code for sad paths.
 *
 * Drives onRequestPost directly — SELF.fetch isn't wired up in this
 * project's vitest-pool-workers config.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { seedTestData, generateTestId } from '../helpers/db';
import { onRequestPost as emailWebhookPost } from '../../functions/api/webhooks/email-ingest';

const db = env.DB;
let seed: Awaited<ReturnType<typeof seedTestData>>;

function makePdfBlob(): Blob {
  const bytes = new TextEncoder().encode('%PDF-1.4\n%fake payload\n');
  return new Blob([bytes], { type: 'application/pdf' });
}

function makeContext(form: FormData): any {
  return {
    request: new Request('http://localhost/api/webhooks/email-ingest', {
      method: 'POST',
      body: form,
    }),
    env,
    data: {},
    params: {},
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
    functionPath: '/api/webhooks/email-ingest',
  };
}

async function callWebhook(form: FormData) {
  const res = await emailWebhookPost(makeContext(form));
  return { status: res.status, body: (await res.json()) as any };
}

beforeAll(async () => {
  seed = await seedTestData(db);

  // Migration 0017 drops email_domain_mappings; recreate it here.
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

  // Seed a document type so the mapping can reference a valid FK — the
  // queue's document_type_id column is a non-null FK to document_types.
  const docTypeId = generateTestId();
  await db
    .prepare(
      `INSERT OR IGNORE INTO document_types (id, tenant_id, name, slug, active)
       VALUES (?, ?, ?, ?, 1)`,
    )
    .bind(docTypeId, seed.tenantId, 'Webhook Test DocType', `webhook-dt-${docTypeId}`)
    .run();

  // Wire up a mapping for a known sender domain. default_document_type_id
  // is the value the handler uses when inserting a processing_queue row.
  await db
    .prepare(
      `INSERT OR IGNORE INTO email_domain_mappings (id, tenant_id, domain, default_user_id, default_document_type_id, active)
       VALUES (?, ?, ?, ?, ?, 1)`,
    )
    .bind(
      generateTestId(),
      seed.tenantId,
      'ingest.example.com',
      seed.userId,
      docTypeId,
    )
    .run();
}, 30_000);

describe('POST /api/webhooks/email-ingest', () => {
  it('Mailgun-shaped payload queues a single attachment', async () => {
    const form = new FormData();
    form.append('sender', 'vendor@ingest.example.com');
    form.append('subject', 'New COA from mailgun');
    form.append('attachment-1', makePdfBlob(), 'mail-doc.pdf');

    const { status, body } = await callWebhook(form);
    expect(status).toBe(200);
    expect(body.results).toBeDefined();
    // Without QWEN_URL/QWEN_SECRET the extractor falls back to low-confidence
    // queuing — that's fine for asserting the queue row exists.
    expect(body.results.length).toBe(1);
    expect(['queued', 'ingested']).toContain(body.results[0].status);

    const row = await db
      .prepare(
        'SELECT file_name FROM processing_queue WHERE tenant_id = ? AND file_name = ?',
      )
      .bind(seed.tenantId, 'mail-doc.pdf')
      .first<{ file_name: string }>();
    expect(row?.file_name).toBe('mail-doc.pdf');
  });

  it('SendGrid-shaped payload (uses "from" instead of "sender") also queues', async () => {
    const form = new FormData();
    form.append('from', '"Vendor Name" <vendor@ingest.example.com>');
    form.append('subject', 'SendGrid shape');
    form.append('attachment1', makePdfBlob(), 'sg-doc.pdf');

    const { status, body } = await callWebhook(form);
    expect(status).toBe(200);
    expect(body.results?.length).toBe(1);
    expect(body.results[0].fileName).toBe('sg-doc.pdf');
  });

  it('unknown sender domain returns 200 with a message and no queue rows', async () => {
    const form = new FormData();
    form.append('sender', 'stranger@not-mapped.example');
    form.append('subject', 'unknown');
    form.append('attachment-1', makePdfBlob(), 'skip-doc.pdf');

    const before = (await db
      .prepare(
        'SELECT COUNT(*) as c FROM processing_queue WHERE file_name = ?',
      )
      .bind('skip-doc.pdf')
      .first<{ c: number }>())!.c;

    const { status, body } = await callWebhook(form);
    expect(status).toBe(200);
    expect(String(body.message || '')).toMatch(/no tenant mapping/i);

    const after = (await db
      .prepare(
        'SELECT COUNT(*) as c FROM processing_queue WHERE file_name = ?',
      )
      .bind('skip-doc.pdf')
      .first<{ c: number }>())!.c;
    expect(after).toBe(before);
  });

  it('multiple attachments each create their own queue item', async () => {
    const form = new FormData();
    form.append('sender', 'vendor@ingest.example.com');
    form.append('subject', 'multi-attach');
    form.append('attachment-1', makePdfBlob(), 'multi-a.pdf');
    form.append('attachment-2', makePdfBlob(), 'multi-b.pdf');
    form.append('attachment-3', makePdfBlob(), 'multi-c.pdf');

    const { status, body } = await callWebhook(form);
    expect(status).toBe(200);
    expect(body.results.length).toBe(3);

    const queued = await db
      .prepare(
        `SELECT file_name FROM processing_queue
         WHERE tenant_id = ? AND file_name IN ('multi-a.pdf', 'multi-b.pdf', 'multi-c.pdf')`,
      )
      .bind(seed.tenantId)
      .all<{ file_name: string }>();
    expect(new Set(queued.results.map((r) => r.file_name))).toEqual(
      new Set(['multi-a.pdf', 'multi-b.pdf', 'multi-c.pdf']),
    );
  });
});
