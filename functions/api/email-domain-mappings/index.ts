import { generateId, logAudit, getClientIp } from '../../lib/db';
import {
  requireRole,
  requireTenantAccess,
  BadRequestError,
  errorToResponse,
} from '../../lib/permissions';
import { sanitizeString } from '../../lib/validation';
import type { Env, User } from '../../lib/types';

/**
 * GET /api/email-domain-mappings
 * List mappings. org_admin sees own tenant's mappings, super_admin sees all or filters by ?tenant_id=.
 */
export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireRole(user, 'super_admin', 'org_admin');

    const url = new URL(context.request.url);
    const tenantIdFilter = url.searchParams.get('tenant_id');

    let query: string;
    let bindings: string[];

    if (user.role === 'super_admin' && !tenantIdFilter) {
      // Super admin sees all
      query = `SELECT edm.*, t.name as tenant_name, u.name as default_user_name
               FROM email_domain_mappings edm
               LEFT JOIN tenants t ON edm.tenant_id = t.id
               LEFT JOIN users u ON edm.default_user_id = u.id
               ORDER BY edm.created_at DESC`;
      bindings = [];
    } else {
      const tenantId = tenantIdFilter || user.tenant_id;
      if (!tenantId) {
        throw new BadRequestError('tenant_id is required');
      }
      requireTenantAccess(user, tenantId);

      query = `SELECT edm.*, t.name as tenant_name, u.name as default_user_name
               FROM email_domain_mappings edm
               LEFT JOIN tenants t ON edm.tenant_id = t.id
               LEFT JOIN users u ON edm.default_user_id = u.id
               WHERE edm.tenant_id = ?
               ORDER BY edm.created_at DESC`;
      bindings = [tenantId];
    }

    const stmt = bindings.length > 0
      ? context.env.DB.prepare(query).bind(...bindings)
      : context.env.DB.prepare(query);

    const { results } = await stmt.all();

    return new Response(JSON.stringify({ mappings: results }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Email domain mapping GET error:', err);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

/**
 * POST /api/email-domain-mappings
 * Create mapping. org_admin+ for own tenant.
 * Body: { domain: string, tenant_id?: string, default_user_id?: string }
 */
export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireRole(user, 'super_admin', 'org_admin');

    const body = (await context.request.json()) as {
      domain?: string;
      tenant_id?: string;
      default_user_id?: string;
    };

    if (!body.domain || typeof body.domain !== 'string') {
      throw new BadRequestError('domain is required');
    }

    const tenantId = body.tenant_id || user.tenant_id;
    if (!tenantId) {
      throw new BadRequestError('tenant_id is required');
    }

    requireTenantAccess(user, tenantId);

    // Basic domain validation
    const domain = sanitizeString(body.domain).toLowerCase();
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$/.test(domain)) {
      throw new BadRequestError('Invalid domain format');
    }

    // Validate default_user_id if provided
    if (body.default_user_id) {
      const userExists = await context.env.DB.prepare(
        'SELECT id FROM users WHERE id = ? AND tenant_id = ? AND active = 1'
      )
        .bind(body.default_user_id, tenantId)
        .first();
      if (!userExists) {
        throw new BadRequestError('default_user_id must reference an active user in the same tenant');
      }
    }

    const id = generateId();

    try {
      await context.env.DB.prepare(
        `INSERT INTO email_domain_mappings (id, domain, tenant_id, default_user_id, active)
         VALUES (?, ?, ?, ?, 1)`
      )
        .bind(id, domain, tenantId, body.default_user_id || null)
        .run();
    } catch (err: any) {
      if (err.message?.includes('UNIQUE constraint')) {
        throw new BadRequestError(`Domain "${domain}" is already mapped`);
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
      .bind(id)
      .first();

    await logAudit(
      context.env.DB,
      user.id,
      tenantId,
      'email_domain_mapping.created',
      'email_domain_mapping',
      id,
      JSON.stringify({ domain, default_user_id: body.default_user_id || null }),
      getClientIp(context.request)
    );

    return new Response(JSON.stringify({ mapping: row }), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Email domain mapping POST error:', err);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
