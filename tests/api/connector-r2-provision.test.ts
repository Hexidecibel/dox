/**
 * Tests for the per-connector R2 provision + rotate endpoints
 * (Phase B3).
 *
 *   POST /api/connectors/:id/r2/provision
 *   POST /api/connectors/:id/r2/rotate
 *
 * Both endpoints sit behind the standard JWT/API-key gate and require
 * super_admin or org_admin in the connector's tenant. We mock the
 * Cloudflare API by stubbing globalThis.fetch — only api.cloudflare.com
 * traffic is intercepted; everything else (D1, R2 bindings) runs in
 * the real Workers test pool.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { env } from 'cloudflare:test';
import { seedTestData, generateTestId } from '../helpers/db';
import { onRequestPost as provisionPost } from '../../functions/api/connectors/[id]/r2/provision';
import { onRequestPost as rotatePost } from '../../functions/api/connectors/[id]/r2/rotate';

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
  slug?: string;
  bucketName?: string | null;
  cfTokenId?: string | null;
}): Promise<{ id: string; slug: string }> {
  const id = generateTestId();
  const slug = opts.slug ?? `r2-test-${id.slice(0, 8)}`;
  await db
    .prepare(
      `INSERT INTO connectors (id, tenant_id, name, slug, system_type,
                               config, field_mappings, active,
                               r2_bucket_name, r2_cf_token_id,
                               created_at, updated_at)
       VALUES (?, ?, ?, ?, 'erp', '{}', ?, 1, ?, ?,
               datetime('now'), datetime('now'))`,
    )
    .bind(
      id,
      opts.tenantId,
      `r2 test ${id}`,
      slug,
      JSON.stringify(defaultMappings()),
      opts.bucketName ?? null,
      opts.cfTokenId ?? null,
    )
    .run();
  return { id, slug };
}

function makeContext(
  connectorId: string,
  user: { id: string; role: string; tenant_id: string | null },
  envOverrides: Record<string, unknown> = {},
) {
  const request = new Request(
    `http://localhost/api/connectors/${connectorId}/r2/provision`,
    { method: 'POST' },
  );
  return {
    request,
    env: { ...env, ...envOverrides },
    data: { user },
    params: { id: connectorId },
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
    functionPath: `/api/connectors/${connectorId}/r2/provision`,
  } as any;
}

/**
 * Stub globalThis.fetch so the provisionR2 helper's CF API calls are
 * intercepted. Returns the calls list + a restore() to put the
 * original fetch back. Only api.cloudflare.com is intercepted —
 * anything else (R2 bindings inside miniflare, D1) bypasses.
 */
