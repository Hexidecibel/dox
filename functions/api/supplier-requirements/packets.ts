/**
 * GET /api/supplier-requirements/packets — the requirement packets an admin
 * can apply from Supplier Requirements / Supplier detail, from the tenant's
 * starter pack (the one its setup wizard chose, else the default).
 */

import { requireRole, errorToResponse } from '../../lib/permissions';
import { resolveTenantPack } from '../../lib/requirement-derivation';
import type { Env, User } from '../../lib/types';
import type { RequirementPacketCatalogResponse } from '../../../shared/types';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireRole(user, 'super_admin', 'org_admin');
    const url = new URL(context.request.url);
    const tenantId =
      user.role === 'super_admin' ? url.searchParams.get('tenant_id') || user.tenant_id : user.tenant_id;
    if (!tenantId) return json({ error: 'tenant_id is required' }, 400);

    const pack = await resolveTenantPack(context.env.DB, tenantId, url.searchParams.get('pack'));
    const response: RequirementPacketCatalogResponse = {
      pack: pack.pack,
      pack_label: pack.label,
      packets: pack.requirement_packets.map((p) => ({
        slug: p.slug,
        name: p.name,
        description: p.description,
        requirements: [...p.requirements],
        recommends: [...p.recommends],
      })),
    };
    return json(response);
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('list requirement packets error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
};
