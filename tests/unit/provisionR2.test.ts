/**
 * Unit tests for `functions/lib/connectors/provisionR2.ts`.
 *
 * The helper talks to the Cloudflare API v4 to create a per-connector
 * R2 bucket + a scoped token. We inject a `fetch` shim so tests don't
 * hit the live CF API. Coverage here:
 *   - Happy-path: bucket create + token create both 200 → returns
 *     well-shaped creds with the correct bucket name and endpoint.
 *   - Bucket-already-exists (CF returns 409 with code 10004): we skip
 *     past the conflict and still mint a token successfully.
 *   - Token creation failure: the helper bubbles a clear error message
 *     including the CF status + truncated body.
 *   - Missing env vars: throws before any network call.
 *   - Rotate path: revokes the existing token, then mints a fresh one.
 *   - Bucket name composition matches `dox-drops-<slug>` and is
 *     trimmed to 63 chars.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  provisionConnectorBucket,
  rotateConnectorR2Token,
  bucketNameForSlug,
  r2EndpointFor,
  __resetPermissionGroupCacheForTests,
} from '../../functions/lib/connectors/provisionR2';
import type { Env } from '../../functions/lib/types';

/**
 * Local SHA-256 hex helper for asserting the derived secret_access_key
 * shape. Mirrors what `provisionR2.ts` does internally.
 */
async function sha256HexForTest(input: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(input),
  );
  const bytes = new Uint8Array(buf);
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, '0');
  }
  return out;
}

interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

/**
 * Build a fetch mock that responds to URL+method tuples with canned
 * responses. Records every call into `calls` for assertions.
 */
function makeFetchMock(
  routes: Array<{
    match: (url: string, init?: RequestInit) => boolean;
    respond: () => Response | Promise<Response>;
  }>,
) {
  const calls: FetchCall[] = [];
  const fn = async (input: string, init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    if (init?.headers) {
      const h = init.headers as Record<string, string>;
      for (const k of Object.keys(h)) headers[k.toLowerCase()] = h[k];
    }
    calls.push({
      url: input,
      method: init?.method ?? 'GET',
      headers,
      body: typeof init?.body === 'string' ? init.body : undefined,
    });
    for (const route of routes) {
      if (route.match(input, init)) {
        return await route.respond();
      }
    }
    return new Response('no route matched', { status: 599 });
  };
  return { fn, calls };
}

const baseEnv: Partial<Env> = {
  CLOUDFLARE_ACCOUNT_ID: 'acct123',
  CLOUDFLARE_API_TOKEN: 'cf-pat-token',
};

beforeEach(() => {
  __resetPermissionGroupCacheForTests();
});

describe('bucketNameForSlug', () => {
  it('prefixes with dox-drops-', () => {
    expect(bucketNameForSlug('acme-foods')).toBe('dox-drops-acme-foods');
  });

  it('lowercases the slug', () => {
    expect(bucketNameForSlug('AcmeFoods')).toBe('dox-drops-acmefoods');
  });

  it('trims to 63 chars', () => {
    const longSlug = 'a'.repeat(80);
    const name = bucketNameForSlug(longSlug);
    expect(name.length).toBeLessThanOrEqual(63);
    expect(name.startsWith('dox-drops-')).toBe(true);
  });
});

describe('r2EndpointFor', () => {
  it('returns the standard R2 S3-compat URL', () => {
    expect(r2EndpointFor('xyz123')).toBe(
      'https://xyz123.r2.cloudflarestorage.com',
    );
  });
});

