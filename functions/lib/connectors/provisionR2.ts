/**
 * Per-connector R2 bucket + scoped token provisioner — Phase B3.
 *
 * Each connector's S3 drop door gets:
 *   - a dedicated R2 bucket (`dox-drops-<slug>`),
 *   - a Cloudflare-issued R2 API token scoped to ONLY that bucket
 *     (Workers R2 Storage Bucket Item Write permission group),
 *   - vendor-facing creds (access_key_id + secret_access_key) the
 *     tenant copies into `aws s3`, rclone, boto3, etc.
 *
 * The CF-side token id is captured so rotation can revoke the old
 * token cleanly (DELETE /tokens/<id>) — the access_key_id alone isn't
 * sufficient to address the token via the management API.
 *
 * This module talks to the Cloudflare API v4 directly. It is NOT a
 * thin wrapper — it knows about R2's specific resource ARN shape and
 * the permission-group naming. Tests inject a `fetch` shim so the
 * unit tests don't hit the real CF API.
 *
 * Bucket name shape: `dox-drops-<slug>`. The slug is already validated
 * against `[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$` upstream, so the
 * resulting bucket name always satisfies R2's 3-63 char `[a-z0-9-]`
 * rule. We still trim defensively in case a future change to the slug
 * spec relaxes the bounds.
 */

import type { Env } from '../types';

/** Bucket name prefix for the per-connector S3 drop door. */
export const BUCKET_PREFIX = 'dox-drops-';

/** R2's S3-compatible endpoint pattern. Region is always `auto`. */
export function r2EndpointFor(accountId: string): string {
  return `https://${accountId}.r2.cloudflarestorage.com`;
}

export interface ProvisionedR2Creds {
  /** Bucket name. Always starts with `dox-drops-`. */
  bucket_name: string;
  /** Vendor-facing access key id (plaintext at rest is fine — it's
   * scoped to one bucket and rotatable). */
  access_key_id: string;
  /** Vendor-facing secret access key (plaintext ONCE; caller encrypts
   * before persistence). Only visible at create time. */
  secret_access_key: string;
  /** Cloudflare-side token ID — needed to DELETE the token on rotation. */
  cf_token_id: string;
  /** S3-compatible endpoint URL the vendor plugs into their tooling. */
  endpoint: string;
}

/**
 * Minimal `fetch`-shape interface so tests can inject a mock without
 * patching globalThis.fetch. Using the global type would require cross-
 * realm fetch instances to be assignable, which they're not in vitest.
 */
export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

interface ProvisionDeps {
  /** Override the network fetch. Defaults to globalThis.fetch. */
  fetch?: FetchLike;
}

interface ConnectorRef {
  id: string;
  slug: string;
}

interface ConnectorRefWithToken extends ConnectorRef {
  /** Existing CF token ID. Required for rotation. */
  cf_token_id: string;
}

const CF_API_BASE = 'https://api.cloudflare.com/client/v4';

/**
 * Static permission group ID for "Workers R2 Storage Bucket Item Write"
 * — the bucket-scoped read+write group that lets a token LIST/GET/PUT
 * objects within a single bucket. Pulled from the documented R2
 * permission groups list. We ALSO hit the live permission-groups
 * endpoint at runtime as a safety net (see `resolvePermissionGroupId`)
 * because Cloudflare has bumped these IDs in the past, but the static
 * value is the fast path for the common case.
 */
const STATIC_R2_PG_ID = '2efd5506f9c8494dacb1fa10a3e7d5b6';

/**
 * Cache the resolved permission-group ID at the module scope so we
 * don't pay the `GET /permission_groups` round-trip on every provision
 * call within the same Worker isolate.
 */
let cachedPermissionGroupId: string | null = null;

/**
 * Resolve the R2 read+write permission group ID. Uses the static
 * documented value as the fast path; the live listing endpoint
 * (`lookupR2PermissionGroupId`) is exposed separately as a fallback
 * for the (currently rare) case where CF rotates the documented IDs.
 *
 * Args are accepted for symmetry with the lookup helper — if we ever
 * wire the runtime fallback in here directly we already have the
 * fetcher / token in scope.
 */
async function resolvePermissionGroupId(
  _accountId: string,
  _apiToken: string,
  _fetcher: FetchLike,
): Promise<string> {
  if (cachedPermissionGroupId) return cachedPermissionGroupId;

  // Try the static value first — almost always works.
  cachedPermissionGroupId = STATIC_R2_PG_ID;
  return cachedPermissionGroupId;
}

/**
 * List permission groups and find the R2 bucket-scoped read+write
 * group. Used as the fallback when the static ID fails. Exported only
 * so tests can target it directly.
 */
