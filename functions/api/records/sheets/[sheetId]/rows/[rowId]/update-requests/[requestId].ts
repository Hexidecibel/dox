/**
 * DELETE /api/records/sheets/:sheetId/rows/:rowId/update-requests/:requestId
 *
 * Cancel a pending update request. Sets status='cancelled' so the
 * recipient's link starts returning the "no longer accepting updates"
 * page on next load. We don't hard-delete — the audit trail of who/when
 * stays intact.
 */
import { logAudit, getClientIp } from '../../../../../../../lib/db';
import {
  requireRole,
  NotFoundError,
  errorToResponse,
} from '../../../../../../../lib/permissions';
import { loadSheetForUser, logRecordsActivity } from '../../../../../../../lib/records/helpers';
import type { Env, User } from '../../../../../../../lib/types';
import type { RecordUpdateRequestRow } from '../../../../../../../../shared/types';

export const onRequestDelete: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const sheetId = context.params.sheetId as string;
    const rowId = context.params.rowId as string;
    const requestId = context.params.requestId as string;

    requireRole(user, 'super_admin', 'org_admin', 'user');

    const sheet = await loadSheetForUser(context.env.DB, sheetId, user);

    const req = await context.env.DB.prepare(
      `SELECT * FROM records_update_requests
        WHERE id = ? AND sheet_id = ? AND row_id = ? AND tenant_id = ?`,
    )
      .bind(requestId, sheetId, rowId, sheet.tenant_id)
      .first<RecordUpdateRequestRow>();

    if (!req) throw new NotFoundError('Update request not found');

    if (req.status !== 'pending') {
      // Idempotent — already cancelled / responded / expired.
      return new Response(JSON.stringify({ success: true }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    await context.env.DB.prepare(
      `UPDATE records_update_requests SET status = 'cancelled' WHERE id = ?`,
    )
      .bind(requestId)
      .run();

    await logRecordsActivity(context.env.DB, {
      tenantId: sheet.tenant_id,
      sheetId,
      rowId,
      actorId: user.id,
      kind: 'update_request_cancelled',
      details: { request_id: requestId, recipient_email: req.recipient_email },
    });

    await logAudit(
      context.env.DB,
      user.id,
      sheet.tenant_id,
      'records_update_request.cancelled',
      'records_update_request',
      requestId,
      null,
      getClientIp(context.request),
    );

    return new Response(JSON.stringify({ success: true }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Cancel update request error:', err);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
