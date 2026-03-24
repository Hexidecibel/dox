import type { GraphQLContext } from '../context';
import { roleToGql, statusToGql } from '../roles';

/**
 * Field resolvers for nested types.
 * These resolve fields that require additional DB lookups (relationships).
 */

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

export const typeResolvers = {
  Tenant: {
    documents: async (
      parent: { id: string },
      _args: unknown,
      ctx: GraphQLContext
    ) => {
      const results = await ctx.db
        .prepare(
          "SELECT * FROM documents WHERE tenant_id = ? AND status != 'deleted' ORDER BY updated_at DESC"
        )
        .bind(parent.id)
        .all();

      return (results.results || []).map((row) =>
        mapDocument(row as Record<string, unknown>)
      );
    },

    users: async (
      parent: { id: string },
      _args: unknown,
      ctx: GraphQLContext
    ) => {
      const results = await ctx.db
        .prepare(
          'SELECT id, email, name, role, tenant_id, active, last_login_at, created_at FROM users WHERE tenant_id = ? ORDER BY name ASC'
        )
        .bind(parent.id)
        .all();

      return (results.results || []).map((row) =>
        mapUser(row as Record<string, unknown>)
      );
    },
  },

  User: {
    tenant: async (
      parent: { tenant_id?: string | null; tenantId?: string | null },
      _args: unknown,
      ctx: GraphQLContext
    ) => {
      const tenantId = parent.tenant_id || parent.tenantId;
      if (!tenantId) return null;

      const row = await ctx.db
        .prepare('SELECT * FROM tenants WHERE id = ?')
        .bind(tenantId)
        .first();

      if (!row) return null;
      return mapTenant(row as Record<string, unknown>);
    },
  },

  Document: {
    tenant: async (
      parent: { tenant_id?: string; tenantId?: string },
      _args: unknown,
      ctx: GraphQLContext
    ) => {
      const tenantId = parent.tenant_id || parent.tenantId;
      if (!tenantId) return null;

      const row = await ctx.db
        .prepare('SELECT * FROM tenants WHERE id = ?')
        .bind(tenantId)
        .first();

      if (!row) return null;
      return mapTenant(row as Record<string, unknown>);
    },

    createdBy: async (
      parent: { created_by: string },
      _args: unknown,
      ctx: GraphQLContext
    ) => {
      const row = await ctx.db
        .prepare(
          'SELECT id, email, name, role, tenant_id, active, last_login_at, created_at FROM users WHERE id = ?'
        )
        .bind(parent.created_by)
        .first();

      if (!row) {
        // Return a placeholder if user was deleted
        return {
          id: parent.created_by,
          email: 'unknown',
          name: 'Unknown User',
          role: 'READER',
          tenantId: null,
          tenant_id: null,
          active: false,
          lastLoginAt: null,
          createdAt: null,
        };
      }
      return mapUser(row as Record<string, unknown>);
    },

    versions: async (
      parent: { id: string },
      _args: unknown,
      ctx: GraphQLContext
    ) => {
      const results = await ctx.db
        .prepare(
          'SELECT * FROM document_versions WHERE document_id = ? ORDER BY version_number DESC'
        )
        .bind(parent.id)
        .all();

      return (results.results || []).map((row) => {
        const r = row as Record<string, unknown>;
        return {
          id: r.id,
          versionNumber: r.version_number,
          fileName: r.file_name,
          fileSize: r.file_size,
          mimeType: r.mime_type,
          checksum: r.checksum ?? null,
          changeNotes: r.change_notes ?? null,
          uploaded_by: r.uploaded_by, // for nested resolver
          createdAt: r.created_at,
        };
      });
    },
  },

  DocumentVersion: {
    uploadedBy: async (
      parent: { uploaded_by: string },
      _args: unknown,
      ctx: GraphQLContext
    ) => {
      const row = await ctx.db
        .prepare(
          'SELECT id, email, name, role, tenant_id, active, last_login_at, created_at FROM users WHERE id = ?'
        )
        .bind(parent.uploaded_by)
        .first();

      if (!row) {
        return {
          id: parent.uploaded_by,
          email: 'unknown',
          name: 'Unknown User',
          role: 'READER',
          tenantId: null,
          tenant_id: null,
          active: false,
          lastLoginAt: null,
          createdAt: null,
        };
      }
      return mapUser(row as Record<string, unknown>);
    },
  },

  AuditEntry: {
    user: async (
      parent: { user_id?: string | null },
      _args: unknown,
      ctx: GraphQLContext
    ) => {
      if (!parent.user_id) return null;

      const row = await ctx.db
        .prepare(
          'SELECT id, email, name, role, tenant_id, active, last_login_at, created_at FROM users WHERE id = ?'
        )
        .bind(parent.user_id)
        .first();

      if (!row) return null;
      return mapUser(row as Record<string, unknown>);
    },
  },
};
