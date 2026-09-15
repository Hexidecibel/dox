/**
 * POST /api/supplier-requirements/review — the worklist's bulk actions on rows
 * that need a person: unconfirmed rows from the initial bulk seed
 * (source IS NULL) and derived rows flagged as no longer on the verified list.
 *
 *   { action: 'confirm', ids }  stamp source 'human', clear the flag
 *   { action: 'remove',  ids }  hard delete (the existing detach semantics),
 *                               one audit row per row carrying the whole row
 *
 * "Replace with a packet" is POST /api/supplier-requirements/apply-packet with
 * `replace_unconfirmed: true`.
 *
 * Role: super_admin, org_admin.
 */

import { getClientIp } from '../../lib/db';
import { requireRole, BadRequestError, errorToResponse } from '../../lib/permissions';
import { resolveWriteTenant } from '../../lib/registry-vocab';
import { reviewSupplierRequirements } from '../../lib/requirement-derivation';
import type { Env, User } from '../../lib/types';
import type { SupplierRequirementReviewRequest, SupplierRequirementReviewResponse } from '../../../shared/types';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireRole(user, 'super_admin', 'org_admin');
    const body = (await context.request.json().catch(() => null)) as SupplierRequirementReviewRequest | null;
    if (!body || typeof body !== 'object') throw new BadRequestError('A JSON body is required');
    if (body.action !== 'confirm' && body.action !== 'remove') {
      throw new BadRequestError('action must be confirm or remove');
    }
    if (!Array.isArray(body.ids)) throw new BadRequestError('ids must be an array');
    const tenantId = resolveWriteTenant(user, body.tenant_id);

    const outcome = await reviewSupplierRequirements(context.env.DB, {
      tenantId,
      action: body.action,
      ids: body.ids,
      actorId: user.id,
      ip: getClientIp(context.request),
    });
    const response: SupplierRequirementReviewResponse = { action: body.action, ...outcome };
    return json(response);
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('supplier requirement review error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
};
