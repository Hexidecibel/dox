import { describe, it, expect } from 'vitest';
import {
  hashPassword,
  verifyPassword,
  generateToken,
  verifyToken,
  generateId,
  generateApiKey,
  hashApiKey,
} from '../../functions/lib/auth';

describe('hashPassword', () => {
  it('produces a salt:hash hex string', async () => {
    const result = await hashPassword('TestPass123');
    expect(result).toMatch(/^[0-9a-f]+:[0-9a-f]+$/);
  });

  it('salt is 16 bytes (32 hex chars)', async () => {
    const result = await hashPassword('TestPass123');
    const [salt] = result.split(':');
    expect(salt).toHaveLength(32);
  });

  it('hash is 32 bytes (64 hex chars)', async () => {
    const result = await hashPassword('TestPass123');
    const [, hash] = result.split(':');
    expect(hash).toHaveLength(64);
  });

  it('produces different salts each time', async () => {
    const a = await hashPassword('same-password');
    const b = await hashPassword('same-password');
    const [saltA] = a.split(':');
    const [saltB] = b.split(':');
    expect(saltA).not.toBe(saltB);
  });
});

describe('verifyPassword', () => {
  it('accepts the correct password', async () => {
    const hash = await hashPassword('MySecurePass1');
    expect(await verifyPassword('MySecurePass1', hash)).toBe(true);
  });

  it('rejects an incorrect password', async () => {
    const hash = await hashPassword('MySecurePass1');
    expect(await verifyPassword('WrongPassword1', hash)).toBe(false);
  });

  it('returns false for malformed stored hash', async () => {
    expect(await verifyPassword('anything', 'not-a-valid-hash')).toBe(false);
  });

  it('returns false for empty stored hash', async () => {
    expect(await verifyPassword('anything', '')).toBe(false);
  });
});

describe('generateToken / verifyToken', () => {
  const secret = 'test-secret-key';
  const payload = {
    sub: 'user-123',
    email: 'test@example.com',
    role: 'org_admin',
    tenantId: 'tenant-456',
  };

  it('creates a 3-part JWT string', async () => {
    const token = await generateToken(payload, secret);
    expect(token.split('.')).toHaveLength(3);
  });

  it('round-trips: verify returns correct payload', async () => {
    const token = await generateToken(payload, secret);
    const decoded = await verifyToken(token, secret);
    expect(decoded).not.toBeNull();
    expect(decoded!.sub).toBe('user-123');
    expect(decoded!.email).toBe('test@example.com');
    expect(decoded!.role).toBe('org_admin');
    expect(decoded!.tenantId).toBe('tenant-456');
  });

  it('handles null tenantId', async () => {
    const token = await generateToken({ ...payload, tenantId: null }, secret);
    const decoded = await verifyToken(token, secret);
    expect(decoded).not.toBeNull();
    expect(decoded!.tenantId).toBeNull();
  });

  it('rejects token signed with wrong secret', async () => {
    const token = await generateToken(payload, secret);
    const decoded = await verifyToken(token, 'wrong-secret');
    expect(decoded).toBeNull();
  });

  it('rejects tampered token', async () => {
    const token = await generateToken(payload, secret);
    // Tamper with the payload portion
    const parts = token.split('.');
    parts[1] = parts[1] + 'x';
    const tampered = parts.join('.');
    const decoded = await verifyToken(tampered, secret);
    expect(decoded).toBeNull();
  });

  it('rejects expired token', async () => {
    // Create a token that expired 1ms ago by using a negative expiry
    const header = { alg: 'HS256', typ: 'JWT' };
    const encoder = new TextEncoder();

    const now = Date.now();
    const expiredPayload = {
      ...payload,
      iat: now - 2000,
      exp: now - 1, // expired
    };

    function base64UrlEncode(data: Uint8Array): string {
      let binary = '';
      for (const byte of data) binary += String.fromCharCode(byte);
      return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }

    const headerB64 = base64UrlEncode(encoder.encode(JSON.stringify(header)));
    const payloadB64 = base64UrlEncode(encoder.encode(JSON.stringify(expiredPayload)));
    const signingInput = `${headerB64}.${payloadB64}`;

    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(signingInput));
    const sigB64 = base64UrlEncode(new Uint8Array(sig));

    const expiredToken = `${signingInput}.${sigB64}`;
    const decoded = await verifyToken(expiredToken, secret);
    expect(decoded).toBeNull();
  });

  it('rejects malformed tokens', async () => {
    expect(await verifyToken('not.a.valid.token', secret)).toBeNull();
    expect(await verifyToken('only-one-part', secret)).toBeNull();
    expect(await verifyToken('', secret)).toBeNull();
  });
});

describe('generateId', () => {
  it('returns a 32-char hex string', () => {
    const id = generateId();
    expect(id).toMatch(/^[0-9a-f]{32}$/);
  });

  it('generates unique IDs', () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateId()));
    expect(ids.size).toBe(100);
  });
});

describe('generateApiKey', () => {
  it('returns key with dox_sk_ prefix', () => {
    const { key } = generateApiKey();
    expect(key.startsWith('dox_sk_')).toBe(true);
  });

  it('key has correct length (prefix + 64 hex chars)', () => {
    const { key } = generateApiKey();
    // dox_sk_ (7) + 64 hex chars = 71
    expect(key).toHaveLength(71);
  });

  it('returns a prefix (first 12 chars)', () => {
    const { key, prefix } = generateApiKey();
    expect(prefix).toBe(key.substring(0, 12));
    expect(prefix).toHaveLength(12);
  });

  it('generates unique keys', () => {
    const keys = new Set(Array.from({ length: 50 }, () => generateApiKey().key));
    expect(keys.size).toBe(50);
  });
});

describe('hashApiKey', () => {
  it('returns a 64-char hex string (SHA-256)', async () => {
    const hash = await hashApiKey('dox_sk_abc123');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('same input produces same hash', async () => {
    const a = await hashApiKey('dox_sk_test');
    const b = await hashApiKey('dox_sk_test');
    expect(a).toBe(b);
  });

  it('different inputs produce different hashes', async () => {
    const a = await hashApiKey('dox_sk_aaa');
    const b = await hashApiKey('dox_sk_bbb');
    expect(a).not.toBe(b);
  });
});
