/**
 * Regression tests for the public webhook endpoint (universal-doors model).
 *
 * Phase B0 (migration 0048): the `connector_type` column was dropped, so
 * the webhook endpoint can no longer gate on connector type — instead it
 * gates on the actual webhook config (signature_method + signature_header,
 * OR ip_allowlist). Connectors without webhook config fall through to the
 * "no webhook authentication configured" 403, regardless of what other
 * door config they carry.
 *
 * Coverage:
 *  - 403 "No webhook authentication configured" on a connector with no
 *    webhook config (sane default).
 *  - 404 for a non-existent connector.
 *  - 400 "not active" for a deactivated connector.
 *  - 403 (NOT 400 type-mismatch) on a connector with email-style config —
 *    the type-mismatch gate is gone in B0.
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
  config?: Record<string, unknown>;
  active?: number;
}): Promise<string> {
  const id = generateTestId();
  await db
    .prepare(
      `INSERT INTO connectors (id, tenant_id, name, system_type, config, field_mappings, active, created_at, updated_at)
       VALUES (?, ?, ?, 'erp', ?, ?, ?, datetime('now'), datetime('now'))`,
    )
    .bind(
      id,
      opts.tenantId,
      `webhook-test-${id}`,
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

describe('POST /api/webhooks/connectors/:connectorId — universal-doors model', () => {
  it('returns 403 "no webhook auth configured" on a connector with no webhook config', async () => {
    // Phase B0: every connector exposes the webhook door, so the type
    // gate is gone. A connector with no signature_method + no
    // ip_allowlist falls through to the auth gate (403).
    const id = await insertConnector({
      tenantId: seed.tenantId,
      config: {},
    });

    const response = await webhookPost(makeContext(id, { hello: 'world' }));
    const body = (await response.json()) as { error: string };

    expect(response.status).toBe(403);
    expect(body.error).toMatch(/No webhook authentication configured/i);
    // The pre-B0 "not a webhook type" error is gone.
    expect(body.error).not.toMatch(/not a webhook type/i);
  });

  it('returns 404 for a non-existent connector id', async () => {
    const id = generateTestId();
    const response = await webhookPost(makeContext(id, {}));
    expect(response.status).toBe(404);
  });

  it('falls through to the auth gate (NOT a type-mismatch 400) for a connector with email-style config', async () => {
    // Phase B0: the type-mismatch 400 is gone. A connector with email
    // scoping but no webhook auth lands on the same 403 as any other
    // connector without webhook auth — the gate is the actual webhook
    // config, not a per-row type tag.
    const id = await insertConnector({
      tenantId: seed.tenantId,
      config: { subject_patterns: ['foo'] },
    });
    const response = await webhookPost(makeContext(id, {}));
    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: string };
    expect(body.error).toMatch(/No webhook authentication configured/i);
    expect(body.error).not.toMatch(/not a webhook type/i);
  });

  it('returns 400 "not active" when the connector is inactive', async () => {
    const id = await insertConnector({
      tenantId: seed.tenantId,
      config: {},
      active: 0,
    });
    const response = await webhookPost(makeContext(id, {}));
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toMatch(/not active/i);
  });
});
