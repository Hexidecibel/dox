/**
 * POST /api/renewal-requests/:id/sends/:sendId/approve
 * Body: { subject, body }
 *
 * THE ONE ENDPOINT THAT MAILS A SUPPLIER (migration 0133; AJ Conner,
 * D-040..D-051). The scheduled run drafts; this is the single approval by a
 * person that every supplier email requires.
 *
 * Who: the draft's assigned approver, or an org_admin / super_admin. It does
 * NOT use `requireComposer`: the composer is admin-only, and the approver here
 * is frequently the record's owner, who is not an admin. They approve a draft
 * routed to them by name, which is a narrower thing than composing a request.
 *
 * What it does, in order (functions/lib/renewal-requests.ts):
 *   - on the first approval of a cycle, composes and issues ONE document
 *     request for the expiring document, as the approving person, through the
 *     same compose/issue functions every other request leaves by;
 *   - sends the approved text plus the system's link block from
 *     "<Organization> via SupDox", reply-to the approver, no attachment;
 *   - stores the exact subject and body sent, who approved and when, and
 *     writes `renewal_request.sent`.
 *
 * `subject` and `body` are what the person approved -- the draft as edited.
 * The link block is not in `body` and cannot be supplied: it is appended here.
 *
 * Responses: 200 `{ sent: true }`; 409 the draft is not waiting (already sent,
 * skipped, superseded, cycle ended) or the supplier has no document contact;
 * 503 mail is not configured (nothing sent, the draft keeps waiting); 502 the
 * mail provider refused it (recorded as `failed`, retryable).
 */

import { getClientIp } from '../../../../../lib/db';
import { errorToResponse } from '../../../../../lib/permissions';
import {
  approveRenewalSend,
  listRenewalRequests,
  resolveTenantForRenewalRequest,
} from '../../../../../lib/renewal-requests';
import type { Env, User } from '../../../../../lib/types';
import type { ApproveRenewalSendRequest, ApproveRenewalSendResponse } from '../../../../../../shared/types';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const STATUS: Record<NonNullable<ApproveRenewalSendResponse['code']>, number> = {
  email_not_configured: 503,
  no_document_contact: 409,
  send_failed: 502,
};

export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const cycleId = context.params.id as string;
    const sendId = context.params.sendId as string;
    const tenantId = await resolveTenantForRenewalRequest(context.env.DB, user, cycleId);

    let body: Partial<ApproveRenewalSendRequest>;
    try {
      body = ((await context.request.json()) ?? {}) as Partial<ApproveRenewalSendRequest>;
    } catch {
      return json({ error: 'Body must be JSON: { subject, body }' }, 400);
    }

    const outcome = await approveRenewalSend(context.env.DB, context.env.RESEND_API_KEY, user, {
      tenantId,
      cycleId,
      sendId,
      subject: body.subject,
      body: body.body,
      appUrl: new URL(context.request.url).origin,
      ip: getClientIp(context.request),
    });

    const [request] = await listRenewalRequests(context.env.DB, tenantId, user, { id: cycleId });
    if (outcome.sent) {
      return json({ sent: true, request } satisfies ApproveRenewalSendResponse);
    }
    return json(
      { sent: false, request, error: outcome.error, code: outcome.code } satisfies ApproveRenewalSendResponse,
      STATUS[outcome.code],
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Approve renewal request error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
};
