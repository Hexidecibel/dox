/**
 * API key expiry, end to end against D1.
 *
 *   - `authenticateApiKey` (what the middleware runs) with a PINNED clock: a
 *     date-only expiry of today is accepted, yesterday is rejected, and full
 *     timestamps flip at their exact instant.
 *   - The real middleware chain rejects an expired key and admits a live one.
 *   - POST /api/api-keys refuses an expiry already in the past with a 400
 *     instead of minting a key that is dead on creation, and stores what it
 *     accepts as a full UTC timestamp.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { seedTestData, generateTestId } from '../helpers/db';
import { authenticateApiKey } from '../../functions/lib/api-key-auth';
import { hashApiKey } from '../../functions/lib/auth';
import { onRequest } from '../../functions/api/_middleware';
import { onRequestPost as createApiKey } from '../../functions/api/api-keys/index';

let seed: Awaited<ReturnType<typeof seedTestData>>;
const db = env.DB;

beforeAll(async () => {
  seed = await seedTestData(db);
}, 30_000);

/** Insert a key and return the raw secret a client would send. */
async function insertKey(opts: { expiresAt: string | null; userId?: string; revoked?: number }): Promise<string> {
  const raw = `dox_sk_${generateTestId().replace(/[^a-z0-9]/gi, '')}${Math.random().toString(16).slice(2)}`;
  await db
    .prepare(
      `INSERT INTO api_keys (id, name, key_hash, key_prefix, user_id, tenant_id, permissions, expires_at, revoked)
       VALUES (?, ?, ?, ?, ?, ?, '["*"]', ?, ?)`,
    )
    .bind(
      generateTestId(),
      'Expiry test key',
      await hashApiKey(raw),
      raw.slice(0, 12),
      opts.userId ?? seed.orgAdminId,
      seed.tenantId,
      opts.expiresAt,
      opts.revoked ?? 0,
    )
    .run();
  return raw;
}

describe('authenticateApiKey — date-only expiry (the prod 2026-09-15 bug)', () => {
  it("accepts a key whose date-only expiry is today, all the way to the end of the UTC day", async () => {
    const raw = await insertKey({ expiresAt: '2026-09-15' });
    for (const now of ['2026-09-15T00:00:01Z', '2026-09-15T15:30:00Z', '2026-09-15T23:59:59.999Z']) {
      const result = await authenticateApiKey(db, raw, new Date(now));
      expect(result.ok, now).toBe(true);
      if (result.ok) expect(result.user.id).toBe(seed.orgAdminId);
    }
  });

  it('rejects a key whose date-only expiry was yesterday', async () => {
    const raw = await insertKey({ expiresAt: '2026-09-14' });
    const result = await authenticateApiKey(db, raw, new Date('2026-09-15T09:00:00Z'));
    expect(result).toEqual({ ok: false, error: 'API key expired' });
  });

  it('rejects a date-only key from the first instant of the following day', async () => {
    const raw = await insertKey({ expiresAt: '2026-09-15' });
    const result = await authenticateApiKey(db, raw, new Date('2026-09-16T00:00:00.000Z'));
    expect(result).toEqual({ ok: false, error: 'API key expired' });
  });
});

describe('authenticateApiKey — full timestamp boundaries', () => {
  it('works through the stored instant and not one millisecond after', async () => {
    const raw = await insertKey({ expiresAt: '2026-09-16T06:59:59.999Z' });
    expect((await authenticateApiKey(db, raw, new Date('2026-09-16T06:59:59.999Z'))).ok).toBe(true);
    expect(await authenticateApiKey(db, raw, new Date('2026-09-16T07:00:00.000Z'))).toEqual({
      ok: false,
      error: 'API key expired',
    });
  });

  it('never expires with a NULL expiry', async () => {
    const raw = await insertKey({ expiresAt: null });
    expect((await authenticateApiKey(db, raw, new Date('2999-12-31T00:00:00Z'))).ok).toBe(true);
  });

  it('fails closed on an unreadable stored expiry', async () => {
    const raw = await insertKey({ expiresAt: 'whenever' });
    expect(await authenticateApiKey(db, raw, new Date('2000-01-01T00:00:00Z'))).toEqual({
      ok: false,
      error: 'API key expired',
    });
  });

  it('still rejects unknown, revoked and inactive-user keys', async () => {
    const now = new Date('2026-09-15T12:00:00Z');
    expect(await authenticateApiKey(db, 'dox_sk_nope', now)).toEqual({ ok: false, error: 'Invalid API key' });
    const revoked = await insertKey({ expiresAt: null, revoked: 1 });
    expect(await authenticateApiKey(db, revoked, now)).toEqual({ ok: false, error: 'Invalid API key' });
    const inactive = await insertKey({ expiresAt: null, userId: seed.inactiveId });
    expect(await authenticateApiKey(db, inactive, now)).toEqual({
      ok: false,
      error: 'Account not found or inactive',
    });
  });
});

