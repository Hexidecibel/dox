/**
 * POST /api/records/workflow-runs/:runId/cancel
 *
 * Mark an in-progress run as cancelled. The current step_run flips to
 * `skipped`. Tokens still resolve but the public submit will 404.
 */
import { logAudit, getClientIp } from '../../../../lib/db';
import {
  requireRole,
  NotFoundError,
  errorToResponse,
} from '../../../../lib/permissions';
import { loadSheetForUser, logRecordsActivity } from '../../../../lib/records/helpers';
import { markRunComplete } from '../../../../lib/records/workflows';
import type { Env, User } from '../../../../lib/types';

export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const runId = context.params.runId as string;

    requireRole(user, 'super_admin', 'org_admin', 'user');

    const run = await context.env.DB
      .prepare('SELECT * FROM records_workflow_runs WHERE id = ?')
      .bind(runId)
      .first<{
        id: string;
        tenant_id: string;
        workflow_id: string;
        sheet_id: string;
        row_id: string;
        status: string;
      }>();
    if (!run) throw new NotFoundError('Run not found');

    const sheet = await loadSheetForUser(context.env.DB, run.sheet_id, user);

    if (run.status !== 'pending' && run.status !== 'in_progress') {
      // Idempotent.
      return new Response(JSON.stringify({ success: true }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Skip any awaiting step_run.
    await context.env.DB
      .prepare(
        `UPDATE records_workflow_step_runs
           SET status = 'skipped', completed_at = datetime('now')
         WHERE run_id = ? AND status = 'awaiting_response'`,
      )
      .bind(runId)
      .run();

    await markRunComplete(context.env.DB, runId, 'cancelled');

    await logRecordsActivity(context.env.DB, {
      tenantId: sheet.tenant_id,
      sheetId: run.sheet_id,
      rowId: run.row_id,
      actorId: user.id,
      kind: 'workflow_cancelled',
      details: { workflow_id: run.workflow_id, run_id: runId },
    });

    await logAudit(
      context.env.DB,
      user.id,
      sheet.tenant_id,
      'records_workflow_run.cancelled',
      'records_workflow_run',
      runId,
      null,
      getClientIp(context.request),
    );

    return new Response(JSON.stringify({ success: true }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Cancel workflow run error:', err);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
