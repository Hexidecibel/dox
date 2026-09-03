import { errorToResponse } from '../../lib/permissions';
import { loadModuleAccess } from '../../lib/module-access';
import type { Env, User } from '../../lib/types';
import type { Role } from '../../../shared/types';

/**
 * GET /api/module-access — what the SIGNED-IN user may see.
 *
 * ANY authenticated user, deliberately. `/api/modules` answers about the
 * organization and is admin-only; this one answers about the caller, and the
 * caller is the nav bar. A reader has to be able to ask what their own portal
 * contains, or the nav has nothing to render from and the module gate becomes
 * a 403 with no explanation in front of it.
 *
 * It returns BOTH layers. `tenant_enabled` is the ceiling and `visible` is the
 * ceiling narrowed by this person's functions, so a support answer can be
 * specific about which of the two is hiding something — "your company does not
 * use Orders" and "your role does not include Orders" are fixed on different
 * screens by different people.
 *
 * Never fails on a database error: `loadModuleAccess` falls open and sets
 * `degraded`, because module visibility is a scope control and not a
 * confidentiality boundary. A nav that briefly shows too much beats a nav that
 * shows nothing.
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
    const access = await loadModuleAccess(context.env.DB, user);
    return json({
      tenant_id: user.tenant_id ?? null,
      role: user.role as Role,
      tenant_enabled: access.tenantEnabled,
      visible: access.visible,
      functions: access.functions,
      degraded: access.degraded,
    });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('module-access error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
};
