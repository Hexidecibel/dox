import { describe, it, expect } from 'vitest';
import {
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
  BadRequestError,
  requireRole,
  requireTenantAccess,
  canUpload,
  canManageUsers,
  canViewAudit,
  canManageTenant,
  canManageOrgUsers,
  errorToResponse,
} from '../../functions/lib/permissions';
import type { User } from '../../functions/lib/types';

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: 'user-1',
    email: 'test@example.com',
    name: 'Test User',
    role: 'user',
    tenant_id: 'tenant-1',
    active: 1,
    ...overrides,
  };
}

describe('Error classes', () => {
  it('ForbiddenError has status 403 and correct name', () => {
    const err = new ForbiddenError();
    expect(err.status).toBe(403);
    expect(err.name).toBe('ForbiddenError');
    expect(err.message).toBe('Forbidden');
  });

  it('ForbiddenError accepts custom message', () => {
    const err = new ForbiddenError('Custom message');
    expect(err.message).toBe('Custom message');
  });

  it('NotFoundError has status 404', () => {
    const err = new NotFoundError();
    expect(err.status).toBe(404);
    expect(err.name).toBe('NotFoundError');
    expect(err.message).toBe('Not found');
  });

  it('UnauthorizedError has status 401', () => {
    const err = new UnauthorizedError();
    expect(err.status).toBe(401);
    expect(err.name).toBe('UnauthorizedError');
    expect(err.message).toBe('Unauthorized');
  });

  it('BadRequestError has status 400', () => {
    const err = new BadRequestError();
    expect(err.status).toBe(400);
    expect(err.name).toBe('BadRequestError');
    expect(err.message).toBe('Bad request');
  });

  it('all error classes extend Error', () => {
    expect(new ForbiddenError()).toBeInstanceOf(Error);
    expect(new NotFoundError()).toBeInstanceOf(Error);
    expect(new UnauthorizedError()).toBeInstanceOf(Error);
    expect(new BadRequestError()).toBeInstanceOf(Error);
  });
});

describe('requireRole', () => {
  it('does not throw when user has a matching role', () => {
    const user = makeUser({ role: 'org_admin' });
    expect(() => requireRole(user, 'org_admin', 'super_admin')).not.toThrow();
  });

  it('throws ForbiddenError when user role does not match', () => {
    const user = makeUser({ role: 'reader' });
    expect(() => requireRole(user, 'super_admin', 'org_admin')).toThrow(ForbiddenError);
  });

  it('throw message is "Insufficient permissions"', () => {
    const user = makeUser({ role: 'reader' });
    expect(() => requireRole(user, 'super_admin')).toThrow('Insufficient permissions');
  });
});

describe('requireTenantAccess', () => {
  it('allows super_admin to access any tenant', () => {
    const user = makeUser({ role: 'super_admin', tenant_id: null });
    expect(() => requireTenantAccess(user, 'any-tenant')).not.toThrow();
  });

  it('allows user to access their own tenant', () => {
    const user = makeUser({ tenant_id: 'tenant-1' });
    expect(() => requireTenantAccess(user, 'tenant-1')).not.toThrow();
  });

  it('denies user access to a different tenant', () => {
    const user = makeUser({ tenant_id: 'tenant-1' });
    expect(() => requireTenantAccess(user, 'tenant-2')).toThrow(ForbiddenError);
    expect(() => requireTenantAccess(user, 'tenant-2')).toThrow('Access denied to this tenant');
  });
});

describe('canUpload', () => {
  it('super_admin can upload', () => {
    expect(canUpload(makeUser({ role: 'super_admin' }))).toBe(true);
  });

  it('org_admin can upload', () => {
    expect(canUpload(makeUser({ role: 'org_admin' }))).toBe(true);
  });

  it('user can upload', () => {
    expect(canUpload(makeUser({ role: 'user' }))).toBe(true);
  });

  it('reader cannot upload', () => {
    expect(canUpload(makeUser({ role: 'reader' }))).toBe(false);
  });
});

describe('canManageUsers', () => {
  it('super_admin can manage users', () => {
    expect(canManageUsers(makeUser({ role: 'super_admin' }))).toBe(true);
  });

  it('org_admin can manage users', () => {
    expect(canManageUsers(makeUser({ role: 'org_admin' }))).toBe(true);
  });

  it('user cannot manage users', () => {
    expect(canManageUsers(makeUser({ role: 'user' }))).toBe(false);
  });

  it('reader cannot manage users', () => {
    expect(canManageUsers(makeUser({ role: 'reader' }))).toBe(false);
  });
});

describe('canViewAudit', () => {
  it('super_admin can view audit', () => {
    expect(canViewAudit(makeUser({ role: 'super_admin' }))).toBe(true);
  });

  it('org_admin can view audit', () => {
    expect(canViewAudit(makeUser({ role: 'org_admin' }))).toBe(true);
  });

  it('user cannot view audit', () => {
    expect(canViewAudit(makeUser({ role: 'user' }))).toBe(false);
  });
});

describe('canManageTenant', () => {
  it('only super_admin can manage tenants', () => {
    expect(canManageTenant(makeUser({ role: 'super_admin' }))).toBe(true);
    expect(canManageTenant(makeUser({ role: 'org_admin' }))).toBe(false);
    expect(canManageTenant(makeUser({ role: 'user' }))).toBe(false);
    expect(canManageTenant(makeUser({ role: 'reader' }))).toBe(false);
  });
});

describe('canManageOrgUsers', () => {
  it('super_admin can manage org users for any tenant', () => {
    expect(canManageOrgUsers(makeUser({ role: 'super_admin' }), 'any-tenant')).toBe(true);
  });

  it('org_admin can manage org users for their own tenant', () => {
    expect(canManageOrgUsers(makeUser({ role: 'org_admin', tenant_id: 'tenant-1' }), 'tenant-1')).toBe(true);
  });

  it('org_admin cannot manage org users for another tenant', () => {
    expect(canManageOrgUsers(makeUser({ role: 'org_admin', tenant_id: 'tenant-1' }), 'tenant-2')).toBe(false);
  });

  it('regular user cannot manage org users', () => {
    expect(canManageOrgUsers(makeUser({ role: 'user', tenant_id: 'tenant-1' }), 'tenant-1')).toBe(false);
  });
});

describe('errorToResponse', () => {
  it('converts ForbiddenError to 403 response', async () => {
    const resp = errorToResponse(new ForbiddenError('nope'));
    expect(resp).not.toBeNull();
    expect(resp!.status).toBe(403);
    const body = await resp!.json() as { error: string };
    expect(body.error).toBe('nope');
  });

  it('converts NotFoundError to 404 response', async () => {
    const resp = errorToResponse(new NotFoundError());
    expect(resp).not.toBeNull();
    expect(resp!.status).toBe(404);
  });

  it('converts UnauthorizedError to 401 response', async () => {
    const resp = errorToResponse(new UnauthorizedError());
    expect(resp).not.toBeNull();
    expect(resp!.status).toBe(401);
  });

  it('converts BadRequestError to 400 response', async () => {
    const resp = errorToResponse(new BadRequestError());
    expect(resp).not.toBeNull();
    expect(resp!.status).toBe(400);
  });

  it('returns null for unknown errors', () => {
    expect(errorToResponse(new Error('generic'))).toBeNull();
    expect(errorToResponse('string error')).toBeNull();
    expect(errorToResponse(null)).toBeNull();
  });
});
