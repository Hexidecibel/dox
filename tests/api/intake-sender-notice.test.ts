/**
 * The two automatic emails about a document that was mailed in.
 *
 * Both used to go to whoever sent the email: the ingest summary
 * (functions/api/webhooks/email-ingest.ts) and "Review Needed"
 * (functions/api/queue/[id]/results.ts, with a hard-coded supdox.com link).
 * The sender is usually a supplier. Now:
 *
 *   - the sender is answered ONLY when their address is an active user of the
 *     tenant the document landed in;
 *   - otherwise the tenant's org_admins get an internal notice that a document
 *     arrived from that address, and the sender gets nothing;
 *   - which path was taken is audited (`intake.sender_notice`);
 *   - the Review Queue link is built from the request's own origin.
 *
 * Resend is the only outbound call; it is stubbed and every send is captured.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { seedTestData, generateTestId } from '../helpers/db';
import { onRequestPost as emailWebhookPost } from '../../functions/api/webhooks/email-ingest';
import { onRequestPut as updateQueueResults } from '../../functions/api/queue/[id]/results';
import { normalizeSenderAddress, resolveSenderNotice } from '../../functions/lib/intake/sender-notice';

const db = env.DB;
let seed: Awaited<ReturnType<typeof seedTestData>>;

interface Sent { to: string[]; subject: string; html: string }
let sent: Sent[] = [];

const ORIGIN = 'https://portal.example.test';
const SUPPLIER = 'qa@notice-supplier.example.com';

beforeAll(async () => {
  seed = await seedTestData(db);
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
    .prepare(`INSERT OR IGNORE INTO document_types (id, tenant_id, name, slug, active) VALUES (?, ?, 'Notice DocType', ?, 1)`)
    .bind(docTypeId, seed.tenantId, `notice-dt-${docTypeId}`)
    .run();
  // A supplier's domain, and the tenant's own (its users mail from test.com).
  for (const domain of ['notice-supplier.example.com', 'test.com']) {
    await db
      .prepare(
        `INSERT OR IGNORE INTO email_domain_mappings (id, tenant_id, domain, default_user_id, default_document_type_id, active)
         VALUES (?, ?, ?, ?, ?, 1)`,
      )
      .bind(generateTestId(), seed.tenantId, domain, seed.userId, docTypeId)
      .run();
  }
}, 30_000);

beforeEach(() => {
  sent = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.startsWith('https://api.resend.com/')) {
        const body = JSON.parse(String(init?.body ?? '{}'));
        sent.push({ to: body.to, subject: body.subject, html: body.html });
        return new Response(JSON.stringify({ id: 'mail-1' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      // The extractor's model call: no router in tests, so it fails and the
      // attachment is queued at low confidence, as it would be in production.
      return new Response('unavailable', { status: 503 });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function lastNotice(kind: string) {
  const row = await db
    .prepare(`SELECT details, resource_id FROM audit_log WHERE tenant_id = ? AND action = 'intake.sender_notice' ORDER BY rowid DESC LIMIT 5`)
    .bind(seed.tenantId)
    .all<{ details: string; resource_id: string | null }>();
  const rows = (row.results ?? []).map((r) => ({ ...JSON.parse(r.details), resource_id: r.resource_id }));
  return rows.find((r) => r.kind === kind);
}

describe('who is told', () => {
  it('reads an address out of "Name <address>" and folds case', () => {
    expect(normalizeSenderAddress('"QA Desk" <QA@Example.com>')).toBe('qa@example.com');
    expect(normalizeSenderAddress('  someone@example.com ')).toBe('someone@example.com');
    expect(normalizeSenderAddress('not an address')).toBeNull();
    expect(normalizeSenderAddress(null)).toBeNull();
  });

  it('an active user of THIS tenant is answered directly', async () => {
    const r = await resolveSenderNotice(db, seed.tenantId, 'Regular User <USER@test.com>');
    expect(r).toEqual({ path: 'sender', recipients: ['user@test.com'], senderIsTenantUser: true });
  });

  it('a supplier, an inactive user and a user of another tenant are all outsiders: the org_admins hear instead', async () => {
    for (const from of [SUPPLIER, 'inactive@test.com', 'orgadmin2@test.com']) {
      const r = await resolveSenderNotice(db, seed.tenantId, from);
      expect(r.path, from).toBe('org_admins');
      expect(r.recipients, from).toEqual(['orgadmin@test.com']);
      expect(r.senderIsTenantUser, from).toBe(false);
    }
  });

  it('a tenant with no org_admin reaches nobody, and says so rather than falling back to the sender', async () => {
    const lonely = `lonely-${generateTestId()}`;
    await db.prepare(`INSERT INTO tenants (id, name, slug, active) VALUES (?, 'Lonely', ?, 1)`).bind(lonely, lonely).run();
    expect(await resolveSenderNotice(db, lonely, SUPPLIER)).toEqual({ path: 'nobody', recipients: [], senderIsTenantUser: false });
  });
});

describe('POST /api/webhooks/email-ingest: the summary', () => {
  async function mailIn(from: string, fileName: string) {
    const form = new FormData();
    form.append('sender', from);
    form.append('subject', 'Certificates');
    form.append('attachment-1', new Blob([new TextEncoder().encode(`%PDF-1.4\n${crypto.randomUUID()}\n`)], { type: 'application/pdf' }), fileName);
    const res = await emailWebhookPost({
      request: new Request(`${ORIGIN}/api/webhooks/email-ingest`, { method: 'POST', body: form }),
      env, data: {}, params: {}, waitUntil: () => {}, passThroughOnException: () => {}, next: async () => new Response(null),
      functionPath: '/api/webhooks/email-ingest',
    } as any);
    expect(res.status).toBe(200);
    return (await res.json()) as any;
  }

  it('a supplier who mails a certificate in is sent NOTHING; the org_admins get an internal notice', async () => {
    const body = await mailIn(SUPPLIER, 'supplier-cert.pdf');
    expect(body.results).toHaveLength(1);

    expect(sent).toHaveLength(1);
    expect(sent[0].to).toEqual(['orgadmin@test.com']);
    expect(sent.flatMap((m) => m.to)).not.toContain(SUPPLIER);
    expect(sent[0].subject).toBe(`[SupDox] 1 document arrived by email from ${SUPPLIER}`);
    expect(sent[0].html).toContain('supplier-cert.pdf');
    expect(sent[0].html).toContain('nothing was sent back to it');
    expect(sent[0].html).toContain(`${ORIGIN}/review`);

    const audit = await lastNotice('ingest_summary');
    expect(audit).toMatchObject({
      kind: 'ingest_summary', path: 'org_admins', sender: SUPPLIER, sender_is_tenant_user: false,
      recipients: ['orgadmin@test.com'], sent: true, attachments: 1,
    });
  });

  it('a tenant user forwarding from their own mailbox gets the summary themselves', async () => {
    await mailIn('Regular User <user@test.com>', 'forwarded.pdf');
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toEqual(['user@test.com']);
    expect(sent[0].subject).toMatch(/processed from your email/);
    expect(await lastNotice('ingest_summary')).toMatchObject({ path: 'sender', sender: 'user@test.com', sender_is_tenant_user: true, sent: true });
  });
});

describe('PUT /api/queue/:id/results: "Review Needed"', () => {
  async function emailedItem(from: string): Promise<string> {
    const id = generateTestId();
    await db
      .prepare(
        `INSERT INTO processing_queue
           (id, tenant_id, file_r2_key, file_name, file_size, mime_type, processing_status, status, created_by, source, source_detail)
         VALUES (?, ?, ?, 'emailed <coa>.pdf', 12, 'application/pdf', 'processing', 'pending', ?, 'email', ?)`,
      )
      .bind(id, seed.tenantId, `queue/${id}/f.pdf`, seed.userId, JSON.stringify({ sender: from }))
      .run();
    return id;
  }

  async function postResults(id: string) {
    const res = await updateQueueResults({
      request: new Request(`${ORIGIN}/api/queue/${id}/results`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ processing_status: 'ready', ai_fields: '{}', confidence_score: 0.42 }),
      }),
      env, data: { user: { id: seed.userId, role: 'user', tenant_id: seed.tenantId } }, params: { id },
      waitUntil: () => {}, passThroughOnException: () => {}, next: async () => new Response(null),
      functionPath: `/api/queue/${id}/results`,
    } as any);
    expect(res.status).toBe(200);
  }

  it('is not sent to a supplier: the org_admins are told a document arrived from that address', async () => {
    const id = await emailedItem(SUPPLIER);
    await postResults(id);

    expect(sent).toHaveLength(1);
    expect(sent[0].to).toEqual(['orgadmin@test.com']);
    expect(sent[0].subject).toBe(`[SupDox] 1 document arrived by email from ${SUPPLIER}`);
    expect(sent[0].html).toContain('Needs review (42% confidence)');
    // The file name is escaped, and the link is this deployment's own.
    expect(sent[0].html).toContain('emailed &lt;coa&gt;.pdf');
    expect(sent[0].html).toContain(`href="${ORIGIN}/review"`);
    expect(sent[0].html).not.toContain('supdox.com');

    const audit = await lastNotice('review_needed');
    expect(audit).toMatchObject({ path: 'org_admins', sender: SUPPLIER, recipients: ['orgadmin@test.com'], sent: true, resource_id: id });
  });

  it('goes to the sender when the sender is a tenant user, with a link built from the request origin', async () => {
    const id = await emailedItem('user@test.com');
    await postResults(id);

    expect(sent).toHaveLength(1);
    expect(sent[0].to).toEqual(['user@test.com']);
    expect(sent[0].subject).toBe('[SupDox] Review Needed: emailed <coa>.pdf');
    expect(sent[0].html).toContain(`href="${ORIGIN}/review"`);
    expect(sent[0].html).not.toContain('supdox.com');
    expect(await lastNotice('review_needed')).toMatchObject({ path: 'sender', sender_is_tenant_user: true, resource_id: id });
  });

  it('an item that did not come by email sends nothing and audits nothing', async () => {
    const id = generateTestId();
    await db
      .prepare(
        `INSERT INTO processing_queue (id, tenant_id, file_r2_key, file_name, file_size, mime_type, processing_status, status, created_by)
         VALUES (?, ?, ?, 'uploaded.pdf', 12, 'application/pdf', 'processing', 'pending', ?)`,
      )
      .bind(id, seed.tenantId, `queue/${id}/f.pdf`, seed.userId)
      .run();
    await postResults(id);
    expect(sent).toHaveLength(0);
    const row = await db.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'intake.sender_notice' AND resource_id = ?`).bind(id).first<{ n: number }>();
    expect(row!.n).toBe(0);
  });
});
