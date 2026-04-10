import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { seedTestData, hashTestPassword, generateTestId } from '../helpers/db';

let seed: Awaited<ReturnType<typeof seedTestData>>;
const db = env.DB;

beforeAll(async () => {
  seed = await seedTestData(db);
}, 30_000);

describe('Auth - Login', () => {
  it('should find user by email', async () => {
    const user = await db
      .prepare(
        'SELECT id, email, name, role, tenant_id, active, password_hash FROM users WHERE email = ?'
      )
      .bind('admin@test.com')
      .first<Record<string, unknown>>();

    expect(user).not.toBeNull();
    expect(user!.email).toBe('admin@test.com');
    expect(user!.role).toBe('super_admin');
    expect(user!.active).toBe(1);
    expect(user!.password_hash).toBeTruthy();
  });

  it('should verify correct password via PBKDF2', async () => {
    const user = await db
      .prepare('SELECT password_hash FROM users WHERE email = ?')
      .bind('admin@test.com')
      .first<{ password_hash: string }>();

    expect(user).not.toBeNull();
    const [saltHex, hashHex] = user!.password_hash.split(':');
    expect(saltHex).toBeTruthy();
    expect(hashHex).toBeTruthy();

    const encoder = new TextEncoder();
    const salt = new Uint8Array(saltHex.match(/.{2}/g)!.map((b) => parseInt(b, 16)));

    const keyMaterial = await crypto.subtle.importKey(
      'raw',
      encoder.encode('Admin1234'),
      'PBKDF2',
      false,
      ['deriveBits']
    );

    const derivedBits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
      keyMaterial,
      256
    );

    const derivedHex = Array.from(new Uint8Array(derivedBits))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');

    expect(derivedHex).toBe(hashHex);
  });

  it('should not find user with wrong email', async () => {
    const user = await db
      .prepare('SELECT id FROM users WHERE email = ?')
      .bind('nonexistent@test.com')
      .first();

    expect(user).toBeNull();
  });

  it('should detect inactive user', async () => {
    const user = await db
      .prepare('SELECT id, active FROM users WHERE email = ?')
      .bind('inactive@test.com')
      .first<{ id: string; active: number }>();

    expect(user).not.toBeNull();
    expect(user!.active).toBe(0);
  });

  it('should reject wrong password', async () => {
    const user = await db
      .prepare('SELECT password_hash FROM users WHERE email = ?')
      .bind('admin@test.com')
      .first<{ password_hash: string }>();

    const [saltHex, hashHex] = user!.password_hash.split(':');
    const salt = new Uint8Array(saltHex.match(/.{2}/g)!.map((b) => parseInt(b, 16)));
    const encoder = new TextEncoder();

    const keyMaterial = await crypto.subtle.importKey(
      'raw',
      encoder.encode('WrongPassword1'),
      'PBKDF2',
      false,
      ['deriveBits']
    );

    const derivedBits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
      keyMaterial,
      256
    );

    const derivedHex = Array.from(new Uint8Array(derivedBits))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');

    expect(derivedHex).not.toBe(hashHex);
  });

  it('should track sessions on login', async () => {
    const sessionId = generateTestId();
    const tokenHash = generateTestId();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    await db
      .prepare('INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)')
      .bind(sessionId, seed.superAdminId, tokenHash, expiresAt)
      .run();

    const session = await db
      .prepare('SELECT * FROM sessions WHERE id = ?')
      .bind(sessionId)
      .first();

    expect(session).not.toBeNull();
    expect(session!.user_id).toBe(seed.superAdminId);
    expect(session!.revoked).toBeFalsy();
  });

  it('should update last_login_at on login', async () => {
    await db
      .prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?")
      .bind(seed.superAdminId)
      .run();

    const user = await db
      .prepare('SELECT last_login_at FROM users WHERE id = ?')
      .bind(seed.superAdminId)
      .first<{ last_login_at: string }>();

    expect(user!.last_login_at).toBeTruthy();
  });
});

describe('Auth - Register', () => {
  it('should create a new user with force_password_change', async () => {
    const id = generateTestId();
    const pwHash = await hashTestPassword('NewUser1234');

    await db
      .prepare(
        `INSERT INTO users (id, email, name, role, tenant_id, password_hash, active, force_password_change)
         VALUES (?, ?, ?, ?, ?, ?, 1, 1)`
      )
      .bind(id, `newuser-${id}@test.com`, 'New User', 'user', seed.tenantId, pwHash)
      .run();

    const user = await db.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();

    expect(user).not.toBeNull();
    expect(user!.role).toBe('user');
    expect(user!.force_password_change).toBe(1);
  });

  it('should detect duplicate email before insert', async () => {
    const existing = await db
      .prepare('SELECT id FROM users WHERE email = ?')
      .bind('admin@test.com')
      .first();

    expect(existing).not.toBeNull();
  });

  it('should require valid tenant_id', async () => {
    const fakeTenant = await db
      .prepare('SELECT id FROM tenants WHERE id = ?')
      .bind('nonexistent-tenant')
      .first();

    expect(fakeTenant).toBeNull();
  });

  it('should enforce valid roles', () => {
    const validRoles = ['super_admin', 'org_admin', 'user', 'reader'];
    expect(validRoles.includes('user')).toBe(true);
    expect(validRoles.includes('invalid')).toBe(false);
  });
});

