/**
 * POST /api/spec-tests/:id/aliases — teach an analyte a spelling it did not know.
 *
 * WHY NOT JUST PUT THE ANALYTE. `PUT /api/spec-tests/:id` replaces the whole
 * alias array, which is right for an editor whose text box holds the current
 * list and wrong for a one-click "add this spelling" on a worklist: the panel
 * would have to send back a list it read seconds ago, and a second admin's
 * addition in between would be deleted by the first admin's click. That failure
 * is invisible — the limit stays configured, it just stops matching one
 * supplier's certificates, which is the precise failure this whole screen
 * exists to surface. `bin/lib/specLimitsImport.js` made the same call for the
 * same reason: a re-import is strictly ADDITIVE.
 *
 * So this endpoint merges. It never removes a spelling, it answers with what it
 * actually added (an alias already present is reported, not an error), and it
 * refuses a spelling that is already the analyte's own name, which would match
 * anyway and is pure noise.
 *
 * ONE ALIAS CAN ONLY BELONG TO ONE ANALYTE. `matchSpecTest` tries names first
 * and then aliases in list order, so the same spelling configured on two
 * analytes would resolve by accident of ordering — and applying the wrong
 * limit is the same class of error as applying none while claiming otherwise.
 * A spelling already claimed elsewhere is a 409 naming the analyte that holds it.
 */

import { logAudit, getClientIp } from '../../../lib/db';
import {
  requireRole,
  requireTenantAccess,
  NotFoundError,
  errorToResponse,
} from '../../../lib/permissions';
import { sanitizeString } from '../../../lib/validation';
import { normalizeTestName } from '../../../../shared/specCheck';
import type { Env, User } from '../../../lib/types';

function bad(message: string, status = 400): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function parseAliases(raw: unknown): string[] {
  try {
    const parsed = JSON.parse(String(raw ?? '[]'));
    return Array.isArray(parsed) ? parsed.map((a) => String(a)) : [];
  } catch {
    // A corrupt blob costs this analyte its synonyms; it must not cost the
    // caller the one it is adding, so we start a fresh list rather than throw.
    return [];
  }
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireRole(user, 'super_admin', 'org_admin');

    const specTest = (await context.env.DB.prepare('SELECT * FROM spec_tests WHERE id = ?')
      .bind(context.params.id as string)
      .first()) as Record<string, unknown> | null;
    if (!specTest) throw new NotFoundError('Analyte not found');
    const tenantId = specTest.tenant_id as string;
    requireTenantAccess(user, tenantId);

    const body = (await context.request.json()) as { name?: string; names?: unknown };
    const incoming: string[] = [];
    if (typeof body.name === 'string') incoming.push(body.name);
    if (Array.isArray(body.names)) for (const n of body.names) incoming.push(String(n));

    const cleaned = incoming.map((n) => sanitizeString(n).trim()).filter(Boolean);
    if (cleaned.length === 0) return bad('name is required');

    const existing = parseAliases(specTest.aliases);
    const nameKey = normalizeTestName(specTest.name);
    const index = new Map(existing.map((a) => [normalizeTestName(a), a]));

    // Every other analyte in this tenant, so a spelling cannot be claimed twice.
    const othersRes = await context.env.DB.prepare(
      'SELECT id, name, aliases FROM spec_tests WHERE tenant_id = ? AND id != ?'
    )
      .bind(tenantId, specTest.id as string)
      .all();
    const claimed = new Map<string, string>();
    for (const r of (othersRes.results ?? []) as Record<string, unknown>[]) {
      claimed.set(normalizeTestName(r.name), String(r.name));
      for (const a of parseAliases(r.aliases)) claimed.set(normalizeTestName(a), String(r.name));
    }

    const added: string[] = [];
    const alreadyPresent: string[] = [];
    const sameAsName: string[] = [];
    for (const name of cleaned) {
      const key = normalizeTestName(name);
      if (!key) continue;
      if (key === nameKey) {
        sameAsName.push(name);
        continue;
      }
      const owner = claimed.get(key);
      if (owner) {
        return new Response(
          JSON.stringify({
            error: `"${name}" is already how "${owner}" is recognised. One spelling can only mean one analyte — remove it there first.`,
            analyte: owner,
          }),
          { status: 409, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (index.has(key)) {
        alreadyPresent.push(name);
        continue;
      }
      index.set(key, name);
      existing.push(name);
      added.push(name);
    }

    if (added.length > 0) {
      await context.env.DB.prepare(
        "UPDATE spec_tests SET aliases = ?, updated_at = datetime('now'), updated_by = ? WHERE id = ?"
      )
        .bind(JSON.stringify(existing), user.id, specTest.id as string)
        .run();

      await logAudit(
        context.env.DB,
        user.id,
        tenantId,
        'spec_test.alias_added',
        'spec_tests',
        specTest.id as string,
        JSON.stringify({
          analyte: specTest.name,
          added,
          // The whole resulting list, so the audit row answers "what did this
          // analyte recognise afterwards?" without replaying every earlier row.
          aliases: existing,
        }),
        getClientIp(context.request)
      );
    }

    const updated = await context.env.DB.prepare('SELECT * FROM spec_tests WHERE id = ?')
      .bind(specTest.id as string)
      .first<Record<string, unknown>>();

    return new Response(
      JSON.stringify({
        specTest: { ...updated, aliases: parseAliases(updated?.aliases) },
        added,
        already_present: alreadyPresent,
        same_as_name: sameAsName,
      }),
      { status: added.length > 0 ? 201 : 200, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Add spec-test alias error:', err);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
