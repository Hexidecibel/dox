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
 * GET /api/naming-templates
 * Get the current tenant's naming template.
 * org_admin+ for own tenant, super_admin can specify ?tenant_id=
 */
export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireRole(user, 'super_admin', 'org_admin');

    const url = new URL(context.request.url);
    let tenantId = url.searchParams.get('tenant_id') || user.tenant_id;

    if (!tenantId) {
      throw new BadRequestError('tenant_id is required');
    }

    requireTenantAccess(user, tenantId);

    const template = await context.env.DB.prepare(
      'SELECT * FROM naming_templates WHERE tenant_id = ? AND active = 1'
    )
      .bind(tenantId)
      .first();

    if (!template) {
      return new Response(
        JSON.stringify({
          id: null,
          tenant_id: tenantId,
          template: '{title}.{ext}',
          active: 1,
          created_at: null,
          updated_at: null,
          is_default: true,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    return new Response(JSON.stringify({ ...template, is_default: false }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Naming template GET error:', err);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

/**
 * PUT /api/naming-templates
 * Create or update the tenant's naming template.
 * org_admin+. Body: { template: string, tenant_id?: string }
 */
export const onRequestPut: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireRole(user, 'super_admin', 'org_admin');

    const body = (await context.request.json()) as {
      template?: string;
      tenant_id?: string;
    };

    if (!body.template || typeof body.template !== 'string') {
      throw new BadRequestError('template is required and must be a string');
    }

    const tenantId = body.tenant_id || user.tenant_id;
    if (!tenantId) {
      throw new BadRequestError('tenant_id is required');
    }

    requireTenantAccess(user, tenantId);

    const sanitizedTemplate = sanitizeString(body.template);

    // Validate template has at least one placeholder or literal text
    if (sanitizedTemplate.length === 0) {
      throw new BadRequestError('template cannot be empty');
    }
    if (sanitizedTemplate.length > 500) {
      throw new BadRequestError('template must be 500 characters or less');
    }

    const id = generateId();
    await context.env.DB.prepare(
      `INSERT INTO naming_templates (id, tenant_id, template, active)
       VALUES (?, ?, ?, 1)
       ON CONFLICT(tenant_id) DO UPDATE SET
         template = excluded.template,
         updated_at = datetime('now')`
    )
      .bind(id, tenantId, sanitizedTemplate)
      .run();

    // Fetch the updated row
    const row = await context.env.DB.prepare(
      'SELECT * FROM naming_templates WHERE tenant_id = ?'
    )
      .bind(tenantId)
      .first();

    await logAudit(
      context.env.DB,
      user.id,
      tenantId,
      'naming_template.updated',
      'naming_template',
      row?.id as string || id,
      JSON.stringify({ template: sanitizedTemplate }),
      getClientIp(context.request)
    );

    return new Response(JSON.stringify(row), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Naming template PUT error:', err);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
