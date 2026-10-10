import { getClientIp } from '../../lib/db';
import { drainSoon } from '../../lib/search-reindex';
import {
  requireRole,
  requireTenantAccess,
  BadRequestError,
  NotFoundError,
  errorToResponse,
} from '../../lib/permissions';
import { getStarterPack } from '../../lib/starterPacks.generated';
import { PackRollForwardRefused, runPackRollForward } from '../../lib/pack-roll-forward';
import { PackVersionBehindError } from '../../../shared/packRollForward';
import type { Env, User } from '../../lib/types';
import type { PackRollForwardRequest } from '../../../shared/types';

/**
 * POST /api/starter-packs/roll-forward — THE ONE DOOR a pack update comes
 * through for an organisation that already exists.
 *
 * `dry_run` DEFAULTS TO TRUE. A request that does not say `"dry_run": false`
 * returns the plan and writes nothing -- not a row, not a ledger entry, not a
 * version. An apply recomputes the plan and writes what it then says; every
 * update is guarded in SQL by the value it was planned against, so an edit made
 * between the preview and the apply wins and is reported.
 *
 * WHAT IT WILL AND WILL NOT DO is the header of shared/packRollForward.ts. In
 * one line each: a row that still holds what the pack wrote is updated; a row
 * the organisation changed is kept and reported with both values, and changed
 * only when named in `accept`; a new item is inserted, or adopted when a row
 * already holds its slug; an item the pack dropped is flagged and left alone;
 * what the organisation deleted or switched off stays that way. It never
 * changes a slug, never deletes, and never loosens a sharing rule.
 *
 * AN ORGANISATION WITH NO LEDGER IS REFUSED (409 `not_ledgered`), dry run
 * included. With no record of what the pack wrote, every pack item the
 * organisation lacks would look "new" and be inserted -- including the ones it
 * deleted on purpose. `bin/baseline-pack-ledger` is what establishes the
 * record, from a report a person reads first.
 *
 * AN APPLY RUNS THE PLAN THAT WAS PREVIEWED. The dry run returns
 * `plan_fingerprint`; a non-dry run must send it back as `fingerprint` and is
 * refused when there is none (409 `preview_required`) or when the plan computed
 * at that moment is a different one (409 `plan_changed`: the pack, or a row it
 * touches, moved since the person looked).
 *
 * A VERSION NEVER GOES BACKWARDS: an organisation on a newer version than this
 * build ships is refused (409 `pack_version_behind`), dry run included.
 *
 * Role: super_admin, org_admin. AN API KEY MAY PREVIEW AND MAY NOT APPLY
 * (decision C-183): rewriting an organisation's vocabulary and limits is an
 * act a signed-in administrator answers for, like releasing a held document.
 * 403 `signed_in_admin_required`, in words.
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

    const body = (await context.request.json().catch(() => null)) as PackRollForwardRequest | null;
    if (!body || typeof body !== 'object') throw new BadRequestError('A JSON body is required');

    const tenantId =
      user.role === 'super_admin' ? (body.tenant_id ?? user.tenant_id) : user.tenant_id;
    if (!tenantId) throw new BadRequestError('tenant_id is required');
    requireTenantAccess(user, tenantId);

    const dryRun = body.dry_run !== false;
    // REQUIRES a signed-in session, rather than refusing a key: an auth method
    // this route has never heard of, or none on record, is refused too.
    if (!dryRun && context.data.authMethod !== 'jwt') {
      return json(
        {
          error:
            'An API key can preview a starter-pack update and cannot apply one. ' +
            'Applying changes this organisation\'s document types, requirements and limits, ' +
            'so a signed-in administrator does it, on Settings > Starter pack.',
          code: 'signed_in_admin_required',
        },
        403,
      );
    }
    if (body.accept !== undefined && !Array.isArray(body.accept)) {
      throw new BadRequestError('accept must be a list of { kind, key, field? }');
    }
    const accept = body.accept ?? [];
    if (accept.length > 2000) throw new BadRequestError('At most 2000 accepted items per call');

    const tenant = await context.env.DB.prepare('SELECT id, slug FROM tenants WHERE id = ?')
      .bind(tenantId)
      .first<{ id: string; slug: string | null }>();
    if (!tenant) throw new NotFoundError('Tenant not found');

    const ledgered = await context.env.DB.prepare(
      'SELECT DISTINCT pack FROM tenant_packs WHERE tenant_id = ? ORDER BY pack',
    )
      .bind(tenantId)
      .all<{ pack: string }>();
    const packsOn = (ledgered.results ?? []).map((r) => r.pack);

    let packName = body.pack ? String(body.pack).trim() : '';
    if (!packName) {
      if (packsOn.length === 1) packName = packsOn[0];
      else if (packsOn.length > 1) {
        throw new BadRequestError(`This organisation is on several packs (${packsOn.join(', ')}): say which with "pack"`);
      }
    }
    if (!packName || !packsOn.includes(packName)) {
      return json(
        {
          error:
            'This organisation has no starter-pack record' +
            (packName ? ` for "${packName}"` : '') +
            '. It was set up before pack versions existed, or never took this pack. ' +
            'Without a record of what the pack wrote, an update cannot tell a new item from one this organisation removed, ' +
            'so nothing is rolled forward until it has been baselined (bin/baseline-pack-ledger).',
          code: 'not_ledgered',
        },
        409,
      );
    }
    const pack = getStarterPack(packName);
    if (!pack) throw new NotFoundError(`Unknown starter pack: ${packName}`);

    const result = await runPackRollForward(context.env.DB, {
      tenantId,
      // Seeds the id of a row this inserts; nothing is looked up by it, so the
      // tenant id stands in for an organisation with no slug.
      tenantSlug: tenant.slug || tenantId,
      pack,
      dryRun,
      accept,
      fingerprint: typeof body.fingerprint === 'string' ? body.fingerprint : null,
      actorId: user.id,
      ip: getClientIp(context.request),
    });
    // A renamed type or requirement is searchable text.
    if (!dryRun) drainSoon(context, context.env.DB);
    return json(result);
  } catch (err) {
    if (err instanceof PackRollForwardRefused) {
      return json({ error: err.message, code: err.code }, err.status);
    }
    if (err instanceof PackVersionBehindError) {
      return json(
        { error: err.message, code: err.code, version: err.onVersion, available_version: err.offeredVersion },
        409,
      );
    }
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('starter-pack roll-forward error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
};
