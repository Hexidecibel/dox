import { env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

describe('Test infrastructure', () => {
  it('vitest is working', () => {
    expect(1 + 1).toBe(2);
  });

  it('has D1 binding', () => {
    expect(env.DB).toBeDefined();
  });

  it('has R2 binding', () => {
    expect(env.FILES).toBeDefined();
  });

  it('has JWT_SECRET binding', () => {
    expect(env.JWT_SECRET).toBe('test-jwt-secret-for-testing-only');
  });

  it('can execute SQL on D1', async () => {
    const result = await env.DB.prepare('SELECT 1 as n').first<{ n: number }>();
    expect(result?.n).toBe(1);
  });

  it('has migrations applied (tenants table exists)', async () => {
    const result = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='tenants'"
    ).first<{ name: string }>();
    expect(result?.name).toBe('tenants');
  });

  it('has migrations applied (users table exists)', async () => {
    const result = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='users'"
    ).first<{ name: string }>();
    expect(result?.name).toBe('users');
  });

  it('can write and read from R2', async () => {
    const key = 'test/smoke-test.txt';
    const content = 'hello from smoke test';
    await env.FILES.put(key, content);
    const obj = await env.FILES.get(key);
    expect(obj).not.toBeNull();
    const text = await obj!.text();
    expect(text).toBe(content);
    await env.FILES.delete(key);
  });
});
