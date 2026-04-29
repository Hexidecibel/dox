/**
 * GET    /api/workflow-approvals/public/:token
 * POST   /api/workflow-approvals/public/:token
 *
 * Public, unauthenticated approval endpoint. The token is the gate;
 * tokens are 256-bit base64url. 404 covers EVERY non-fillable case:
 * missing token, expired, already responded, archived row/sheet, etc.
 *
 * Rate limit: 5 submits per IP per token per hour (matches the public
 * update-request endpoint).
 */
import { logAudit, getClientIp } from '../../../lib/db';
import { checkRateLimit, recordAttempt } from '../../../lib/ratelimit';
import { errorToResponse, BadRequestError } from '../../../lib/permissions';
import { parseRowData } from '../../../lib/records/helpers';
import {
  buildPublicApprovalView,
  handleApprovalResponse,
  isApprovalAcceptable,
  type WorkflowStepRunDbRow,
} from '../../../lib/records/workflows';
import type { Env } from '../../../lib/types';
import type { PublicApprovalSubmitRequest } from '../../../../shared/types';

const RATE_LIMIT_PER_HOUR = 5;
const RATE_LIMIT_WINDOW_SECONDS = 60 * 60;

function notFound(): Response {
  return new Response(JSON.stringify({ error: 'Approval not found' }), {
    status: 404,
    headers: { 'Content-Type': 'application/json' },
  });
}
function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function loadStepRunByToken(
  db: D1Database,
  token: string,
): Promise<WorkflowStepRunDbRow | null> {
  return db
    .prepare(`SELECT * FROM records_workflow_step_runs WHERE approver_token = ?`)
    .bind(token)
    .first<WorkflowStepRunDbRow>();
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const token = context.params.token as string;
    if (!token) return notFound();

    const sr = await loadStepRunByToken(context.env.DB, token);
    if (!sr) return notFound();
    if (!isApprovalAcceptable(sr)) return notFound();

    // Pull the row's data so the projection can show contextual fields.
    const run = await context.env.DB
      .prepare('SELECT row_id FROM records_workflow_runs WHERE id = ?')
      .bind(sr.run_id)
      .first<{ row_id: string }>();
    if (!run) return notFound();
    const row = await context.env.DB
      .prepare('SELECT data FROM records_rows WHERE id = ? AND archived = 0')
      .bind(run.row_id)
      .first<{ data: string | null }>();
    if (!row) return notFound();
    const data = parseRowData(row.data);

    const view = await buildPublicApprovalView(context.env.DB, sr, data);
    if (!view) return notFound();

    return new Response(JSON.stringify(view), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  } catch (err) {
    console.error('Public approval fetch error:', err);
    return notFound();
  }
};

export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const token = context.params.token as string;
    if (!token) return notFound();

    const ip = getClientIp(context.request) ?? 'unknown';

    const sr = await loadStepRunByToken(context.env.DB, token);
    if (!sr) return notFound();
    if (!isApprovalAcceptable(sr)) return notFound();

    const rlKey = `workflow_approval_submit:${sr.id}:${ip}`;
    const rl = await checkRateLimit(context.env.DB, rlKey, RATE_LIMIT_PER_HOUR, RATE_LIMIT_WINDOW_SECONDS);
    if (!rl.allowed) {
      return jsonResponse({ error: 'Rate limit exceeded. Try again later.' }, 429);
    }

    let body: PublicApprovalSubmitRequest;
    try {
      body = (await context.request.json()) as PublicApprovalSubmitRequest;
    } catch {
      return jsonResponse({ error: 'Invalid JSON' }, 400);
    }
    if (body.decision !== 'approve' && body.decision !== 'reject') {
      throw new BadRequestError('decision must be approve or reject');
    }
    const comment = typeof body.comment === 'string' ? body.comment.trim().slice(0, 2000) : null;

    const origin = new URL(context.request.url).origin;
    const responderEmail = sr.assignee_email || 'unknown@external';
    await handleApprovalResponse(
      { DB: context.env.DB, RESEND_API_KEY: context.env.RESEND_API_KEY ?? null, appOrigin: origin },
      {
        stepRunId: sr.id,
        decision: body.decision,
        comment: comment || null,
        responder: { kind: 'email', email: responderEmail },
      },
    );

    await recordAttempt(context.env.DB, rlKey, RATE_LIMIT_WINDOW_SECONDS);

    // Audit trail. tenant_id from the run.
    const run = await context.env.DB
      .prepare('SELECT tenant_id FROM records_workflow_runs WHERE id = ?')
      .bind(sr.run_id)
      .first<{ tenant_id: string }>();
    if (run) {
      await logAudit(
        context.env.DB,
        null,
        run.tenant_id,
        `records_workflow_step_run.${body.decision}`,
        'records_workflow_step_run',
        sr.id,
        JSON.stringify({ via: 'public_token', responder: responderEmail, ip }),
        ip,
      );
    }

    return jsonResponse({ success: true, decision: body.decision }, 200);
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Public approval submit error:', err);
    return jsonResponse({ error: 'Submission failed' }, 500);
  }
};
