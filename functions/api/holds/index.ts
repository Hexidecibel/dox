/**
 * GET /api/holds[?tenant_id=&state=&source=&supplier_id=&product_id=]
 * GET /api/holds?count=1
 *
 * The organization's holds (decision C-005, migration 0139): what is on hold,
 * since when, why, who placed it. `state` is `active` (the default),
 * `released` or `all`; `source` is `person`, `spec_critical` or
 * `zero_tolerance`.
 *
 * `?count=1` is what the navigation asks, on a timer: ONE COUNT of active
 * holds, no joins.
 *
 * WHO READS. Anybody signed in to the organization, a read-only account
 * included: a hold explains why a certificate did not go, and the person who
 * needs that explanation is often not QA. Only a QA releaser or an
 * administrator is told `can_release: true`.
 *
 * NOT UNDER ANY MODULE. A hold is on a document; it exists whether or not the
 * organization has orders or compliance switched on.
 */
import { BadRequestError, errorToResponse, requireTenantAccess } from '../../lib/permissions';
import { canReleaseHold, countActiveHolds, listHolds, parseHoldsFilter } from '../../lib/holds';
import type { HoldsCountResponse, HoldsListResponse } from '../../../shared/types';
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

    if (url.searchParams.get('count') === '1') {
      const body: HoldsCountResponse = { count: await countActiveHolds(context.env.DB, tenantId) };
      return json(body);
    }
    const filter = parseHoldsFilter(url.searchParams);
    const listed = await listHolds(context.env.DB, tenantId, filter);
    const body: HoldsListResponse = {
      ...listed,
      can_release: await canReleaseHold(context.env.DB, context.data, user, tenantId),
    };
    return json(body);
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Holds list error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
};