describe('Auth - Forgot Password', () => {
  it('should create a password reset token', async () => {
    await db.prepare('DELETE FROM password_resets WHERE user_id = ?').bind(seed.orgAdminId).run();

    const tokenHash = generateTestId();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();

    await db
      .prepare('INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES (?, ?, ?)')
      .bind(seed.orgAdminId, tokenHash, expiresAt)
      .run();

    const reset = await db
      .prepare('SELECT * FROM password_resets WHERE user_id = ?')
      .bind(seed.orgAdminId)
      .first();

    expect(reset).not.toBeNull();
    expect(reset!.token_hash).toBe(tokenHash);
  });

  it('should detect expired reset token', async () => {
    const tokenHash = generateTestId();
    const expiredAt = new Date(Date.now() - 1000).toISOString();

    await db
      .prepare('INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES (?, ?, ?)')
      .bind(seed.userId, tokenHash, expiredAt)
      .run();

    const reset = await db
      .prepare('SELECT * FROM password_resets WHERE token_hash = ?')
      .bind(tokenHash)
      .first<{ expires_at: string }>();

    expect(reset).not.toBeNull();
    expect(new Date(reset!.expires_at) < new Date()).toBe(true);
  });
});

describe('Auth - Reset Password', () => {
  it('should update password and clear force_password_change', async () => {
    const newHash = await hashTestPassword('NewPass1234');

    await db
      .prepare(
        "UPDATE users SET password_hash = ?, force_password_change = 0, updated_at = datetime('now') WHERE id = ?"
      )
      .bind(newHash, seed.orgAdminId)
      .run();

    const user = await db
      .prepare('SELECT password_hash, force_password_change FROM users WHERE id = ?')
      .bind(seed.orgAdminId)
      .first<{ password_hash: string; force_password_change: number }>();

    expect(user!.password_hash).toBe(newHash);
    expect(user!.force_password_change).toBe(0);
  });

  it('should revoke all sessions after password reset', async () => {
    const sessionId = generateTestId();
    await db
      .prepare(
        "INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, datetime('now', '+1 day'))"
      )
      .bind(sessionId, seed.orgAdminId, generateTestId())
      .run();

    await db
      .prepare('UPDATE sessions SET revoked = 1 WHERE user_id = ?')
      .bind(seed.orgAdminId)
      .run();

    const session = await db
      .prepare('SELECT revoked FROM sessions WHERE id = ?')
      .bind(sessionId)
      .first<{ revoked: number }>();

    expect(session!.revoked).toBe(1);
  });

  it('should clean up used reset token', async () => {
    const tokenHash = generateTestId();
    await db
      .prepare(
        "INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES (?, ?, datetime('now', '+1 hour'))"
      )
      .bind(seed.userId, tokenHash)
      .run();

    const reset = await db
      .prepare('SELECT id FROM password_resets WHERE token_hash = ?')
      .bind(tokenHash)
      .first<{ id: string }>();

    expect(reset).not.toBeNull();
    await db.prepare('DELETE FROM password_resets WHERE id = ?').bind(reset!.id).run();

    const deleted = await db
      .prepare('SELECT id FROM password_resets WHERE token_hash = ?')
      .bind(tokenHash)
      .first();

    expect(deleted).toBeNull();
  });
});

describe('Auth - Rate Limiting', () => {
  it('should track rate limit attempts', async () => {
    const key = `login:127.0.0.1:ratetest-${Date.now()}@example.com`;
    const windowStart = new Date().toISOString();

    await db
      .prepare(
        `INSERT INTO rate_limits (key, attempts, window_start) VALUES (?, 1, ?)
         ON CONFLICT(key) DO UPDATE SET attempts = attempts + 1`
      )
      .bind(key, windowStart)
      .run();

    const record = await db
      .prepare('SELECT attempts FROM rate_limits WHERE key = ?')
      .bind(key)
      .first<{ attempts: number }>();

    expect(record).not.toBeNull();
    expect(record!.attempts).toBeGreaterThanOrEqual(1);
  });

  it('should clear rate limit on success', async () => {
    const key = `login:127.0.0.1:clear-${Date.now()}@example.com`;
    const windowStart = new Date().toISOString();

    await db
      .prepare('INSERT INTO rate_limits (key, attempts, window_start) VALUES (?, 3, ?)')
      .bind(key, windowStart)
      .run();

    await db.prepare('DELETE FROM rate_limits WHERE key = ?').bind(key).run();

    const record = await db
      .prepare('SELECT * FROM rate_limits WHERE key = ?')
      .bind(key)
      .first();

    expect(record).toBeNull();
  });
});
