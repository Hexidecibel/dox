import { generateId, logAudit, getClientIp } from '../../../lib/db';
import {
  requireRole,
  requireTenantAccess,
  BadRequestError,
  errorToResponse,
} from '../../../lib/permissions';
import { sanitizeString } from '../../../lib/validation';
import { slugifyRecords } from '../../../lib/records/helpers';
import type { Env, User } from '../../../lib/types';
import type {
  CreateSheetRequest,
  ApiRecordSheet,
} from '../../../../shared/types';

/**
 * GET /api/records/sheets
 * List Records sheets for the caller's tenant. Returns archived rows
 * only when ?archived=1.
 */
export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const url = new URL(context.request.url);

    let tenantId = url.searchParams.get('tenant_id');
    if (user.role !== 'super_admin') {
      tenantId = user.tenant_id;
    }
    if (!tenantId) {
      throw new BadRequestError('tenant_id is required');
    }
    requireTenantAccess(user, tenantId);

    const archivedParam = url.searchParams.get('archived');
    const archived = archivedParam === '1' ? 1 : 0;

    const limit = Math.min(parseInt(url.searchParams.get('limit') || '100', 10), 500);
    const offset = parseInt(url.searchParams.get('offset') || '0', 10);

    const countRow = await context.env.DB.prepare(
      'SELECT COUNT(*) as total FROM records_sheets WHERE tenant_id = ? AND archived = ?',
    )
      .bind(tenantId, archived)
      .first<{ total: number }>();

    const result = await context.env.DB.prepare(
      `SELECT s.*, u.name as creator_name,
              (SELECT COUNT(*) FROM records_columns c WHERE c.sheet_id = s.id AND c.archived = 0) as column_count,
              (SELECT COUNT(*) FROM records_rows r WHERE r.sheet_id = s.id AND r.archived = 0) as row_count
       FROM records_sheets s
       LEFT JOIN users u ON s.created_by = u.id
       WHERE s.tenant_id = ? AND s.archived = ?
       ORDER BY s.updated_at DESC
       LIMIT ? OFFSET ?`,
    )
      .bind(tenantId, archived, limit, offset)
      .all<ApiRecordSheet>();

    return new Response(
      JSON.stringify({
        sheets: result.results,
        total: countRow?.total ?? 0,
      }),
      { headers: { 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('List sheets error:', err);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

/**
 * POST /api/records/sheets
 * Create a new Records sheet. Slug is derived from name unless explicitly
 * provided; uniqueness is enforced per tenant via the schema.
 */
export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireRole(user, 'super_admin', 'org_admin', 'user');

    const body = (await context.request.json()) as CreateSheetRequest & { tenant_id?: string };

    if (!body.name || !body.name.trim()) {
      throw new BadRequestError('name is required');
    }

    let tenantId = body.tenant_id || null;
    if (user.role !== 'super_admin') {
      tenantId = user.tenant_id;
    }
    if (!tenantId) {
      throw new BadRequestError('tenant_id is required');
    }
    requireTenantAccess(user, tenantId);

    const name = sanitizeString(body.name);
    const baseSlug = body.slug ? slugifyRecords(body.slug) : slugifyRecords(name);
    if (!baseSlug) {
      throw new BadRequestError('Could not derive a valid slug from name');
    }

    // Resolve slug collision by appending -2, -3, ...
    let slug = baseSlug;
    let attempt = 1;
    while (true) {
      const collision = await context.env.DB.prepare(
        'SELECT id FROM records_sheets WHERE tenant_id = ? AND slug = ?',
      )
        .bind(tenantId, slug)
        .first();
      if (!collision) break;
      attempt += 1;
      slug = `${baseSlug}-${attempt}`;
      if (attempt > 50) {
        throw new BadRequestError('Could not allocate a unique slug; please pick a different name');
      }
    }

    const id = generateId();
    const description = body.description ? sanitizeString(body.description) : null;
    const icon = body.icon ? sanitizeString(body.icon) : null;
    const color = body.color ? sanitizeString(body.color) : null;
    const templateKey = body.template_key ? sanitizeString(body.template_key) : null;

    await context.env.DB.prepare(
      `INSERT INTO records_sheets (id, tenant_id, name, slug, description, icon, color, template_key, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(id, tenantId, name, slug, description, icon, color, templateKey, user.id)
      .run();

    await logAudit(
      context.env.DB,
      user.id,
      tenantId,
      'records_sheet.created',
      'records_sheet',
      id,
      JSON.stringify({ name, slug }),
      getClientIp(context.request),
    );

    const sheet = await context.env.DB.prepare(
      'SELECT * FROM records_sheets WHERE id = ?',
    )
      .bind(id)
      .first();

    return new Response(JSON.stringify({ sheet }), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Create sheet error:', err);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
