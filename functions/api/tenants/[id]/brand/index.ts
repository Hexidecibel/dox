/**
 * GET / PUT /api/tenants/:id/brand -- the tenant brand record (migration 0140).
 *
 * WHO: an org_admin of THAT tenant, or a super_admin. Nobody else reads it
 * here -- a `user` or a `reader` has no use for the admin view, and what
 * outsiders are given travels inside the token routes' own payloads
 * (`loadPublicBrand`), never through this endpoint.
 *
 * AN API KEY MAY USE BOTH VERBS. A key authenticates as the admin who created
 * it, and the text and colour fields are configuration like any other. The
 * logo is different (see ./logo.ts): publishing a file is done by a person.
 *
 * PUT is a patch: a field left out is unchanged, null or '' clears it,
 * `support_overrides` replaces the whole set. The first save that SETS
 * something creates the row; a save that changes nothing writes nothing (an
 * empty body on an unbranded tenant creates no row); clearing the last field
 * deletes the row, and the tenant is unbranded again. Every change writes one
 * `tenant.brand_updated` audit row with the old and new value of each field
 * that moved.
 *
 * DELETE is "Remove brand": everything cleared and the logo taken off in one
 * act, audited (`removed: true`). A signed-in person only -- it takes the logo
 * off, and the logo is not an API key's to manage. Published logos stay
 * reachable until they are withdrawn.
 */

import { getClientIp } from '../../../../lib/db';
import { ForbiddenError, errorToResponse } from '../../../../lib/permissions';
import {
  BrandValidationError,
  loadTenantBrand,
  requireBrandAdmin,
  saveTenantBrand,
  brandResponse,
  removeTenantBrand,
} from '../../../../lib/tenant-brand';
import type { Env, User } from '../../../../lib/types';
import type { TenantBrandUpdateRequest } from '../../../../../shared/types';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const tenantId = context.params.id as string;
    requireBrandAdmin(user, tenantId);
    const brand = await loadTenantBrand(context.env.DB, tenantId);
    if (!brand) return json({ error: 'Tenant not found' }, 404);
    return json(await brandResponse(context.env.DB, brand));
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Tenant brand read error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
};

export const onRequestPut: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const tenantId = context.params.id as string;
    requireBrandAdmin(user, tenantId);

    let body: TenantBrandUpdateRequest;
    try {
      body = (await context.request.json()) as TenantBrandUpdateRequest;
    } catch {
      return json({ error: 'The request body must be JSON' }, 400);
    }

    const brand = await saveTenantBrand(context.env.DB, tenantId, body, {
      userId: user.id,
      ip: getClientIp(context.request),
      via: context.data.authMethod === 'api_key' ? 'api_key' : 'jwt',
    });
    if (!brand) return json({ error: 'Tenant not found' }, 404);
    return json(await brandResponse(context.env.DB, brand));
  } catch (err) {
    if (err instanceof BrandValidationError) return json({ error: err.message }, 400);
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Tenant brand update error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
};

export const onRequestDelete: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const tenantId = context.params.id as string;
    requireBrandAdmin(user, tenantId);
    if (context.data.authMethod === 'api_key') {
      throw new ForbiddenError('A brand is removed by a signed-in administrator, not with an API key');
    }
    const brand = await removeTenantBrand(context.env.DB, tenantId, {
      userId: user.id,
      ip: getClientIp(context.request),
    });
    if (!brand) return json({ error: 'Tenant not found' }, 404);
    return json(await brandResponse(context.env.DB, brand));
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Tenant brand removal error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
};
