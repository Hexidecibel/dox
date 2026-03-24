import type { GraphQLContext } from '../context';
import { roleToGql, roleToDB, statusToGql, statusToDB } from '../roles';
import {
  UnauthorizedError,
  ForbiddenError,
  BadRequestError,
  NotFoundError,
  requireRole,
  requireTenantAccess,
} from '../../permissions';
import {
  verifyPassword,
  hashPassword,
  generateToken,
  generateId,
} from '../../auth';
import { validatePassword } from '../../validation';
import { logAudit, getClientIp } from '../../db';
import { sendEmail, buildAdminResetEmail } from '../../email';
import type { User as DBUser, Document } from '../../types';

function requireAuth(ctx: GraphQLContext): DBUser {
  if (!ctx.user) {
    throw new UnauthorizedError('Authentication required');
  }
  return ctx.user;
}

async function hashTokenSHA256(token: string): Promise<string> {
  const encoder = new TextEncoder();
  const hash = await crypto.subtle.digest('SHA-256', encoder.encode(token));
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function generateTempPassword(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  const special = '!@#$%&*';
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);

  let password = '';
  for (const b of bytes) {
    password += chars[b % chars.length];
  }

  const inject = [
    'ABCDEFGHJKLMNPQRSTUVWXYZ'[bytes[0] % 24],
    'abcdefghjkmnpqrstuvwxyz'[bytes[1] % 23],
    '23456789'[bytes[2] % 8],
    special[bytes[3] % special.length],
  ];

  return inject.join('') + password.slice(4);
}

function mapUser(row: Record<string, unknown>) {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: roleToGql(row.role as string),
    tenantId: row.tenant_id ?? null,
    tenant_id: row.tenant_id ?? null,
    active: Boolean(row.active),
    lastLoginAt: row.last_login_at ?? null,
    createdAt: row.created_at,
  };
}

