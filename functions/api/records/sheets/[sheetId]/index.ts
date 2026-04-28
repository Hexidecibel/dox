import { logAudit, getClientIp } from '../../../../lib/db';
import {
  requireRole,
  requireTenantAccess,
  NotFoundError,
  BadRequestError,
  errorToResponse,
} from '../../../../lib/permissions';
import { sanitizeString } from '../../../../lib/validation';
import { slugifyRecords } from '../../../../lib/records/helpers';
import type { Env, User } from '../../../../lib/types';
import type {
  UpdateSheetRequest,
  ApiRecordColumn,
  ApiRecordView,
} from '../../../../../shared/types';

/**
 * GET /api/records/sheets/:sheetId
 * Returns the sheet plus its columns and views (single round trip so the
 * Grid view can mount without a fan-out of follow-up requests).
 */
export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const sheetId = context.params.sheetId as string;

    const sheet = await context.env.DB.prepare(
      `SELECT s.*, u.name as creator_name
       FROM records_sheets s
       LEFT JOIN users u ON s.created_by = u.id
       WHERE s.id = ?`,
    )
      .bind(sheetId)
      .first();

    if (!sheet) {
      throw new NotFoundError('Sheet not found');
    }
    if (user.role !== 'super_admin' && sheet.tenant_id !== user.tenant_id) {
      throw new NotFoundError('Sheet not found');
    }

    const columns = await context.env.DB.prepare(
      `SELECT * FROM records_columns WHERE sheet_id = ? AND archived = 0 ORDER BY display_order ASC, created_at ASC`,
    )
      .bind(sheetId)
      .all<ApiRecordColumn>();

    const views = await context.env.DB.prepare(
      `SELECT v.*, u.name as creator_name FROM records_views v
       LEFT JOIN users u ON v.created_by = u.id
       WHERE v.sheet_id = ?
       ORDER BY v.is_default DESC, v.created_at ASC`,
    )
      .bind(sheetId)
      .all<ApiRecordView>();

    return new Response(
      JSON.stringify({
        sheet,
        columns: columns.results,
        views: views.results,
      }),
      { headers: { 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Get sheet error:', err);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

/**
 * PUT /api/records/sheets/:sheetId
 * Update sheet metadata. Slug edits are validated for tenant uniqueness.
 * Setting `archived: true` performs the same soft-archive as DELETE.
 */
export const onRequestPut: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const sheetId = context.params.sheetId as string;

    requireRole(user, 'super_admin', 'org_admin', 'user');

    const sheet = await context.env.DB.prepare(
      'SELECT * FROM records_sheets WHERE id = ?',
    )
      .bind(sheetId)
      .first<{ id: string; tenant_id: string; slug: string }>();

    if (!sheet) {
      throw new NotFoundError('Sheet not found');
    }
    requireTenantAccess(user, sheet.tenant_id);

    const body = (await context.request.json()) as UpdateSheetRequest;

    const updates: string[] = [];
    const params: (string | number | null)[] = [];

    if (body.name !== undefined) {
      const name = sanitizeString(body.name);
      if (!name) throw new BadRequestError('name cannot be empty');
      updates.push('name = ?');
      params.push(name);
    }

    if (body.slug !== undefined) {
      const newSlug = slugifyRecords(body.slug);
      if (!newSlug) throw new BadRequestError('Invalid slug');
      if (newSlug !== sheet.slug) {
        const collision = await context.env.DB.prepare(
          'SELECT id FROM records_sheets WHERE tenant_id = ? AND slug = ? AND id != ?',
        )
          .bind(sheet.tenant_id, newSlug, sheetId)
          .first();
        if (collision) {
          return new Response(
            JSON.stringify({ error: 'A sheet with this slug already exists for this tenant' }),
            { status: 409, headers: { 'Content-Type': 'application/json' } },
          );
        }
      }
      updates.push('slug = ?');
      params.push(newSlug);
    }

    if (body.description !== undefined) {
      updates.push('description = ?');
      params.push(body.description ? sanitizeString(body.description) : null);
    }
    if (body.icon !== undefined) {
      updates.push('icon = ?');
      params.push(body.icon ? sanitizeString(body.icon) : null);
    }
    if (body.color !== undefined) {
      updates.push('color = ?');
      params.push(body.color ? sanitizeString(body.color) : null);
    }
    if (body.archived !== undefined) {
      updates.push('archived = ?');
      params.push(body.archived ? 1 : 0);
    }

    if (updates.length === 0) {
      throw new BadRequestError('No fields to update');
    }

    updates.push("updated_at = datetime('now')");
    params.push(sheetId);

    await context.env.DB.prepare(
      `UPDATE records_sheets SET ${updates.join(', ')} WHERE id = ?`,
    )
      .bind(...params)
      .run();

    await logAudit(
      context.env.DB,
      user.id,
      sheet.tenant_id,
      'records_sheet.updated',
      'records_sheet',
      sheetId,
      JSON.stringify({ changes: body }),
      getClientIp(context.request),
    );

    const updated = await context.env.DB.prepare(
      'SELECT * FROM records_sheets WHERE id = ?',
    )
      .bind(sheetId)
      .first();

    return new Response(JSON.stringify({ sheet: updated }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Update sheet error:', err);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

/**
 * DELETE /api/records/sheets/:sheetId
 * Soft-archive the sheet. Rows/columns/views remain in D1 so an admin
 * can unarchive (PUT archived=false) without data loss.
 */
export const onRequestDelete: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const sheetId = context.params.sheetId as string;

    requireRole(user, 'super_admin', 'org_admin', 'user');

    const sheet = await context.env.DB.prepare(
      'SELECT id, tenant_id, name FROM records_sheets WHERE id = ?',
    )
      .bind(sheetId)
      .first<{ id: string; tenant_id: string; name: string }>();

    if (!sheet) {
      throw new NotFoundError('Sheet not found');
    }
    requireTenantAccess(user, sheet.tenant_id);

    await context.env.DB.prepare(
      "UPDATE records_sheets SET archived = 1, updated_at = datetime('now') WHERE id = ?",
    )
      .bind(sheetId)
      .run();

    await logAudit(
      context.env.DB,
      user.id,
      sheet.tenant_id,
      'records_sheet.archived',
      'records_sheet',
      sheetId,
      JSON.stringify({ name: sheet.name }),
      getClientIp(context.request),
    );

    return new Response(JSON.stringify({ success: true }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Archive sheet error:', err);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
