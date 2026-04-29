/**
 * GET /api/records/workflow-runs/:runId
 *
 * Returns the run + hydrated step_runs + workflow snapshot. Used by the
 * RowEditPanel WorkflowRunVisualization. Tenant-scoped via the sheet
 * load -- a wrong-tenant runId 404s.
 */
import {
  errorToResponse,
  NotFoundError,
} from '../../../../lib/permissions';
import { loadSheetForUser } from '../../../../lib/records/helpers';
import {
  hydrateStepRun,
  hydrateWorkflow,
  parseWorkflowSteps,
  type WorkflowDbRow,
  type WorkflowStepRunDbRow,
} from '../../../../lib/records/workflows';
import type { Env, User } from '../../../../lib/types';
import type { RecordWorkflowRun } from '../../../../../shared/types';

export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const runId = context.params.runId as string;

    const run = await context.env.DB
      .prepare(
        `SELECT r.*, w.name AS workflow_name, w.steps AS workflow_steps,
                u.name AS triggered_by_name
           FROM records_workflow_runs r
           LEFT JOIN records_workflows w ON r.workflow_id = w.id
           LEFT JOIN users u ON r.triggered_by_user_id = u.id
           WHERE r.id = ?`,
      )
      .bind(runId)
      .first<{
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
    if (!run) throw new NotFoundError('Run not found');

    // Tenant scope check via sheet -- 404s on cross-tenant.
    await loadSheetForUser(context.env.DB, run.sheet_id, user);

    const stepRunsResult = await context.env.DB
      .prepare(
        `SELECT sr.*, u.name AS assignee_user_name
           FROM records_workflow_step_runs sr
           LEFT JOIN users u ON sr.assignee_user_id = u.id
           WHERE sr.run_id = ?
           ORDER BY sr.step_index ASC`,
      )
      .bind(runId)
      .all<WorkflowStepRunDbRow>();

    const out: RecordWorkflowRun = {
      id: run.id,
      tenant_id: run.tenant_id,
      workflow_id: run.workflow_id,
      sheet_id: run.sheet_id,
      row_id: run.row_id,
      status: run.status as RecordWorkflowRun['status'],
      current_step_id: run.current_step_id,
      triggered_by_user_id: run.triggered_by_user_id,
      started_at: run.started_at,
      completed_at: run.completed_at,
      created_at: run.created_at,
      workflow_name: run.workflow_name,
      workflow_steps: run.workflow_steps ? parseWorkflowSteps(run.workflow_steps) : [],
      triggered_by_name: run.triggered_by_name,
      step_runs: (stepRunsResult.results ?? []).map((sr) => hydrateStepRun(sr)),
    };

    return new Response(JSON.stringify({ run: out }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Get workflow run error:', err);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