function mapTenant(r: Record<string, unknown>) {
  return {
    id: r.id,
    name: r.name,
    slug: r.slug,
    description: r.description ?? null,
    active: Boolean(r.active),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function mapDocument(row: Record<string, unknown>) {
  let tags: string[] = [];
  try {
    tags = JSON.parse(row.tags as string);
  } catch {
    // ignore
  }
  return {
    id: row.id,
    title: row.title,
    description: row.description ?? null,
    category: row.category ?? null,
    tags,
    currentVersion: row.current_version,
    status: statusToGql(row.status as string),
    tenantId: row.tenant_id,
    tenant_id: row.tenant_id,
    created_by: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export const mutationResolvers = {
  login: async (
    _parent: unknown,
    args: { email: string; password: string },
    ctx: GraphQLContext
  ) => {
    const email = args.email.toLowerCase().trim();

    const user = await ctx.db
      .prepare(
        'SELECT id, email, name, role, tenant_id, active, password_hash FROM users WHERE email = ?'
      )
      .bind(email)
      .first<DBUser & { password_hash: string }>();

    if (!user) {
      throw new UnauthorizedError('Invalid email or password');
    }

    if (!user.active) {
      throw new ForbiddenError('Account is inactive');
    }

    const valid = await verifyPassword(args.password, user.password_hash);
    if (!valid) {
      throw new UnauthorizedError('Invalid email or password');
    }

    await ctx.db
      .prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?")
      .bind(user.id)
      .run();

    const token = await generateToken(
      {
        sub: user.id,
        email: user.email,
        role: user.role,
        tenantId: user.tenant_id,
      },
      ctx.env.JWT_SECRET
    );

    await logAudit(
      ctx.db,
      user.id,
      user.tenant_id,
      'login',
      'user',
      user.id,
      null,
      getClientIp(ctx.request)
    );

    return {
      token,
      user: mapUser({
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        tenant_id: user.tenant_id,
        active: user.active,
        last_login_at: null,
        created_at: null,
      }),
    };
  },

  changePassword: async (
    _parent: unknown,
    args: { currentPassword: string; newPassword: string },
    ctx: GraphQLContext
  ) => {
    const user = requireAuth(ctx);

    if (args.newPassword.length < 8) {
      throw new BadRequestError(
        'New password must be at least 8 characters'
      );
    }

    const record = await ctx.db
      .prepare('SELECT password_hash FROM users WHERE id = ?')
      .bind(user.id)
      .first<{ password_hash: string }>();

    if (!record) {
      throw new NotFoundError('User not found');
    }

    const valid = await verifyPassword(
      args.currentPassword,
      record.password_hash
    );
    if (!valid) {
      throw new UnauthorizedError('Current password is incorrect');
    }

    const newHash = await hashPassword(args.newPassword);

    await ctx.db
      .prepare(
        "UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?"
      )
      .bind(newHash, user.id)
      .run();

    await logAudit(
      ctx.db,
      user.id,
      user.tenant_id,
      'password_changed',
      'user',
      user.id,
      null,
      getClientIp(ctx.request)
    );

    return true;
  },

  createTenant: async (
    _parent: unknown,
    args: { name: string; slug?: string; description?: string },
    ctx: GraphQLContext
  ) => {
    const user = requireAuth(ctx);
    requireRole(user, 'super_admin');

    const slug = (args.slug || args.name)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');

    if (!slug) {
      throw new BadRequestError('Could not generate a valid slug');
    }

    const existing = await ctx.db
      .prepare('SELECT id FROM tenants WHERE slug = ?')
      .bind(slug)
      .first();

    if (existing) {
      throw new BadRequestError(
        'A tenant with this slug already exists'
      );
    }

    const id = generateId();

    await ctx.db
      .prepare(
        'INSERT INTO tenants (id, name, slug, description, active) VALUES (?, ?, ?, ?, 1)'
      )
      .bind(id, args.name.trim(), slug, args.description?.trim() || null)
      .run();

    await logAudit(
      ctx.db,
      user.id,
      id,
      'tenant_created',
      'tenant',
      id,
      JSON.stringify({ name: args.name, slug }),
      getClientIp(ctx.request)
    );

    const tenant = await ctx.db
      .prepare('SELECT * FROM tenants WHERE id = ?')
      .bind(id)
      .first();

    return mapTenant(tenant as Record<string, unknown>);
  },

  updateTenant: async (
    _parent: unknown,
    args: {
      id: string;
      name?: string;
      description?: string;
      active?: boolean;
    },
    ctx: GraphQLContext
  ) => {
    const user = requireAuth(ctx);
    requireRole(user, 'super_admin');

    const tenant = await ctx.db
      .prepare('SELECT * FROM tenants WHERE id = ?')
      .bind(args.id)
      .first();

    if (!tenant) {
      throw new NotFoundError('Tenant not found');
    }

    const updates: string[] = [];
    const values: (string | number | null)[] = [];

    if (args.name !== undefined) {
      updates.push('name = ?');
      values.push(args.name.trim());
    }
    if (args.description !== undefined) {
      updates.push('description = ?');
      values.push(args.description.trim() || null);
    }
    if (args.active !== undefined) {
      updates.push('active = ?');
      values.push(args.active ? 1 : 0);
    }

    if (updates.length === 0) {
      throw new BadRequestError('No fields to update');
    }

    updates.push("updated_at = datetime('now')");
    values.push(args.id);

    await ctx.db
      .prepare(`UPDATE tenants SET ${updates.join(', ')} WHERE id = ?`)
      .bind(...values)
      .run();

    await logAudit(
      ctx.db,
      user.id,
      args.id,
      'tenant_updated',
      'tenant',
      args.id,
      JSON.stringify(args),
      getClientIp(ctx.request)
    );

    const updated = await ctx.db
      .prepare('SELECT * FROM tenants WHERE id = ?')
      .bind(args.id)
      .first();

    return mapTenant(updated as Record<string, unknown>);
  },

  createUser: async (
    _parent: unknown,
    args: {
      email: string;
      name: string;
      password: string;
      role: string;
      tenantId?: string;
    },
    ctx: GraphQLContext
  ) => {
    const currentUser = requireAuth(ctx);
    requireRole(currentUser, 'super_admin', 'org_admin');

    const dbRole = roleToDB(args.role);
    const validRoles = ['super_admin', 'org_admin', 'user', 'reader'];
    if (!validRoles.includes(dbRole)) {
      throw new BadRequestError(
        `role must be one of: ${validRoles.join(', ')}`
      );
    }

    let tenantId = args.tenantId || null;

    if (currentUser.role === 'org_admin') {
      if (dbRole === 'super_admin' || dbRole === 'org_admin') {
        throw new ForbiddenError(
          'Org admins can only create user or reader roles'
        );
      }
      if (tenantId && tenantId !== currentUser.tenant_id) {
        throw new ForbiddenError(
          'Org admins can only create users within their own tenant'
        );
      }
      if (!tenantId) {
        tenantId = currentUser.tenant_id;
      }
    }

    if (args.password.length < 8) {
      throw new BadRequestError(
        'Password must be at least 8 characters'
      );
    }

    const email = args.email.toLowerCase().trim();

    const existing = await ctx.db
      .prepare('SELECT id FROM users WHERE email = ?')
      .bind(email)
      .first();

    if (existing) {
      throw new BadRequestError(
        'A user with this email already exists'
      );
    }

    if (tenantId) {
      const tenant = await ctx.db
        .prepare('SELECT id FROM tenants WHERE id = ?')
        .bind(tenantId)
        .first();

      if (!tenant) {
        throw new NotFoundError('Tenant not found');
      }
    }

    const id = generateId();
    const passwordHash = await hashPassword(args.password);

    await ctx.db
      .prepare(
        'INSERT INTO users (id, email, name, role, tenant_id, password_hash, active) VALUES (?, ?, ?, ?, ?, ?, 1)'
      )
      .bind(id, email, args.name, dbRole, tenantId, passwordHash)
      .run();

    await logAudit(
      ctx.db,
      currentUser.id,
      tenantId,
      'user_created',
      'user',
      id,
      JSON.stringify({ email, role: dbRole }),
      getClientIp(ctx.request)
    );

    const created = await ctx.db
      .prepare(
        'SELECT id, email, name, role, tenant_id, active, last_login_at, created_at FROM users WHERE id = ?'
      )
      .bind(id)
      .first();

    return mapUser(created as Record<string, unknown>);
  },

  updateUser: async (
    _parent: unknown,
    args: {
      id: string;
      name?: string;
      role?: string;
      active?: boolean;
      tenantId?: string;
    },
    ctx: GraphQLContext
  ) => {
    const currentUser = requireAuth(ctx);

    const target = await ctx.db
      .prepare(
        'SELECT id, email, name, role, tenant_id, active FROM users WHERE id = ?'
      )
      .bind(args.id)
      .first<DBUser>();

    if (!target) {
      throw new NotFoundError('User not found');
    }

    const updates: string[] = [];
    const values: (string | number | null)[] = [];

    if (currentUser.role === 'super_admin') {
      if (args.name !== undefined) {
        updates.push('name = ?');
        values.push(args.name.trim());
      }
      if (args.role !== undefined) {
        updates.push('role = ?');
        values.push(roleToDB(args.role));
      }
      if (args.active !== undefined) {
        updates.push('active = ?');
        values.push(args.active ? 1 : 0);
      }
      if (args.tenantId !== undefined) {
        updates.push('tenant_id = ?');
        values.push(args.tenantId || null);
      }
    } else if (currentUser.role === 'org_admin') {
      if (target.tenant_id !== currentUser.tenant_id) {
        throw new ForbiddenError(
          'Cannot modify users outside your tenant'
        );
      }
      if (
        target.role === 'org_admin' &&
        args.id !== currentUser.id
      ) {
        throw new ForbiddenError('Cannot modify other org admins');
      }
      if (
        args.role !== undefined &&
        (roleToDB(args.role) === 'super_admin' ||
          roleToDB(args.role) === 'org_admin')
      ) {
        throw new ForbiddenError('Cannot assign admin roles');
      }

      if (args.name !== undefined) {
        updates.push('name = ?');
        values.push(args.name.trim());
      }
      if (args.role !== undefined) {
        updates.push('role = ?');
        values.push(roleToDB(args.role));
      }
      if (args.active !== undefined) {
        updates.push('active = ?');
        values.push(args.active ? 1 : 0);
      }
    } else {
      if (args.id !== currentUser.id) {
        throw new ForbiddenError(
          'You can only update your own profile'
        );
      }
      if (args.name !== undefined) {
        updates.push('name = ?');
        values.push(args.name.trim());
      }
    }

    if (updates.length === 0) {
      throw new BadRequestError('No valid fields to update');
    }

    updates.push("updated_at = datetime('now')");
    values.push(args.id);

    await ctx.db
      .prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`)
      .bind(...values)
      .run();

    await logAudit(
      ctx.db,
      currentUser.id,
      currentUser.tenant_id,
      'user_updated',
      'user',
      args.id,
      JSON.stringify(args),
      getClientIp(ctx.request)
    );

    const updated = await ctx.db
      .prepare(
        'SELECT id, email, name, role, tenant_id, active, last_login_at, created_at FROM users WHERE id = ?'
      )
      .bind(args.id)
      .first();

    return mapUser(updated as Record<string, unknown>);
  },

  createDocument: async (
    _parent: unknown,
    args: {
      title: string;
      description?: string;
      category?: string;
      tags?: string[];
      tenantId: string;
    },
    ctx: GraphQLContext
  ) => {
    const user = requireAuth(ctx);
    requireRole(user, 'super_admin', 'org_admin', 'user');

    let tenantId = args.tenantId;
    if (user.role !== 'super_admin') {
      tenantId = user.tenant_id!;
    }

    requireTenantAccess(user, tenantId);

    const tenant = await ctx.db
      .prepare('SELECT id FROM tenants WHERE id = ? AND active = 1')
      .bind(tenantId)
      .first();

    if (!tenant) {
      throw new NotFoundError('Tenant not found or inactive');
    }

    const id = generateId();
    const tags = JSON.stringify(args.tags || []);

    await ctx.db
      .prepare(
        "INSERT INTO documents (id, tenant_id, title, description, category, tags, current_version, status, created_by) VALUES (?, ?, ?, ?, ?, ?, 0, 'active', ?)"
      )
      .bind(
        id,
        tenantId,
        args.title,
        args.description || null,
        args.category || null,
        tags,
        user.id
      )
      .run();

    await logAudit(
      ctx.db,
      user.id,
      tenantId,
      'document_created',
      'document',
      id,
      JSON.stringify({ title: args.title }),
      getClientIp(ctx.request)
    );

    const created = await ctx.db
      .prepare('SELECT * FROM documents WHERE id = ?')
      .bind(id)
      .first();

    return mapDocument(created as Record<string, unknown>);
  },

  updateDocument: async (
    _parent: unknown,
    args: {
      id: string;
      title?: string;
      description?: string;
      category?: string;
      tags?: string[];
      status?: string;
    },
    ctx: GraphQLContext
  ) => {
    const user = requireAuth(ctx);
    requireRole(user, 'super_admin', 'org_admin', 'user');

    const doc = await ctx.db
      .prepare(
        "SELECT * FROM documents WHERE id = ? AND status != 'deleted'"
      )
      .bind(args.id)
      .first<Document>();

    if (!doc) {
      throw new NotFoundError('Document not found');
    }

    requireTenantAccess(user, doc.tenant_id);

    const updates: string[] = [];
    const params: (string | null)[] = [];

    if (args.title !== undefined) {
      updates.push('title = ?');
      params.push(args.title);
    }
    if (args.description !== undefined) {
      updates.push('description = ?');
      params.push(args.description);
    }
    if (args.category !== undefined) {
      updates.push('category = ?');
      params.push(args.category);
    }
    if (args.tags !== undefined) {
      updates.push('tags = ?');
      params.push(JSON.stringify(args.tags));
    }
    if (args.status !== undefined) {
      const dbStatus = statusToDB(args.status);
      if (!['active', 'archived'].includes(dbStatus)) {
        throw new BadRequestError('status must be ACTIVE or ARCHIVED');
      }
      updates.push('status = ?');
      params.push(dbStatus);
    }

    if (updates.length === 0) {
      throw new BadRequestError('No fields to update');
    }

    updates.push("updated_at = datetime('now')");
    params.push(args.id);

    await ctx.db
      .prepare(
        `UPDATE documents SET ${updates.join(', ')} WHERE id = ?`
      )
      .bind(...params)
      .run();

    await logAudit(
      ctx.db,
      user.id,
      doc.tenant_id,
      'document_updated',
      'document',
      args.id,
      JSON.stringify(args),
      getClientIp(ctx.request)
    );

    const updated = await ctx.db
      .prepare('SELECT * FROM documents WHERE id = ?')
      .bind(args.id)
      .first();

    return mapDocument(updated as Record<string, unknown>);
  },

  deleteDocument: async (
    _parent: unknown,
    args: { id: string },
    ctx: GraphQLContext
  ) => {
    const user = requireAuth(ctx);
    requireRole(user, 'super_admin', 'org_admin', 'user');

    const doc = await ctx.db
      .prepare(
        "SELECT * FROM documents WHERE id = ? AND status != 'deleted'"
      )
      .bind(args.id)
      .first<Document>();

    if (!doc) {
      throw new NotFoundError('Document not found');
    }

    requireTenantAccess(user, doc.tenant_id);

    await ctx.db
      .prepare(
        "UPDATE documents SET status = 'deleted', updated_at = datetime('now') WHERE id = ?"
      )
      .bind(args.id)
      .run();

    await logAudit(
      ctx.db,
      user.id,
      doc.tenant_id,
      'document_deleted',
      'document',
      args.id,
      null,
      getClientIp(ctx.request)
    );

    return true;
  },

  logout: async (
    _parent: unknown,
    _args: unknown,
    ctx: GraphQLContext
  ) => {
    const user = requireAuth(ctx);

    const authHeader = ctx.request.headers.get('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new BadRequestError('No token provided');
    }

    const token = authHeader.slice(7);
    const tokenHash = await hashTokenSHA256(token);

    await ctx.db
      .prepare(
        'UPDATE sessions SET revoked = 1 WHERE token_hash = ? AND user_id = ?'
      )
      .bind(tokenHash, user.id)
      .run();

    await logAudit(
      ctx.db,
      user.id,
      user.tenant_id,
      'logout',
      'user',
      user.id,
      null,
      getClientIp(ctx.request)
    );

    return true;
  },

  deleteTenant: async (
    _parent: unknown,
    args: { id: string },
    ctx: GraphQLContext
  ) => {
    const user = requireAuth(ctx);
    requireRole(user, 'super_admin');

    const tenant = await ctx.db
      .prepare('SELECT * FROM tenants WHERE id = ?')
      .bind(args.id)
      .first();

    if (!tenant) {
      throw new NotFoundError('Tenant not found');
    }

    await ctx.db
      .prepare(
        "UPDATE tenants SET active = 0, updated_at = datetime('now') WHERE id = ?"
      )
      .bind(args.id)
      .run();

    await logAudit(
      ctx.db,
      user.id,
      args.id,
      'tenant_deactivated',
      'tenant',
      args.id,
      null,
      getClientIp(ctx.request)
    );

    return true;
  },

  deleteUser: async (
    _parent: unknown,
    args: { id: string },
    ctx: GraphQLContext
  ) => {
    const currentUser = requireAuth(ctx);

    const target = await ctx.db
      .prepare(
        'SELECT id, email, name, role, tenant_id, active FROM users WHERE id = ?'
      )
      .bind(args.id)
      .first<DBUser>();

    if (!target) {
      throw new NotFoundError('User not found');
    }

    if (currentUser.role === 'super_admin') {
      // Can deactivate any user
    } else if (currentUser.role === 'org_admin') {
      if (target.tenant_id !== currentUser.tenant_id) {
        throw new ForbiddenError(
          'Cannot deactivate users outside your tenant'
        );
      }
      if (
        target.role === 'org_admin' ||
        target.role === 'super_admin'
      ) {
        throw new ForbiddenError('Cannot deactivate admins');
      }
    } else {
      throw new ForbiddenError('Insufficient permissions');
    }

    await ctx.db
      .prepare(
        "UPDATE users SET active = 0, updated_at = datetime('now') WHERE id = ?"
      )
      .bind(args.id)
      .run();

    await logAudit(
      ctx.db,
      currentUser.id,
      currentUser.tenant_id,
      'user_deactivated',
      'user',
      args.id,
      null,
      getClientIp(ctx.request)
    );

    return true;
  },

  resetUserPassword: async (
    _parent: unknown,
    args: { id: string },
    ctx: GraphQLContext
  ) => {
    const currentUser = requireAuth(ctx);
    requireRole(currentUser, 'super_admin', 'org_admin');

    const targetUser = await ctx.db
      .prepare(
        'SELECT id, email, name, tenant_id, role FROM users WHERE id = ?'
      )
      .bind(args.id)
      .first<{
        id: string;
        email: string;
        name: string;
        tenant_id: string | null;
        role: string;
      }>();

    if (!targetUser) {
      throw new NotFoundError('User not found');
    }

    if (currentUser.role === 'org_admin') {
      if (
        !targetUser.tenant_id ||
        targetUser.tenant_id !== currentUser.tenant_id
      ) {
        throw new ForbiddenError(
          'You can only reset passwords for users in your organization'
        );
      }
      if (
        targetUser.role === 'super_admin' ||
        targetUser.role === 'org_admin'
      ) {
        throw new ForbiddenError(
          "Insufficient permissions to reset this user's password"
        );
      }
    }

    const tempPassword = generateTempPassword();
    const passwordHash = await hashPassword(tempPassword);

    await ctx.db
      .prepare(
        "UPDATE users SET password_hash = ?, force_password_change = 1, updated_at = datetime('now') WHERE id = ?"
      )
      .bind(passwordHash, args.id)
      .run();

    // Revoke all existing sessions
    await ctx.db
      .prepare('UPDATE sessions SET revoked = 1 WHERE user_id = ?')
      .bind(args.id)
      .run();

    await logAudit(
      ctx.db,
      currentUser.id,
      targetUser.tenant_id,
      'user.password_reset',
      'user',
      args.id,
      JSON.stringify({ resetBy: currentUser.email }),
      getClientIp(ctx.request)
    );

    // Send email if Resend is configured
    let emailSent = false;
    if (ctx.env.RESEND_API_KEY) {
      const origin = new URL(ctx.request.url).origin;
      const loginUrl = origin + '/login';
      const { subject, html } = buildAdminResetEmail({
        userName: targetUser.name,
        adminName: currentUser.name,
        tempPassword,
        loginUrl,
      });

      emailSent = await sendEmail(ctx.env.RESEND_API_KEY, {
        to: targetUser.email,
        subject,
        html,
      });
    }

    return { temporaryPassword: tempPassword, emailSent };
  },

  generateReport: async (
    _parent: unknown,
    args: {
      tenantId?: string;
      category?: string;
      dateFrom?: string;
      dateTo?: string;
    },
    ctx: GraphQLContext
  ) => {
    const user = requireAuth(ctx);

    let tenantId = args.tenantId || null;
    if (user.role !== 'super_admin') {
      tenantId = user.tenant_id;
    }

    if (tenantId) {
      requireTenantAccess(user, tenantId);
    }

    const conditions: string[] = ["d.status != 'deleted'"];
    const params: (string | number)[] = [];

    if (tenantId) {
      conditions.push('d.tenant_id = ?');
      params.push(tenantId);
    }

    if (args.category) {
      conditions.push('d.category = ?');
      params.push(args.category);
    }

    if (args.dateFrom) {
      conditions.push('d.created_at >= ?');
      params.push(args.dateFrom);
    }

    if (args.dateTo) {
      conditions.push('d.created_at <= ?');
      params.push(args.dateTo + 'T23:59:59');
    }

    const whereClause =
      conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const query = `
      SELECT
        d.title,
        d.category,
        d.tags,
        d.status,
        d.current_version,
        dv.file_name,
        dv.file_size,
        u.name as creator_name,
        d.created_at,
        d.updated_at
      FROM documents d
      LEFT JOIN users u ON d.created_by = u.id
      LEFT JOIN document_versions dv ON d.id = dv.document_id AND d.current_version = dv.version_number
      ${whereClause}
      ORDER BY d.updated_at DESC
    `;

    const results = await ctx.db
      .prepare(query)
      .bind(...params)
      .all<{
        title: string;
        category: string | null;
        tags: string;
        status: string;
        current_version: number;
        file_name: string | null;
        file_size: number | null;
        creator_name: string | null;
        created_at: string;
        updated_at: string;
      }>();

    const rows = results.results || [];

    await logAudit(
      ctx.db,
      user.id,
      tenantId || user.tenant_id,
      'report.generate',
      'report',
      null,
      JSON.stringify({
        format: 'json',
        category: args.category || null,
        count: rows.length,
      }),
      getClientIp(ctx.request)
    );

    const data = rows.map((r) => ({
      title: r.title,
      category: r.category || null,
      tags: r.tags,
      status: r.status,
      currentVersion: r.current_version,
      fileName: r.file_name || null,
      fileSizeKB: r.file_size ? Math.round(r.file_size / 1024) : 0,
      uploadedBy: r.creator_name || null,
      createdDate: r.created_at,
      lastUpdated: r.updated_at,
    }));

    return { data, total: data.length };
  },
};
