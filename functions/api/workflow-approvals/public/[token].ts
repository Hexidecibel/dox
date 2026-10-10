/**
 * GET    /api/workflow-approvals/public/:token
 * POST   /api/workflow-approvals/public/:token
 *
 * Public, unauthenticated approval endpoint. The token is the gate;
 * tokens are 256-bit base64url. 404 covers EVERY unusable case, with one
 * body: missing token, expired, already responded, a run that is no longer in
 * progress, a workflow that is archived or no longer active, an archived row
 * or sheet, a run whose row / sheet / workflow is not in the run's own tenant,
 * an inactive organisation, Records switched off.
 *
 * ONE GATE FOR BOTH VERBS (`loadPublicApprovalContext`, C-128). The decision
 * used to check only that the step was still awaiting a response, so a link
 * kept accepting an approval after its row had been archived.
 *
 * What the page is given is an allow-list (C-122, C-123): the row's title,
 * ONLY the columns the step names, each reference as a name, and the sender's
 * name -- never an email, never an id.
 *
 * Rate limit: 30 reads and 5 decisions per IP per step per hour. Every read
 * is audited (C-130).
 */
import { logAudit, getClientIp } from '../../../lib/db';
import { checkRateLimit, recordAttempt } from '../../../lib/ratelimit';
import { errorToResponse, BadRequestError } from '../../../lib/permissions';
import {
  buildPublicApprovalView,
  handleApprovalResponse,
  loadPublicApprovalContext,
} from '../../../lib/records/workflows';
import { publicNotFound, rateLimited, takePublicView } from '../../../lib/records/publicView';
import { loadPublicBrand } from '../../../lib/tenant-brand';
import type { Env } from '../../../lib/types';
import type { PublicApprovalSubmitRequest, PublicApprovalSubmitResponse } from '../../../../shared/types';

const RATE_LIMIT_PER_HOUR = 5;
const RATE_LIMIT_WINDOW_SECONDS = 60 * 60;
/** Generous for a person refreshing the page; tight enough to stop a scraper. */
const VIEWS_PER_HOUR = 30;

const notFound = () => publicNotFound('Approval not found');

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const token = context.params.token as string;
    if (!token) return notFound();

    const ctx = await loadPublicApprovalContext(context.env.DB, token);
    if (!ctx) return notFound();

    const ip = getClientIp(context.request) ?? 'unknown';
    if (!(await takePublicView(context.env.DB, 'records_approval_view', ctx.stepRun.id, ip, VIEWS_PER_HOUR))) {
      return rateLimited();
    }

    const view = await buildPublicApprovalView(context.env.DB, ctx);

    // The token is a bearer secret and is not written into the log.
    await logAudit(
      context.env.DB,
      null,
      ctx.tenantId,
      'records_workflow_step_run.view',
      'records_workflow_step_run',
      ctx.stepRun.id,
      JSON.stringify({ run_id: ctx.stepRun.run_id, fields_shown: view.row.fields.length, ip }),
      ip,
    );

    // The organisation's brand (0140), from the tenant of the run this token
    // resolved to.
    const brand = await loadPublicBrand(context.env.DB, ctx.tenantId, 'records_approval');

    // No brand record: the payload has no `brand` key.
    return new Response(JSON.stringify(brand ? { ...view, brand } : view), {
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

    // The same gate the page passed through. A decision is refused exactly
    // where the page is refused.
    const ctx = await loadPublicApprovalContext(context.env.DB, token);
    if (!ctx) return notFound();
    const sr = ctx.stepRun;

    const rlKey = `workflow_approval_submit:${sr.id}:${ip}`;
    const rl = await checkRateLimit(context.env.DB, rlKey, RATE_LIMIT_PER_HOUR, RATE_LIMIT_WINDOW_SECONDS);
    if (!rl.allowed) return rateLimited();

    let body: PublicApprovalSubmitRequest;
    try {
      body = (await context.request.json()) as PublicApprovalSubmitRequest;
    } catch {
      return jsonResponse({ error: 'Invalid JSON' }, 400);
    }
    if (!body || (body.decision !== 'approve' && body.decision !== 'reject')) {
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

    // Audit trail, under the tenant the gate resolved.
    await logAudit(
      context.env.DB,
      null,
      ctx.tenantId,
      `records_workflow_step_run.${body.decision}`,
      'records_workflow_step_run',
      sr.id,
      JSON.stringify({ via: 'public_token', responder: responderEmail, ip }),
      ip,
    );

    const response: PublicApprovalSubmitResponse = { success: true, decision: body.decision };
    return jsonResponse(response, 200);
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Public approval submit error:', err);
    return jsonResponse({ error: 'Submission failed' }, 500);
  }
};
