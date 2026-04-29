/**
 * GET /api/records/workflow-approvals/inbox
 *
 * Lists pending approvals assigned to the current user. Joins the step_run
 * to its run + workflow + row + sheet for context the inbox UI needs.
 */
import { errorToResponse } from '../../../lib/permissions';
import type { Env, User } from '../../../lib/types';
import type { WorkflowApprovalInboxItem } from '../../../../shared/types';

export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;

    const result = await context.env.DB
      .prepare(
        `SELECT sr.id AS step_run_id,
                sr.run_id AS run_id,
                sr.token_expires_at AS due_at,
                sr.started_at AS started_at,
                r.workflow_id AS workflow_id,
                r.sheet_id AS sheet_id,
                r.row_id AS row_id,
                w.name AS workflow_name,
                w.steps AS workflow_steps,
                s.name AS sheet_name,
                rr.display_title AS row_title,
                u.name AS triggered_by_name
           FROM records_workflow_step_runs sr
           JOIN records_workflow_runs r ON sr.run_id = r.id
           JOIN records_workflows w ON r.workflow_id = w.id
           JOIN records_sheets s ON r.sheet_id = s.id
           JOIN records_rows rr ON r.row_id = rr.id
           LEFT JOIN users u ON r.triggered_by_user_id = u.id
           WHERE sr.assignee_user_id = ?
             AND sr.status = 'awaiting_response'
             AND r.status IN ('pending','in_progress')
             AND r.tenant_id = ?
           ORDER BY sr.started_at DESC`,
      )
      .bind(user.id, user.tenant_id ?? '')
      .all<{
        step_run_id: string;
        run_id: string;
        due_at: string | null;
        started_at: string | null;
        workflow_id: string;
        sheet_id: string;
        row_id: string;
        workflow_name: string;
        workflow_steps: string;
        sheet_name: string;
        row_title: string | null;
        triggered_by_name: string | null;
      }>();

    const items: WorkflowApprovalInboxItem[] = (result.results ?? []).map((r) => {
      // Find the step name from the workflow snapshot for this step_run.
      let stepName = 'Approval';
      let message: string | null = null;
      try {
        const steps = JSON.parse(r.workflow_steps) as Array<{
          id: string; name: string; config: { message?: string | null };
        }>;
        // step_id isn't in the projection -- look up later. Fallback to first
        // pending. (Optimization deferred; inbox is small.)
        // We can refine this lookup -- the step_run has step_id but the
        // current SELECT didn't pull it. Pull it inline below.
        void steps;
      } catch {
        // ignore
      }
      return {
        step_run_id: r.step_run_id,
        run_id: r.run_id,
        workflow_id: r.workflow_id,
        workflow_name: r.workflow_name,
        step_name: stepName,
        sheet_id: r.sheet_id,
        sheet_name: r.sheet_name,
        row_id: r.row_id,
        row_title: r.row_title,
        message,
        due_at: r.due_at,
        started_at: r.started_at,
        triggered_by_name: r.triggered_by_name,
      };
    });

    // Second pass: pull step_id + step_name per item (tiny N, simple loop).
    if (items.length > 0) {
      const ids = items.map((i) => i.step_run_id);
      const placeholders = ids.map(() => '?').join(',');
      const stepIdRes = await context.env.DB
        .prepare(`SELECT id, step_id FROM records_workflow_step_runs WHERE id IN (${placeholders})`)
        .bind(...ids)
        .all<{ id: string; step_id: string }>();
      const idToStepId = new Map((stepIdRes.results ?? []).map((r) => [r.id, r.step_id]));
      // Pull each workflow's steps once.
      const wfIds = Array.from(new Set(items.map((i) => i.workflow_id)));
      const wfPlaceholders = wfIds.map(() => '?').join(',');
      const wfRes = await context.env.DB
        .prepare(`SELECT id, steps FROM records_workflows WHERE id IN (${wfPlaceholders})`)
        .bind(...wfIds)
        .all<{ id: string; steps: string }>();
      const wfStepMap = new Map<string, Array<{ id: string; name: string; config: { message?: string | null } }>>();
      for (const w of wfRes.results ?? []) {
        try {
          wfStepMap.set(w.id, JSON.parse(w.steps));
        } catch {
          wfStepMap.set(w.id, []);
        }
      }
      for (const item of items) {
        const stepId = idToStepId.get(item.step_run_id);
        const steps = wfStepMap.get(item.workflow_id) ?? [];
        const step = stepId ? steps.find((s) => s.id === stepId) : null;
        if (step) {
          item.step_name = step.name;
          item.message = step.config?.message ?? null;
        }
      }
    }

    return new Response(JSON.stringify({ items, total: items.length }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Workflow approval inbox error:', err);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
