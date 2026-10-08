/**
 * Per-tenant editable extraction-prompt layer (the "industry layer").
 *
 * The industry layer of the extraction prompt used to be a hardcoded constant
 * shared by every tenant. This endpoint exposes it as an editable per-tenant
 * field: when `extraction_context` is NULL or empty the worker / Pages-Function
 * path falls back to GENERIC_INDUSTRY_CONTEXT, which assumes nothing about what
 * the organisation buys. (Until migration 0136 the fallback was one tenant's
 * dairy playbook; 0136 wrote that text into every tenant relying on it, and it
 * is offered here as a named template a person can load.)
 *
 * Auth: super_admin + org_admin only (tenant-level config is more sensitive
 * than the per-(supplier, doctype) combo instructions, which `user` can edit).
 * org_admin is scoped to its own tenant; super_admin may pass ?tenant_id=.
 *
 * See migration 0072_tenant_extraction_context.sql for the schema.
 */

import { logAudit, getClientIp } from '../../lib/db';
import {
  requireRole,
  requireTenantAccess,
  BadRequestError,
  errorToResponse,
} from '../../lib/permissions';
import { DAIRY_CONTEXT_TEMPLATE, EXTRACTION_CONTEXT_TEMPLATES, GENERIC_INDUSTRY_CONTEXT } from '../../lib/llm';
import type { Env, User } from '../../lib/types';

/** Hard cap on the tenant context length. It's a full prompt layer, so this is
 *  more generous than the per-combo instruction cap (8000). */
const MAX_CONTEXT_LENGTH = 16000;

/**
 * GET /api/tenant-extraction-context[?tenant_id=Z]
 * Returns the tenant's editable extraction context (null when unset → the
 * generic block is used at extraction time), what that generic block is
 * (`generic_context`), the named templates the editor can load (`templates`),
 * and edit metadata.
 *
 * `default_template` is the dairy template under the name it has always had:
 * it is what the "load template" button seeded before there was a list, and a
 * client written against the older response keeps working. It is NOT what an
 * empty context falls back to any more; `generic_context` is.
 */
export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireRole(user, 'super_admin', 'org_admin');

    const url = new URL(context.request.url);
    const tenantIdParam = url.searchParams.get('tenant_id');

    // Tenant resolution: super_admin may pass ?tenant_id= to query any tenant;
    // org_admin is scoped to its own tenant.
    let tenantId: string;
    if (user.role === 'super_admin') {
      if (!tenantIdParam) {
        throw new BadRequestError('tenant_id is required for super_admin');
      }
      tenantId = tenantIdParam;
    } else {
      tenantId = user.tenant_id!;
    }
    requireTenantAccess(user, tenantId);

    const row = await context.env.DB.prepare(
      `SELECT name, extraction_context, extraction_context_updated_at, extraction_context_updated_by
       FROM tenants WHERE id = ?`
    )
      .bind(tenantId)
      .first<{
        name: string | null;
        extraction_context: string | null;
        extraction_context_updated_at: string | null;
        extraction_context_updated_by: string | null;
      }>();

    return new Response(
      JSON.stringify({
        extraction_context: row?.extraction_context ?? null,
        // The organisation's own name. The extraction worker reads it from here
        // to fill rule 5 of the prompt ("these documents are filed by ...").
        tenant_name: row?.name ?? null,
        default_template: DAIRY_CONTEXT_TEMPLATE,
        generic_context: GENERIC_INDUSTRY_CONTEXT,
        templates: EXTRACTION_CONTEXT_TEMPLATES,
        updated_at: row?.extraction_context_updated_at ?? null,
        updated_by: row?.extraction_context_updated_by ?? null,
      }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Get tenant extraction context error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};

/**
 * PUT /api/tenant-extraction-context
 * Body: { extraction_context, tenant_id? }
 * Sets the tenant's extraction context. An empty string clears it (→ falls back
 * to the generic block at extraction time).
 */
export const onRequestPut: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireRole(user, 'super_admin', 'org_admin');

    const body = (await context.request.json()) as {
      extraction_context?: string;
      tenant_id?: string;
    };

    if (typeof body.extraction_context !== 'string') {
      throw new BadRequestError('extraction_context must be a string');
    }
    const extractionContext = body.extraction_context;
    if (extractionContext.length > MAX_CONTEXT_LENGTH) {
      throw new BadRequestError(
        `extraction_context too long (max ${MAX_CONTEXT_LENGTH} chars)`
      );
    }

    // Tenant resolution (mirrors GET).
    let tenantId: string;
    if (user.role === 'super_admin') {
      if (!body.tenant_id) {
        throw new BadRequestError('tenant_id is required for super_admin');
      }
      tenantId = body.tenant_id;
    } else {
      tenantId = user.tenant_id!;
    }
    requireTenantAccess(user, tenantId);

    await context.env.DB.prepare(
      `UPDATE tenants
       SET extraction_context = ?,
           extraction_context_updated_at = datetime('now'),
           extraction_context_updated_by = ?
       WHERE id = ?`
    )
      .bind(extractionContext, user.id, tenantId)
      .run();

    const saved = await context.env.DB.prepare(
      `SELECT extraction_context, extraction_context_updated_at, extraction_context_updated_by
       FROM tenants WHERE id = ?`
    )
      .bind(tenantId)
      .first<{
        extraction_context: string | null;
        extraction_context_updated_at: string | null;
        extraction_context_updated_by: string | null;
      }>();

    await logAudit(
      context.env.DB,
      user.id,
      tenantId,
      'tenant_extraction_context_updated',
      'tenants',
      tenantId,
      JSON.stringify({ length: extractionContext.length }),
      getClientIp(context.request)
    );

    return new Response(
      JSON.stringify({
        extraction_context: saved?.extraction_context ?? null,
        updated_at: saved?.extraction_context_updated_at ?? null,
        updated_by: saved?.extraction_context_updated_by ?? null,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Update tenant extraction context error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
