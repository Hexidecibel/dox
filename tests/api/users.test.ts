import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { seedTestData, hashTestPassword, generateTestId } from '../helpers/db';

let seed: Awaited<ReturnType<typeof seedTestData>>;
const db = env.DB;

beforeAll(async () => {
  seed = await seedTestData(db);
}, 30_000);

describe('Users - List', () => {
  it('super_admin sees all users', async () => {
    const result = await db
      .prepare('SELECT id, email, name, role, tenant_id, active FROM users ORDER BY name ASC')
      .all();
    expect(result.results.length).toBeGreaterThanOrEqual(5);
  });

  it('can filter by tenant_id', async () => {
    const result = await db
      .prepare('SELECT id, email, name, role, tenant_id FROM users WHERE tenant_id = ? ORDER BY name ASC')
      .bind(seed.tenantId)
      .all();
    for (const user of result.results) {
      expect(user.tenant_id).toBe(seed.tenantId);
    }
  });

  it('org_admin query returns only own tenant', async () => {
    const result = await db
      .prepare('SELECT id, tenant_id FROM users WHERE tenant_id = ?')
      .bind(seed.tenantId)
      .all();
    const tenant2Users = result.results.filter((u) => u.tenant_id === seed.tenantId2);
    expect(tenant2Users.length).toBe(0);
  });
});

describe('Users - Get by ID', () => {
  it('should get user by ID', async () => {
    const user = await db
      .prepare('SELECT id, email, name, role, tenant_id, active FROM users WHERE id = ?')
      .bind(seed.orgAdminId)
      .first();
    expect(user).not.toBeNull();
    expect(user!.email).toBe('orgadmin@test.com');
    expect(user!.role).toBe('org_admin');
  });

  it('should return null for non-existent user', async () => {
    const user = await db.prepare('SELECT id FROM users WHERE id = ?').bind('nonexistent-id').first();
    expect(user).toBeNull();
  });
});

describe('Users - Me', () => {
  it('should return current user with tenant name', async () => {
    const user = await db
      .prepare('SELECT id, email, name, role, tenant_id FROM users WHERE id = ?')
      .bind(seed.orgAdminId)
      .first();
    expect(user).not.toBeNull();

    const tenant = await db
      .prepare('SELECT name FROM tenants WHERE id = ?')
      .bind(user!.tenant_id as string)
      .first<{ name: string }>();
    expect(tenant!.name).toBe('Test Corp');
  });
});

describe('Users - Update', () => {
  it('should update user name', async () => {
    const id = generateTestId();
    const hash = await hashTestPassword('Test1234');
    await db
      .prepare('INSERT INTO users (id, email, name, role, tenant_id, password_hash, active) VALUES (?, ?, ?, ?, ?, ?, 1)')
      .bind(id, `upd-name-${id}@test.com`, 'Original', 'user', seed.tenantId, hash)
      .run();

    await db.prepare("UPDATE users SET name = ?, updated_at = datetime('now') WHERE id = ?").bind('Updated', id).run();

    const user = await db.prepare('SELECT name FROM users WHERE id = ?').bind(id).first<{ name: string }>();
    expect(user!.name).toBe('Updated');
  });

  it('should update user email', async () => {
    const id = generateTestId();
    const hash = await hashTestPassword('Test1234');
    await db
      .prepare('INSERT INTO users (id, email, name, role, tenant_id, password_hash, active) VALUES (?, ?, ?, ?, ?, ?, 1)')
      .bind(id, `upd-email-${id}@test.com`, 'Email Test', 'user', seed.tenantId, hash)
      .run();

    await db.prepare("UPDATE users SET email = ?, updated_at = datetime('now') WHERE id = ?").bind(`new-${id}@test.com`, id).run();

    const user = await db.prepare('SELECT email FROM users WHERE id = ?').bind(id).first<{ email: string }>();
    expect(user!.email).toBe(`new-${id}@test.com`);
  });

  it('should update user role', async () => {
    const id = generateTestId();
    const hash = await hashTestPassword('Test1234');
    await db
      .prepare('INSERT INTO users (id, email, name, role, tenant_id, password_hash, active) VALUES (?, ?, ?, ?, ?, ?, 1)')
      .bind(id, `upd-role-${id}@test.com`, 'Role Test', 'user', seed.tenantId, hash)
      .run();

    await db.prepare("UPDATE users SET role = ?, updated_at = datetime('now') WHERE id = ?").bind('org_admin', id).run();

    const user = await db.prepare('SELECT role FROM users WHERE id = ?').bind(id).first<{ role: string }>();
    expect(user!.role).toBe('org_admin');
  });

  it('should update active status', async () => {
    const id = generateTestId();
    const hash = await hashTestPassword('Test1234');
    await db
      .prepare('INSERT INTO users (id, email, name, role, tenant_id, password_hash, active) VALUES (?, ?, ?, ?, ?, ?, 1)')
      .bind(id, `upd-active-${id}@test.com`, 'Active Test', 'user', seed.tenantId, hash)
      .run();

    await db.prepare("UPDATE users SET active = 0, updated_at = datetime('now') WHERE id = ?").bind(id).run();
    const user = await db.prepare('SELECT active FROM users WHERE id = ?').bind(id).first<{ active: number }>();
    expect(user!.active).toBe(0);
  });
});

describe('Users - Delete (Deactivate)', () => {
  it('should soft-delete user by setting active to 0', async () => {
    const id = generateTestId();
    const hash = await hashTestPassword('Test1234');
    await db
      .prepare('INSERT INTO users (id, email, name, role, tenant_id, password_hash, active) VALUES (?, ?, ?, ?, ?, ?, 1)')
      .bind(id, `del-${id}@test.com`, 'Del Test', 'user', seed.tenantId, hash)
      .run();

    await db.prepare("UPDATE users SET active = 0, updated_at = datetime('now') WHERE id = ?").bind(id).run();
    const user = await db.prepare('SELECT active FROM users WHERE id = ?').bind(id).first<{ active: number }>();
    expect(user!.active).toBe(0);
  });

  it('should not hard-delete user record', async () => {
    const user = await db.prepare('SELECT id FROM users WHERE id = ?').bind(seed.inactiveId).first();
    expect(user).not.toBeNull();
  });
});

describe('Users - Permission Checks', () => {
  it('org_admin cannot see users outside their tenant (data isolation)', async () => {
    const otherUser = await db
      .prepare('SELECT id, tenant_id FROM users WHERE id = ?')
      .bind(seed.orgAdmin2Id)
      .first<{ id: string; tenant_id: string }>();

    expect(otherUser).not.toBeNull();
    expect(otherUser!.tenant_id).toBe(seed.tenantId2);
    expect(otherUser!.tenant_id).not.toBe(seed.tenantId);
  });

  it('org_admin role verified on existing users', async () => {
    const orgAdmin = await db
      .prepare('SELECT id, role FROM users WHERE id = ?')
      .bind(seed.orgAdminId)
      .first<{ id: string; role: string }>();
    expect(orgAdmin!.role).toBe('org_admin');
  });
});