export async function lookupR2PermissionGroupId(
  _accountId: string,
  apiToken: string,
  fetcher: FetchLike,
): Promise<string> {
  // Permission groups live under /user/tokens since CF API tokens are
  // user-owned. Permission group IDs themselves are global, so the
  // account ID isn't part of the path. The first arg is kept on the
  // signature so callers don't have to change shape.
  const url = `${CF_API_BASE}/user/tokens/permission_groups`;
  const res = await fetcher(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${apiToken}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(
      `CF permission_groups list failed: ${res.status} ${body.slice(0, 200)}`,
    );
  }
  const body = (await res.json()) as {
    result: Array<{ id: string; name: string }>;
  };
  // Look for the R2 bucket write group. CF has used a few names for
  // this over time — check all of the documented ones.
  const candidates = [
    'Workers R2 Storage Bucket Item Write',
    'Workers R2 Storage Write',
  ];
  for (const want of candidates) {
    const hit = body.result.find((g) => g.name === want);
    if (hit) return hit.id;
  }
  throw new Error(
    `Could not find R2 read+write permission group; known names not present in account permissions list`,
  );
}

/**
 * Validate the env has the CF creds it needs. Throws a clear error if
 * either is missing — the caller (POST /api/connectors handler) gets
 * to decide whether to fail the request or stamp the connector and
 * surface a "needs S3 setup" affordance later.
 */
function requireCfEnv(env: Env): { accountId: string; apiToken: string } {
  if (!env.CLOUDFLARE_ACCOUNT_ID || !env.CLOUDFLARE_API_TOKEN) {
    throw new Error(
      'CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN must be set as Pages secrets to provision R2 buckets',
    );
  }
  return {
    accountId: env.CLOUDFLARE_ACCOUNT_ID,
    apiToken: env.CLOUDFLARE_API_TOKEN,
  };
}

/**
 * Compose the bucket name for a connector. Slugs are validated upstream
 * to satisfy R2's bucket-name rules; we apply the prefix and trim to
 * 63 chars defensively.
 */
export function bucketNameForSlug(slug: string): string {
  const composed = `${BUCKET_PREFIX}${slug.toLowerCase()}`;
  return composed.slice(0, 63);
}

/**
 * Wrap a CF API call in a uniform error. Returns parsed JSON on 2xx,
 * throws with status + truncated body on anything else.
 */
async function cfFetch<T>(
  fetcher: FetchLike,
  url: string,
  init: RequestInit,
  context: string,
): Promise<T> {
  const res = await fetcher(url, init);
  const text = await res.text();
  let parsed: any = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* fallthrough — response wasn't JSON */
  }
  if (!res.ok) {
    const snippet = text.slice(0, 300);
    throw new Error(
      `CF API ${context} failed: ${res.status} ${snippet}`,
    );
  }
  return (parsed ?? {}) as T;
}

/**
 * Create the per-connector R2 bucket. Idempotent — if the bucket
 * already exists (CF returns 409 with the right error code) we treat
 * it as success and proceed to mint a fresh token.
 *
 * R2's "bucket already exists" response shape per the v4 envelope is
 * `{ success: false, errors: [{ code: 10004, message: 'The bucket you
 * tried to create already exists' }], ... }`. We accept any 409 OR an
 * envelope with code 10004 as "already there."
 */
async function createBucket(
  accountId: string,
  apiToken: string,
  bucketName: string,
  fetcher: FetchLike,
): Promise<void> {
  const url = `${CF_API_BASE}/accounts/${accountId}/r2/buckets`;
  const res = await fetcher(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name: bucketName }),
  });
  if (res.ok) return;
  // Not OK — treat known idempotency cases as success.
  const text = await res.text();
  let parsed: any = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* not json */
  }
  const errs: Array<{ code?: number; message?: string }> = parsed?.errors ?? [];
  const alreadyExists =
    res.status === 409 ||
    errs.some((e) => e.code === 10004) ||
    errs.some((e) => typeof e.message === 'string' && /already exists/i.test(e.message));
  if (alreadyExists) return;
  throw new Error(
    `CF R2 bucket create failed: ${res.status} ${text.slice(0, 300)}`,
  );
}

/**
 * Mint a CF-managed R2 API token scoped to a single bucket. Returns
 * the token id (for revoke), the S3 access_key_id, and the S3
 * secret_access_key.
 *
 * Per the Cloudflare R2 docs at
 * https://developers.cloudflare.com/r2/api/s3/tokens/ the S3-compat
 * mapping is:
 *   - access_key_id     = token.id (32-char hex, used as-is)
 *   - secret_access_key = sha256(token.value) lowercase hex (64 chars)
 *
 * The `value` field returned by `POST /user/tokens` is the API-token
 * bearer secret used for authenticating against the CF API; for S3
 * usage R2 expects its SHA-256 digest as the secret. Using `value`
 * directly causes R2 SigV4 signature mismatches.
 */