describe('provisionConnectorBucket — happy path', () => {
  it('creates the bucket, mints a token, and returns the creds', async () => {
    const { fn, calls } = makeFetchMock([
      {
        match: (url, init) =>
          url.includes('/r2/buckets') && init?.method === 'POST',
        respond: () =>
          new Response(
            JSON.stringify({ result: { name: 'dox-drops-acme' }, success: true }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
      },
      {
        match: (url, init) => url.endsWith('/tokens') && init?.method === 'POST',
        respond: () =>
          new Response(
            JSON.stringify({
              result: { id: 'tok-id-abc', value: 'secret-shhh' },
              success: true,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
      },
    ]);

    const creds = await provisionConnectorBucket(
      baseEnv as Env,
      { id: 'conn-1', slug: 'acme' },
      { fetch: fn },
    );

    expect(creds.bucket_name).toBe('dox-drops-acme');
    expect(creds.cf_token_id).toBe('tok-id-abc');
    // Per https://developers.cloudflare.com/r2/api/s3/tokens/ :
    //   access_key_id     = token.id          (32-char hex from CF — here
    //                                          our mock returns 'tok-id-abc'
    //                                          so we match it literally)
    //   secret_access_key = sha256(token.value) lowercase hex (64 chars).
    expect(creds.access_key_id).toBe('tok-id-abc');
    expect(creds.secret_access_key).toMatch(/^[a-f0-9]{64}$/);
    // sha256('secret-shhh') precomputed.
    const expectedSecret = await sha256HexForTest('secret-shhh');
    expect(creds.secret_access_key).toBe(expectedSecret);
    expect(creds.endpoint).toBe('https://acct123.r2.cloudflarestorage.com');

    // Two CF calls, both authenticated.
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toContain('/accounts/acct123/r2/buckets');
    expect(calls[0].headers['authorization']).toBe('Bearer cf-pat-token');
    expect(calls[1].url).toContain('/user/tokens');

    // Token policy scoped to the right bucket resource.
    const tokenBody = JSON.parse(calls[1].body!) as {
      policies: Array<{
        resources: Record<string, string>;
        permission_groups: Array<{ id: string }>;
      }>;
    };
    const resources = tokenBody.policies[0].resources;
    const resourceKeys = Object.keys(resources);
    expect(resourceKeys).toHaveLength(1);
    expect(resourceKeys[0]).toBe(
      'com.cloudflare.edge.r2.bucket.acct123_default_dox-drops-acme',
    );
    expect(resources[resourceKeys[0]]).toBe('*');
    expect(tokenBody.policies[0].permission_groups[0].id).toMatch(/[a-f0-9]{32}/);
  });
});

describe('provisionConnectorBucket — bucket already exists is idempotent', () => {
  it('treats CF 409 / code 10004 as success and proceeds to token mint', async () => {
    const { fn } = makeFetchMock([
      {
        match: (url, init) =>
          url.includes('/r2/buckets') && init?.method === 'POST',
        respond: () =>
          new Response(
            JSON.stringify({
              success: false,
              errors: [
                { code: 10004, message: 'The bucket you tried to create already exists' },
              ],
            }),
            { status: 409, headers: { 'Content-Type': 'application/json' } },
          ),
      },
      {
        match: (url, init) => url.endsWith('/tokens') && init?.method === 'POST',
        respond: () =>
          new Response(
            JSON.stringify({
              result: { id: 'tok-id-2', value: 'secret-2' },
              success: true,
            }),
            { status: 200 },
          ),
      },
    ]);

    const creds = await provisionConnectorBucket(
      baseEnv as Env,
      { id: 'conn-2', slug: 'beta' },
      { fetch: fn },
    );

    expect(creds.bucket_name).toBe('dox-drops-beta');
    expect(creds.cf_token_id).toBe('tok-id-2');
  });
});

describe('provisionConnectorBucket — failure surfaces clear errors', () => {
  it('throws with status + body snippet on token creation failure', async () => {
    const { fn } = makeFetchMock([
      {
        match: (url, init) =>
          url.includes('/r2/buckets') && init?.method === 'POST',
        respond: () =>
          new Response(JSON.stringify({ result: {}, success: true }), {
            status: 200,
          }),
      },
      {
        match: (url, init) => url.endsWith('/tokens') && init?.method === 'POST',
        respond: () =>
          new Response(
            JSON.stringify({
              success: false,
              errors: [{ code: 9999, message: 'Permission denied to mint tokens' }],
            }),
            { status: 403 },
          ),
      },
    ]);

    await expect(
      provisionConnectorBucket(
        baseEnv as Env,
        { id: 'conn-3', slug: 'gamma' },
        { fetch: fn },
      ),
    ).rejects.toThrow(/tokens\.create.*403.*Permission denied/i);
  });

  it('throws on bucket-create non-409 failure', async () => {
    const { fn } = makeFetchMock([
      {
        match: (url, init) =>
          url.includes('/r2/buckets') && init?.method === 'POST',
        respond: () =>
          new Response('Internal Server Error', { status: 500 }),
      },
    ]);

    await expect(
      provisionConnectorBucket(
        baseEnv as Env,
        { id: 'conn-4', slug: 'delta' },
        { fetch: fn },
      ),
    ).rejects.toThrow(/bucket create failed.*500/i);
  });
});

describe('provisionConnectorBucket — env validation', () => {
  it('throws when CLOUDFLARE_ACCOUNT_ID is missing', async () => {
    await expect(
      provisionConnectorBucket(
        { CLOUDFLARE_API_TOKEN: 'x' } as Env,
        { id: 'c', slug: 's' },
        { fetch: async () => new Response('') },
      ),
    ).rejects.toThrow(/CLOUDFLARE_ACCOUNT_ID/);
  });

  it('throws when CLOUDFLARE_API_TOKEN is missing', async () => {
    await expect(
      provisionConnectorBucket(
        { CLOUDFLARE_ACCOUNT_ID: 'x' } as Env,
        { id: 'c', slug: 's' },
        { fetch: async () => new Response('') },
      ),
    ).rejects.toThrow(/CLOUDFLARE_API_TOKEN/);
  });
});

describe('rotateConnectorR2Token', () => {
  it('revokes the existing token then mints a new one', async () => {
    const { fn, calls } = makeFetchMock([
      {
        match: (url, init) =>
          url.includes('/tokens/old-token-id') && init?.method === 'DELETE',
        respond: () =>
          new Response(JSON.stringify({ result: {}, success: true }), {
            status: 200,
          }),
      },
      {
        match: (url, init) => url.endsWith('/tokens') && init?.method === 'POST',
        respond: () =>
          new Response(
            JSON.stringify({
              result: { id: 'new-token-id', value: 'new-secret' },
              success: true,
            }),
            { status: 200 },
          ),
      },
    ]);

    const creds = await rotateConnectorR2Token(
      baseEnv as Env,
      { id: 'conn-5', slug: 'epsilon', cf_token_id: 'old-token-id' },
      { fetch: fn },
    );

    expect(creds.cf_token_id).toBe('new-token-id');
    expect(creds.access_key_id).toBe('new-token-id');
    // secret_access_key = sha256(token.value)
    expect(creds.secret_access_key).toBe(await sha256HexForTest('new-secret'));
    // DELETE happened before POST.
    const deleteIdx = calls.findIndex((c) => c.method === 'DELETE');
    const postIdx = calls.findIndex((c) => c.method === 'POST');
    expect(deleteIdx).toBeLessThan(postIdx);
    expect(deleteIdx).toBeGreaterThanOrEqual(0);
  });

  it('treats 404 on revoke as already-gone (idempotent)', async () => {
    const { fn } = makeFetchMock([
      {
        match: (url, init) =>
          url.includes('/tokens/missing') && init?.method === 'DELETE',
        respond: () =>
          new Response(JSON.stringify({ errors: [], success: false }), {
            status: 404,
          }),
      },
      {
        match: (url, init) => url.endsWith('/tokens') && init?.method === 'POST',
        respond: () =>
          new Response(
            JSON.stringify({
              result: { id: 'fresh', value: 'val' },
              success: true,
            }),
            { status: 200 },
          ),
      },
    ]);

    const creds = await rotateConnectorR2Token(
      baseEnv as Env,
      { id: 'conn-6', slug: 'zeta', cf_token_id: 'missing' },
      { fetch: fn },
    );
    expect(creds.cf_token_id).toBe('fresh');
  });

  it('propagates revoke failure on non-404 errors', async () => {
    const { fn } = makeFetchMock([
      {
        match: (url, init) =>
          url.includes('/tokens/blocked') && init?.method === 'DELETE',
        respond: () => new Response('Forbidden', { status: 403 }),
      },
    ]);

    await expect(
      rotateConnectorR2Token(
        baseEnv as Env,
        { id: 'conn-7', slug: 'eta', cf_token_id: 'blocked' },
        { fetch: fn },
      ),
    ).rejects.toThrow(/token revoke failed.*403/i);
  });
});
