/**
 * GET    /api/records/sheets/:sheetId/rows/:rowId/workflow-runs
 * POST   /api/records/sheets/:sheetId/rows/:rowId/workflow-runs
 *
 * Manually start a workflow on a row (POST), or list runs for the row.
 */
import { logAudit, getClientIp } from '../../../../../../../lib/db';
import {
  requireRole,
  BadRequestError,
  NotFoundError,
  errorToResponse,
} from '../../../../../../../lib/permissions';
import { loadSheetForUser } from '../../../../../../../lib/records/helpers';
import {
  hydrateWorkflow,
  readRunStall,
  stallForView,
  startWorkflowRun,
  type WorkflowDbRow,
} from '../../../../../../../lib/records/workflows';
import type { Env, User } from '../../../../../../../lib/types';
import type { RecordWorkflowStep, StartWorkflowRunRequest } from '../../../../../../../../shared/types';

export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const sheetId = context.params.sheetId as string;
    const rowId = context.params.rowId as string;

    const sheet = await loadSheetForUser(context.env.DB, sheetId, user);

    // THE ROW MUST BE ON THIS SHEET, IN THE SHEET'S TENANT, before anything
    // is read by its id (C-152). The sheet is the caller's; the row id is
    // whatever was typed into the URL. Without this a row id of another
    // tenant, under one's own sheet id, listed that tenant's runs.
    const row = await context.env.DB.prepare(
      'SELECT id FROM records_rows WHERE id = ? AND sheet_id = ? AND tenant_id = ?',
    )
      .bind(rowId, sheet.id, sheet.tenant_id)
      .first<{ id: string }>();
    if (!row) throw new NotFoundError('Row not found');

    // A GET READS (C-151). A stalled run is reported below, never repaired
    // here: no step is started and no mail is sent by listing runs.
    const result = await context.env.DB.prepare(
      `SELECT r.*, w.name AS workflow_name, w.steps AS workflow_steps,
              u.name AS triggered_by_name
         FROM records_workflow_runs r
         LEFT JOIN records_workflows w ON r.workflow_id = w.id AND w.tenant_id = r.tenant_id
         LEFT JOIN users u ON r.triggered_by_user_id = u.id
         WHERE r.row_id = ? AND r.sheet_id = ? AND r.tenant_id = ?
         ORDER BY r.created_at DESC`,
    )
      .bind(rowId, sheet.id, sheet.tenant_id)
      .all<{
        id: string;
        tenant_id: string;
        workflow_id: string;
        sheet_id: string;
        row_id: string;
        status: string;
        current_step_id: string | null;
        triggered_by_user_id: string | null;
        started_at: string | null;
        completed_at: string | null;
        created_at: string;
        workflow_name: string | null;
        workflow_steps: string | null;
        triggered_by_name: string | null;
      }>();

    const runs = [];
    for (const r of result.results ?? []) {
      const steps = (r.workflow_steps ? safeParseSteps(r.workflow_steps) : []) as RecordWorkflowStep[];
      // `stalled` / `stalled_reason` / `resumable`, present only on a run
      // that is in progress with nothing waiting and nothing happening.
      const stall = stallForView(await readRunStall(context.env.DB, r, steps));
      runs.push({
      id: r.id,
      tenant_id: r.tenant_id,
      workflow_id: r.workflow_id,
      sheet_id: r.sheet_id,
      row_id: r.row_id,
      status: r.status as 'pending' | 'in_progress' | 'completed' | 'rejected' | 'cancelled',
      current_step_id: r.current_step_id,
      triggered_by_user_id: r.triggered_by_user_id,
      started_at: r.started_at,
      completed_at: r.completed_at,
      created_at: r.created_at,
      workflow_name: r.workflow_name,
      workflow_steps: steps,
      triggered_by_name: r.triggered_by_name,
      ...stall,
      });
    }

    return new Response(JSON.stringify({ runs, total: runs.length }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('List workflow runs error:', err);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const sheetId = context.params.sheetId as string;
    const rowId = context.params.rowId as string;

    requireRole(user, 'super_admin', 'org_admin', 'user');

    const sheet = await loadSheetForUser(context.env.DB, sheetId, user);

    const row = await context.env.DB.prepare(
      'SELECT id FROM records_rows WHERE id = ? AND sheet_id = ? AND tenant_id = ? AND archived = 0',
    )
      .bind(rowId, sheet.id, sheet.tenant_id)
      .first<{ id: string }>();
    if (!row) throw new NotFoundError('Row not found');

    const body = (await context.request.json()) as StartWorkflowRunRequest;
    if (!body.workflow_id) throw new BadRequestError('workflow_id is required');

    const wfRow = await context.env.DB.prepare(
      `SELECT w.*, u.name as creator_name
         FROM records_workflows w
         LEFT JOIN users u ON w.created_by_user_id = u.id
         WHERE w.id = ? AND w.sheet_id = ? AND w.tenant_id = ? AND w.archived = 0`,
    )
      .bind(body.workflow_id, sheet.id, sheet.tenant_id)
      .first<WorkflowDbRow>();
    if (!wfRow) throw new NotFoundError('Workflow not found');
    const workflow = hydrateWorkflow(wfRow);

    const origin = new URL(context.request.url).origin;
    const { runId, failed } = await startWorkflowRun(
      { DB: context.env.DB, RESEND_API_KEY: context.env.RESEND_API_KEY ?? null, appOrigin: origin },
      { workflow, rowId, triggeredByUserId: user.id },
    );

    // The first step could not be started: the run exists, already ended
    // `cancelled` with the reason on it. Saying "started" would be a lie the
    // builder finds out about later (C-147); this is a signed-in person who
    // can fix the step, so they are told why.
    if (failed) {
      await logAudit(
        context.env.DB,
        user.id,
        sheet.tenant_id,
        'records_workflow_run.start_failed',
        'records_workflow_run',
        runId,
        JSON.stringify({ workflow_id: workflow.id, row_id: rowId, reason: failed }),
        getClientIp(context.request),
      );
      return new Response(
        JSON.stringify({
          error: `The workflow could not be started. ${failed}`,
          code: 'workflow_start_failed',
          run_id: runId,
          run_status: 'cancelled',
        }),
        { status: 422, headers: { 'Content-Type': 'application/json' } },
      );
    }

    await logAudit(
      context.env.DB,
      user.id,
      sheet.tenant_id,
      'records_workflow_run.started',
      'records_workflow_run',
      runId,
      JSON.stringify({ workflow_id: workflow.id, row_id: rowId }),
      getClientIp(context.request),
    );

    return new Response(JSON.stringify({ run_id: runId }), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Start workflow run error:', err);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

function safeParseSteps(raw: string): unknown[] {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
