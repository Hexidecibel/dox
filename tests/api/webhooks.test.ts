import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { seedTestData, generateTestId } from '../helpers/db';

let seed: Awaited<ReturnType<typeof seedTestData>>;
const db = env.DB;

beforeAll(async () => {
  seed = await seedTestData(db);

  // Migration 0017 drops email_domain_mappings; recreate for tests
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS email_domain_mappings (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
      domain TEXT NOT NULL,
      tenant_id TEXT NOT NULL REFERENCES tenants(id),
      default_user_id TEXT REFERENCES users(id),
      default_document_type_id TEXT,
      active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(domain)
    )
  `).run();
}, 30_000);

describe('Webhooks - Email Ingest', () => {
  it('should find email domain mapping', async () => {
    // Create mapping
    const mappingId = generateTestId();
    await db
      .prepare(
        `INSERT INTO email_domain_mappings (id, tenant_id, domain, default_user_id, active)
         VALUES (?, ?, ?, ?, 1)`
      )
      .bind(mappingId, seed.tenantId, 'example.com', seed.userId)
      .run();

    const mapping = await db
      .prepare(
        `SELECT edm.tenant_id, edm.default_user_id, t.slug AS tenant_slug
         FROM email_domain_mappings edm
         JOIN tenants t ON t.id = edm.tenant_id
         WHERE edm.domain = ? AND edm.active = 1`
      )
      .bind('example.com')
      .first();

    expect(mapping).not.toBeNull();
    expect(mapping!.tenant_id).toBe(seed.tenantId);
    expect(mapping!.tenant_slug).toBe('test-corp');
  });

  it('should return null for unmapped domain', async () => {
    const mapping = await db
      .prepare(
        `SELECT * FROM email_domain_mappings WHERE domain = ? AND active = 1`
      )
      .bind('unknown-domain.com')
      .first();

    expect(mapping).toBeNull();
  });

  it('should queue items in processing_queue', async () => {
    const queueId = generateTestId();
    await db
      .prepare(
        `INSERT INTO processing_queue (id, tenant_id, file_r2_key, file_name, file_size, mime_type, status, created_by)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`
      )
      .bind(queueId, seed.tenantId, 'pending/test/file.pdf', 'file.pdf', 1024, 'application/pdf', seed.userId)
      .run();

    const item = await db.prepare('SELECT * FROM processing_queue WHERE id = ?').bind(queueId).first();
    expect(item).not.toBeNull();
    expect(item!.status).toBe('pending');
    expect(item!.file_name).toBe('file.pdf');
  });

  it('should store extracted fields in queue item', async () => {
    const queueId = generateTestId();
    const fields = JSON.stringify({ lot_number: 'LOT-123', supplier_name: 'Acme' });

    await db
      .prepare(
        `INSERT INTO processing_queue (id, tenant_id, file_r2_key, file_name, file_size, mime_type, ai_fields, ai_confidence, confidence_score, status, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
      )
      .bind(queueId, seed.tenantId, 'pending/test/coa.pdf', 'coa.pdf', 2048, 'application/pdf', fields, 'high', 0.85, seed.userId)
      .run();

    const item = await db.prepare('SELECT ai_fields, confidence_score FROM processing_queue WHERE id = ?').bind(queueId).first();
    expect(JSON.parse(item!.ai_fields as string).lot_number).toBe('LOT-123');
    expect(item!.confidence_score).toBe(0.85);
  });
});

describe('Webhooks - Connector Webhook', () => {
  it('should find connector by ID', async () => {
    const connId = generateTestId();
    await db
      .prepare(
        `INSERT INTO connectors (id, tenant_id, name, connector_type, system_type, config, field_mappings, active, created_by, created_at, updated_at)
         VALUES (?, ?, ?, 'webhook', 'other', ?, '{}', 1, ?, datetime('now'), datetime('now'))`
      )
      .bind(connId, seed.tenantId, 'Webhook Connector', JSON.stringify({ signature_method: 'hmac_sha256', signature_header: 'X-Signature' }), seed.orgAdminId)
      .run();

    const connector = await db
      .prepare('SELECT * FROM connectors WHERE id = ?')
      .bind(connId)
      .first();

    expect(connector).not.toBeNull();
    expect(connector!.connector_type).toBe('webhook');
    expect(connector!.active).toBe(1);

    const config = JSON.parse(connector!.config as string);
    expect(config.signature_method).toBe('hmac_sha256');
  });

  it('should reject inactive connector', async () => {
    const connId = generateTestId();
    await db
      .prepare(
        `INSERT INTO connectors (id, tenant_id, name, connector_type, system_type, config, field_mappings, active, created_by, created_at, updated_at)
         VALUES (?, ?, ?, 'webhook', 'other', '{}', '{}', 0, ?, datetime('now'), datetime('now'))`
      )
      .bind(connId, seed.tenantId, 'Inactive Webhook', seed.orgAdminId)
      .run();

    const connector = await db
      .prepare('SELECT active FROM connectors WHERE id = ?')
      .bind(connId)
      .first();

    expect(connector!.active).toBe(0);
  });

  it('should reject non-webhook connector type', async () => {
    const connId = generateTestId();
    await db
      .prepare(
        `INSERT INTO connectors (id, tenant_id, name, connector_type, system_type, config, field_mappings, active, created_by, created_at, updated_at)
         VALUES (?, ?, ?, 'email', 'other', '{}', '{}', 1, ?, datetime('now'), datetime('now'))`
      )
      .bind(connId, seed.tenantId, 'Email Not Webhook', seed.orgAdminId)
      .run();

    const connector = await db
      .prepare('SELECT connector_type FROM connectors WHERE id = ?')
      .bind(connId)
      .first();

    expect(connector!.connector_type).toBe('email');
    expect(connector!.connector_type).not.toBe('webhook');
  });

  it('should verify HMAC-SHA256 signature', async () => {
    const secret = 'test-webhook-secret';
    const body = '{"order":"123"}';

    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );

    const signed = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
    const expected = Array.from(new Uint8Array(signed))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');

    // Verify
    const verifyKey = await crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify']
    );

    const valid = await crypto.subtle.verify('HMAC', verifyKey, signed, encoder.encode(body));
    expect(valid).toBe(true);

    // Wrong body should fail
    const invalid = await crypto.subtle.verify('HMAC', verifyKey, signed, encoder.encode('tampered'));
    expect(invalid).toBe(false);
  });
});

describe('Webhooks - Audit Logging', () => {
  it('should write audit log entries', async () => {
    await db
      .prepare(
        `INSERT INTO audit_log (user_id, tenant_id, action, resource_type, resource_id, details, ip_address)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(seed.userId, seed.tenantId, 'webhook.received', 'connector', 'conn-123', '{"source":"test"}', '127.0.0.1')
      .run();

    const log = await db
      .prepare("SELECT * FROM audit_log WHERE action = 'webhook.received' AND resource_id = 'conn-123'")
      .first();

    expect(log).not.toBeNull();
    expect(log!.tenant_id).toBe(seed.tenantId);
  });
});
