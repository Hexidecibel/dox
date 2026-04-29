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
  startWorkflowRun,
  type WorkflowDbRow,
} from '../../../../../../../lib/records/workflows';
import type { Env, User } from '../../../../../../../lib/types';
import type { StartWorkflowRunRequest } from '../../../../../../../../shared/types';

export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const sheetId = context.params.sheetId as string;
    const rowId = context.params.rowId as string;

    await loadSheetForUser(context.env.DB, sheetId, user);

    const result = await context.env.DB.prepare(
      `SELECT r.*, w.name AS workflow_name, w.steps AS workflow_steps,
              u.name AS triggered_by_name
         FROM records_workflow_runs r
         LEFT JOIN records_workflows w ON r.workflow_id = w.id
         LEFT JOIN users u ON r.triggered_by_user_id = u.id
         WHERE r.row_id = ?
         ORDER BY r.created_at DESC`,
    )
      .bind(rowId)
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

    const runs = (result.results ?? []).map((r) => ({
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
      workflow_steps: r.workflow_steps ? safeParseSteps(r.workflow_steps) : [],
      triggered_by_name: r.triggered_by_name,
    }));

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
      'SELECT id FROM records_rows WHERE id = ? AND sheet_id = ? AND archived = 0',
    )
      .bind(rowId, sheetId)
      .first<{ id: string }>();
    if (!row) throw new NotFoundError('Row not found');

    const body = (await context.request.json()) as StartWorkflowRunRequest;
    if (!body.workflow_id) throw new BadRequestError('workflow_id is required');

    const wfRow = await context.env.DB.prepare(
      `SELECT w.*, u.name as creator_name
         FROM records_workflows w
         LEFT JOIN users u ON w.created_by_user_id = u.id
         WHERE w.id = ? AND w.sheet_id = ? AND w.archived = 0`,
    )
      .bind(body.workflow_id, sheetId)
      .first<WorkflowDbRow>();
    if (!wfRow) throw new NotFoundError('Workflow not found');
    const workflow = hydrateWorkflow(wfRow);

    const origin = new URL(context.request.url).origin;
    const { runId } = await startWorkflowRun(
      { DB: context.env.DB, RESEND_API_KEY: context.env.RESEND_API_KEY ?? null, appOrigin: origin },
      { workflow, rowId, triggeredByUserId: user.id },
    );

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
