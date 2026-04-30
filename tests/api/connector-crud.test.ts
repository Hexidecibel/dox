/**
 * Regression tests for POST /api/connectors and PUT /api/connectors/:id.
 *
 * These exercise the REST handlers directly (not the DB layer) so we catch
 * validation + persistence issues end-to-end.
 *
 * Coverage:
 *  - Issue 1 regression: PATCH with `config: { subject_patterns: [...] }`
 *    round-trips through the DB. The column is persisted and a GET returns
 *    the same list. This guards against a silent "payload stripped" or
 *    "normalizer swallowed config" bug like the one the user hit while live
 *    testing.
 *  - Part B validation: POST an email connector with neither patterns nor a
 *    sender filter -> 400 with `code: empty_email_config`.
 *  - Part B validation: PATCH an email connector to an empty config -> 400
 *    with the same code (wiping patterns off an active connector is
 *    considered the same class of mistake as creating one with none).
 *  - Baseline happy path: POST an email connector with patterns -> 201 and
 *    the response carries the patterns back.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { seedTestData, generateTestId } from '../helpers/db';
import { onRequestPost as createConnector } from '../../functions/api/connectors/index';
import { onRequestPut as updateConnector, onRequestGet as getConnector } from '../../functions/api/connectors/[id]';

let seed: Awaited<ReturnType<typeof seedTestData>>;
const db = env.DB;

beforeAll(async () => {
  seed = await seedTestData(db);
}, 30_000);

function makePostContext(
  body: Record<string, unknown>,
  user: { id: string; role: string; tenant_id: string | null },
) {
  const request = new Request('http://localhost/api/connectors', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return {
    request,
    env,
    data: { user },
    params: {},
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
    functionPath: '/api/connectors',
  } as any;
}

function makePutContext(
  id: string,
  body: Record<string, unknown>,
  user: { id: string; role: string; tenant_id: string | null },
) {
  const request = new Request(`http://localhost/api/connectors/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return {
    request,
    env,
    data: { user },
    params: { id },
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
    functionPath: `/api/connectors/${id}`,
  } as any;
}

function makeGetContext(
  id: string,
  user: { id: string; role: string; tenant_id: string | null },
) {
  const request = new Request(`http://localhost/api/connectors/${id}`, { method: 'GET' });
  return {
    request,
    env,
    data: { user },
    params: { id },
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
    functionPath: `/api/connectors/${id}`,
  } as any;
}

async function insertEmailConnector(config: Record<string, unknown>): Promise<string> {
  const id = generateTestId();
  await db
    .prepare(
      `INSERT INTO connectors (id, tenant_id, name, system_type, config, field_mappings, active, created_by, created_at, updated_at)
       VALUES (?, ?, ?, 'erp', ?, '{}', 1, ?, datetime('now'), datetime('now'))`,
    )
    .bind(id, seed.tenantId, `crud-test-${id}`, JSON.stringify(config), seed.orgAdminId)
    .run();
  return id;
}

describe('POST /api/connectors — email-scoping validation (universal-doors model)', () => {
  // Phase B0: connectors no longer have a per-row type. The historical
  // "email connector with empty config -> 400" rule is rephrased as
  // "any connector that explicitly opts into email-scoping but provides
  // empty values for both subject_patterns AND sender_filter -> 400".
  it('rejects a connector that opts into email scoping with empty patterns AND empty sender_filter', async () => {
    const user = { id: seed.orgAdminId, role: 'org_admin', tenant_id: seed.tenantId };
    const response = await createConnector(
      makePostContext(
        {
          name: 'Empty Email-Scoped Connector',
          system_type: 'erp',
          tenant_id: seed.tenantId,
          config: { subject_patterns: [], sender_filter: '' },
        },
        user,
      ),
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string; code: string };
    expect(body.code).toBe('empty_email_config');
    expect(body.error).toMatch(/subject pattern|sender filter/i);
  });

  it('accepts a connector with no email scoping at all', async () => {
    // Phase B0: a brand-new connector with no email-scoping config is
    // valid — the email door simply isn't wired for this connector yet.
    // This was REJECTED pre-B0 (when connector_type='email' implied
    // mandatory scoping); now it's the universal default.
    const user = { id: seed.orgAdminId, role: 'org_admin', tenant_id: seed.tenantId };
    const response = await createConnector(
      makePostContext(
        {
          name: 'No-Email-Scoping Connector',
          system_type: 'erp',
          tenant_id: seed.tenantId,
          config: {},
        },
        user,
      ),
    );
    expect(response.status).toBe(201);
  });

  it('accepts a connector with subject patterns', async () => {
    const user = { id: seed.orgAdminId, role: 'org_admin', tenant_id: seed.tenantId };
    const response = await createConnector(
      makePostContext(
        {
          name: 'Patterned Connector',
          system_type: 'erp',
          tenant_id: seed.tenantId,
          config: { subject_patterns: ['Daily COA Report'] },
        },
        user,
      ),
    );
    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      connector: { id: string; config: string | Record<string, unknown> };
    };
    expect(body.connector.id).toBeTruthy();
    const cfg =
      typeof body.connector.config === 'string'
        ? (JSON.parse(body.connector.config) as Record<string, unknown>)
        : body.connector.config;
    expect(cfg.subject_patterns).toEqual(['Daily COA Report']);
  });

  it('accepts a connector with only a sender filter', async () => {
    const user = { id: seed.orgAdminId, role: 'org_admin', tenant_id: seed.tenantId };
    const response = await createConnector(
      makePostContext(
        {
          name: 'Sender-Only Connector',
          system_type: 'erp',
          tenant_id: seed.tenantId,
          config: { sender_filter: '@trusted.example.com' },
        },
        user,
      ),
    );
    expect(response.status).toBe(201);
  });
});

describe('PUT /api/connectors/:id — subject_patterns persistence (Issue 1)', () => {
  it('PATCH with config.subject_patterns is persisted and returned on GET', async () => {
    // Seed a connector with a placeholder pattern so the initial state is
    // valid. We'll PATCH new patterns in, then GET and verify.
    const connectorId = await insertEmailConnector({ subject_patterns: ['Placeholder'] });
    const user = { id: seed.orgAdminId, role: 'org_admin', tenant_id: seed.tenantId };

    const putResponse = await updateConnector(
      makePutContext(
        connectorId,
        { config: { subject_patterns: ['Daily Report', 'Weekly Summary'] } },
        user,
      ),
    );
    expect(putResponse.status).toBe(200);
    const putBody = (await putResponse.json()) as {
      connector: { config: string | Record<string, unknown> };
    };
    const putCfg =
      typeof putBody.connector.config === 'string'
        ? (JSON.parse(putBody.connector.config) as Record<string, unknown>)
        : putBody.connector.config;
    expect(putCfg.subject_patterns).toEqual(['Daily Report', 'Weekly Summary']);

    // Round-trip: fetch via GET and confirm the new patterns are still there.
    const getResponse = await getConnector(makeGetContext(connectorId, user));
    expect(getResponse.status).toBe(200);
    const getBody = (await getResponse.json()) as {
      connector: { config: string | Record<string, unknown> };
    };
    const getCfg =
      typeof getBody.connector.config === 'string'
        ? (JSON.parse(getBody.connector.config) as Record<string, unknown>)
        : getBody.connector.config;
    expect(getCfg.subject_patterns).toEqual(['Daily Report', 'Weekly Summary']);
  });

  it('rejects a PATCH that wipes subject_patterns without a sender filter', async () => {
    const connectorId = await insertEmailConnector({ subject_patterns: ['Placeholder'] });
    const user = { id: seed.orgAdminId, role: 'org_admin', tenant_id: seed.tenantId };

    const response = await updateConnector(
      makePutContext(connectorId, { config: { subject_patterns: [] } }, user),
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { code: string };
    expect(body.code).toBe('empty_email_config');
  });

  it('accepts a PATCH that swaps patterns for a sender filter', async () => {
    const connectorId = await insertEmailConnector({ subject_patterns: ['Placeholder'] });
    const user = { id: seed.orgAdminId, role: 'org_admin', tenant_id: seed.tenantId };

    const response = await updateConnector(
      makePutContext(
        connectorId,
        { config: { sender_filter: '@partner.example.com' } },
        user,
      ),
    );
    expect(response.status).toBe(200);
  });
});
