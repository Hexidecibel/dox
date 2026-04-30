/**
 * API test for GET /api/connectors/:id/sample — rehydrates a stored sample
 * for an existing connector and re-runs schema discovery.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { seedTestData, generateTestId } from '../helpers/db';
import { onRequestGet as rehydrateSample } from '../../functions/api/connectors/[id]/sample';

let seed: Awaited<ReturnType<typeof seedTestData>>;
const db = env.DB;

beforeAll(async () => {
  seed = await seedTestData(db);
}, 30_000);

async function seedConnectorWithSample(tenantId: string, csv: string): Promise<{ connectorId: string; sampleKey: string }> {
  const sampleKey = `tmp/connector-samples/${tenantId}/${generateTestId()}`;
  await env.FILES.put(sampleKey, new TextEncoder().encode(csv), {
    httpMetadata: { contentType: 'text/csv' },
    customMetadata: {
      source_type: 'csv',
      tenant_id: tenantId,
      original_name: 'orig.csv',
      expires_at: String(Date.now() + 3600_000),
    },
  });

  const connectorId = generateTestId();
  await db.prepare(
    `INSERT INTO connectors (id, tenant_id, name, config, field_mappings, active, created_at, updated_at, sample_r2_key)
     VALUES (?, ?, ?, ?, ?, 1, datetime('now'), datetime('now'), ?)`
  ).bind(
    connectorId,
    tenantId,
    'Test connector',
    '{}',
    JSON.stringify({ version: 2, core: {}, extended: [] }),
    sampleKey,
  ).run();

  return { connectorId, sampleKey };
}

function makeContext(
  id: string,
  user: { id: string; role: string; tenant_id: string | null },
) {
  const request = new Request(`http://localhost/api/connectors/${id}/sample`, { method: 'GET' });
  return {
    request,
    env,
    data: { user },
    params: { id },
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
    functionPath: `/api/connectors/${id}/sample`,
  } as any;
}

describe('GET /api/connectors/:id/sample', () => {
  it('rehydrates a CSV sample and returns detected_fields', async () => {
    const csv = `Order #,Cust #,Customer Name
SO-1001,K00123,Acme Corp
SO-1002,K00124,Beta Inc`;
    const { connectorId } = await seedConnectorWithSample(seed.tenantId, csv);

    const user = { id: seed.orgAdminId, role: 'org_admin', tenant_id: seed.tenantId };
    const response = await rehydrateSample(makeContext(connectorId, user));
    expect(response.status).toBe(200);
    const data = await response.json() as {
      sample_id: string;
      source_type: string;
      detected_fields: Array<{ name: string; candidate_target?: string }>;
      suggested_mappings: { version: number };
    };
    expect(data.source_type).toBe('csv');
    expect(data.detected_fields.length).toBe(3);
    expect(data.detected_fields[0].name).toBe('Order #');
    expect(data.suggested_mappings.version).toBe(2);
  });

  it('returns 404 for a connector without a stored sample', async () => {
    const connectorId = generateTestId();
    await db.prepare(
      `INSERT INTO connectors (id, tenant_id, name, config, field_mappings, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, datetime('now'), datetime('now'))`
    ).bind(
      connectorId,
      seed.tenantId,
      'No sample connector',
      '{}',
      JSON.stringify({ version: 2, core: {}, extended: [] }),
    ).run();

    const user = { id: seed.orgAdminId, role: 'org_admin', tenant_id: seed.tenantId };
    const response = await rehydrateSample(makeContext(connectorId, user));
    expect(response.status).toBe(404);
  });

  it('blocks cross-tenant access', async () => {
    const csv = `Order #\nSO-1`;
    const { connectorId } = await seedConnectorWithSample(seed.tenantId, csv);
    // Other-tenant admin (different tenant_id) should 404.
    const user = { id: seed.orgAdmin2Id, role: 'org_admin', tenant_id: seed.tenantId2 };
    const response = await rehydrateSample(makeContext(connectorId, user));
    expect(response.status).toBeGreaterThanOrEqual(400);
  });
});
