/**
 * POST /api/records/workflow-approvals/:stepRunId
 *
 * Authenticated approver decision. Used by the in-app approvals inbox
 * when the assignee is a known user. The user must be the assignee_user_id
 * on the step_run -- otherwise 404 (hide existence).
 */
import { logAudit, getClientIp } from '../../../lib/db';
import {
  BadRequestError,
  NotFoundError,
  errorToResponse,
} from '../../../lib/permissions';
import {
  handleApprovalResponse,
  isApprovalAcceptable,
  type WorkflowStepRunDbRow,
} from '../../../lib/records/workflows';
import type { Env, User } from '../../../lib/types';
import type { PublicApprovalSubmitRequest } from '../../../../shared/types';

export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const stepRunId = context.params.stepRunId as string;

    const sr = await context.env.DB
      .prepare(`SELECT * FROM records_workflow_step_runs WHERE id = ?`)
      .bind(stepRunId)
      .first<WorkflowStepRunDbRow>();
    if (!sr) throw new NotFoundError('Approval not found');

    // The current user must be the assignee.
    if (sr.assignee_user_id !== user.id) {
      throw new NotFoundError('Approval not found');
    }
    if (!isApprovalAcceptable(sr)) {
      throw new NotFoundError('Approval no longer accepting responses');
    }

    const body = (await context.request.json()) as PublicApprovalSubmitRequest;
    if (body.decision !== 'approve' && body.decision !== 'reject') {
      throw new BadRequestError('decision must be approve or reject');
    }
    const comment = typeof body.comment === 'string' ? body.comment.trim().slice(0, 2000) : null;

    const origin = new URL(context.request.url).origin;
    await handleApprovalResponse(
      { DB: context.env.DB, RESEND_API_KEY: context.env.RESEND_API_KEY ?? null, appOrigin: origin },
      {
        stepRunId,
        decision: body.decision,
        comment: comment || null,
        responder: { kind: 'user', id: user.id },
      },
    );

    // For audit purposes load the run (cheap).
    const run = await context.env.DB
      .prepare('SELECT tenant_id FROM records_workflow_runs WHERE id = ?')
      .bind(sr.run_id)
      .first<{ tenant_id: string }>();
    if (run) {
      await logAudit(
        context.env.DB,
        user.id,
        run.tenant_id,
        `records_workflow_step_run.${body.decision}`,
        'records_workflow_step_run',
        stepRunId,
        JSON.stringify({ run_id: sr.run_id }),
        getClientIp(context.request),
      );
    }

    return new Response(JSON.stringify({ success: true, decision: body.decision }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Approval submit error:', err);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
