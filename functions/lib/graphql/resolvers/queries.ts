import type { GraphQLContext } from '../context';
import { roleToGql, statusToGql, statusToDB } from '../roles';
import type { User as DBUser, Tenant, Document, AuditEntry } from '../../types';
import {
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  requireTenantAccess,
} from '../../permissions';

function requireAuth(ctx: GraphQLContext): DBUser {
  if (!ctx.user) {
    throw new UnauthorizedError('Authentication required');
  }
  return ctx.user;
}

/** Map a DB user row to GraphQL User shape. */
function mapUser(row: Record<string, unknown>) {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: roleToGql(row.role as string),
    tenantId: row.tenant_id ?? null,
    tenant_id: row.tenant_id ?? null, // keep raw for nested resolver
    active: Boolean(row.active),
    lastLoginAt: row.last_login_at ?? null,
    createdAt: row.created_at,
  };
}

/** Map a DB document row to GraphQL Document shape. */
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
    tenant_id: row.tenant_id, // for nested resolver
    created_by: row.created_by, // for nested resolver
    externalRef: row.external_ref ?? null,
    sourceMetadata: row.source_metadata ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapAuditEntry(row: Record<string, unknown>) {
  return {
    id: row.id,
    user_id: row.user_id ?? null, // for nested resolver
    action: row.action,
    resourceType: row.resource_type ?? null,
    resourceId: row.resource_id ?? null,
    details: row.details ?? null,
    ipAddress: row.ip_address ?? null,
    createdAt: row.created_at,
  };
}

