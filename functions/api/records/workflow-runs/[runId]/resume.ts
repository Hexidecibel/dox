/**
 * POST /api/records/workflow-runs/:runId/resume
 *
 * Resume a STALLED run: one that is in progress with no step waiting on
 * anybody, because the worker died between recording a decision and starting
 * the next step (decision C-151).
 *
 * This is an explicit act by a signed-in person. Reading a run never repairs
 * it; the run view reports `stalled` and offers this and Cancel.
 *
 * Who: the same people who may cancel a run (super_admin, org_admin, user --
 * never a reader), scoped through the run's sheet, so a run of another tenant
 * is a 404.
 *
 * Answers:
 *   200  { success, action: 'started' | 'moved' }
 *   409  the run is not stalled, cannot be resumed without guessing (the
 *        reason says why, and `can_cancel` is true), or is already being
 *        resumed by somebody else
 *   422  the step was started and could not be sent; the run has been
 *        stopped with that reason (C-135)
 */
import { logAudit, getClientIp } from '../../../../lib/db';
import { requireRole, NotFoundError, errorToResponse } from '../../../../lib/permissions';
import { loadSheetForUser, logRecordsActivity } from '../../../../lib/records/helpers';
import { resumeStalledRun } from '../../../../lib/records/workflows';
import type { Env, User } from '../../../../lib/types';

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const runId = context.params.runId as string;

    requireRole(user, 'super_admin', 'org_admin', 'user');

    const run = await context.env.DB
      .prepare('SELECT id, tenant_id, workflow_id, sheet_id, row_id FROM records_workflow_runs WHERE id = ?')
      .bind(runId)
      .first<{ id: string; tenant_id: string; workflow_id: string; sheet_id: string; row_id: string }>();
    if (!run) throw new NotFoundError('Run not found');

    // Tenant scope through the sheet: another tenant's run is a 404.
    const sheet = await loadSheetForUser(context.env.DB, run.sheet_id, user);
    if (sheet.tenant_id !== run.tenant_id) throw new NotFoundError('Run not found');

    const outcome = await resumeStalledRun(
      {
        DB: context.env.DB,
        RESEND_API_KEY: context.env.RESEND_API_KEY ?? null,
        appOrigin: new URL(context.request.url).origin,
      },
      runId,
    );

    await logAudit(
      context.env.DB,
      user.id,
      sheet.tenant_id,
      outcome.ok ? 'records_workflow_run.resumed' : 'records_workflow_run.resume_refused',
      'records_workflow_run',
      runId,
      JSON.stringify(outcome.ok ? { action: outcome.action } : { code: outcome.code, reason: outcome.reason }),
      getClientIp(context.request),
    );

    if (outcome.ok) {
      await logRecordsActivity(context.env.DB, {
        tenantId: sheet.tenant_id,
        sheetId: run.sheet_id,
        rowId: run.row_id,
        actorId: user.id,
        kind: 'workflow_resumed',
        details: { workflow_id: run.workflow_id, run_id: runId, action: outcome.action },
      });
      return json({ success: true, action: outcome.action }, 200);
    }

    if (outcome.code === 'step_failed') {
      return json(
        { error: `The step could not be started, so the run was stopped. ${outcome.reason}`, code: outcome.code, run_status: 'cancelled' },
        422,
      );
    }
    return json({ error: outcome.reason, code: outcome.code, can_cancel: outcome.code === 'not_resumable' }, 409);
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Resume workflow run error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
};
