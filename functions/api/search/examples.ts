/**
 * GET /api/search/examples?tenant_id= — "Try" examples built from this
 * tenant's own approved documents, each verified by running it through the
 * search executor first (functions/lib/search/examples.ts).
 *
 * The tenant is the user's own; a super_admin names one with `tenant_id` and
 * gets a 400 without it (the workspace shows no examples then, the same way it
 * asks the super_admin to choose an organization before searching).
 * Response: `SearchExamplesResponse` — `examples: []` for a tenant with nothing
 * on file, and the page falls back to its static chips.
 */

import { BadRequestError, errorToResponse, requireRole, requireTenantAccess } from '../../lib/permissions';
import { buildSearchExamples } from '../../lib/search/examples';
import type { Env, User } from '../../lib/types';

export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireRole(user, 'super_admin', 'org_admin', 'user', 'reader');
    const url = new URL(context.request.url);
    let tenantId = url.searchParams.get('tenant_id') || null;
    if (user.role !== 'super_admin') tenantId = user.tenant_id;
    if (!tenantId) throw new BadRequestError('tenant_id is required');
    requireTenantAccess(user, tenantId);

    const result = await buildSearchExamples(context.env.DB, tenantId);
    return new Response(JSON.stringify(result), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, max-age=3600' },
    });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Search examples error:', err);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