export const queryResolvers = {
  me: async (_parent: unknown, _args: unknown, ctx: GraphQLContext) => {
    const user = requireAuth(ctx);
    const row = await ctx.db
      .prepare(
        'SELECT id, email, name, role, tenant_id, active, last_login_at, created_at FROM users WHERE id = ?'
      )
      .bind(user.id)
      .first();

    if (!row) throw new NotFoundError('User not found');
    return mapUser(row as Record<string, unknown>);
  },

  tenants: async (_parent: unknown, _args: unknown, ctx: GraphQLContext) => {
    const user = requireAuth(ctx);

    let query: string;
    const bindings: string[] = [];

    if (user.role === 'super_admin') {
      query = 'SELECT * FROM tenants ORDER BY name ASC';
    } else {
      if (!user.tenant_id) return [];
      query = 'SELECT * FROM tenants WHERE id = ? ORDER BY name ASC';
      bindings.push(user.tenant_id);
    }

    const result = await ctx.db.prepare(query).bind(...bindings).all();
    return (result.results || []).map((row) => {
      const r = row as Record<string, unknown>;
      return {
        id: r.id,
        name: r.name,
        slug: r.slug,
        description: r.description ?? null,
        active: Boolean(r.active),
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      };
    });
  },

  tenant: async (
    _parent: unknown,
    args: { id: string },
    ctx: GraphQLContext
  ) => {
    const user = requireAuth(ctx);

    if (user.role !== 'super_admin') {
      requireTenantAccess(user, args.id);
    }

    const row = await ctx.db
      .prepare('SELECT * FROM tenants WHERE id = ?')
      .bind(args.id)
      .first();

    if (!row) return null;
    const r = row as Record<string, unknown>;
    return {
      id: r.id,
      name: r.name,
      slug: r.slug,
      description: r.description ?? null,
      active: Boolean(r.active),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  },

  users: async (
    _parent: unknown,
    args: { tenantId?: string },
    ctx: GraphQLContext
  ) => {
    const user = requireAuth(ctx);

    if (user.role !== 'super_admin' && user.role !== 'org_admin') {
      throw new ForbiddenError('Insufficient permissions');
    }

    let query: string;
    const bindings: string[] = [];

    if (user.role === 'super_admin') {
      if (args.tenantId) {
        query =
          'SELECT id, email, name, role, tenant_id, active, last_login_at, created_at FROM users WHERE tenant_id = ? ORDER BY name ASC';
        bindings.push(args.tenantId);
      } else {
        query =
          'SELECT id, email, name, role, tenant_id, active, last_login_at, created_at FROM users ORDER BY name ASC';
      }
    } else {
      if (!user.tenant_id) return [];
      query =
        'SELECT id, email, name, role, tenant_id, active, last_login_at, created_at FROM users WHERE tenant_id = ? ORDER BY name ASC';
      bindings.push(user.tenant_id);
    }

    const result = await ctx.db.prepare(query).bind(...bindings).all();
    return (result.results || []).map((row) =>
      mapUser(row as Record<string, unknown>)
    );
  },

  user: async (
    _parent: unknown,
    args: { id: string },
    ctx: GraphQLContext
  ) => {
    const user = requireAuth(ctx);

    const row = await ctx.db
      .prepare(
        'SELECT id, email, name, role, tenant_id, active, last_login_at, created_at FROM users WHERE id = ?'
      )
      .bind(args.id)
      .first();

    if (!row) return null;

    const target = row as Record<string, unknown>;

    // Access control
    if (user.role === 'super_admin') {
      // can see any user
    } else if (user.role === 'org_admin') {
      if (target.tenant_id !== user.tenant_id) {
        throw new ForbiddenError('Cannot view users outside your tenant');
      }
    } else {
      if (args.id !== user.id) {
        throw new ForbiddenError('You can only view your own profile');
      }
    }

    return mapUser(target);
  },

  documents: async (
    _parent: unknown,
    args: {
      tenantId?: string;
      category?: string;
      status?: string;
      limit?: number;
      offset?: number;
    },
    ctx: GraphQLContext
  ) => {
    const user = requireAuth(ctx);

    const status = args.status ? statusToDB(args.status) : 'active';
    const limit = Math.min(args.limit || 50, 200);
    const offset = args.offset || 0;

    let tenantId = args.tenantId || null;
    if (user.role !== 'super_admin') {
      tenantId = user.tenant_id;
    }

    const conditions: string[] = ['d.status = ?'];
    const params: (string | number)[] = [status];

    if (tenantId) {
      conditions.push('d.tenant_id = ?');
      params.push(tenantId);
    }
    if (args.category) {
      conditions.push('d.category = ?');
      params.push(args.category);
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;

    const query = `
      SELECT d.* FROM documents d
      ${whereClause}
      ORDER BY d.updated_at DESC
      LIMIT ? OFFSET ?
    `;

    const results = await ctx.db
      .prepare(query)
      .bind(...params, limit, offset)
      .all();

    return (results.results || []).map((row) =>
      mapDocument(row as Record<string, unknown>)
    );
  },

  document: async (
    _parent: unknown,
    args: { id: string },
    ctx: GraphQLContext
  ) => {
    const user = requireAuth(ctx);

    const row = await ctx.db
      .prepare(
        "SELECT * FROM documents WHERE id = ? AND status != 'deleted'"
      )
      .bind(args.id)
      .first();

    if (!row) return null;

    const doc = row as Record<string, unknown>;
    requireTenantAccess(user, doc.tenant_id as string);

    return mapDocument(doc);
  },

  lookupDocument: async (
    _parent: unknown,
    args: { externalRef: string; tenantId: string },
    ctx: GraphQLContext
  ) => {
    const user = requireAuth(ctx);
    requireTenantAccess(user, args.tenantId);

    const row = await ctx.db
      .prepare(
        "SELECT * FROM documents WHERE external_ref = ? AND tenant_id = ? AND status != 'deleted'"
      )
      .bind(args.externalRef, args.tenantId)
      .first();

    if (!row) return null;
    return mapDocument(row as Record<string, unknown>);
  },

  searchDocuments: async (
    _parent: unknown,
    args: {
      query: string;
      tenantId?: string;
      category?: string;
      limit?: number;
      offset?: number;
    },
    ctx: GraphQLContext
  ) => {
    const user = requireAuth(ctx);

    const limit = Math.min(args.limit || 50, 200);
    const offset = args.offset || 0;

    let tenantId = args.tenantId || null;
    if (user.role !== 'super_admin') {
      tenantId = user.tenant_id;
    }

    const conditions: string[] = ["d.status = 'active'"];
    const params: (string | number)[] = [];

    if (args.query) {
      conditions.push(
        '(d.title LIKE ? OR d.description LIKE ? OR d.tags LIKE ?)'
      );
      const searchTerm = `%${args.query}%`;
      params.push(searchTerm, searchTerm, searchTerm);
    }

    if (tenantId) {
      conditions.push('d.tenant_id = ?');
      params.push(tenantId);
    }

    if (args.category) {
      conditions.push('d.category = ?');
      params.push(args.category);
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;

    const countResult = await ctx.db
      .prepare(`SELECT COUNT(*) as total FROM documents d ${whereClause}`)
      .bind(...params)
      .first<{ total: number }>();

    const results = await ctx.db
      .prepare(
        `SELECT d.* FROM documents d
         ${whereClause}
         ORDER BY d.updated_at DESC
         LIMIT ? OFFSET ?`
      )
      .bind(...params, limit, offset)
      .all();

    return {
      documents: (results.results || []).map((row) =>
        mapDocument(row as Record<string, unknown>)
      ),
      total: countResult?.total || 0,
    };
  },

  auditLog: async (
    _parent: unknown,
    args: {
      tenantId?: string;
      action?: string;
      userId?: string;
      resourceType?: string;
      dateFrom?: string;
      dateTo?: string;
      limit?: number;
      offset?: number;
    },
    ctx: GraphQLContext
  ) => {
    const user = requireAuth(ctx);

    if (user.role !== 'super_admin' && user.role !== 'org_admin') {
      throw new ForbiddenError('Insufficient permissions');
    }

    const limit = Math.min(args.limit || 50, 200);
    const offset = args.offset || 0;

    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (user.role === 'org_admin') {
      conditions.push('a.tenant_id = ?');
      params.push(user.tenant_id!);
    } else if (args.tenantId) {
      conditions.push('a.tenant_id = ?');
      params.push(args.tenantId);
    }

    if (args.action) {
      conditions.push('a.action = ?');
      params.push(args.action);
    }

    if (args.userId) {
      conditions.push('a.user_id = ?');
      params.push(args.userId);
    }

    if (args.resourceType) {
      conditions.push('a.resource_type = ?');
      params.push(args.resourceType);
    }

    if (args.dateFrom) {
      conditions.push('a.created_at >= ?');
      params.push(args.dateFrom);
    }

    if (args.dateTo) {
      conditions.push('a.created_at <= ?');
      params.push(args.dateTo + 'T23:59:59');
    }

    const whereClause =
      conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countResult = await ctx.db
      .prepare(`SELECT COUNT(*) as total FROM audit_log a ${whereClause}`)
      .bind(...params)
      .first<{ total: number }>();

    const results = await ctx.db
      .prepare(
        `SELECT a.* FROM audit_log a
         ${whereClause}
         ORDER BY a.created_at DESC
         LIMIT ? OFFSET ?`
      )
      .bind(...params, limit, offset)
      .all();

    return {
      entries: (results.results || []).map((row) =>
        mapAuditEntry(row as Record<string, unknown>)
      ),
      total: countResult?.total || 0,
    };
  },
};
