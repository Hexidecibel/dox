/**
 * Tests for `POST /api/connectors/:id/api-token/rotate`.
 *
 * Permission contract:
 *   - super_admin: can rotate any connector.
 *   - org_admin (same tenant): can rotate.
 *   - org_admin (other tenant): blocked.
 *   - reader / user roles: blocked.
 *
 * Behavior:
 *   - Returns a new 64-char hex token.
 *   - The new token replaces `connectors.api_token` immediately.
 *   - The old token stops working — the drop endpoint rejects it.
 *   - The new token works on the drop endpoint.
 *   - An audit row is written tagged `connector.api_token_rotated`
 *     with the new token's last4 (NOT the full token).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { seedTestData, generateTestId } from '../helpers/db';
import { onRequestPost as rotatePost } from '../../functions/api/connectors/[id]/api-token/rotate';
import { onRequestPost as dropPost } from '../../functions/api/connectors/[id]/drop';

let seed: Awaited<ReturnType<typeof seedTestData>>;
const db = env.DB;

beforeAll(async () => {
  seed = await seedTestData(db);
}, 30_000);

function defaultMappings() {
  return {
    version: 2,
    core: {
      order_number: {
        enabled: true,
        required: true,
        source_labels: ['Order #'],
      },
    },
    extended: [],
  };
}

async function insertConnector(opts: {
  tenantId: string;
  apiToken?: string | null;
}): Promise<string> {
  const id = generateTestId();
  await db
    .prepare(
      `INSERT INTO connectors (id, tenant_id, name, system_type,
                               config, field_mappings, active, api_token,
                               created_at, updated_at)
       VALUES (?, ?, ?, 'erp', '{}', ?, 1, ?,
               datetime('now'), datetime('now'))`,
    )
    .bind(
      id,
      opts.tenantId,
      `rotate-test-${id}`,
      JSON.stringify(defaultMappings()),
      opts.apiToken === undefined ? `seed-${id}` : opts.apiToken,
    )
    .run();
  return id;
}

function makeContext(
  connectorId: string,
  user: { id: string; role: string; tenant_id: string | null },
) {
  const request = new Request(
    `http://localhost/api/connectors/${connectorId}/api-token/rotate`,
    { method: 'POST' },
  );
  return {
    request,
    env,
    data: { user },
    params: { id: connectorId },
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
    functionPath: `/api/connectors/${connectorId}/api-token/rotate`,
  } as any;
}

describe('POST /api/connectors/:id/api-token/rotate — permission gate', () => {
  it('blocks readers with 403', async () => {
    const id = await insertConnector({ tenantId: seed.tenantId });
    const ctx = makeContext(id, {
      id: seed.readerId,
      role: 'reader',
      tenant_id: seed.tenantId,
    });
    const resp = await rotatePost(ctx);
    expect(resp.status).toBe(403);
  });

  it('blocks regular users with 403', async () => {
    const id = await insertConnector({ tenantId: seed.tenantId });
    const ctx = makeContext(id, {
      id: seed.userId,
      role: 'user',
      tenant_id: seed.tenantId,
    });
    const resp = await rotatePost(ctx);
    expect(resp.status).toBe(403);
  });

  it('blocks org_admins from a different tenant', async () => {
    const id = await insertConnector({ tenantId: seed.tenantId });
    const ctx = makeContext(id, {
      id: seed.orgAdmin2Id,
      role: 'org_admin',
      tenant_id: seed.tenantId2,
    });
    const resp = await rotatePost(ctx);
    expect(resp.status).toBe(403);
  });

  it('allows org_admin in the connector tenant', async () => {
    const id = await insertConnector({ tenantId: seed.tenantId });
    const ctx = makeContext(id, {
      id: seed.orgAdminId,
      role: 'org_admin',
      tenant_id: seed.tenantId,
    });
    const resp = await rotatePost(ctx);
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { api_token: string };
    expect(body.api_token).toMatch(/^[a-f0-9]{64}$/);
  });

  it('allows super_admin against any tenant', async () => {
    const id = await insertConnector({ tenantId: seed.tenantId });
    const ctx = makeContext(id, {
      id: seed.superAdminId,
      role: 'super_admin',
      tenant_id: null,
    });
    const resp = await rotatePost(ctx);
    expect(resp.status).toBe(200);
  });
});

describe('POST /api/connectors/:id/api-token/rotate — behavior', () => {
  it('rotates the token, writes the new value to the DB, and audit-logs the last4', async () => {
    const id = await insertConnector({
      tenantId: seed.tenantId,
      apiToken: 'before-rotate',
    });
    const ctx = makeContext(id, {
      id: seed.orgAdminId,
      role: 'org_admin',
      tenant_id: seed.tenantId,
    });
    const resp = await rotatePost(ctx);
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { api_token: string };

    // DB row updated.
    const row = await db
      .prepare(`SELECT api_token FROM connectors WHERE id = ?`)
      .bind(id)
      .first<{ api_token: string }>();
    expect(row?.api_token).toBe(body.api_token);
    expect(row?.api_token).not.toBe('before-rotate');

    // Audit log row exists, references the new token's last4 only.
    const audit = await db
      .prepare(
        `SELECT action, details FROM audit_log
          WHERE resource_type = 'connector' AND resource_id = ?
          ORDER BY id DESC LIMIT 1`,
      )
      .bind(id)
      .first<{ action: string; details: string }>();
    expect(audit?.action).toBe('connector.api_token_rotated');
    const details = JSON.parse(audit!.details) as { last4: string };
    expect(details.last4).toBe(body.api_token.slice(-4));
    // Audit must NOT include the full token.
    expect(audit!.details).not.toContain(body.api_token);
  });

  it('hard-cutover: the old token stops working immediately, the new one starts', async () => {
    const id = await insertConnector({
      tenantId: seed.tenantId,
      apiToken: 'pre-rotation-token',
    });

    // Rotate.
    const ctx = makeContext(id, {
      id: seed.orgAdminId,
      role: 'org_admin',
      tenant_id: seed.tenantId,
    });
    const rotateResp = await rotatePost(ctx);
    expect(rotateResp.status).toBe(200);
    const { api_token: newToken } = (await rotateResp.json()) as { api_token: string };

    // Old token rejected by the drop endpoint.
    const oldDropReq = new Request(`http://localhost/api/connectors/${id}/drop`, {
      method: 'POST',
      headers: { authorization: 'Bearer pre-rotation-token' },
      body: makeFormDataWithCsv('Order #\nSO-1'),
    });
    const oldResp = await dropPost({
      request: oldDropReq,
      env,
      data: {},
      params: { id },
      waitUntil: () => {},
      passThroughOnException: () => {},
      next: async () => new Response(null),
      functionPath: `/api/connectors/${id}/drop`,
    } as any);
    expect(oldResp.status).toBe(401);

    // New token accepted.
    const newDropReq = new Request(`http://localhost/api/connectors/${id}/drop`, {
      method: 'POST',
      headers: { authorization: `Bearer ${newToken}` },
      body: makeFormDataWithCsv('Order #\nSO-1'),
    });
    const newResp = await dropPost({
      request: newDropReq,
      env,
      data: {},
      params: { id },
      waitUntil: () => {},
      passThroughOnException: () => {},
      next: async () => new Response(null),
      functionPath: `/api/connectors/${id}/drop`,
    } as any);
    expect(newResp.status).toBe(200);
  });

  it('returns 404 for a missing connector', async () => {
    const fakeId = generateTestId();
    const ctx = makeContext(fakeId, {
      id: seed.superAdminId,
      role: 'super_admin',
      tenant_id: null,
    });
    const resp = await rotatePost(ctx);
    expect(resp.status).toBe(404);
  });
});

/**
 * Build a multipart/form-data body with a single CSV file under the
 * `file` key. Constructed via the FormData API so the boundary header
 * comes through the Request constructor automatically.
 */
function makeFormDataWithCsv(content: string): FormData {
  const form = new FormData();
  form.append('file', new File([content], 'orders.csv', { type: 'text/csv' }));
  return form;
}
