/**
 * Test auth helpers — JWT creation and user setup for Workers pool tests.
 * Uses the same crypto APIs as the app (Web Crypto / crypto.subtle).
 * The JWT_SECRET here MUST match the one in vitest.config.ts miniflare bindings.
 */

function base64UrlEncode(data: ArrayBuffer | Uint8Array): string {
  const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export interface TestTokenOptions {
  userId?: string;
  email?: string;
  tenantId?: string | null;
  expiresInMs?: number;
  secret?: string;
}

/** Must match the JWT_SECRET binding in vitest.config.ts */
export const TEST_JWT_SECRET = 'test-jwt-secret-for-testing-only';

/**
 * Create a JWT token matching the app's format (HMAC-SHA256, 24h expiry).
 */
export async function createTestToken(
  role: string,
  options: TestTokenOptions = {}
): Promise<string> {
  const {
    userId = 'test-user-id',
    email = 'test@example.com',
    tenantId = 'test-tenant-id',
    expiresInMs = 24 * 60 * 60 * 1000,
    secret = TEST_JWT_SECRET,
  } = options;

  const header = { alg: 'HS256', typ: 'JWT' };
  const encoder = new TextEncoder();

  const now = Date.now();
  const payload = {
    sub: userId,
    email,
    role,
    tenantId,
    iat: now,
    exp: now + expiresInMs,
  };

  const headerB64 = base64UrlEncode(encoder.encode(JSON.stringify(header)));
  const payloadB64 = base64UrlEncode(encoder.encode(JSON.stringify(payload)));
  const signingInput = `${headerB64}.${payloadB64}`;

  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(signingInput));
  const signatureB64 = base64UrlEncode(signature);

  return `${signingInput}.${signatureB64}`;
}

/**
 * Hash a password using the same PBKDF2 algorithm as the app.
 * Returns "salt:hash" hex string.
 */
export async function hashTestPassword(password: string): Promise<string> {
  const encoder = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));

  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );

  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt,
      iterations: 100000,
      hash: 'SHA-256',
    },
    keyMaterial,
    256
  );

  return `${toHex(salt.buffer)}:${toHex(derivedBits)}`;
}

/**
 * Create a user in the DB with a hashed password and return both the user record and a JWT token.
 */
export async function createAuthenticatedUser(
  db: D1Database,
  role: string,
  tenantId: string | null,
  overrides: {
    id?: string;
    email?: string;
    name?: string;
    password?: string;
    active?: number;
  } = {}
): Promise<{
  user: { id: string; email: string; name: string; role: string; tenant_id: string | null; active: number };
  token: string;
  password: string;
}> {
  const id = overrides.id || crypto.randomUUID().replace(/-/g, '');
  const email = overrides.email || `${id}@test.com`;
  const name = overrides.name || 'Test User';
  const password = overrides.password || 'TestPass123';
  const active = overrides.active ?? 1;

  const passwordHash = await hashTestPassword(password);

  await db
    .prepare(
      `INSERT INTO users (id, email, password_hash, name, role, tenant_id, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
    )
    .bind(id, email, passwordHash, name, role, tenantId, active)
    .run();

  const token = await createTestToken(role, {
    userId: id,
    email,
    tenantId,
  });

  return {
    user: { id, email, name, role, tenant_id: tenantId, active },
    token,
    password,
  };
}
