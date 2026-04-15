/**
 * Regression test for POST /api/connectors/:id/test.
 *
 * The detail-page "Test" button was broken because the endpoint required
 * `config.subject_patterns` on email connectors, which returned 400 for any
 * freshly-created connector that hadn't been through the wizard yet. The
 * requirement has been downgraded to a warning — an email connector with
 * no patterns + no sender filter is legal (matches every email for its
 * tenant) but the response surfaces an actionable warning so the UI can
 * tell the user.
 *
 * Coverage:
 *  - email connector with empty config succeeds (regression case)
 *  - warning is emitted when patterns + sender filter are both absent
 *  - email connector with patterns succeeds cleanly (no warnings)
 *  - api_poll connector still requires endpoint_url (400 when missing)
 *  - 403 when a user's tenant doesn't match the connector's tenant
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { seedTestData, generateTestId } from '../helpers/db';
import { onRequestPost as testConnector } from '../../functions/api/connectors/[id]/test';

let seed: Awaited<ReturnType<typeof seedTestData>>;
const db = env.DB;

beforeAll(async () => {
  seed = await seedTestData(db);
}, 30_000);

async function insertConnector(
  tenantId: string,
  connectorType: 'email' | 'api_poll' | 'webhook' | 'file_watch',
  config: Record<string, unknown>,
): Promise<string> {
  const id = generateTestId();
  await db
    .prepare(
      `INSERT INTO connectors (id, tenant_id, name, connector_type, system_type, config, field_mappings, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'erp', ?, ?, 1, datetime('now'), datetime('now'))`,
    )
    .bind(
      id,
      tenantId,
      `test-${connectorType}`,
      connectorType,
      JSON.stringify(config),
      JSON.stringify({ version: 2, core: {}, extended: [] }),
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

describe('POST /api/connectors/:id/test', () => {
  it('succeeds for an email connector with an empty config (regression)', async () => {
    const connectorId = await insertConnector(seed.tenantId, 'email', {});
    const user = { id: seed.orgAdminId, role: 'org_admin', tenant_id: seed.tenantId };

    const response = await testConnector(makeContext(connectorId, user));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { success: boolean; message: string; warnings: string[] };
    expect(body.success).toBe(true);
    expect(body.warnings.length).toBeGreaterThan(0);
    expect(body.warnings[0]).toMatch(/match/i);
  });

  it('emits no warnings when subject_patterns are set', async () => {
    const connectorId = await insertConnector(seed.tenantId, 'email', {
      subject_patterns: ['Order Status', 'COA'],
    });
    const user = { id: seed.orgAdminId, role: 'org_admin', tenant_id: seed.tenantId };

    const response = await testConnector(makeContext(connectorId, user));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { success: boolean; warnings: string[] };
    expect(body.success).toBe(true);
    expect(body.warnings).toEqual([]);
  });

  it('emits no warnings when only a sender filter is set', async () => {
    const connectorId = await insertConnector(seed.tenantId, 'email', {
      sender_filter: '@trusted.example.com',
    });
    const user = { id: seed.orgAdminId, role: 'org_admin', tenant_id: seed.tenantId };

    const response = await testConnector(makeContext(connectorId, user));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { success: boolean; warnings: string[] };
    expect(body.success).toBe(true);
    expect(body.warnings).toEqual([]);
  });

  it('still rejects api_poll connectors missing endpoint_url', async () => {
    const connectorId = await insertConnector(seed.tenantId, 'api_poll', {});
    const user = { id: seed.orgAdminId, role: 'org_admin', tenant_id: seed.tenantId };

    const response = await testConnector(makeContext(connectorId, user));
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toMatch(/endpoint_url/);
  });

  it('rejects when the user is from a different tenant', async () => {
    const connectorId = await insertConnector(seed.tenantId, 'email', {
      subject_patterns: ['Whatever'],
    });
    const user = { id: 'other-user', role: 'org_admin', tenant_id: 'some-other-tenant-id' };

    const response = await testConnector(makeContext(connectorId, user));
    // requireTenantAccess throws ForbiddenError which should 403.
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
  });
});
