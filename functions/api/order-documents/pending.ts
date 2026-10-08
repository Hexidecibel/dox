/**
 * GET /api/order-documents/pending[?tenant_id=] — every document waiting for
 * QA across the organization's orders (migration 0138).
 *
 * This is QA's worklist: what was ordered, by whom, for which customer, the
 * document's rule as it stands NOW, who a release would mail, and whether a
 * release would go through (a document archived, expired or locked since the
 * order was sent is listed with the reason, so QA is not offered a button that
 * will be refused).
 *
 * THE LIST IS FOR PEOPLE WHO CAN ACT ON IT. A QA releaser or an administrator
 * gets the lines; anybody else gets `can_release: false` and an empty list --
 * a 200, not a 403, so the navigation can ask for the count without an error
 * on every page load. A salesperson sees their own waiting lines on the order
 * itself. An API key is never a releaser.
 *
 * Under the fulfillment module, like the orders the lines belong to.
 */
import { BadRequestError, errorToResponse, requireTenantAccess } from '../../lib/permissions';
import { countPendingOrderDocuments, listPendingOrderDocuments } from '../../lib/order-documents';
import { exitActorForRequest } from '../../lib/sharing-rule';
import type { PendingOrderDocumentsCount, PendingOrderDocumentsResponse } from '../../../shared/types';
import type { Env, User } from '../../lib/types';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const url = new URL(context.request.url);
    let tenantId = url.searchParams.get('tenant_id');
    if (user.role !== 'super_admin') tenantId = user.tenant_id;
    if (!tenantId) throw new BadRequestError('tenant_id is required');
    requireTenantAccess(user, tenantId);

    const actor = await exitActorForRequest(context.env.DB, context.data, user, tenantId);
    const canRelease = actor.method === 'jwt' && actor.canReleaseQa;

    // `?count=1` is what the rail asks: ONE COUNT, none of the live judgement
    // the list runs over every line.
    if (url.searchParams.get('count') === '1') {
      const body: PendingOrderDocumentsCount = {
        can_release: canRelease,
        count: canRelease ? await countPendingOrderDocuments(context.env.DB, tenantId) : 0,
      };
      return json(body);
    }
    if (!canRelease) {
      const empty: PendingOrderDocumentsResponse = { can_release: false, count: 0, lines: [] };
      return json(empty);
    }
    const lines = await listPendingOrderDocuments(context.env.DB, tenantId, actor);
    const body: PendingOrderDocumentsResponse = { can_release: true, count: lines.length, lines };
    return json(body);
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Pending order documents error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
};
