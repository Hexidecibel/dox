/**
 * Regression test for the public webhook endpoint's SELECT column.
 *
 * Earlier the handler queried `SELECT ... type ...` from the connectors
 * table and compared `connector.type !== 'webhook'`. The real DB column
 * (per migration 0030) is `connector_type`, so the value came back as
 * undefined and every request was rejected as "not a webhook type" — even
 * for a correctly-configured webhook connector. This test exercises the
 * same path and proves the SELECT now uses the real column name.
 *
 * Coverage:
 *  - 400 "No webhook authentication configured" on a real webhook connector
 *    (not the old "Connector is not a webhook type" error)
 *  - 404 for a non-existent connector
 *  - 400 "not a webhook type" for an email connector (sanity check)
 *  - 400 "not active" for a deactivated webhook connector
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { seedTestData, generateTestId } from '../helpers/db';
import { onRequestPost as webhookPost } from '../../functions/api/webhooks/connectors/[connectorId]';

let seed: Awaited<ReturnType<typeof seedTestData>>;
const db = env.DB;

beforeAll(async () => {
  seed = await seedTestData(db);
}, 30_000);

async function insertConnector(opts: {
  tenantId: string;
  connectorType: 'email' | 'webhook' | 'file_watch';
  config?: Record<string, unknown>;
  active?: number;
}): Promise<string> {
  const id = generateTestId();
  await db
    .prepare(
      `INSERT INTO connectors (id, tenant_id, name, connector_type, system_type, config, field_mappings, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'erp', ?, ?, ?, datetime('now'), datetime('now'))`,
    )
    .bind(
      id,
      opts.tenantId,
      `webhook-test-${id}`,
      opts.connectorType,
      JSON.stringify(opts.config || {}),
      JSON.stringify({ version: 2, core: {}, extended: [] }),
      opts.active ?? 1,
    )
    .run();
  return id;
}

function makeContext(id: string, body: unknown) {
  const request = new Request(`http://localhost/api/webhooks/connectors/${id}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  return {
    request,
    env,
    data: {},
    params: { connectorId: id },
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
    functionPath: `/api/webhooks/connectors/${id}`,
  } as any;
}

describe('POST /api/webhooks/connectors/:connectorId — column name bug fix', () => {
  it('does NOT reject a real webhook connector with "not a webhook type"', async () => {
    // Webhook connector with no signature method and no IP allowlist. The
    // handler should progress past the type check and land on the
    // "No webhook authentication configured" branch (403). Before the fix
    // it would stop at `connector.type !== 'webhook'` -> 400 because `type`
    // came back undefined.
    const id = await insertConnector({
      tenantId: seed.tenantId,
      connectorType: 'webhook',
      config: {},
    });

    const response = await webhookPost(makeContext(id, { hello: 'world' }));
    const body = (await response.json()) as { error: string };

    // The key assertion: we must NOT get the "is not a webhook type" error.
    expect(body.error).not.toMatch(/not a webhook type/i);
    // And the downstream auth gate should have run, producing 403.
    expect(response.status).toBe(403);
    expect(body.error).toMatch(/No webhook authentication configured/i);
  });

  it('returns 404 for a non-existent connector id', async () => {
    const id = generateTestId();
    const response = await webhookPost(makeContext(id, {}));
    expect(response.status).toBe(404);
  });

  it('returns 400 "not a webhook type" for a real email connector', async () => {
    const id = await insertConnector({
      tenantId: seed.tenantId,
      connectorType: 'email',
      config: { subject_patterns: ['foo'] },
    });
    const response = await webhookPost(makeContext(id, {}));
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toMatch(/not a webhook type/i);
  });

  it('returns 400 "not active" when the webhook connector is inactive', async () => {
    const id = await insertConnector({
      tenantId: seed.tenantId,
      connectorType: 'webhook',
      config: {},
      active: 0,
    });
    const response = await webhookPost(makeContext(id, {}));
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toMatch(/not active/i);
  });
});
