/**
 * POST /api/document-requests/:id/issue — THE issue action.
 *
 * One issue path, one routing record, one audit trail, regardless of what
 * filled the form. A gap report, a saved template, a person typing and a
 * future draft generator all produce a draft and all commit it here.
 * `document_requests.origin` records which; it selects nothing.
 *
 * WHAT ISSUING DOES
 * -----------------
 *   1. status draft -> issued, `issued_at` stamped
 *   2. exactly ONE `request_routing` row created — the internal record of the
 *      dispatch, never visible externally (see the migration and
 *      `buildSupplierRequestView`)
 *   3. exactly ONE audit row
 *
 * All in a single `db.batch`, which D1 runs as one transaction, so a request
 * cannot end up issued with no routing record or vice versa. The UNIQUE on
 * `request_routing.request_id` makes a double-fire a constraint error rather
 * than a second record of one event.
 *
 * A HUMAN ACTOR IS REQUIRED, and that is the mechanism, not a side effect. The
 * client's rule is that a generator "populates a draft that a human reviews and
 * amends before issue; it never issues on its own". `request_routing.issued_by`
 * is NOT NULL and is taken from the authenticated user, so there is no way to
 * write an issue event without one.
 *
 * After issue the request is immutable. Changes go through :id/amend, which
 * writes a new version and preserves this one.
 */

import { getClientIp } from '../../../lib/db';
import { errorToResponse } from '../../../lib/permissions';
import {
  auditRequest,
  issueRequest,
  loadRequestDetail,
  requireComposer,
  resolveTenantForRequest,
} from '../../../lib/document-requests';
import type { IssueDocumentRequestRequest } from '../../../../shared/types';
import type { Env, User } from '../../../lib/types';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireComposer(user);

    const id = context.params.id as string;
    const tenantId = await resolveTenantForRequest(context.env.DB, user, id);

    let body: IssueDocumentRequestRequest = {};
    try {
      body = ((await context.request.json()) ?? {}) as IssueDocumentRequestRequest;
    } catch {
      // Issuing with no body is the common case from a UI button.
      body = {};
    }

    await issueRequest(context.env.DB, tenantId, id, user, {
      channel: body.channel,
      recipient: body.recipient ?? null,
      internalNotes: body.internal_notes ?? null,
    });

    const request = await loadRequestDetail(context.env.DB, tenantId, id);

    await auditRequest(
      context.env.DB,
      user,
      tenantId,
      'document_request_issued',
      id,
      {
        supplier_id: request.supplier_id,
        version: request.version,
        origin: request.origin,
        line_count: request.counts.total,
        free_text_lines: request.counts.free_text,
        channel: request.routing?.channel ?? null,
      },
      getClientIp(context.request),
    );

    return json({ request });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Issue document request error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
};
