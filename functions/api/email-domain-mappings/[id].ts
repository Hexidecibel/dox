import { logAudit, getClientIp } from '../../lib/db';
import {
  requireRole,
  requireTenantAccess,
  NotFoundError,
  BadRequestError,
  errorToResponse,
} from '../../lib/permissions';
import { sanitizeString } from '../../lib/validation';
import type { Env, User } from '../../lib/types';

/**
 * PUT /api/email-domain-mappings/:id
 * Update mapping. org_admin+.
 * Fields: domain, default_user_id, active.
 */
export const onRequestPut: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireRole(user, 'super_admin', 'org_admin');

    const mappingId = context.params.id as string;

    // Fetch existing mapping
    const existing = await context.env.DB.prepare(
      'SELECT * FROM email_domain_mappings WHERE id = ?'
    )
      .bind(mappingId)
      .first<{ id: string; domain: string; tenant_id: string; default_user_id: string | null; active: number }>();

    if (!existing) {
      throw new NotFoundError('Email domain mapping not found');
    }

    requireTenantAccess(user, existing.tenant_id);

    const body = (await context.request.json()) as {
      domain?: string;
      default_user_id?: string | null;
      active?: number;
    };

    const updates: string[] = [];
    const bindings: (string | number | null)[] = [];

    if (body.domain !== undefined) {
      const domain = sanitizeString(body.domain).toLowerCase();
      if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$/.test(domain)) {
        throw new BadRequestError('Invalid domain format');
      }
      updates.push('domain = ?');
      bindings.push(domain);
    }

    if (body.default_user_id !== undefined) {
      if (body.default_user_id) {
        const userExists = await context.env.DB.prepare(
          'SELECT id FROM users WHERE id = ? AND tenant_id = ? AND active = 1'
        )
          .bind(body.default_user_id, existing.tenant_id)
          .first();
        if (!userExists) {
          throw new BadRequestError('default_user_id must reference an active user in the same tenant');
        }
      }
      updates.push('default_user_id = ?');
      bindings.push(body.default_user_id || null);
    }

    if (body.active !== undefined) {
      updates.push('active = ?');
      bindings.push(body.active ? 1 : 0);
    }

    if (updates.length === 0) {
      throw new BadRequestError('No fields to update');
    }

    bindings.push(mappingId);

    try {
      await context.env.DB.prepare(
        `UPDATE email_domain_mappings SET ${updates.join(', ')} WHERE id = ?`
      )
        .bind(...bindings)
        .run();
    } catch (err: any) {
      if (err.message?.includes('UNIQUE constraint')) {
        throw new BadRequestError('Domain is already mapped to another tenant');
      }
      throw err;
    }

    const row = await context.env.DB.prepare(
      `SELECT edm.*, t.name as tenant_name, u.name as default_user_name
       FROM email_domain_mappings edm
       LEFT JOIN tenants t ON edm.tenant_id = t.id
       LEFT JOIN users u ON edm.default_user_id = u.id
       WHERE edm.id = ?`
    )
      .bind(mappingId)
      .first();

    await logAudit(
      context.env.DB,
      user.id,
      existing.tenant_id,
      'email_domain_mapping.updated',
      'email_domain_mapping',
      mappingId,
      JSON.stringify(body),
      getClientIp(context.request)
    );

    return new Response(JSON.stringify(row), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Email domain mapping PUT error:', err);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

/**
 * DELETE /api/email-domain-mappings/:id
 * Hard delete. org_admin+.
 */
export const onRequestDelete: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireRole(user, 'super_admin', 'org_admin');

    const mappingId = context.params.id as string;

    const existing = await context.env.DB.prepare(
      'SELECT * FROM email_domain_mappings WHERE id = ?'
    )
      .bind(mappingId)
      .first<{ id: string; domain: string; tenant_id: string }>();

    if (!existing) {
      throw new NotFoundError('Email domain mapping not found');
    }

    requireTenantAccess(user, existing.tenant_id);

    await context.env.DB.prepare(
      'DELETE FROM email_domain_mappings WHERE id = ?'
    )
      .bind(mappingId)
      .run();

    await logAudit(
      context.env.DB,
      user.id,
      existing.tenant_id,
      'email_domain_mapping.deleted',
      'email_domain_mapping',
      mappingId,
      JSON.stringify({ domain: existing.domain }),
      getClientIp(context.request)
    );

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Email domain mapping DELETE error:', err);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
