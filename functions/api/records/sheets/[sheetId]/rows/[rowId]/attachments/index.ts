/**
 * GET /api/records/sheets/:sheetId/rows/:rowId/attachments
 *
 * List attachments linked to a row. Used by the admin row drawer to
 * render the Attachments section. Tenant-scoped via loadSheetForUser.
 *
 * Pending (unsubmitted) attachments are filtered out — they're a
 * pre-submit transient state that admins shouldn't see.
 */

import { errorToResponse, NotFoundError } from '../../../../../../../lib/permissions';
import { loadSheetForUser } from '../../../../../../../lib/records/helpers';
import type { Env, User } from '../../../../../../../lib/types';
import type { ApiRecordRowAttachment } from '../../../../../../../../shared/types';

export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const sheetId = context.params.sheetId as string;
    const rowId = context.params.rowId as string;

    await loadSheetForUser(context.env.DB, sheetId, user);

    const row = await context.env.DB.prepare(
      'SELECT id FROM records_rows WHERE id = ? AND sheet_id = ?',
    )
      .bind(rowId, sheetId)
      .first<{ id: string }>();
    if (!row) throw new NotFoundError('Row not found');

    const attachments = await context.env.DB.prepare(
      `SELECT a.*, u.name as uploader_name
       FROM records_row_attachments a
       LEFT JOIN users u ON a.uploaded_by = u.id
       WHERE a.row_id = ?
         AND a.pending_token IS NULL
       ORDER BY a.created_at ASC, a.id ASC`,
    )
      .bind(rowId)
      .all<ApiRecordRowAttachment>();

    return new Response(
      JSON.stringify({ attachments: attachments.results ?? [] }),
      { headers: { 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('List row attachments error:', err);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
