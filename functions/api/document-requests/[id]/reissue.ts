/**
 * POST /api/document-requests/:id/reissue — a NEW ask modelled on an old one.
 *
 * The client named two cases and they are the same operation: a RENEWAL ("same
 * packet, this year's certificates") and a NEW ITEM under an already-approved
 * vendor ("they're onboarded, we just need the spec sheet for the new SKU").
 *
 * NOT AN AMENDMENT, and this is the easy mistake in the feature:
 *
 *   amend    the SAME ask, corrected. Same root, version + 1, the previous
 *            version stamped superseded. Per-line progress carries forward.
 *   reissue  a NEW ask. NEW root, version back to 1, `reissue_of_request_id`
 *            kept as provenance. Per-line progress deliberately does NOT carry
 *            forward — last year's certificate is not this year's, and a
 *            renewal that opened with every line already `accepted` would be
 *            worse than useless.
 *
 * Reusing the original root for a renewal would rewrite last year's record as
 * though it had always been about this year, which is the exact failure the
 * versioning rule exists to prevent.
 *
 * The result is a DRAFT. A renewal is still an ask a person should look at
 * before it goes out, and issuing straight from here would give the composer a
 * second issue path — the one thing the module refuses to have. Issue it with
 * POST :new_id/issue like everything else.
 *
 * `supplier_id` defaults to the source's, because the common case is the same
 * vendor a year later. Pointing it at a different supplier is how "the packet
 * we send every approved vendor" gets reused without first saving a template.
 */

import { getClientIp } from '../../../lib/db';
import { errorToResponse } from '../../../lib/permissions';
import {
  auditRequest,
  loadRequestDetail,
  reissueRequest,
  requireComposer,
  resolveTenantForRequest,
} from '../../../lib/document-requests';
import type { ReissueDocumentRequestRequest } from '../../../../shared/types';
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

    let body: ReissueDocumentRequestRequest = {};
    try {
      body = ((await context.request.json()) ?? {}) as ReissueDocumentRequestRequest;
    } catch {
      body = {};
    }

    const newId = await reissueRequest(context.env.DB, tenantId, id, user, body);
    const request = await loadRequestDetail(context.env.DB, tenantId, newId);

    await auditRequest(
      context.env.DB,
      user,
      tenantId,
      'document_request_reissued',
      newId,
      {
        reissue_of_request_id: id,
        supplier_id: request.supplier_id,
        line_count: request.counts.total,
      },
      getClientIp(context.request),
    );

    return json({ request, reissue_of_request_id: id }, 201);
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Reissue document request error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
};
