/**
 * "That is not a test."
 *
 * POST   /api/spec-unmatched/ignore  { name, reason? }  — dismiss a spelling
 * DELETE /api/spec-unmatched/ignore?name=…              — undo the dismissal
 *
 * WHY THE PANEL NEEDS THIS. On the live tenant the unmatched list is 195
 * spellings and only a dozen are analytes; the rest are the other things a COA
 * prints in a results table ("Flavor", "LOT CODE", "TIME IN", "Best By Date").
 * Without a way to say so once, the worklist can only grow, and the ten
 * spellings that ARE costing real checks sink into it — the same argument
 * migration 0095 makes about ranking limits.
 *
 * IT CHANGES NO VERDICT. Nothing in `shared/specCheck.ts` reads this table. The
 * result stays unjudged, still says so on the document, and is still counted in
 * the `unjudged` line a reviewer sees. This is a statement about a
 * configuration worklist, not about a certificate.
 *
 * KEYED ON THE MATCH KEY, not the printed text, so dismissing "Flavor" also
 * dismisses "FLAVOR" — an alias for either would have fixed both, so asking
 * twice would be asking the same question twice. Every write is audited, the
 * dismissed list is readable, and undo is one call.
 */

import { generateId, logAudit, getClientIp } from '../../lib/db';
import { requireRole, errorToResponse, NotFoundError } from '../../lib/permissions';
import { sanitizeString } from '../../lib/validation';
import { normalizeTestName } from '../../../shared/specCheck';
import type { Env, User } from '../../lib/types';

function bad(message: string, status = 400): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function tenantFor(user: User, given: string | null): string | Response {
  if (user.role === 'super_admin') {
    if (!given) return bad('tenant_id is required for super_admin');
    return given;
  }
  return user.tenant_id!;
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireRole(user, 'super_admin', 'org_admin');

    const body = (await context.request.json()) as {
      name?: string;
      reason?: string | null;
      tenant_id?: string;
    };

    const tenant = tenantFor(user, body.tenant_id ?? null);
    if (tenant instanceof Response) return tenant;

    const raw = sanitizeString(String(body.name ?? '')).trim();
    const key = normalizeTestName(raw);
    if (!key) return bad('name is required');

    const id = generateId();
    // OR IGNORE, not an error: two admins clearing the same worklist is not a
    // conflict, and the row that is already there says the same thing.
    await context.env.DB.prepare(
      `INSERT OR IGNORE INTO spec_unmatched_ignores
         (id, tenant_id, name_key, name_raw, reason, created_by)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
      .bind(id, tenant, key, raw, body.reason ? sanitizeString(body.reason) : null, user.id)
      .run();

    const row = await context.env.DB.prepare(
      'SELECT * FROM spec_unmatched_ignores WHERE tenant_id = ? AND name_key = ?'
    )
      .bind(tenant, key)
      .first<Record<string, unknown>>();

    await logAudit(
      context.env.DB,
      user.id,
      tenant,
      'spec_unmatched.ignored',
      'spec_unmatched_ignores',
      String(row?.id ?? id),
      JSON.stringify({ name: raw, name_key: key, reason: body.reason ?? null }),
      getClientIp(context.request)
    );

    return new Response(JSON.stringify({ ignored: row }), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Ignore unmatched analyte error:', err);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

export const onRequestDelete: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireRole(user, 'super_admin', 'org_admin');

    const url = new URL(context.request.url);
    const tenant = tenantFor(user, url.searchParams.get('tenant_id'));
    if (tenant instanceof Response) return tenant;

    const key = normalizeTestName(url.searchParams.get('name') ?? '');
    if (!key) return bad('name is required');

    const row = await context.env.DB.prepare(
      'SELECT * FROM spec_unmatched_ignores WHERE tenant_id = ? AND name_key = ?'
    )
      .bind(tenant, key)
      .first<Record<string, unknown>>();
    if (!row) throw new NotFoundError('That spelling is not dismissed');

    await context.env.DB.prepare('DELETE FROM spec_unmatched_ignores WHERE id = ?')
      .bind(String(row.id))
      .run();

    await logAudit(
      context.env.DB,
      user.id,
      tenant,
      'spec_unmatched.restored',
      'spec_unmatched_ignores',
      String(row.id),
      JSON.stringify({ name: row.name_raw, name_key: key }),
      getClientIp(context.request)
    );

    return new Response(JSON.stringify({ success: true }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Restore unmatched analyte error:', err);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
