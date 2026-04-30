/**
 * Tests for the Phase B4 public drop link auth path on
 * `POST /api/connectors/:id/drop`.
 *
 * The drop endpoint accepts EITHER `api_token` (Phase B2) or
 * `public_link_token` (Phase B4) as the bearer. These tests focus on
 * the public-link arm:
 *
 *   - Drop with valid public_link_token -> 200
 *   - Drop with expired public_link_token -> 401
 *   - Drop after revoke (token NULL) -> 401 (auth fallthrough)
 *   - Drop with right slug but wrong token -> 401
 *   - Drop with the api_token still works (regression check)
 *   - Successful public-link drop tags the run with source='public_link'
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { seedTestData, generateTestId } from '../helpers/db';
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
      order_number: { enabled: true, required: true, source_labels: ['Order #'] },
    },
    extended: [],
  };
}

async function insertConnector(opts: {
  tenantId: string;
  apiToken?: string | null;
  publicLinkToken?: string | null;
  publicLinkExpiresAt?: number | null;
  active?: number;
  deletedAt?: string | null;
  slug?: string | null;
}): Promise<{ id: string; slug: string | null }> {
  const id = generateTestId();
  const slug = opts.slug === undefined ? `pl-test-${id.slice(0, 8)}` : opts.slug;
  await db
    .prepare(
      `INSERT INTO connectors (id, tenant_id, name, slug,
                               config, field_mappings, active,
                               api_token, public_link_token,
                               public_link_expires_at, deleted_at,
                               created_at, updated_at)
       VALUES (?, ?, ?, ?, '{}', ?, ?, ?, ?, ?, ?,
               datetime('now'), datetime('now'))`,
    )
    .bind(
      id,
      opts.tenantId,
      `pl-test-${id}`,
      slug,
      JSON.stringify(defaultMappings()),
      opts.active ?? 1,
      opts.apiToken === undefined ? null : opts.apiToken,
      opts.publicLinkToken === undefined ? null : opts.publicLinkToken,
      opts.publicLinkExpiresAt === undefined ? null : opts.publicLinkExpiresAt,
      opts.deletedAt ?? null,
    )
    .run();
  return { id, slug };
}

function makeContext(connectorId: string, request: Request) {
  return {
    request,
    env,
    data: {},
    params: { id: connectorId },
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
    functionPath: `/api/connectors/${connectorId}/drop`,
  } as any;
}

function multipartRequest(
  connectorId: string,
  csv: string,
  authorization: string,
): Request {
  const form = new FormData();
  form.append('file', new File([csv], 'orders.csv', { type: 'text/csv' }));
  return new Request(`http://localhost/api/connectors/${connectorId}/drop`, {
    method: 'POST',
    headers: { authorization },
    body: form,
  });
}

describe('POST /api/connectors/:id/drop — public-link auth path (Phase B4)', () => {
  it('accepts a drop with a valid public_link_token (no expiry)', async () => {
    const { id } = await insertConnector({
      tenantId: seed.tenantId,
      apiToken: null,
      publicLinkToken: 'pl-no-expiry',
      publicLinkExpiresAt: null,
    });
    const req = multipartRequest(id, 'Order #\nSO-PL-1', 'Bearer pl-no-expiry');
    const resp = await dropPost(makeContext(id, req));
    expect(resp.status).toBe(200);
  });

  it('accepts a drop with a valid public_link_token (future expiry)', async () => {
    const future = Math.floor(Date.now() / 1000) + 3600;
    const { id } = await insertConnector({
      tenantId: seed.tenantId,
      apiToken: null,
      publicLinkToken: 'pl-future-expiry',
      publicLinkExpiresAt: future,
    });
    const req = multipartRequest(id, 'Order #\nSO-PL-2', 'Bearer pl-future-expiry');
    const resp = await dropPost(makeContext(id, req));
    expect(resp.status).toBe(200);
  });

  it('rejects a drop with an expired public_link_token (401)', async () => {
    const past = Math.floor(Date.now() / 1000) - 60;
    const { id } = await insertConnector({
      tenantId: seed.tenantId,
      apiToken: null,
      publicLinkToken: 'pl-expired',
      publicLinkExpiresAt: past,
    });
    const req = multipartRequest(id, 'Order #\nSO-EXP-1', 'Bearer pl-expired');
    const resp = await dropPost(makeContext(id, req));
    expect(resp.status).toBe(401);
  });

  it('rejects a drop after the public link has been revoked (token NULL) (401)', async () => {
    const { id } = await insertConnector({
      tenantId: seed.tenantId,
      apiToken: null,
      publicLinkToken: null,
      publicLinkExpiresAt: null,
    });
    // Simulate vendor still trying with an old (now-NULLed) token.
    const req = multipartRequest(id, 'Order #\nSO-REV-1', 'Bearer some-old-token');
    const resp = await dropPost(makeContext(id, req));
    expect(resp.status).toBe(401);
  });

  it('rejects a drop with the right slug but wrong public_link_token (401)', async () => {
    const { id } = await insertConnector({
      tenantId: seed.tenantId,
      apiToken: null,
      publicLinkToken: 'pl-correct',
      publicLinkExpiresAt: null,
    });
    const req = multipartRequest(id, 'Order #\nSO-WRONG-1', 'Bearer pl-incorrect');
    const resp = await dropPost(makeContext(id, req));
    expect(resp.status).toBe(401);
  });

  it('still accepts api_token alongside an active public_link_token', async () => {
    const future = Math.floor(Date.now() / 1000) + 3600;
    const { id } = await insertConnector({
      tenantId: seed.tenantId,
      apiToken: 'api-tok-coexist',
      publicLinkToken: 'pl-coexist',
      publicLinkExpiresAt: future,
    });
    const req = multipartRequest(id, 'Order #\nSO-COEX-1', 'Bearer api-tok-coexist');
    const resp = await dropPost(makeContext(id, req));
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { run_id: string };
    const run = await db
      .prepare(`SELECT source FROM connector_runs WHERE id = ?`)
      .bind(body.run_id)
      .first<{ source: string | null }>();
    expect(run?.source).toBe('api');
  });

  it("tags the run with source='public_link' on a successful public-link drop", async () => {
    const { id } = await insertConnector({
      tenantId: seed.tenantId,
      apiToken: null,
      publicLinkToken: 'pl-source-tag',
      publicLinkExpiresAt: null,
    });
    const req = multipartRequest(id, 'Order #\nSO-TAG-1', 'Bearer pl-source-tag');
    const resp = await dropPost(makeContext(id, req));
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { run_id: string };
    const run = await db
      .prepare(`SELECT source FROM connector_runs WHERE id = ?`)
      .bind(body.run_id)
      .first<{ source: string | null }>();
    expect(run?.source).toBe('public_link');
  });
});