describe('middleware chain uses the shared expiry rule', () => {
  async function callAuth(rawKey: string) {
    const [, authFn] = onRequest;
    const request = new Request('http://localhost/api/documents', { headers: { 'X-API-Key': rawKey } });
    const data: Record<string, unknown> = {};
    const res = await authFn({
      request,
      env,
      data,
      params: {},
      waitUntil: () => {},
      passThroughOnException: () => {},
      functionPath: '/api/documents',
      next: async () => new Response(JSON.stringify({ reached: true }), { status: 200 }),
    } as any);
    return { status: res.status, body: (await res.json()) as any, data };
  }

  it('401s a key whose date-only expiry is long past', async () => {
    const { status, body } = await callAuth(await insertKey({ expiresAt: '2020-01-01' }));
    expect(status).toBe(401);
    expect(body.error).toBe('API key expired');
  });

  it('admits a live key and resolves its user', async () => {
    const { status, body, data } = await callAuth(await insertKey({ expiresAt: '2999-12-31' }));
    expect(status).toBe(200);
    expect(body.reached).toBe(true);
    expect((data.user as { id: string }).id).toBe(seed.orgAdminId);
  });
});

describe('POST /api/api-keys — expiresAt validation', () => {
  function post(body: Record<string, unknown>) {
    return createApiKey({
      request: new Request('http://localhost/api/api-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
      env,
      data: { user: { id: seed.orgAdminId, role: 'org_admin', tenant_id: seed.tenantId } },
      params: {},
      waitUntil: () => {},
      passThroughOnException: () => {},
      next: async () => new Response(null),
      functionPath: '/api/api-keys',
    } as any);
  }

  it('rejects an expiry date in the past with a clear 400', async () => {
    const res = await post({ name: 'Past key', expiresAt: '2020-01-01' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('in the past');
    const count = await db
      .prepare(`SELECT COUNT(*) AS n FROM api_keys WHERE name = 'Past key'`)
      .first<{ n: number }>();
    expect(count?.n).toBe(0);
  });

  it('rejects a past timestamp, a zone-less timestamp and a non-date', async () => {
    for (const expiresAt of ['2020-01-01T00:00:00Z', '2999-01-01T10:00:00', 'tomorrow']) {
      const res = await post({ name: 'Bad expiry key', expiresAt });
      expect(res.status, expiresAt).toBe(400);
    }
  });

  it('stores an accepted date-only expiry as the end of that UTC day', async () => {
    const res = await post({ name: 'Future date key', expiresAt: '2999-12-31' });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { apiKey: { expires_at: string | null } };
    expect(body.apiKey.expires_at).toBe('2999-12-31T23:59:59.999Z');
  });

  it('stores a zoned timestamp normalised to UTC, and no expiry as NULL', async () => {
    const zoned = await post({ name: 'Zoned key', expiresAt: '2999-06-30T23:59:59.999-07:00' });
    expect(zoned.status).toBe(201);
    expect(((await zoned.json()) as any).apiKey.expires_at).toBe('2999-07-01T06:59:59.999Z');

    const never = await post({ name: 'Forever key' });
    expect(never.status).toBe(201);
    expect(((await never.json()) as any).apiKey.expires_at).toBeNull();
  });
});