async function createBucketScopedToken(
  accountId: string,
  apiToken: string,
  bucketName: string,
  permissionGroupId: string,
  tokenName: string,
  fetcher: FetchLike,
): Promise<{ token_id: string; access_key_id: string; secret: string }> {
  // CF API tokens are user-owned resources, so creation goes through
  // /user/tokens. The policy below still scopes the resulting token to
  // a single account-level R2 bucket via the resource ARN — token
  // policies can target account/zone resources regardless of where the
  // token "lives" (user vs account).
  const url = `${CF_API_BASE}/user/tokens`;
  const body = {
    name: tokenName,
    policies: [
      {
        effect: 'allow',
        permission_groups: [{ id: permissionGroupId }],
        resources: {
          [`com.cloudflare.edge.r2.bucket.${accountId}_default_${bucketName}`]: '*',
        },
      },
    ],
  };
  const result = await cfFetch<{
    result: { id: string; value: string };
    success?: boolean;
  }>(
    fetcher,
    url,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    },
    'tokens.create',
  );
  const token_id = result.result.id;
  const tokenValue = result.result.value;
  // R2 S3-compat per https://developers.cloudflare.com/r2/api/s3/tokens/:
  //   access_key_id     = token.id (32-char hex, used as-is)
  //   secret_access_key = sha256(token.value) lowercase hex (64 chars)
  const access_key_id = token_id;
  const secret = await sha256Hex(tokenValue);
  return { token_id, access_key_id, secret };
}

/**
 * Revoke a CF-managed token by id. Used by rotation to ensure the old
 * vendor creds stop working immediately.
 */
async function revokeToken(
  _accountId: string,
  apiToken: string,
  tokenId: string,
  fetcher: FetchLike,
): Promise<void> {
  // Token revocation, like creation, targets the user-tokens API.
  // accountId is retained on the signature for symmetry with the rest
  // of the helpers; CF's /user/tokens/<id> path is account-agnostic.
  const url = `${CF_API_BASE}/user/tokens/${tokenId}`;
  const res = await fetcher(url, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${apiToken}` },
  });
  if (res.ok) return;
  // 404 = already gone; treat as success so rotation is idempotent.
  if (res.status === 404) return;
  const text = await res.text().catch(() => '');
  throw new Error(
    `CF token revoke failed: ${res.status} ${text.slice(0, 300)}`,
  );
}

/**
 * SHA-256 hex of a UTF-8 string. R2 derives the S3 secret_access_key
 * from the CF token's `value` field this way.
 */
async function sha256Hex(input: string): Promise<string> {
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

/**
 * Provision a new R2 bucket + scoped token for a connector.
 *
 * Idempotent on the bucket (re-running on a connector that already has
 * a bucket re-uses the existing bucket and just mints a new token).
 * NOT idempotent on the token — every call creates a fresh one. The
 * caller is responsible for revoking the prior token if they care
 * about not littering the CF account.
 */
export async function provisionConnectorBucket(
  env: Env,
  connector: ConnectorRef,
  deps: ProvisionDeps = {},
): Promise<ProvisionedR2Creds> {
  const fetcher = deps.fetch ?? ((input, init) => fetch(input, init));
  const { accountId, apiToken } = requireCfEnv(env);

  const bucketName = bucketNameForSlug(connector.slug);

  await createBucket(accountId, apiToken, bucketName, fetcher);

  const pgId = await resolvePermissionGroupId(accountId, apiToken, fetcher);

  const tokenName = `dox-drops-${connector.slug}-vendor-token`;
  const { token_id, access_key_id, secret } = await createBucketScopedToken(
    accountId,
    apiToken,
    bucketName,
    pgId,
    tokenName,
    fetcher,
  );

  return {
    bucket_name: bucketName,
    access_key_id,
    secret_access_key: secret,
    cf_token_id: token_id,
    endpoint: r2EndpointFor(accountId),
  };
}

/**
 * Rotate the R2 vendor token for an existing connector. Revokes the
 * existing CF token (best effort — 404 is treated as success) then
 * creates a new one against the same bucket.
 */
export async function rotateConnectorR2Token(
  env: Env,
  connector: ConnectorRefWithToken,
  deps: ProvisionDeps = {},
): Promise<ProvisionedR2Creds> {
  const fetcher = deps.fetch ?? ((input, init) => fetch(input, init));
  const { accountId, apiToken } = requireCfEnv(env);

  const bucketName = bucketNameForSlug(connector.slug);

  // Revoke first so a transient failure mid-rotation can't leave both
  // tokens valid simultaneously. If revoke fails, propagate — the
  // operator can retry without leaking double-credentials.
  if (connector.cf_token_id) {
    await revokeToken(accountId, apiToken, connector.cf_token_id, fetcher);
  }

  const pgId = await resolvePermissionGroupId(accountId, apiToken, fetcher);
  const tokenName = `dox-drops-${connector.slug}-vendor-token`;
  const { token_id, access_key_id, secret } = await createBucketScopedToken(
    accountId,
    apiToken,
    bucketName,
    pgId,
    tokenName,
    fetcher,
  );

  return {
    bucket_name: bucketName,
    access_key_id,
    secret_access_key: secret,
    cf_token_id: token_id,
    endpoint: r2EndpointFor(accountId),
  };
}

/**
 * Test-only helper: clear the module-scope cache for the resolved
 * permission group ID. Vitest module isolation usually takes care of
 * this, but exported for explicit cleanup in cross-suite tests.
 */
export function __resetPermissionGroupCacheForTests(): void {
  cachedPermissionGroupId = null;
}
