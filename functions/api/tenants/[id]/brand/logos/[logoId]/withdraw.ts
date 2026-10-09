/**
 * POST /api/tenants/:id/brand/logos/:logoId/withdraw -- make a published logo
 * unreachable (migration 0140, decision C-111).
 *
 * A replaced or removed logo normally STAYS at its URL, because mail already
 * sent points at it. Withdrawing is the exception a person chooses: the image
 * is deleted from storage, its URL answers 404 from now on, and the row is
 * kept, marked with who withdrew it and why. Mail already sent that shows this
 * logo will show a broken image; the settings screen says so before the act.
 *
 * Body: `{ "reason": "..." }`, required, one line, 300 characters at most.
 *
 * WHO: a signed-in org_admin of THAT tenant, or a super_admin. Not an API key:
 * it deletes a published file. Any of the tenant's logos may be withdrawn, the
 * current one included (it is taken off the brand in the same act). A logo id
 * that belongs to another tenant is a 404, the same as one that does not exist.
 *
 * Withdrawing twice is not an error and writes no second audit row.
 */

import { getClientIp } from '../../../../../../lib/db';
import { ForbiddenError, errorToResponse } from '../../../../../../lib/permissions';
import {
  BrandValidationError,
  brandResponse,
  requireBrandAdmin,
  withdrawBrandLogo,
} from '../../../../../../lib/tenant-brand';
import type { Env, User } from '../../../../../../lib/types';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const tenantId = context.params.id as string;
    const logoId = context.params.logoId as string;
    requireBrandAdmin(user, tenantId);
    if (context.data.authMethod === 'api_key') {
      throw new ForbiddenError('A logo is withdrawn by a signed-in administrator, not with an API key');
    }

    let body: { reason?: unknown };
    try {
      body = (await context.request.json()) as { reason?: unknown };
    } catch {
      return json({ error: 'The request body must be JSON with a "reason"' }, 400);
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return json({ error: 'The request body must be JSON with a "reason"' }, 400);
    }

    // The bucket is named here so the exit register sees this file reaches it.
    const outcome = await withdrawBrandLogo(
      { DB: context.env.DB, FILES: context.env.FILES },
      tenantId,
      logoId,
      body.reason,
      { userId: user.id, ip: getClientIp(context.request) },
    );
    if (!outcome.ok) {
      return json({ error: outcome.reason === 'tenant_not_found' ? 'Tenant not found' : 'Logo not found' }, 404);
    }
    return json(await brandResponse(context.env.DB, outcome.brand));
  } catch (err) {
    if (err instanceof BrandValidationError) return json({ error: err.message }, 400);
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Tenant brand logo withdrawal error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
};
