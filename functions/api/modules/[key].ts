import { logAudit, getClientIp } from '../../lib/db';
import { requireRole, BadRequestError, errorToResponse } from '../../lib/permissions';
import { isModuleKey, MODULES } from '../../../shared/modules';
import { readTenantModuleRows, buildModuleSummaries, resolveSettingsTenantId } from './index';
import type { Env, User } from '../../lib/types';

/**
 * PUT /api/modules/:key — switch one module on or off for one tenant.
 *
 * Role: super_admin, org_admin. Deciding which parts of the portal a company
 * uses is an organization-level decision, so it sits with the same two roles
 * that already manage users and routing.
 *
 * ALWAYS WRITES A ROW, even when the new state matches the code default. The
 * absence of a row means "nobody has decided", and once somebody HAS decided
 * that is worth recording — with who and when — so that a later change to a
 * default cannot silently move a tenant that had explicitly chosen the same
 * thing. (Defaults are frozen once a module ships for exactly this reason; see
 * `shared/modules.ts`.)
 *
 * The audit action is `module.enabled` / `module.disabled` rather than a
 * single `module.update` with the value in the details: turning a module OFF
 * is the event somebody goes looking for months later — "when did Orders
 * disappear" — and a distinct action name makes that one filter instead of a
 * JSON scan.
 */

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export const onRequestPut: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireRole(user, 'super_admin', 'org_admin');

    const key = context.params.key as string;
    // An unknown key is a 400, not a 404: the caller named something that is
    // not part of this build's vocabulary at all, and writing the row anyway
    // would leave a decision behind that can never produce a surface.
    if (!isModuleKey(key)) throw new BadRequestError(`Unknown module: ${String(key)}`);

    const body = (await context.request.json().catch(() => ({}))) as {
      enabled?: unknown;
      tenant_id?: string;
    };
    if (typeof body.enabled !== 'boolean') {
      throw new BadRequestError('enabled must be a boolean');
    }

    const url = new URL(context.request.url);
    const tenantId = resolveSettingsTenantId(
      user,
      body.tenant_id ?? url.searchParams.get('tenant_id'),
    );

    await context.env.DB.prepare(
      `INSERT INTO tenant_modules (tenant_id, module_key, enabled, updated_by)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(tenant_id, module_key) DO UPDATE SET
         enabled = excluded.enabled,
         updated_at = datetime('now'),
         updated_by = excluded.updated_by`,
    )
      .bind(tenantId, key, body.enabled ? 1 : 0, user.id)
      .run();

    await logAudit(
      context.env.DB,
      user.id,
      tenantId,
      body.enabled ? 'module.enabled' : 'module.disabled',
      'module',
      key,
      JSON.stringify({ module_key: key, label: MODULES[key].label, enabled: body.enabled }),
      getClientIp(context.request),
    );

    const rows = await readTenantModuleRows(context.env.DB, tenantId);
    const summary = buildModuleSummaries(rows).find((m) => m.key === key);
    return json({ module: summary });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('module update error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
};
