/**
 * Phase B5 — per-connector drop rate limit (60 req/min).
 *
 * The /api/connectors/:id/drop endpoint is the only path that's rate-
 * limited (S3 / email / manual aren't). Both the api_token and the
 * public_link_token paths share the same bucket keyed by connector_id,
 * so a vendor with both tokens can't double their quota.
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { seedTestData, generateTestId } from '../helpers/db';
import { onRequestPost as dropPost } from '../../functions/api/connectors/[id]/drop';

let seed: Awaited<ReturnType<typeof seedTestData>>;
const db = env.DB;

beforeAll(async () => {
  seed = await seedTestData(db);
}, 30_000);

beforeEach(async () => {
  // The rate_limits table is keyed by connector_id; previous tests can
  // leave rows behind that interfere with our counts. Clear it.
  await db.prepare(`DELETE FROM rate_limits`).run();
});

async function insertConnector(
  apiToken: string,
): Promise<string> {
  const id = generateTestId();
  await db
    .prepare(
      `INSERT INTO connectors (id, tenant_id, name, slug,
                               config, field_mappings, active,
                               api_token,
                               created_at, updated_at)
       VALUES (?, ?, ?, ?, '{}', ?, 1, ?,
               datetime('now'), datetime('now'))`,
    )
    .bind(
      id,
      seed.tenantId,
      `rl-${id}`,
      `rl-${id.slice(0, 8)}`,
      JSON.stringify({
        version: 2,
        core: { order_number: { enabled: true, required: true, source_labels: ['Order #'] } },
        extended: [],
      }),
      apiToken,
    )
    .run();
  return id;
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

function buildRequest(connectorId: string, token: string): Request {
  const form = new FormData();
  form.append(
    'file',
    new File(['Order #\nSO-1'], 'orders.csv', { type: 'text/csv' }),
  );
  return new Request(`http://localhost/api/connectors/${connectorId}/drop`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: form,
  });
}

describe('POST /api/connectors/:id/drop — rate limit', () => {
  it('returns 429 with Retry-After once 60 requests/minute is exceeded', async () => {
    const id = await insertConnector('rl-token');

    // Drive 60 requests to fill the bucket. We don't assert each
    // response status — some will fail validation downstream but the
    // rate-limit counter increments either way.
    for (let i = 0; i < 60; i++) {
      const resp = await dropPost(
        makeContext(id, buildRequest(id, 'rl-token')),
      );
      // The response must NOT be 429 yet.
      expect(resp.status).not.toBe(429);
    }

    // 61st request trips the limit.
    const tripping = await dropPost(
      makeContext(id, buildRequest(id, 'rl-token')),
    );
    expect(tripping.status).toBe(429);

    const retryAfter = tripping.headers.get('Retry-After');
    expect(retryAfter).toBeTruthy();
    expect(Number(retryAfter)).toBeGreaterThan(0);

    const body = (await tripping.json()) as {
      error: string;
      retry_after: number;
    };
    expect(body.error).toBe('rate_limited');
    expect(body.retry_after).toBeGreaterThan(0);
  }, 60_000);

  it('does not rate-limit different connectors against each other', async () => {
    const id1 = await insertConnector('tok-a');
    const id2 = await insertConnector('tok-b');

    // Burn id1's bucket.
    for (let i = 0; i < 60; i++) {
      await dropPost(makeContext(id1, buildRequest(id1, 'tok-a')));
    }
    const tripped = await dropPost(makeContext(id1, buildRequest(id1, 'tok-a')));
    expect(tripped.status).toBe(429);

    // id2 still has full quota.
    const fresh = await dropPost(makeContext(id2, buildRequest(id2, 'tok-b')));
    expect(fresh.status).not.toBe(429);
  }, 60_000);
});
