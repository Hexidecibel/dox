import { logAudit, getClientIp } from '../../lib/db';
import {
  requireRole,
  requireTenantAccess,
  BadRequestError,
  errorToResponse,
} from '../../lib/permissions';
import {
  countActiveDocuments,
  createDraftRun,
  decideSetupNeed,
  getDraftRun,
  getLatestCompletedRun,
} from '../../lib/tenant-setup';
import type { Env, User } from '../../lib/types';
import type { CreateTenantSetupRequest, TenantSetupResponse } from '../../../shared/types';

/**
 * /api/tenant-setup — the first-run wizard's position marker.
 *
 * The row this endpoint manages records WHERE SOMEBODY GOT TO. It is not a
 * staging area: screen 1 seeds the tenant through `/api/starter-packs/apply`,
 * screen 3 writes `owner_routes`, and each of those is a real write to a real
 * table the moment it happens. Abandoning a run at screen 4 therefore leaves a
 * partially configured tenant, which is the same thing half an hour of manual
 * admin work leaves, and every pack write is `INSERT OR IGNORE` on a
 * deterministic id so nothing is ever clobbered on a re-run.
 *
 * See `migrations/0101_tenant_setup_runs.sql` for why stage-then-commit was
 * rejected: a staged step 1 makes screens 2-6 render from a JSON blob instead
 * of from the tenant, which is how a wizard comes to "work" over a tenant that
 * does not.
 *
 * Role: super_admin, org_admin — the same tier as every other screen that
 * configures a tenant.
 */

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Resolve which tenant this call is about.
 *
 * A super_admin may pass `tenant_id` (they scope into tenants routinely, and
 * the wizard is exactly the sort of thing they run on somebody's behalf);
 * everyone else is pinned to their own, whatever they sent.
 */
function resolveTenantId(user: User, requested: string | null | undefined): string {
  const tenantId = user.role === 'super_admin' ? (requested ?? user.tenant_id) : user.tenant_id;
  if (!tenantId) throw new BadRequestError('tenant_id is required');
  requireTenantAccess(user, tenantId);
  return tenantId;
}

/**
 * GET /api/tenant-setup[?tenant_id=]
 *
 * Returns `{ run, needed, reason, document_count, has_completed_run }`.
 *
 * `needed` is TRUE ONLY WHEN BOTH hold: no completed run exists AND the tenant
 * has zero active documents. Either test alone is wrong in a way somebody
 * notices — see `decideSetupNeed`. `reason` is returned so the banner can
 * explain itself rather than silently not appearing.
 *
 * `run` prefers the draft in flight and falls back to the most recent completed
 * run, so a caller that just wants "was this tenant ever set up, and by whom"
 * does not need a second request.
 */
export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireRole(user, 'super_admin', 'org_admin');

    const url = new URL(context.request.url);
    const tenantId = resolveTenantId(user, url.searchParams.get('tenant_id'));

    const [draft, completed, documentCount] = await Promise.all([
      getDraftRun(context.env.DB, tenantId),
      getLatestCompletedRun(context.env.DB, tenantId),
      countActiveDocuments(context.env.DB, tenantId),
    ]);

    const { needed, reason } = decideSetupNeed(completed !== null, documentCount, draft !== null);

    const body: TenantSetupResponse = {
      run: draft ?? completed,
      needed,
      reason,
      document_count: documentCount,
      has_completed_run: completed !== null,
    };
    return json(body);
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('tenant-setup get error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
};

/**
 * POST /api/tenant-setup
 * Body: { tenant_id?, restart?, pack? }
 *
 * Returns the EXISTING draft when there is one — pressing "Set up" twice, or
 * opening /setup in a second tab, must resume rather than fork a second
 * half-finished walk-through. `{ restart: true }` is the explicit opt-out: it
 * marks the current draft `abandoned` and opens a fresh run, which is what
 * somebody re-aiming a tenant at a different vertical wants.
 *
 * A restart does NOT undo anything screen 1 seeded, and cannot: the rows are
 * already in the tenant's own tables and may have been edited since. Starting
 * over means walking the screens again, not emptying the tenant.
 */
export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireRole(user, 'super_admin', 'org_admin');

    const body = (await context.request.json().catch(() => ({}))) as CreateTenantSetupRequest;
    const tenantId = resolveTenantId(user, body.tenant_id);

    const existing = await getDraftRun(context.env.DB, tenantId);
    const restart = body.restart === true;

    const run = await createDraftRun(context.env.DB, tenantId, user.id, {
      restart,
      pack: body.pack ?? null,
    });

    // Only audit a run that actually opened. Returning the existing draft is a
    // read dressed as a POST and does not deserve a row; a restart does,
    // because it is a decision somebody made about a tenant.
    if (!existing || restart) {
      await logAudit(
        context.env.DB,
        user.id,
        tenantId,
        restart ? 'tenant_setup.restart' : 'tenant_setup.start',
        'tenant_setup_run',
        run.id,
        JSON.stringify({ pack: run.pack, abandoned: restart ? existing?.id ?? null : null }),
        getClientIp(context.request),
      );
    }

    return json({ run }, existing && !restart ? 200 : 201);
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('tenant-setup create error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
};
