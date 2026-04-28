import { generateId, logAudit, getClientIp } from '../../../../../lib/db';
import {
  requireRole,
  BadRequestError,
  errorToResponse,
} from '../../../../../lib/permissions';
import { sanitizeString } from '../../../../../lib/validation';
import { loadSheetForUser } from '../../../../../lib/records/helpers';
import type { Env, User } from '../../../../../lib/types';
import type {
  CreateViewRequest,
  RecordViewType,
  ApiRecordView,
} from '../../../../../../shared/types';

const VIEW_TYPES: RecordViewType[] = ['grid', 'kanban', 'timeline', 'gallery', 'calendar'];

/**
 * GET /api/records/sheets/:sheetId/views
 * Returns all views the caller can see: shared views + their own personal
 * views. Default views first, then by created_at.
 */
export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const sheetId = context.params.sheetId as string;

    await loadSheetForUser(context.env.DB, sheetId, user);

    // Personal views are scoped to creator; shared views are visible to all
    // sheet viewers within the tenant. (Tenant scoping is enforced by the
    // sheet load above.)
    const result = await context.env.DB.prepare(
      `SELECT v.*, u.name as creator_name
       FROM records_views v
       LEFT JOIN users u ON v.created_by = u.id
       WHERE v.sheet_id = ?
         AND (v.shared = 1 OR v.created_by = ?)
       ORDER BY v.is_default DESC, v.created_at ASC`,
    )
      .bind(sheetId, user.id)
      .all<ApiRecordView>();

    return new Response(
      JSON.stringify({ views: result.results }),
      { headers: { 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('List views error:', err);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

/**
 * POST /api/records/sheets/:sheetId/views
 * Create a saved view. If is_default=true, any other default for this
 * sheet is cleared first.
 */
export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const sheetId = context.params.sheetId as string;

    requireRole(user, 'super_admin', 'org_admin', 'user');

    const sheet = await loadSheetForUser(context.env.DB, sheetId, user);

    const body = (await context.request.json()) as CreateViewRequest;

    if (!body.name || !body.name.trim()) {
      throw new BadRequestError('name is required');
    }
    if (!body.view_type || !VIEW_TYPES.includes(body.view_type)) {
      throw new BadRequestError('view_type is required and must be a valid view type');
    }

    const isDefault = body.is_default ? 1 : 0;
    if (isDefault) {
      await context.env.DB.prepare(
        "UPDATE records_views SET is_default = 0, updated_at = datetime('now') WHERE sheet_id = ?",
      )
        .bind(sheetId)
        .run();
    }

    const id = generateId();
    const config = body.config ? JSON.stringify(body.config) : null;
    const shared = body.shared === false ? 0 : 1;
    const name = sanitizeString(body.name);

    await context.env.DB.prepare(
      `INSERT INTO records_views
         (id, sheet_id, tenant_id, name, view_type, config, is_default, shared, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(id, sheetId, sheet.tenant_id, name, body.view_type, config, isDefault, shared, user.id)
      .run();

    await logAudit(
      context.env.DB,
      user.id,
      sheet.tenant_id,
      'records_view.created',
      'records_view',
      id,
      JSON.stringify({ sheet_id: sheetId, name, view_type: body.view_type }),
      getClientIp(context.request),
    );

    const view = await context.env.DB.prepare(
      'SELECT * FROM records_views WHERE id = ?',
    )
      .bind(id)
      .first();

    return new Response(JSON.stringify({ view }), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Create view error:', err);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
