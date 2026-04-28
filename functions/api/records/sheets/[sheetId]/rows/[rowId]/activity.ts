/**
 * GET /api/records/sheets/:sheetId/rows/:rowId/activity
 *
 * Paginated activity feed for a single row. Used by the row drawer's
 * Activity sub-section. Newest-first to match how the UI renders the
 * timeline.
 *
 * Activity is a UX feed (records_activity), separate from the
 * compliance audit_log written by logAudit. This endpoint reads from
 * records_activity only.
 */

import { errorToResponse, NotFoundError } from '../../../../../../lib/permissions';
import { loadSheetForUser } from '../../../../../../lib/records/helpers';
import type { Env, User } from '../../../../../../lib/types';
import type { ApiRecordActivity } from '../../../../../../../shared/types';

export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const sheetId = context.params.sheetId as string;
    const rowId = context.params.rowId as string;
    const url = new URL(context.request.url);

    await loadSheetForUser(context.env.DB, sheetId, user);

    // Confirm the row belongs to the sheet so we don't expose activity
    // from a different sheet's row via path manipulation.
    const row = await context.env.DB.prepare(
      'SELECT id FROM records_rows WHERE id = ? AND sheet_id = ?',
    )
      .bind(rowId, sheetId)
      .first<{ id: string }>();
    if (!row) {
      throw new NotFoundError('Row not found');
    }

    const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200);
    const offset = parseInt(url.searchParams.get('offset') || '0', 10);

    const countRow = await context.env.DB.prepare(
      'SELECT COUNT(*) as total FROM records_activity WHERE row_id = ?',
    )
      .bind(rowId)
      .first<{ total: number }>();

    const activity = await context.env.DB.prepare(
      `SELECT a.*, u.name as actor_name
       FROM records_activity a
       LEFT JOIN users u ON a.actor_id = u.id
       WHERE a.row_id = ?
       ORDER BY a.created_at DESC, a.id DESC
       LIMIT ? OFFSET ?`,
    )
      .bind(rowId, limit, offset)
      .all<ApiRecordActivity>();

    return new Response(
      JSON.stringify({
        activity: activity.results,
        total: countRow?.total ?? 0,
        limit,
        offset,
      }),
      { headers: { 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('List row activity error:', err);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