function stubCfFetch(
  responder: (
    url: string,
    init?: RequestInit,
  ) => Response | Promise<Response>,
): { calls: Array<{ url: string; method: string }>; restore: () => void } {
  const calls: Array<{ url: string; method: string }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : (input as Request).url ?? String(input);
    if (url.startsWith('https://api.cloudflare.com')) {
      calls.push({ url, method: init?.method ?? 'GET' });
      return await responder(url, init);
    }
    return original(input as any, init);
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

const cfHappyPath = (url: string, init?: RequestInit): Response => {
  if (url.includes('/r2/buckets') && init?.method === 'POST') {
    return new Response(
      JSON.stringify({ result: { name: 'ok' }, success: true }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }
  if (url.endsWith('/tokens') && init?.method === 'POST') {
    return new Response(
      JSON.stringify({
        result: { id: `tok-${crypto.randomUUID()}`, value: `secret-${crypto.randomUUID()}` },
        success: true,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }
  if (url.includes('/tokens/') && init?.method === 'DELETE') {
    return new Response(
      JSON.stringify({ result: {}, success: true }),
      { status: 200 },
    );
  }
  return new Response('unmatched', { status: 599 });
};

const TEST_INTAKE_KEY =
  'aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899';
const TEST_CF_ENV = {
  CLOUDFLARE_ACCOUNT_ID: 'testacct',
  CLOUDFLARE_API_TOKEN: 'testtoken',
  INTAKE_ENCRYPTION_KEY: TEST_INTAKE_KEY,
};

let _stub: ReturnType<typeof stubCfFetch> | null = null;

afterEach(() => {
  if (_stub) {
    _stub.restore();
    _stub = null;
  }
});

describe('POST /api/connectors/:id/r2/provision — permissions', () => {
  it('blocks readers with 403', async () => {
    const { id } = await insertConnector({ tenantId: seed.tenantId });
    const ctx = makeContext(
      id,
      { id: seed.readerId, role: 'reader', tenant_id: seed.tenantId },
      TEST_CF_ENV,
    );
    const resp = await provisionPost(ctx);
    expect(resp.status).toBe(403);
  });

  it('blocks org_admin from a different tenant', async () => {
    const { id } = await insertConnector({ tenantId: seed.tenantId });
    const ctx = makeContext(
      id,
      { id: seed.orgAdmin2Id, role: 'org_admin', tenant_id: seed.tenantId2 },
      TEST_CF_ENV,
    );
    const resp = await provisionPost(ctx);
    expect(resp.status).toBe(403);
  });
});

describe('POST /api/connectors/:id/r2/provision — happy path', () => {
  it('mints bucket+token, persists encrypted secret, returns plaintext once', async () => {
    _stub = stubCfFetch(cfHappyPath);
    const { id, slug } = await insertConnector({ tenantId: seed.tenantId });
    const ctx = makeContext(
      id,
      { id: seed.orgAdminId, role: 'org_admin', tenant_id: seed.tenantId },
      TEST_CF_ENV,
    );
    const resp = await provisionPost(ctx);
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as {
      bucket_name: string;
      access_key_id: string;
      secret_access_key: string;
      endpoint: string;
    };
    expect(body.bucket_name).toBe(`dox-drops-${slug}`);
    expect(body.access_key_id).toMatch(/^[a-f0-9]{64}$/);
    expect(body.secret_access_key).toMatch(/^secret-/);
    expect(body.endpoint).toBe('https://testacct.r2.cloudflarestorage.com');

    const row = await db
      .prepare(
        `SELECT r2_bucket_name, r2_access_key_id,
                r2_secret_access_key_encrypted, r2_cf_token_id
           FROM connectors WHERE id = ?`,
      )
      .bind(id)
      .first<{
        r2_bucket_name: string;
        r2_access_key_id: string;
        r2_secret_access_key_encrypted: string;
        r2_cf_token_id: string;
      }>();
    expect(row?.r2_bucket_name).toBe(`dox-drops-${slug}`);
    expect(row?.r2_access_key_id).toBe(body.access_key_id);
    // Ciphertext should NOT contain the plaintext.
    expect(row?.r2_secret_access_key_encrypted).not.toContain(body.secret_access_key);
    expect(row?.r2_cf_token_id).toMatch(/^tok-/);
  });

  it('returns 409 already_provisioned if the connector already has a bucket', async () => {
    _stub = stubCfFetch(cfHappyPath);
    const { id } = await insertConnector({
      tenantId: seed.tenantId,
      bucketName: 'dox-drops-existing',
    });
    const ctx = makeContext(
      id,
      { id: seed.orgAdminId, role: 'org_admin', tenant_id: seed.tenantId },
      TEST_CF_ENV,
    );
    const resp = await provisionPost(ctx);
    expect(resp.status).toBe(409);
    const body = (await resp.json()) as { error: string };
    expect(body.error).toBe('already_provisioned');
  });

  it('returns 503 when CF env vars are missing', async () => {
    const { id } = await insertConnector({ tenantId: seed.tenantId });
    const ctx = makeContext(
      id,
      { id: seed.orgAdminId, role: 'org_admin', tenant_id: seed.tenantId },
      // Deliberately omit TEST_CF_ENV.
      {},
    );
    const resp = await provisionPost(ctx);
    expect(resp.status).toBe(503);
  });
});

describe('POST /api/connectors/:id/r2/rotate', () => {
  it('returns 409 when the connector has no bucket yet', async () => {
    _stub = stubCfFetch(cfHappyPath);
    const { id } = await insertConnector({ tenantId: seed.tenantId });
    const ctx = makeContext(
      id,
      { id: seed.orgAdminId, role: 'org_admin', tenant_id: seed.tenantId },
      TEST_CF_ENV,
    );
    const resp = await rotatePost(ctx);
    expect(resp.status).toBe(409);
    const body = (await resp.json()) as { error: string };
    expect(body.error).toBe('not_provisioned');
  });

  it('revokes existing token then mints a new one (DB updated)', async () => {
    _stub = stubCfFetch(cfHappyPath);
    const { id, slug } = await insertConnector({
      tenantId: seed.tenantId,
      bucketName: 'dox-drops-pre-existing',
      cfTokenId: 'old-token-id',
    });
    // Stamp a known prior access_key_id so we can confirm rotation
    // changed it.
    await db
      .prepare(
        `UPDATE connectors SET r2_access_key_id = 'old-key-id' WHERE id = ?`,
      )
      .bind(id)
      .run();

    const ctx = makeContext(
      id,
      { id: seed.orgAdminId, role: 'org_admin', tenant_id: seed.tenantId },
      TEST_CF_ENV,
    );
    const resp = await rotatePost(ctx);
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as {
      access_key_id: string;
      secret_access_key: string;
      bucket_name: string;
    };
    expect(body.access_key_id).not.toBe('old-key-id');

    const row = await db
      .prepare(
        `SELECT r2_access_key_id, r2_cf_token_id, r2_secret_access_key_encrypted
           FROM connectors WHERE id = ?`,
      )
      .bind(id)
      .first<{
        r2_access_key_id: string;
        r2_cf_token_id: string;
        r2_secret_access_key_encrypted: string;
      }>();
    expect(row?.r2_access_key_id).toBe(body.access_key_id);
    expect(row?.r2_cf_token_id).not.toBe('old-token-id');

    // Verify CF DELETE for the old token was issued before POST for the new.
    const calls = _stub!.calls;
    const deleteIdx = calls.findIndex(
      (c) => c.method === 'DELETE' && c.url.includes('/tokens/old-token-id'),
    );
    const postIdx = calls.findIndex(
      (c) => c.method === 'POST' && c.url.endsWith('/tokens'),
    );
    expect(deleteIdx).toBeGreaterThanOrEqual(0);
    expect(postIdx).toBeGreaterThan(deleteIdx);

    void slug;
  });

  it('blocks readers with 403', async () => {
    const { id } = await insertConnector({
      tenantId: seed.tenantId,
      bucketName: 'dox-drops-x',
      cfTokenId: 'tok',
    });
    const ctx = makeContext(
      id,
      { id: seed.readerId, role: 'reader', tenant_id: seed.tenantId },
      TEST_CF_ENV,
    );
    const resp = await rotatePost(ctx);
    expect(resp.status).toBe(403);
  });
});

beforeEach(() => {
  // Make sure no stale stub bleeds between tests.
  _stub = null;
});
