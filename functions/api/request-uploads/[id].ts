/**
 * GET /api/request-uploads/:id — one supplier arrival, as staff see it.
 *
 * Tenant scoping is in the WHERE clause, so another tenant's id is a 404 and
 * not a probe. Any tenant user may read. See ./index.ts for what is never in
 * the payload.
 */

import { errorToResponse } from '../../lib/permissions';
import { loadArrival, resolveTenantForUpload } from '../../lib/request-arrivals';
import type { RequestArrivalResponse } from '../../../shared/types';
import type { Env, User } from '../../lib/types';

export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const id = context.params.id as string;
    const tenantId = await resolveTenantForUpload(context.env.DB, user, id);
    const body: RequestArrivalResponse = { arrival: await loadArrival(context.env.DB, tenantId, id) };
    return new Response(JSON.stringify(body), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Get request upload error:', err);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
