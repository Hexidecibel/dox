import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { seedTestData, generateTestId } from '../helpers/db';
import { createTestToken } from '../helpers/auth';
import { hashApiKey } from '../../functions/lib/auth';
import { onRequest as middleware } from '../../functions/api/_middleware';

let seed: Awaited<ReturnType<typeof seedTestData>>;
const db = env.DB;

beforeAll(async () => {
  seed = await seedTestData(db);
}, 30_000);

describe('API Keys - Create', () => {
  it('should create an API key with hash', async () => {
    const id = generateTestId();
    const keyHash = generateTestId();
    const prefix = 'dox_sk_abcd';

    await db
      .prepare(
        `INSERT INTO api_keys (id, name, key_hash, key_prefix, user_id, tenant_id, permissions, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`
      )
      .bind(id, 'Test Key', keyHash, prefix, seed.orgAdminId, seed.tenantId, '["*"]')
      .run();

    const key = await db.prepare('SELECT * FROM api_keys WHERE id = ?').bind(id).first();
    expect(key).not.toBeNull();
    expect(key!.name).toBe('Test Key');
    expect(key!.key_hash).toBe(keyHash);
    expect(key!.key_prefix).toBe(prefix);
    expect(key!.user_id).toBe(seed.orgAdminId);
    expect(key!.tenant_id).toBe(seed.tenantId);
    expect(key!.revoked).toBeFalsy();
  });

  it('should create key with expiration', async () => {
    const id = generateTestId();
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

    await db
      .prepare(
        `INSERT INTO api_keys (id, name, key_hash, key_prefix, user_id, tenant_id, permissions, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(id, 'Expiring Key', generateTestId(), 'dox_sk_exp', seed.orgAdminId, seed.tenantId, '["*"]', expiresAt)
      .run();

    const key = await db.prepare('SELECT expires_at FROM api_keys WHERE id = ?').bind(id).first();
    expect(key!.expires_at).toBeTruthy();
  });

  it('should create key with specific permissions', async () => {
    const id = generateTestId();
    const permissions = JSON.stringify(['read', 'write']);

    await db
      .prepare(
        `INSERT INTO api_keys (id, name, key_hash, key_prefix, user_id, tenant_id, permissions)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(id, 'Limited Key', generateTestId(), 'dox_sk_lim', seed.orgAdminId, seed.tenantId, permissions)
      .run();

    const key = await db.prepare('SELECT permissions FROM api_keys WHERE id = ?').bind(id).first();
    expect(JSON.parse(key!.permissions as string)).toEqual(['read', 'write']);
  });
});

describe('API Keys - List', () => {
  it('should list keys with user info via JOIN', async () => {
    const result = await db
      .prepare(
        `SELECT ak.*, u.name as user_name, u.email as user_email
         FROM api_keys ak
         JOIN users u ON ak.user_id = u.id
         WHERE ak.tenant_id = ?
         ORDER BY ak.created_at DESC`
      )
      .bind(seed.tenantId)
      .all();

    for (const key of result.results) {
      expect(key.tenant_id).toBe(seed.tenantId);
      expect(key.user_name).toBeTruthy();
      expect(key.user_email).toBeTruthy();
    }
  });

  it('should show key_hash but not plaintext key', async () => {
    const id = generateTestId();
    const keyHash = generateTestId();

    await db
      .prepare(
        `INSERT INTO api_keys (id, name, key_hash, key_prefix, user_id, tenant_id, permissions)
         VALUES (?, ?, ?, ?, ?, ?, '["*"]')`
      )
      .bind(id, 'Hash Key', keyHash, 'dox_sk_hash', seed.orgAdminId, seed.tenantId)
      .run();

    const key = await db.prepare('SELECT * FROM api_keys WHERE id = ?').bind(id).first();
    expect(key!.key_hash).toBe(keyHash);
    // There is no plaintext key column in the database
    expect((key as any).key).toBeUndefined();
  });

  it('super_admin sees all keys', async () => {
    const result = await db
      .prepare(
        `SELECT ak.* FROM api_keys ak ORDER BY ak.created_at DESC`
      )
      .all();
    // Just verify it doesn't error
    expect(result.results).toBeDefined();
  });
});

describe('API Keys - Revoke', () => {
  it('should revoke a key', async () => {
    const id = generateTestId();
    await db
      .prepare(
        `INSERT INTO api_keys (id, name, key_hash, key_prefix, user_id, tenant_id, permissions)
         VALUES (?, ?, ?, ?, ?, ?, '["*"]')`
      )
      .bind(id, 'Revoke Key', generateTestId(), 'dox_sk_rev', seed.orgAdminId, seed.tenantId)
      .run();

    await db.prepare('UPDATE api_keys SET revoked = 1 WHERE id = ?').bind(id).run();

    const key = await db.prepare('SELECT revoked FROM api_keys WHERE id = ?').bind(id).first();
    expect(key!.revoked).toBe(1);
  });

  it('should not find revoked key by hash for auth', async () => {
    const keyHash = `revoked-hash-${Date.now()}`;
    const id = generateTestId();

    await db
      .prepare(
        `INSERT INTO api_keys (id, name, key_hash, key_prefix, user_id, tenant_id, permissions, revoked)
         VALUES (?, ?, ?, ?, ?, ?, '["*"]', 1)`
      )
      .bind(id, 'Revoked Auth', keyHash, 'dox_sk_rvk', seed.orgAdminId, seed.tenantId)
      .run();

    const row = await db
      .prepare(
        `SELECT ak.*, u.id as uid FROM api_keys ak JOIN users u ON ak.user_id = u.id
         WHERE ak.key_hash = ? AND ak.revoked = 0`
      )
      .bind(keyHash)
      .first();

    expect(row).toBeNull();
  });

  it('should detect already-revoked key', async () => {
    const id = generateTestId();
    await db
      .prepare(
        `INSERT INTO api_keys (id, name, key_hash, key_prefix, user_id, tenant_id, permissions, revoked)
         VALUES (?, ?, ?, ?, ?, ?, '["*"]', 1)`
      )
      .bind(id, 'Already Revoked', generateTestId(), 'dox_sk_ar', seed.orgAdminId, seed.tenantId)
      .run();

    const key = await db.prepare('SELECT revoked FROM api_keys WHERE id = ?').bind(id).first<{ revoked: number }>();
    expect(key!.revoked).toBe(1);
  });
});

describe('API Keys - Auth Lookup', () => {
  it('should find valid key by hash with user info', async () => {
    const keyHash = `valid-hash-${Date.now()}`;
    const id = generateTestId();

    await db
      .prepare(
        `INSERT INTO api_keys (id, name, key_hash, key_prefix, user_id, tenant_id, permissions)
         VALUES (?, ?, ?, ?, ?, ?, '["*"]')`
      )
      .bind(id, 'Auth Key', keyHash, 'dox_sk_aut', seed.orgAdminId, seed.tenantId)
      .run();

    const row = await db
      .prepare(
        `SELECT ak.*, u.id as uid, u.email, u.name, u.role, u.tenant_id as user_tenant_id, u.active
         FROM api_keys ak
         JOIN users u ON ak.user_id = u.id
         WHERE ak.key_hash = ? AND ak.revoked = 0`
      )
      .bind(keyHash)
      .first();

    expect(row).not.toBeNull();
    expect(row!.email).toBe('orgadmin@test.com');
    expect(row!.role).toBe('org_admin');
  });

  it('should detect expired key', async () => {
    const keyHash = `expired-hash-${Date.now()}`;
    const id = generateTestId();
    const expiredAt = new Date(Date.now() - 1000).toISOString();

    await db
      .prepare(
        `INSERT INTO api_keys (id, name, key_hash, key_prefix, user_id, tenant_id, permissions, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, '["*"]', ?)`
      )
      .bind(id, 'Expired Key', keyHash, 'dox_sk_exp', seed.orgAdminId, seed.tenantId, expiredAt)
      .run();

    const row = await db
      .prepare('SELECT expires_at FROM api_keys WHERE key_hash = ? AND revoked = 0')
      .bind(keyHash)
      .first<{ expires_at: string }>();

    expect(row).not.toBeNull();
    expect(new Date(row!.expires_at) < new Date()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// How the request was authenticated (migration 0137). A key acts as the user
// who made it for everything except taking files out, where it reads only
// "send freely" documents -- so the middleware has to SAY it was a key.
// ---------------------------------------------------------------------------
describe('API Keys - the middleware records how the caller authenticated', () => {
  async function throughAuth(headers: Record<string, string>, url = 'http://localhost/api/documents') {
    const [, authFn] = middleware;
    const data: Record<string, unknown> = {};
    const res = await authFn({
      request: new Request(url, { headers }),
      env,
      data,
      params: {},
      waitUntil: () => {},
      passThroughOnException: () => {},
      functionPath: '/api/documents',
      next: async () => new Response(JSON.stringify({ reached: true }), { status: 200 }),
    } as any);
    return { status: res.status, data };
  }

  async function liveKey(): Promise<{ raw: string; id: string }> {
    const raw = `dox_sk_${generateTestId().replace(/[^a-z0-9]/gi, '')}${Math.random().toString(16).slice(2)}`;
    const id = generateTestId();
    await db
      .prepare(
        `INSERT INTO api_keys (id, name, key_hash, key_prefix, user_id, tenant_id, permissions, revoked)
         VALUES (?, 'method test key', ?, ?, ?, ?, '["*"]', 0)`,
      )
      .bind(id, await hashApiKey(raw), raw.slice(0, 12), seed.orgAdminId, seed.tenantId)
      .run();
    return { raw, id };
  }

  it('an API key is marked as a key, with its id, and still resolves to its user', async () => {
    const key = await liveKey();
    const { status, data } = await throughAuth({ 'X-API-Key': key.raw });
    expect(status).toBe(200);
    expect(data.authMethod).toBe('api_key');
    expect(data.apiKeyId).toBe(key.id);
    expect((data.user as { id: string }).id).toBe(seed.orgAdminId);
  });

  it('a login is marked as a login, in the header or in ?token=', async () => {
    const token = await createTestToken('org_admin', {
      userId: seed.orgAdminId,
      email: 'orgadmin@test.com',
      tenantId: seed.tenantId,
    });
    const header = await throughAuth({ Authorization: `Bearer ${token}` });
    expect(header.status).toBe(200);
    expect(header.data.authMethod).toBe('jwt');
    expect(header.data.apiKeyId).toBeUndefined();

    const query = await throughAuth({}, `http://localhost/api/documents?token=${encodeURIComponent(token)}`);
    expect(query.status).toBe(200);
    expect(query.data.authMethod).toBe('jwt');
  });

  it('a login sent together with a key is a login: the key is not consulted', async () => {
    const key = await liveKey();
    const token = await createTestToken('user', {
      userId: seed.userId,
      email: 'user@test.com',
      tenantId: seed.tenantId,
    });
    const { data } = await throughAuth({ Authorization: `Bearer ${token}`, 'X-API-Key': key.raw });
    expect(data.authMethod).toBe('jwt');
    expect((data.user as { id: string }).id).toBe(seed.userId);
  });

  it('a refused key marks nothing', async () => {
    const { status, data } = await throughAuth({ 'X-API-Key': 'dox_sk_not_a_real_key' });
    expect(status).toBe(401);
    expect(data.authMethod).toBeUndefined();
    expect(data.user).toBeUndefined();
  });
});
