import { logAudit, getClientIp } from '../../../../../lib/db';
import {
  requireRole,
  ForbiddenError,
  NotFoundError,
  BadRequestError,
  errorToResponse,
} from '../../../../../lib/permissions';
import { sanitizeString } from '../../../../../lib/validation';
import { loadSheetForUser } from '../../../../../lib/records/helpers';
import type { Env, User } from '../../../../../lib/types';
import type {
  UpdateViewRequest,
  RecordViewType,
} from '../../../../../../shared/types';

const VIEW_TYPES: RecordViewType[] = ['grid', 'kanban', 'timeline', 'gallery', 'calendar'];

interface ViewRow {
  id: string;
  sheet_id: string;
  tenant_id: string;
  name: string;
  view_type: RecordViewType;
  config: string | null;
  is_default: number;
  shared: number;
  created_by: string | null;
}

async function loadViewInSheet(
  db: D1Database,
  sheetId: string,
  viewId: string,
  user: User,
): Promise<ViewRow> {
  const view = await db
    .prepare('SELECT * FROM records_views WHERE id = ? AND sheet_id = ?')
    .bind(viewId, sheetId)
    .first<ViewRow>();
  if (!view) {
    throw new NotFoundError('View not found');
  }
  // Personal view: only the creator can see/edit. Treat as 404 to avoid
  // leaking existence.
  if (view.shared === 0 && view.created_by !== user.id && user.role !== 'super_admin') {
    throw new NotFoundError('View not found');
  }
  return view;
}

/**
 * GET /api/records/sheets/:sheetId/views/:viewId
 */
export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const sheetId = context.params.sheetId as string;
    const viewId = context.params.viewId as string;

    await loadSheetForUser(context.env.DB, sheetId, user);
    const view = await loadViewInSheet(context.env.DB, sheetId, viewId, user);

    return new Response(JSON.stringify({ view }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Get view error:', err);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

/**
 * PUT /api/records/sheets/:sheetId/views/:viewId
 * Update a view. Personal views can only be edited by their creator;
 * shared views can be edited by any non-reader in the tenant.
 */
export const onRequestPut: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const sheetId = context.params.sheetId as string;
    const viewId = context.params.viewId as string;

    requireRole(user, 'super_admin', 'org_admin', 'user');

    const sheet = await loadSheetForUser(context.env.DB, sheetId, user);
    const view = await loadViewInSheet(context.env.DB, sheetId, viewId, user);

    // Personal views: only creator (or super_admin) may modify.
    if (view.shared === 0 && view.created_by !== user.id && user.role !== 'super_admin') {
      throw new ForbiddenError('Cannot edit another user\'s personal view');
    }

    const body = (await context.request.json()) as UpdateViewRequest;

    const updates: string[] = [];
    const params: (string | number | null)[] = [];

    if (body.name !== undefined) {
      const name = sanitizeString(body.name);
      if (!name) throw new BadRequestError('name cannot be empty');
      updates.push('name = ?');
      params.push(name);
    }

    if (body.view_type !== undefined) {
      if (!VIEW_TYPES.includes(body.view_type)) {
        throw new BadRequestError('Invalid view_type');
      }
      updates.push('view_type = ?');
      params.push(body.view_type);
    }

    if (body.config !== undefined) {
      updates.push('config = ?');
      params.push(body.config ? JSON.stringify(body.config) : null);
    }

    if (body.is_default !== undefined) {
      const next = body.is_default ? 1 : 0;
      if (next === 1 && view.is_default === 0) {
        await context.env.DB.prepare(
          "UPDATE records_views SET is_default = 0, updated_at = datetime('now') WHERE sheet_id = ?",
        )
          .bind(sheetId)
          .run();
      }
      updates.push('is_default = ?');
      params.push(next);
    }

    if (body.shared !== undefined) {
      updates.push('shared = ?');
      params.push(body.shared ? 1 : 0);
    }

    if (updates.length === 0) {
      throw new BadRequestError('No fields to update');
    }

    updates.push("updated_at = datetime('now')");
    params.push(viewId);

    await context.env.DB.prepare(
      `UPDATE records_views SET ${updates.join(', ')} WHERE id = ?`,
    )
      .bind(...params)
      .run();

    await logAudit(
      context.env.DB,
      user.id,
      sheet.tenant_id,
      'records_view.updated',
      'records_view',
      viewId,
      JSON.stringify({ sheet_id: sheetId, changes: body }),
      getClientIp(context.request),
    );

    const updated = await context.env.DB.prepare(
      'SELECT * FROM records_views WHERE id = ?',
    )
      .bind(viewId)
      .first();

    return new Response(JSON.stringify({ view: updated }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Update view error:', err);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

/**
 * DELETE /api/records/sheets/:sheetId/views/:viewId
 * Hard-delete (per spec: views are cheap to recreate). Same modifier
 * rules as PUT.
 */
export const onRequestDelete: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const sheetId = context.params.sheetId as string;
    const viewId = context.params.viewId as string;

    requireRole(user, 'super_admin', 'org_admin', 'user');

    const sheet = await loadSheetForUser(context.env.DB, sheetId, user);
    const view = await loadViewInSheet(context.env.DB, sheetId, viewId, user);

    if (view.shared === 0 && view.created_by !== user.id && user.role !== 'super_admin') {
      throw new ForbiddenError('Cannot delete another user\'s personal view');
    }

    await context.env.DB.prepare('DELETE FROM records_views WHERE id = ?')
      .bind(viewId)
      .run();

    await logAudit(
      context.env.DB,
      user.id,
      sheet.tenant_id,
      'records_view.deleted',
      'records_view',
      viewId,
      JSON.stringify({ sheet_id: sheetId, name: view.name }),
      getClientIp(context.request),
    );

    return new Response(JSON.stringify({ success: true }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Delete view error:', err);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
