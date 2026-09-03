import { logAudit, getClientIp } from '../../lib/db';
import {
  requireRole,
  requireTenantAccess,
  BadRequestError,
  NotFoundError,
  errorToResponse,
} from '../../lib/permissions';
import { applyStarterPack } from '../../lib/starter-packs';
import { getStarterPack } from '../../lib/starterPacks.generated';
import { getRunById, stampApplied } from '../../lib/tenant-setup';
import type { Env, User } from '../../lib/types';
import type {
  ApplyStarterPackRequest,
  ApplyStarterPackResponse,
  TenantSetupPackApplication,
  TenantSetupRun,
} from '../../../shared/types';

/**
 * POST /api/starter-packs/apply — screen 1 of the setup wizard, doing the thing.
 *
 * This is the SAME seeding `bin/create-tenant --pack fsqa` performs, from
 * inside the portal: the same tables, the same deterministic `packRowId()`s and
 * the same `INSERT OR IGNORE`. Which means a tenant created with `--pack fsqa`
 * and then walked through the wizard collides on every key and inserts nothing,
 * and screen 1 can honestly tell somebody that re-running adds what is missing
 * and overwrites nothing.
 *
 * IT WRITES THROUGH, IMMEDIATELY, RATHER THAN STAGING. Screen 1's rows are what
 * screens 2-6 have to show. A staged pack would leave every later screen
 * rendering from a JSON blob while the tenant stayed empty — see the header of
 * `migrations/0101_tenant_setup_runs.sql`.
 *
 * `run_id` is optional. Given one, the result is stamped into that run's
 * `applied` ledger so screen 1 can render as a read-only summary on the way
 * back through. Without one this is just "seed my tenant from a pack", which is
 * a reasonable thing to want outside the wizard and is why the endpoint lives
 * under the pack resource rather than under the run.
 *
 * Role: super_admin, org_admin.
 */

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

    const body = (await context.request.json().catch(() => ({}))) as ApplyStarterPackRequest;

    const tenantId =
      user.role === 'super_admin' ? (body.tenant_id ?? user.tenant_id) : user.tenant_id;
    if (!tenantId) throw new BadRequestError('tenant_id is required');
    requireTenantAccess(user, tenantId);

    const packName = String(body.pack ?? '').trim();
    if (!packName) throw new BadRequestError('pack is required');
    const pack = getStarterPack(packName);
    if (!pack) throw new NotFoundError(`Unknown starter pack: ${packName}`);

    // The tenant SLUG is half of every deterministic row id, so a missing
    // tenant is a hard stop rather than something to invent a default for.
    const tenant = await context.env.DB.prepare('SELECT id, slug FROM tenants WHERE id = ?')
      .bind(tenantId)
      .first<{ id: string; slug: string | null }>();
    if (!tenant) throw new NotFoundError('Tenant not found');
    if (!tenant.slug) {
      throw new BadRequestError(
        'This tenant has no slug, and a pack row id is derived from it. Set a slug first.',
      );
    }

    const result = await applyStarterPack(context.env.DB, pack, tenantId, tenant.slug);

    let run: TenantSetupRun | null = null;
    if (body.run_id) {
      const target = await getRunById(context.env.DB, body.run_id);
      // A run id from another tenant is a bug or an attack; either way it must
      // not be stamped. The seeding above already happened against the tenant
      // the caller is entitled to, so this only skips the bookkeeping.
      if (target && target.tenant_id === tenantId) {
        const stamp: TenantSetupPackApplication = {
          name: pack.pack,
          applied_at: new Date().toISOString(),
          counts: { ...result.counts },
          already_seeded: result.inserted === 0,
        };
        run = await stampApplied(context.env.DB, body.run_id, 'pack', stamp);
        if (target.pack !== pack.pack) {
          await context.env.DB.prepare(
            `UPDATE tenant_setup_runs SET pack = ?, updated_at = datetime('now') WHERE id = ?`,
          )
            .bind(pack.pack, body.run_id)
            .run();
          run = await getRunById(context.env.DB, body.run_id);
        }
      }
    }

    await logAudit(
      context.env.DB,
      user.id,
      tenantId,
      'starter_pack.apply',
      'tenant',
      tenantId,
      JSON.stringify({ pack: pack.pack, inserted: result.inserted, counts: result.counts }),
      getClientIp(context.request),
    );

    const response: ApplyStarterPackResponse = {
      pack: result.pack,
      counts: { ...result.counts },
      inserted: result.inserted,
      run,
    };
    return json(response);
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('starter-pack apply error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
};
