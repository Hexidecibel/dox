/**
 * Regression tests for POST /api/connectors/:id/test.
 *
 * Phase B0 universal-doors model: connectors no longer carry a per-row
 * type. Email-scoping validation runs only when the row's config has
 * explicitly opted into the email door (subject_patterns or
 * sender_filter present). The probe response now carries `probes[]` with
 * one entry per door — the legacy single `probe` field points at the
 * first non-OK door for back-compat with the single-Alert UI.
 *
 * Coverage:
 *  - connector with subject_patterns: [] AND sender_filter: '' is REJECTED
 *    (incoherent — opted into the door but provided no scoping).
 *  - connector with only patterns passes; probes[] surfaces email + manual.
 *  - connector with only a sender filter passes.
 *  - connector with no email scoping at all is VALID (empty config — the
 *    email door simply isn't wired for this connector yet).
 *  - 403 when a user's tenant doesn't match the connector's tenant.
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
  config: Record<string, unknown>,
): Promise<string> {
  const id = generateTestId();
  await db
    .prepare(
      `INSERT INTO connectors (id, tenant_id, name, system_type, config, field_mappings, active, created_at, updated_at)
       VALUES (?, ?, ?, 'erp', ?, ?, 1, datetime('now'), datetime('now'))`,
    )
    .bind(
      id,
      tenantId,
      `test-${id}`,
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
  it('rejects a connector that opted into email scoping with empty patterns AND blank sender filter', async () => {
    // Phase B0: opting in (passing the keys) but with empty values is
    // the same incoherent state we rejected pre-B0.
    const connectorId = await insertConnector(seed.tenantId, {
      subject_patterns: [],
      sender_filter: '   ',
    });
    const user = { id: seed.orgAdminId, role: 'org_admin', tenant_id: seed.tenantId };

    const response = await testConnector(makeContext(connectorId, user));
    expect(response.status).toBe(400);
    const body = (await response.json()) as { code: string };
    expect(body.code).toBe('empty_email_config');
  });

  it('accepts a connector with subject_patterns set', async () => {
    const connectorId = await insertConnector(seed.tenantId, {
      subject_patterns: ['Order Status', 'COA'],
    });
    const user = { id: seed.orgAdminId, role: 'org_admin', tenant_id: seed.tenantId };

    const response = await testConnector(makeContext(connectorId, user));
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      success: boolean;
      warnings: string[];
      probe?: { probe: string; ok: boolean };
      probes?: Array<{ probe: string; ok: boolean }>;
    };
    expect(body.success).toBe(true);
    // probes[] carries one entry per door; email and file_watch should both run.
    const probeNames = (body.probes || []).map((p) => p.probe);
    expect(probeNames).toContain('email');
    expect(probeNames).toContain('file_watch');
  });

  it('accepts a connector with only a sender filter', async () => {
    const connectorId = await insertConnector(seed.tenantId, {
      sender_filter: '@trusted.example.com',
    });
    const user = { id: seed.orgAdminId, role: 'org_admin', tenant_id: seed.tenantId };

    const response = await testConnector(makeContext(connectorId, user));
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      success: boolean;
      warnings: string[];
      probe?: { probe: string; ok: boolean };
      probes?: Array<{ probe: string; ok: boolean }>;
    };
    expect(body.success).toBe(true);
    const probeNames = (body.probes || []).map((p) => p.probe);
    expect(probeNames).toContain('email');
  });

  it('accepts a connector with no email-scoping config at all', async () => {
    // Phase B0: brand-new connectors have no email scoping by default —
    // the email door simply isn't wired yet. The endpoint should still
    // return 200 with the manual-upload probe (and an email probe in a
    // not-OK state since there's no scoping).
    const connectorId = await insertConnector(seed.tenantId, {});
    const user = { id: seed.orgAdminId, role: 'org_admin', tenant_id: seed.tenantId };

    const response = await testConnector(makeContext(connectorId, user));
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      success: boolean;
      probes?: Array<{ probe: string; ok: boolean }>;
    };
    expect(body.success).toBe(true);
    expect(body.probes).toBeDefined();
  });

  it('rejects when the user is from a different tenant', async () => {
    const connectorId = await insertConnector(seed.tenantId, {
      subject_patterns: ['Whatever'],
    });
    const user = { id: 'other-user', role: 'org_admin', tenant_id: 'some-other-tenant-id' };

    const response = await testConnector(makeContext(connectorId, user));
    // requireTenantAccess throws ForbiddenError which should 403.
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
  });
});
