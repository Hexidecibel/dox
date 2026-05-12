/**
 * API tests for the per-connector extraction instructions surface (R2.b).
 *
 * The connector PUT endpoint (`/api/connectors/:id`) accepts an
 * `extraction_instructions` field. Once set, the value is forwarded into
 * every subsequent ConnectorContext via the orchestrator and prepended to
 * the Qwen parsing prompt. These tests exercise the API contract:
 *
 *   - PUT saves trimmed instructions and GET returns them.
 *   - Empty / whitespace / null clears the row (treated identically).
 *   - Length cap is enforced.
 *   - Type validation rejects non-strings.
 *   - Non-admin (user, reader) cannot mutate.
 *   - Cross-tenant access denied for both GET (NotFound) and PUT.
 *
 * Drives the handlers directly with a fake PagesFunction context — mirrors
 * tests/api/connector-crud.test.ts since the vitest-pool-workers config
 * doesn't wire up SELF.fetch in this project.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { runMigrations, seedTestData, generateTestId } from '../helpers/db';
import {
  onRequestGet as getConnector,
  onRequestPut as putConnector,
} from '../../functions/api/connectors/[id]';

const db = env.DB;
let seed: Awaited<ReturnType<typeof seedTestData>>;

// Fixtures
let connectorId = '';
let otherTenantConnectorId = '';

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
  const request = new Request(`http://localhost/api/connectors/${id}`, {
    method: 'GET',
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

async function insertConnector(tenantId: string): Promise<string> {
  const id = generateTestId();
  await db
    .prepare(
      `INSERT INTO connectors (id, tenant_id, name, config, field_mappings, active, created_by, created_at, updated_at)
       VALUES (?, ?, ?, '{}', '{}', 1, ?, datetime('now'), datetime('now'))`,
    )
    .bind(id, tenantId, `instr-test-${id.slice(0, 6)}`, seed.orgAdminId)
    .run();
  return id;
}

beforeAll(async () => {
  await runMigrations(db);
  seed = await seedTestData(db);
  connectorId = await insertConnector(seed.tenantId);
  otherTenantConnectorId = await insertConnector(seed.tenantId2);
}, 30_000);

describe('PUT /api/connectors/:id — extraction_instructions', () => {
  const orgAdmin = () => ({ id: seed.orgAdminId, role: 'org_admin', tenant_id: seed.tenantId });

  it('saves instructions and GET returns them verbatim', async () => {
    const text = 'CODE DATE column is expiration_date. Ignore footer "totals" rows.';
    const putRes = await putConnector(makePutContext(connectorId, { extraction_instructions: text }, orgAdmin()));
    expect(putRes.status).toBe(200);

    const getRes = await getConnector(makeGetContext(connectorId, orgAdmin()));
    expect(getRes.status).toBe(200);
    const body = (await getRes.json()) as { connector: { extraction_instructions?: string | null } };
    expect(body.connector.extraction_instructions).toBe(text);
  });

  it('trims surrounding whitespace before persisting', async () => {
    const text = '   trim me please   \n';
    const putRes = await putConnector(makePutContext(connectorId, { extraction_instructions: text }, orgAdmin()));
    expect(putRes.status).toBe(200);

    const row = await db
      .prepare('SELECT extraction_instructions FROM connectors WHERE id = ?')
      .bind(connectorId)
      .first<{ extraction_instructions: string | null }>();
    expect(row?.extraction_instructions).toBe('trim me please');
  });

  it('empty string clears the row (stored as NULL)', async () => {
    // Pre-load a value so the clear is observable.
    await putConnector(makePutContext(connectorId, { extraction_instructions: 'temp' }, orgAdmin()));
    const clearRes = await putConnector(makePutContext(connectorId, { extraction_instructions: '' }, orgAdmin()));
    expect(clearRes.status).toBe(200);

    const row = await db
      .prepare('SELECT extraction_instructions FROM connectors WHERE id = ?')
      .bind(connectorId)
      .first<{ extraction_instructions: string | null }>();
    expect(row?.extraction_instructions).toBeNull();
  });

  it('explicit null also clears the row', async () => {
    await putConnector(makePutContext(connectorId, { extraction_instructions: 'temp again' }, orgAdmin()));
    const clearRes = await putConnector(makePutContext(connectorId, { extraction_instructions: null }, orgAdmin()));
    expect(clearRes.status).toBe(200);

    const row = await db
      .prepare('SELECT extraction_instructions FROM connectors WHERE id = ?')
      .bind(connectorId)
      .first<{ extraction_instructions: string | null }>();
    expect(row?.extraction_instructions).toBeNull();
  });

  it('rejects non-string non-null payloads with 400', async () => {
    const putRes = await putConnector(
      makePutContext(connectorId, { extraction_instructions: 42 }, orgAdmin()),
    );
    expect(putRes.status).toBe(400);
  });

  it('rejects payloads over the length cap', async () => {
    const bigText = 'x'.repeat(8001);
    const putRes = await putConnector(
      makePutContext(connectorId, { extraction_instructions: bigText }, orgAdmin()),
    );
    expect(putRes.status).toBe(400);
  });

  it('non-admin "user" role gets 403', async () => {
    const regularUser = { id: seed.userId, role: 'user', tenant_id: seed.tenantId };
    const putRes = await putConnector(
      makePutContext(connectorId, { extraction_instructions: 'should not write' }, regularUser),
    );
    expect(putRes.status).toBe(403);
  });

  it('reader role gets 403', async () => {
    const reader = { id: seed.readerId, role: 'reader', tenant_id: seed.tenantId };
    const putRes = await putConnector(
      makePutContext(connectorId, { extraction_instructions: 'should not write' }, reader),
    );
    expect(putRes.status).toBe(403);
  });

  it('cross-tenant org_admin cannot mutate', async () => {
    const otherAdmin = { id: seed.orgAdmin2Id, role: 'org_admin', tenant_id: seed.tenantId2 };
    const putRes = await putConnector(
      makePutContext(connectorId, { extraction_instructions: 'cross-tenant attempt' }, otherAdmin),
    );
    // Tenant gate fires 403; the row still belongs to tenant 1 so we don't
    // 404 — confirming the rejection is the access check, not a misfire.
    expect(putRes.status).toBe(403);
  });

  it('cross-tenant org_admin cannot read', async () => {
    const otherAdmin = { id: seed.orgAdmin2Id, role: 'org_admin', tenant_id: seed.tenantId2 };
    const getRes = await getConnector(makeGetContext(connectorId, otherAdmin));
    // GET collapses access-denied to NotFound to avoid leaking existence.
    expect(getRes.status).toBe(404);
  });

  it('super_admin can mutate any tenant', async () => {
    const superAdmin = { id: seed.superAdminId, role: 'super_admin', tenant_id: null };
    const putRes = await putConnector(
      makePutContext(otherTenantConnectorId, { extraction_instructions: 'super-admin write' }, superAdmin),
    );
    expect(putRes.status).toBe(200);

    const row = await db
      .prepare('SELECT extraction_instructions FROM connectors WHERE id = ?')
      .bind(otherTenantConnectorId)
      .first<{ extraction_instructions: string | null }>();
    expect(row?.extraction_instructions).toBe('super-admin write');
  });
});

describe('parseWithAI prompt prepend (R2.b integration)', () => {
  it('prependConnectorInstructions inserts the reviewer header into the prompt', async () => {
    // Pull the helper directly. Keeping this as a unit-style assertion next to
    // the API tests so a single test file covers both the persistence path
    // (PUT/GET) and the prompt-construction path (the *reason* we persist).
    const { prependConnectorInstructions, getDefaultParsingPrompt } = await import(
      '../../functions/lib/connectors/email'
    );

    const base = getDefaultParsingPrompt();
    const out = prependConnectorInstructions(base, 'TREAT CODE DATE AS expiration_date');

    expect(out.startsWith('## Reviewer instructions')).toBe(true);
    expect(out).toMatch(/TREAT CODE DATE AS expiration_date/);
    // Base prompt still present at the tail — we prepend, not replace.
    expect(out).toContain(base);
  });

  it('is a no-op when instructions are empty / whitespace / undefined', async () => {
    const { prependConnectorInstructions, getDefaultParsingPrompt } = await import(
      '../../functions/lib/connectors/email'
    );
    const base = getDefaultParsingPrompt();
    expect(prependConnectorInstructions(base, undefined)).toBe(base);
    expect(prependConnectorInstructions(base, '')).toBe(base);
    expect(prependConnectorInstructions(base, '   \n\t  ')).toBe(base);
  });
});
