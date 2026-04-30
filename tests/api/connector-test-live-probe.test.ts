/**
 * Tests for the per-type live probe that POST /api/connectors/:id/test now
 * performs. In addition to validating config shape, the endpoint returns a
 * `probe` object with per-type details:
 *
 *   file_watch -> stored sample reachability + metadata + row count
 *   email      -> inbound address + email_domain_mappings rows
 *   webhook    -> public webhook URL + sample curl
 *   api_poll   -> "not implemented" (no crash)
 *
 * Coverage:
 *  - file_watch with a stored sample in R2: probe.ok=true, details carry
 *    file_name / size / source_type.
 *  - file_watch with no sample: probe.ok=false.
 *  - file_watch with a missing R2 object (expired): probe.ok=false.
 *  - email with no email_domain_mappings rows: probe.ok=false (warning).
 *  - email with at least one mapping row: probe.ok=true, details carry
 *    sender_domains + inbound_address.
 *  - webhook: probe.ok=true, details carry url + sample_curl.
 *  - api_poll: probe.ok=false, clean message, HTTP 200 (not 500).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { seedTestData, generateTestId } from '../helpers/db';
import { onRequestPost as testConnector } from '../../functions/api/connectors/[id]/test';

let seed: Awaited<ReturnType<typeof seedTestData>>;
const db = env.DB;

beforeAll(async () => {
  seed = await seedTestData(db);

  // The webhooks / email-ingest test suite expects this table to exist —
  // migration 0017 drops it. Recreate it so the email probe can hit real
  // rows for the "has mappings" happy path. Mirrors tests/api/webhooks.test.ts.
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
}, 30_000);

async function insertConnector(opts: {
  tenantId: string;
  connectorType: 'email' | 'webhook' | 'file_watch' | 'api_poll';
  config?: Record<string, unknown>;
  sampleR2Key?: string | null;
}): Promise<string> {
  const id = generateTestId();
  await db
    .prepare(
      `INSERT INTO connectors (id, tenant_id, name, connector_type, system_type, config, field_mappings, active, sample_r2_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'erp', ?, ?, 1, ?, datetime('now'), datetime('now'))`,
    )
    .bind(
      id,
      opts.tenantId,
      `probe-test-${id}`,
      opts.connectorType,
      JSON.stringify(opts.config || {}),
      JSON.stringify({ version: 2, core: {}, extended: [] }),
      opts.sampleR2Key ?? null,
    )
    .run();
  return id;
}

function makeContext(
  id: string,
  user: { id: string; role: string; tenant_id: string | null },
) {
  const request = new Request(`http://localhost/api/connectors/${id}/test`, { method: 'POST' });
  return {
    request,
    env,
    data: { user },
    params: { id },
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
    functionPath: `/api/connectors/${id}/test`,
  } as any;
}

describe('POST /api/connectors/:id/test — file_watch probe', () => {
  it('returns probe.ok=true with sample metadata for a reachable sample', async () => {
    // Stage a real sample in R2.
    const sampleKey = `tmp/connector-samples/${seed.tenantId}/${generateTestId()}`;
    const csv = 'Order #,Cust #\nSO-1,K-1\nSO-2,K-2\nSO-3,K-3';
    await env.FILES.put(sampleKey, new TextEncoder().encode(csv), {
      httpMetadata: { contentType: 'text/csv' },
      customMetadata: {
        source_type: 'csv',
        tenant_id: seed.tenantId,
        original_name: 'probe-orders.csv',
      },
    });

    const id = await insertConnector({
      tenantId: seed.tenantId,
      connectorType: 'file_watch',
      sampleR2Key: sampleKey,
    });
    const user = { id: seed.orgAdminId, role: 'org_admin', tenant_id: seed.tenantId };

    const response = await testConnector(makeContext(id, user));
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      probe: { probe: string; ok: boolean; message: string; details: Record<string, unknown> };
    };
    expect(body.probe.probe).toBe('file_watch');
    expect(body.probe.ok).toBe(true);
    expect(body.probe.details.file_name).toBe('probe-orders.csv');
    expect(body.probe.details.source_type).toBe('csv');
    expect(body.probe.details.row_count).toBe(3);
    expect(body.probe.details.size).toBeGreaterThan(0);
  });

  it('returns probe.ok=false when no stored sample exists', async () => {
    const id = await insertConnector({
      tenantId: seed.tenantId,
      connectorType: 'file_watch',
      sampleR2Key: null,
    });
    const user = { id: seed.orgAdminId, role: 'org_admin', tenant_id: seed.tenantId };

    const response = await testConnector(makeContext(id, user));
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      probe: { ok: boolean; message: string };
    };
    expect(body.probe.ok).toBe(false);
    expect(body.probe.message).toMatch(/No stored sample/i);
  });

  it('returns probe.ok=false when the sample_r2_key points at missing R2 object', async () => {
    const id = await insertConnector({
      tenantId: seed.tenantId,
      connectorType: 'file_watch',
      sampleR2Key: `tmp/connector-samples/${seed.tenantId}/does-not-exist-${generateTestId()}`,
    });
    const user = { id: seed.orgAdminId, role: 'org_admin', tenant_id: seed.tenantId };

    const response = await testConnector(makeContext(id, user));
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      probe: { ok: boolean; message: string };
    };
    expect(body.probe.ok).toBe(false);
    expect(body.probe.message).toMatch(/no longer reachable|not found|expired/i);
  });
});

describe('POST /api/connectors/:id/test — email probe', () => {
  // The probe no longer consults `email_domain_mappings` — see
  // `probeEmail` in `functions/api/connectors/[id]/test.ts`. The connector
  // dispatch path is sender-agnostic; the receive address itself is the
  // routing key, so the probe only needs a valid config + a tenant slug.

  it('returns probe.ok=true with the inbound receive address on prod hosts', async () => {
    const id = await insertConnector({
      tenantId: seed.tenantId,
      connectorType: 'email',
      config: { subject_patterns: ['Test'] },
    });
    const user = { id: seed.orgAdminId, role: 'org_admin', tenant_id: seed.tenantId };

    const response = await testConnector(makeContext(id, user));
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      probe: { ok: boolean; message: string; details: Record<string, unknown> };
    };
    expect(body.probe.ok).toBe(true);
    expect(body.probe.details.inbound_address).toBe('test-corp@supdox.com');
    expect(body.probe.details.environment).toBe('production');
    // Probe message must NOT reference the dropped email_domain_mappings table.
    expect(body.probe.message).not.toMatch(/email_domain_mappings/i);
    expect(body.probe.message).toMatch(/test-corp@supdox\.com/);
  });

  it('returns probe.ok=false with a staging-not-wired message on staging hosts', async () => {
    const id = await insertConnector({
      tenantId: seed.tenantId,
      connectorType: 'email',
      config: { subject_patterns: ['Test'] },
    });
    const user = { id: seed.orgAdminId, role: 'org_admin', tenant_id: seed.tenantId };

    // Hand-roll a context with a staging URL so isStagingHost() returns true.
    const stagingRequest = new Request(
      `https://doc-upload-site-staging.pages.dev/api/connectors/${id}/test`,
      { method: 'POST' },
    );
    const ctx = {
      request: stagingRequest,
      env,
      data: { user },
      params: { id },
      waitUntil: () => {},
      passThroughOnException: () => {},
      next: async () => new Response(null),
      functionPath: `/api/connectors/${id}/test`,
    } as any;

    const response = await testConnector(ctx);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      probe: { ok: boolean; message: string; details: Record<string, unknown> };
    };
    expect(body.probe.ok).toBe(false);
    expect(body.probe.message).toMatch(/staging/i);
    expect(body.probe.message).not.toMatch(/email_domain_mappings/i);
    expect(body.probe.details.environment).toBe('staging');
    // Address still derived (so the UI can show it), just with the staging domain.
    expect(body.probe.details.inbound_address).toBe('test-corp@supdox-staging.com');
  });
});

describe('POST /api/connectors/:id/test — webhook probe', () => {
  it('returns the public webhook URL and a sample curl', async () => {
    const id = await insertConnector({
      tenantId: seed.tenantId,
      connectorType: 'webhook',
      config: { signature_method: 'hmac_sha256', signature_header: 'X-Signature' },
    });
    const user = { id: seed.orgAdminId, role: 'org_admin', tenant_id: seed.tenantId };

    const response = await testConnector(makeContext(id, user));
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      probe: { ok: boolean; details: Record<string, unknown> };
    };
    expect(body.probe.ok).toBe(true);
    expect(body.probe.details.url).toMatch(new RegExp(`/api/webhooks/connectors/${id}$`));
    expect(body.probe.details.sample_curl).toMatch(/curl -X POST/);
    expect(body.probe.details.auth_configured).toBe(true);
  });

  it('flags missing auth config in the probe message', async () => {
    const id = await insertConnector({
      tenantId: seed.tenantId,
      connectorType: 'webhook',
      config: {},
    });
    const user = { id: seed.orgAdminId, role: 'org_admin', tenant_id: seed.tenantId };

    const response = await testConnector(makeContext(id, user));
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      probe: { ok: boolean; message: string; details: Record<string, unknown> };
    };
    expect(body.probe.details.auth_configured).toBe(false);
    // The URL is still generated — auth gap is called out in the message.
    expect(body.probe.message).toMatch(/no signature method|no.+auth/i);
  });
});

describe('POST /api/connectors/:id/test — api_poll probe', () => {
  it('cleanly returns "not implemented" without crashing', async () => {
    const id = await insertConnector({
      tenantId: seed.tenantId,
      connectorType: 'api_poll',
      config: { endpoint_url: 'https://example.com/api' },
    });
    const user = { id: seed.orgAdminId, role: 'org_admin', tenant_id: seed.tenantId };

    const response = await testConnector(makeContext(id, user));
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      probe: { ok: boolean; message: string };
    };
    expect(body.probe.ok).toBe(false);
    expect(body.probe.message).toMatch(/not implemented/i);
  });
});
