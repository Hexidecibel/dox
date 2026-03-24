import type { User } from './types';

export class ForbiddenError extends Error {
  status = 403;
  constructor(message = 'Forbidden') {
    super(message);
    this.name = 'ForbiddenError';
  }
}

export class NotFoundError extends Error {
  status = 404;
  constructor(message = 'Not found') {
    super(message);
    this.name = 'NotFoundError';
  }
}

export class UnauthorizedError extends Error {
  status = 401;
  constructor(message = 'Unauthorized') {
    super(message);
    this.name = 'UnauthorizedError';
  }
}

export class BadRequestError extends Error {
  status = 400;
  constructor(message = 'Bad request') {
    super(message);
    this.name = 'BadRequestError';
  }
}

export function requireRole(user: User, ...roles: string[]): void {
  if (!roles.includes(user.role)) {
    throw new ForbiddenError('Insufficient permissions');
  }
}

export function requireTenantAccess(user: User, tenantId: string): void {
  if (user.role === 'super_admin') return;
  if (user.tenant_id !== tenantId) {
    throw new ForbiddenError('Access denied to this tenant');
  }
}

export function canUpload(user: User): boolean {
  return user.role === 'super_admin' || user.role === 'org_admin' || user.role === 'user';
}

export function canManageUsers(user: User): boolean {
  return user.role === 'super_admin' || user.role === 'org_admin';
}

export function canViewAudit(user: User): boolean {
  return user.role === 'super_admin' || user.role === 'org_admin';
}

export function canManageTenant(user: User): boolean {
  return user.role === 'super_admin';
}

export function canManageOrgUsers(user: User, tenantId: string): boolean {
  if (user.role === 'super_admin') return true;
  if (user.role === 'org_admin' && user.tenant_id === tenantId) return true;
  return false;
}

/**
 * Convert a known error into a JSON Response.
 * Returns null if the error is not a recognized HTTP error.
 */
export function errorToResponse(err: unknown): Response | null {
  if (
    err instanceof ForbiddenError ||
    err instanceof NotFoundError ||
    err instanceof UnauthorizedError ||
    err instanceof BadRequestError
  ) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: err.status,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  return null;
}
