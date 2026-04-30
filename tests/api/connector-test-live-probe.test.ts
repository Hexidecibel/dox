/**
 * Tests for the live probes that POST /api/connectors/:id/test runs.
 *
 * Phase B0 universal-doors model: every connector exposes every intake
 * door, so the endpoint runs ALL applicable probes per call. The
 * response carries `probes[]` (one entry per door) and a legacy `probe`
 * field that surfaces the first non-OK door for the single-Alert UI.
 * For B0 the doors covered are file_watch (manual upload) + email;
 * webhook / api_poll don't have door-specific config yet so they're
 * dropped from the universal probe set.
 *
 * Coverage:
 *  - file_watch probe with a stored sample in R2: ok=true, details carry
 *    file_name / size / source_type.
 *  - file_watch probe with no sample: ok=false.
 *  - file_watch probe with a missing R2 object (expired): ok=false.
 *  - email probe on prod hosts with valid scoping: ok=true, address
 *    derived from tenant slug.
 *  - email probe on staging hosts: ok=false with staging-not-wired
 *    message.
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
  config?: Record<string, unknown>;
  sampleR2Key?: string | null;
}): Promise<string> {
  const id = generateTestId();
  await db
    .prepare(
      `INSERT INTO connectors (id, tenant_id, name, system_type, config, field_mappings, active, sample_r2_key, created_at, updated_at)
       VALUES (?, ?, ?, 'erp', ?, ?, 1, ?, datetime('now'), datetime('now'))`,
    )
    .bind(
      id,
      opts.tenantId,
      `probe-test-${id}`,
      JSON.stringify(opts.config || {}),
      JSON.stringify({ version: 2, core: {}, extended: [] }),
      opts.sampleR2Key ?? null,
    )
    .run();
  return id;
}

interface ProbePayload { probe: string; ok: boolean; message: string; details: Record<string, unknown> }

/**
 * Pick the per-door probe out of the universal `probes[]` response.
 * Phase B0 helper — the legacy single `probe` field surfaces only the
 * first non-OK door, so we walk the array directly to assert on a
 * specific door's outcome.
 */
function pickProbe(probes: ProbePayload[] | undefined, name: string): ProbePayload | undefined {
  return (probes || []).find((p) => p.probe === name);
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

describe('POST /api/connectors/:id/test — file_watch probe (manual-upload door)', () => {
  it('returns ok=true with sample metadata for a reachable sample', async () => {
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
      sampleR2Key: sampleKey,
      // Provide email scoping so the email probe is also OK — that way
      // the legacy `probe` field surfaces the manual-upload door (first
      // non-OK door, or first probe if all are OK).
      config: { subject_patterns: ['Order'] },
    });
    const user = { id: seed.orgAdminId, role: 'org_admin', tenant_id: seed.tenantId };

    const response = await testConnector(makeContext(id, user));
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      probes: ProbePayload[];
    };
    const fwProbe = pickProbe(body.probes, 'file_watch');
    expect(fwProbe).toBeDefined();
    expect(fwProbe!.ok).toBe(true);
    expect(fwProbe!.details.file_name).toBe('probe-orders.csv');
    expect(fwProbe!.details.source_type).toBe('csv');
    expect(fwProbe!.details.row_count).toBe(3);
    expect(fwProbe!.details.size).toBeGreaterThan(0);
  });

  it('returns ok=false when no stored sample exists', async () => {
    const id = await insertConnector({
      tenantId: seed.tenantId,
      sampleR2Key: null,
    });
    const user = { id: seed.orgAdminId, role: 'org_admin', tenant_id: seed.tenantId };

    const response = await testConnector(makeContext(id, user));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { probes: ProbePayload[] };
    const fwProbe = pickProbe(body.probes, 'file_watch');
    expect(fwProbe).toBeDefined();
    expect(fwProbe!.ok).toBe(false);
    expect(fwProbe!.message).toMatch(/No stored sample/i);
  });

  it('returns ok=false when the sample_r2_key points at missing R2 object', async () => {
    const id = await insertConnector({
      tenantId: seed.tenantId,
      sampleR2Key: `tmp/connector-samples/${seed.tenantId}/does-not-exist-${generateTestId()}`,
    });
    const user = { id: seed.orgAdminId, role: 'org_admin', tenant_id: seed.tenantId };

    const response = await testConnector(makeContext(id, user));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { probes: ProbePayload[] };
    const fwProbe = pickProbe(body.probes, 'file_watch');
    expect(fwProbe).toBeDefined();
    expect(fwProbe!.ok).toBe(false);
    expect(fwProbe!.message).toMatch(/no longer reachable|not found|expired/i);
  });
});

describe('POST /api/connectors/:id/test — email probe', () => {
  // The probe no longer consults `email_domain_mappings`. The connector
  // dispatch path is sender-agnostic; the receive address itself is the
  // routing key, so the probe only needs a valid config + a tenant slug.
  // Phase B0: every connector with email-scoping config (subject_patterns
  // or sender_filter) gets the email probe — no per-row type tag involved.

  it('returns ok=true with the inbound receive address on prod hosts', async () => {
    const id = await insertConnector({
      tenantId: seed.tenantId,
      config: { subject_patterns: ['Test'] },
    });
    const user = { id: seed.orgAdminId, role: 'org_admin', tenant_id: seed.tenantId };

    const response = await testConnector(makeContext(id, user));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { probes: ProbePayload[] };
    const emailProbe = pickProbe(body.probes, 'email');
    expect(emailProbe).toBeDefined();
    expect(emailProbe!.ok).toBe(true);
    expect(emailProbe!.details.inbound_address).toBe('test-corp@supdox.com');
    expect(emailProbe!.details.environment).toBe('production');
    expect(emailProbe!.message).not.toMatch(/email_domain_mappings/i);
    expect(emailProbe!.message).toMatch(/test-corp@supdox\.com/);
  });

  it('returns ok=false with a staging-not-wired message on staging hosts', async () => {
    const id = await insertConnector({
      tenantId: seed.tenantId,
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
    const body = (await response.json()) as { probes: ProbePayload[] };
    const emailProbe = pickProbe(body.probes, 'email');
    expect(emailProbe).toBeDefined();
    expect(emailProbe!.ok).toBe(false);
    expect(emailProbe!.message).toMatch(/staging/i);
    expect(emailProbe!.message).not.toMatch(/email_domain_mappings/i);
    expect(emailProbe!.details.environment).toBe('staging');
    expect(emailProbe!.details.inbound_address).toBe('test-corp@supdox-staging.com');
  });
});
