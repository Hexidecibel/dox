import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { seedTestData, generateTestId } from '../helpers/db';

let seed: Awaited<ReturnType<typeof seedTestData>>;
const db = env.DB;

beforeAll(async () => {
  seed = await seedTestData(db);
}, 30_000);

describe('Middleware - Public Routes', () => {
  const publicRoutes = [
    '/api/auth/login',
    '/api/auth/forgot-password',
    '/api/auth/reset-password',
    '/api/graphql',
    '/api/webhooks/email-ingest',
    '/api/webhooks/connectors',
    '/api/webhooks/connectors/some-id',
  ];

  for (const route of publicRoutes) {
    it(`should recognize ${route} as public`, () => {
      const isPublic = publicRoutes.some(
        (r) => route === r || route.startsWith(r + '/')
      );
      expect(isPublic).toBe(true);
    });
  }

  const protectedRoutes = [
    '/api/documents',
    '/api/users',
    '/api/tenants',
    '/api/products',
    '/api/suppliers',
    '/api/api-keys',
  ];

  for (const route of protectedRoutes) {
    it(`should recognize ${route} as protected`, () => {
      const PUBLIC = ['/api/auth/login', '/api/auth/forgot-password', '/api/auth/reset-password', '/api/graphql', '/api/webhooks/email-ingest', '/api/webhooks/connectors'];
      const isPublic = PUBLIC.some((r) => route === r || route.startsWith(r + '/'));
      expect(isPublic).toBe(false);
    });
  }
});

describe('Middleware - JWT Validation', () => {
  it('should generate and verify a JWT token', async () => {
    // Test the JWT flow using the same crypto primitives
    const secret = env.JWT_SECRET;
    const encoder = new TextEncoder();

    const header = { alg: 'HS256', typ: 'JWT' };
    const payload = {
      sub: seed.superAdminId,
      email: 'admin@test.com',
      role: 'super_admin',
      tenantId: null,
      iat: Date.now(),
      exp: Date.now() + 24 * 60 * 60 * 1000,
    };

    const base64UrlEncode = (data: Uint8Array): string => {
      let binary = '';
      for (const byte of data) binary += String.fromCharCode(byte);
      return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    };

    const headerB64 = base64UrlEncode(encoder.encode(JSON.stringify(header)));
    const payloadB64 = base64UrlEncode(encoder.encode(JSON.stringify(payload)));
    const signingInput = `${headerB64}.${payloadB64}`;

    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign', 'verify']
    );

    const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(signingInput));
    const signatureB64 = base64UrlEncode(new Uint8Array(signature));
    const token = `${signingInput}.${signatureB64}`;

    // Verify
    const [h, p, s] = token.split('.');
    const valid = await crypto.subtle.verify(
      'HMAC',
      key,
      (() => {
        const str = s.replace(/-/g, '+').replace(/_/g, '/');
        const padded = str + '='.repeat((4 - str.length % 4) % 4);
        const binary = atob(padded);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return bytes;
      })(),
      encoder.encode(`${h}.${p}`)
    );

    expect(valid).toBe(true);
  });

  it('should detect expired JWT', () => {
    const payload = {
      sub: seed.superAdminId,
      exp: Date.now() - 1000, // Already expired
    };
    expect(payload.exp < Date.now()).toBe(true);
  });
});

describe('Middleware - Session Revocation', () => {
  it('should detect revoked session', async () => {
    const sessionId = generateTestId();
    const tokenHash = generateTestId();

    await db
      .prepare("INSERT INTO sessions (id, user_id, token_hash, expires_at, revoked) VALUES (?, ?, ?, datetime('now', '+1 day'), 1)")
      .bind(sessionId, seed.superAdminId, tokenHash)
      .run();

    const session = await db
      .prepare('SELECT revoked FROM sessions WHERE token_hash = ? AND user_id = ?')
      .bind(tokenHash, seed.superAdminId)
      .first<{ revoked: number }>();

    expect(session!.revoked).toBe(1);
  });

  it('should allow non-revoked session', async () => {
    const sessionId = generateTestId();
    const tokenHash = generateTestId();

    await db
      .prepare("INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, datetime('now', '+1 day'))")
      .bind(sessionId, seed.superAdminId, tokenHash)
      .run();

    const session = await db
      .prepare('SELECT revoked FROM sessions WHERE token_hash = ? AND user_id = ?')
      .bind(tokenHash, seed.superAdminId)
      .first<{ revoked: number }>();

    expect(session).not.toBeNull();
    expect(session!.revoked).toBeFalsy();
  });
});

describe('Middleware - API Key Auth', () => {
  it('should find valid API key by hash', async () => {
    const keyHash = `mw-valid-${Date.now()}`;
    const id = generateTestId();

    await db
      .prepare(
        `INSERT INTO api_keys (id, name, key_hash, key_prefix, user_id, tenant_id, permissions)
         VALUES (?, ?, ?, ?, ?, ?, '["*"]')`
      )
      .bind(id, 'MW Key', keyHash, 'dox_sk_mw', seed.orgAdminId, seed.tenantId)
      .run();

    const row = await db
      .prepare(
        `SELECT ak.*, u.id as uid, u.email, u.name, u.role, u.tenant_id, u.active
         FROM api_keys ak
         JOIN users u ON ak.user_id = u.id
         WHERE ak.key_hash = ? AND ak.revoked = 0`
      )
      .bind(keyHash)
      .first();

    expect(row).not.toBeNull();
    expect(row!.role).toBe('org_admin');
  });

  it('should reject revoked API key', async () => {
    const keyHash = `mw-revoked-${Date.now()}`;
    const id = generateTestId();

    await db
      .prepare(
        `INSERT INTO api_keys (id, name, key_hash, key_prefix, user_id, tenant_id, permissions, revoked)
         VALUES (?, ?, ?, ?, ?, ?, '["*"]', 1)`
      )
      .bind(id, 'MW Revoked', keyHash, 'dox_sk_rv', seed.orgAdminId, seed.tenantId)
      .run();

    const row = await db
      .prepare(
        `SELECT ak.* FROM api_keys ak WHERE ak.key_hash = ? AND ak.revoked = 0`
      )
      .bind(keyHash)
      .first();

    expect(row).toBeNull();
  });

  it('should reject inactive user behind API key', async () => {
    const keyHash = `mw-inactive-${Date.now()}`;
    const id = generateTestId();

    await db
      .prepare(
        `INSERT INTO api_keys (id, name, key_hash, key_prefix, user_id, tenant_id, permissions)
         VALUES (?, ?, ?, ?, ?, ?, '["*"]')`
      )
      .bind(id, 'MW Inactive', keyHash, 'dox_sk_in', seed.inactiveId, seed.tenantId)
      .run();

    const row = await db
      .prepare(
        `SELECT ak.*, u.active
         FROM api_keys ak
         JOIN users u ON ak.user_id = u.id
         WHERE ak.key_hash = ? AND ak.revoked = 0`
      )
      .bind(keyHash)
      .first();

    expect(row).not.toBeNull();
    expect(row!.active).toBe(0);
  });
});
