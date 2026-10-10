import { requireRole, requireTenantAccess, BadRequestError, errorToResponse } from '../../lib/permissions';
import { getStarterPack } from '../../lib/starterPacks.generated';
import { listTenantPackStatus } from '../../lib/pack-roll-forward';
import type { Env, User } from '../../lib/types';
import type { TenantPackStatusResponse } from '../../../shared/types';

/**
 * GET /api/starter-packs/status — which pack and version this organisation is
 * on, and whether a newer one ships with this build. Settings > Starter pack
 * opens with it.
 *
 * `not_ledgered` is the honest third state. An organisation set up before
 * migration 0141 has the pack's rows and no record of them; saying "you are on
 * version 1" would be a guess, and saying nothing would hide that updates
 * cannot reach it yet. It is reported as what it is, with the pack its setup
 * run named when there was one.
 *
 * Role: super_admin, org_admin. `?tenant_id=` for a super_admin.
 */

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
      user.role === 'super_admin' ? (url.searchParams.get('tenant_id') ?? user.tenant_id) : user.tenant_id;
    if (!tenantId) throw new BadRequestError('tenant_id is required');
    requireTenantAccess(user, tenantId);

    const packs = await listTenantPackStatus(context.env.DB, tenantId, getStarterPack);

    let notLedgered: TenantPackStatusResponse['not_ledgered'] = null;
    if (packs.length === 0) {
      const run = await context.env.DB.prepare(
        `SELECT pack FROM tenant_setup_runs
          WHERE tenant_id = ? AND pack IS NOT NULL
          ORDER BY updated_at DESC LIMIT 1`,
      )
        .bind(tenantId)
        .first<{ pack: string }>();
      const vocab = await context.env.DB.prepare(
        `SELECT (SELECT COUNT(*) FROM requirements WHERE tenant_id = ?1) +
                (SELECT COUNT(*) FROM document_types WHERE tenant_id = ?1) AS n`,
      )
        .bind(tenantId)
        .first<{ n: number }>();
      // An organisation with no vocabulary at all is simply new: nothing to
      // baseline, and the setup wizard is where it takes a pack.
      if (run?.pack || Number(vocab?.n ?? 0) > 0) notLedgered = { pack: run?.pack ?? null };
    }

    const body: TenantPackStatusResponse = { tenant_id: tenantId, packs, not_ledgered: notLedgered };
    return json(body);
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('starter-pack status error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
};
