/**
 * POST /api/search/interpret — how typed text reads, without running it
 * (search redesign Phase 2).
 *
 * Body: `SearchInterpretRequest` { text, tenant_id? }.
 * Response: `SearchInterpretResponse` { clauses, residual, labels }.
 *
 * The omnibox calls this when Enter is pressed before the live search has
 * answered, so what it keeps is the tenant-aware reading and never a guess;
 * the command palette calls it to show how a phrase will read before it is
 * run. One D1 batch; nothing is judged and nothing is written. Detected
 * clauses are returned, never applied — the caller decides.
 */

import { BadRequestError, errorToResponse, requireRole, requireTenantAccess } from '../../lib/permissions';
import { callerHasModule } from '../../lib/module-access';
import { interpretQueryText } from '../../lib/search/interpretText';
import type { Env, User } from '../../lib/types';
import type { SearchInterpretRequest } from '../../../shared/types';

export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireRole(user, 'super_admin', 'org_admin', 'user', 'reader');

    let body: SearchInterpretRequest;
    try {
      body = (await context.request.json()) as SearchInterpretRequest;
    } catch {
      throw new BadRequestError('Invalid JSON body');
    }
    if (!body || typeof body.text !== 'string') throw new BadRequestError('text is required');

    let tenantId = body.tenant_id || null;
    if (user.role !== 'super_admin') tenantId = user.tenant_id;
    if (!tenantId) throw new BadRequestError('tenant_id is required');
    requireTenantAccess(user, tenantId);

    const fulfillment = await callerHasModule(context.env.DB, user, context.data, 'fulfillment');
    const result = await interpretQueryText(context.env.DB, tenantId, body.text, { fulfillment });
    const body2 = fulfillment ? result : { ...result, modules_not_applied: ['fulfillment' as const] };
    return new Response(JSON.stringify(body2), { headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Search interpret error:', err);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
