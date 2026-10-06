/**
 * GET /api/renewal-requests[?tenant_id=] -- the supplier renewal requests of a
 * tenant (migration 0133): what is waiting for an approval, what was sent,
 * what was escalated, and -- computed here, at read -- the alerting documents
 * NO request could be drafted for and why (no supplier on the document, no
 * document contact on the supplier, already past the last follow-up window).
 *
 * Read-only, any role in the tenant; under the Compliance module gate. Each
 * row carries `can_approve` for the CALLER, so the screen never offers a
 * button the approve endpoint would refuse.
 *
 * Nothing here sends anything. A supplier is mailed by exactly one endpoint:
 * POST /api/renewal-requests/:id/sends/:sendId/approve.
 */

import { BadRequestError, errorToResponse, requireTenantAccess } from '../../lib/permissions';
import { computeExpirations, LEAD_TIME_WINDOW } from '../../lib/expirations';
import {
  listRenewalRequests,
  listResponseExtras,
  loadNotDrafted,
} from '../../lib/renewal-requests';
import type { Env, User } from '../../lib/types';
import type { RenewalRequestListResponse } from '../../../shared/types';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const url = new URL(context.request.url);

    let tenantId = url.searchParams.get('tenant_id');
    if (user.role !== 'super_admin') tenantId = user.tenant_id;
    if (!tenantId) throw new BadRequestError('tenant_id is required');
    requireTenantAccess(user, tenantId);

    const asOf = url.searchParams.get('as_of') || new Date().toISOString().slice(0, 10);
    // The same classification the alert run uses: each document against its
    // own lead time, so "not drafted" here matches what the next run reports.
    const { rows } = await computeExpirations(context.env.DB, tenantId, asOf, LEAD_TIME_WINDOW);

    const [requests, notDrafted] = await Promise.all([
      listRenewalRequests(context.env.DB, tenantId, user),
      loadNotDrafted(context.env.DB, tenantId, rows),
    ]);

    const body: RenewalRequestListResponse = {
      requests,
      not_drafted: notDrafted,
      ...listResponseExtras(context.env.RESEND_API_KEY),
    };
    return json(body);
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('List renewal requests error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
};
