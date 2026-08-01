/**
 * /api/requirements — layer-2 vocabulary CRUD (migration 0080).
 *
 * A requirement is one checklist LINE ITEM ("Allergen Matrix", "100g
 * Nutritionals", "Bank reconciliations on file"). Documents CLOSE them; claims
 * OPEN them. Per-tenant rows, so a new vertical is configuration.
 *
 * Shape and permissions deliberately mirror /api/document-types: same role
 * gate (super_admin | org_admin), same tenant scoping, same soft-delete.
 */

import { generateId, logAudit, getClientIp } from '../../lib/db';
import { requireRole, errorToResponse } from '../../lib/permissions';
import { sanitizeString } from '../../lib/validation';
import { slugifyVocab, resolveWriteTenant } from '../../lib/registry-vocab';
import type { Env, User } from '../../lib/types';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * GET /api/requirements
 * List the tenant's checklist line items. Non-super_admins are pinned to their
 * own tenant; super_admin may pass ?tenant_id=. ?active=0|1 (default: active
 * only), ?checklist= narrows to one checklist grouping.
 *
 * Each row carries `document_count` (confirmed documents closing it) and
 * `claim_type_count` (claims that open it) so the admin UI can show what a row
 * is actually doing before someone deactivates it.
 */
export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const url = new URL(context.request.url);
    const activeFilter = url.searchParams.get('active');
    const tenantIdParam = url.searchParams.get('tenant_id');
    const checklistParam = url.searchParams.get('checklist');
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '200', 10), 500);
    const offset = parseInt(url.searchParams.get('offset') || '0', 10);

    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (user.role === 'super_admin') {
      if (tenantIdParam) {
        conditions.push('r.tenant_id = ?');
        params.push(tenantIdParam);
      }
    } else {
      conditions.push('r.tenant_id = ?');
      params.push(user.tenant_id!);
    }

    if (activeFilter !== null) {
      conditions.push('r.active = ?');
      params.push(Number(activeFilter));
    } else {
      conditions.push('r.active = 1');
    }

    if (checklistParam) {
      conditions.push('r.checklist = ?');
      params.push(checklistParam);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countResult = await context.env.DB.prepare(
      `SELECT COUNT(*) as total FROM requirements r ${whereClause}`,
    )
      .bind(...params)
      .first<{ total: number }>();

    const results = await context.env.DB.prepare(
      `SELECT r.*, t.name AS tenant_name,
              (SELECT COUNT(*) FROM document_requirements dr
                WHERE dr.requirement_id = r.id AND dr.status = 'confirmed') AS document_count,
              (SELECT COUNT(*) FROM claim_type_requirements ctr
                WHERE ctr.requirement_id = r.id) AS claim_type_count
         FROM requirements r
         LEFT JOIN tenants t ON t.id = r.tenant_id
         ${whereClause}
        ORDER BY r.checklist, r.sort_order, r.name
        LIMIT ? OFFSET ?`,
    )
      .bind(...params, limit, offset)
      .all();

    return json({
      requirements: results.results,
      total: countResult?.total || 0,
      limit,
      offset,
    });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('List requirements error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
};

/**
 * POST /api/requirements
 * Create a checklist line item. org_admin+ for their own tenant; super_admin
 * must pass tenant_id. `slug` may be supplied explicitly (importers and
 * starter packs need stable slugs); otherwise it is derived from the name.
 */
export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireRole(user, 'super_admin', 'org_admin');

    const body = (await context.request.json()) as {
      name?: string;
      slug?: string;
      description?: string;
      checklist?: string;
      sort_order?: number;
      tenant_id?: string;
    };

    if (!body.name || !body.name.trim()) {
      return json({ error: 'name is required' }, 400);
    }

    const tenantId = resolveWriteTenant(user, body.tenant_id);

    const name = sanitizeString(body.name);
    const description = body.description ? sanitizeString(body.description) : null;
    const checklist = body.checklist ? sanitizeString(body.checklist) : null;
    const slug = slugifyVocab(body.slug || name);

    if (!slug) {
      return json({ error: 'Could not generate a valid slug from name' }, 400);
    }

    const existing = await context.env.DB.prepare(
      'SELECT id FROM requirements WHERE slug = ? AND tenant_id = ?',
    )
      .bind(slug, tenantId)
      .first();

    if (existing) {
      return json({ error: 'A requirement with this slug already exists for this tenant' }, 409);
    }

    const id = generateId();
    const sortOrder = Number.isFinite(Number(body.sort_order)) ? Number(body.sort_order) : 0;

    await context.env.DB.prepare(
      `INSERT INTO requirements (id, tenant_id, slug, name, description, checklist, sort_order, active)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
    )
      .bind(id, tenantId, slug, name, description, checklist, sortOrder)
      .run();

    await logAudit(
      context.env.DB,
      user.id,
      tenantId,
      'requirement_created',
      'requirement',
      id,
      JSON.stringify({ name, slug, checklist }),
      getClientIp(context.request),
    );

    const requirement = await context.env.DB.prepare('SELECT * FROM requirements WHERE id = ?')
      .bind(id)
      .first();

    return json({ requirement }, 201);
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Create requirement error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
};
