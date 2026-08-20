/**
 * Analytes a tenant holds spec limits for, and the names suppliers print for
 * them.
 *
 * The aliases are the load-bearing part. Thresholds are one number; the reason
 * spec checking is real work is that one supplier prints "Coliform", another
 * "Coliforms (MPN)", another "Total Coliform", and SPC / APC / TPC / Standard
 * Plate Count are one test wearing four names. Matching is exact-on-normalized
 * over name + aliases (see `matchSpecTest`) — never fuzzy, because "Coliform"
 * substring-matching "Fecal Coliform" would apply the wrong limit invisibly.
 */

import { generateId, logAudit, getClientIp } from '../../lib/db';
import { requireRole, errorToResponse } from '../../lib/permissions';
import { sanitizeString } from '../../lib/validation';
import type { Env, User } from '../../lib/types';

/** Parse and clean an aliases payload into a JSON array string. */
export function normalizeAliases(input: unknown): string {
  if (!Array.isArray(input)) return '[]';
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input) {
    const s = sanitizeString(String(raw ?? '')).trim();
    if (!s) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return JSON.stringify(out);
}

function tenantFor(user: User, bodyTenantId?: string): string | Response {
  if (user.role === 'super_admin') {
    if (!bodyTenantId) {
      return new Response(JSON.stringify({ error: 'tenant_id is required for super_admin' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return bodyTenantId;
  }
  return user.tenant_id!;
}

/** GET /api/spec-tests — list this tenant's analytes. Any tenant user may read. */
export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const url = new URL(context.request.url);
    const tenantIdParam = url.searchParams.get('tenant_id');

    const tenantId =
      user.role === 'super_admin' ? tenantIdParam || null : user.tenant_id!;

    const where = tenantId ? 'WHERE st.tenant_id = ?' : '';
    const params = tenantId ? [tenantId] : [];

    const results = await context.env.DB.prepare(
      `SELECT st.*, COUNT(sl.id) AS limit_count
         FROM spec_tests st
         LEFT JOIN spec_limits sl ON sl.spec_test_id = st.id AND sl.active = 1
         ${where}
        GROUP BY st.id
        ORDER BY st.name ASC`
    )
      .bind(...params)
      .all();

    const specTests = (results.results ?? []).map((r) => {
      const row = r as Record<string, unknown>;
      let aliases: string[] = [];
      try {
        const parsed = JSON.parse(String(row.aliases ?? '[]'));
        if (Array.isArray(parsed)) aliases = parsed.map(String);
      } catch {
        // A corrupt blob costs this analyte its synonyms, not the whole list.
      }
      return { ...row, aliases };
    });

    return new Response(JSON.stringify({ specTests }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('List spec tests error:', err);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

/** POST /api/spec-tests — create an analyte. org_admin+. */
export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireRole(user, 'super_admin', 'org_admin');

    const body = (await context.request.json()) as {
      name?: string;
      aliases?: unknown;
      default_unit?: string | null;
      notes?: string | null;
      tenant_id?: string;
    };

    const name = sanitizeString(body.name || '').trim();
    if (!name) {
      return new Response(JSON.stringify({ error: 'name is required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const tenant = tenantFor(user, body.tenant_id);
    if (tenant instanceof Response) return tenant;

    const existing = await context.env.DB.prepare(
      'SELECT id FROM spec_tests WHERE tenant_id = ? AND LOWER(name) = LOWER(?)'
    )
      .bind(tenant, name)
      .first();
    if (existing) {
      return new Response(JSON.stringify({ error: 'That analyte already exists' }), {
        status: 409,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const id = generateId();
    await context.env.DB.prepare(
      `INSERT INTO spec_tests (id, tenant_id, name, aliases, default_unit, notes, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        id,
        tenant,
        name,
        normalizeAliases(body.aliases),
        body.default_unit ? sanitizeString(body.default_unit) : null,
        body.notes ? sanitizeString(body.notes) : null,
        user.id
      )
      .run();

    await logAudit(
      context.env.DB,
      user.id,
      tenant,
      'spec_test.created',
      'spec_tests',
      id,
      JSON.stringify({ name }),
      getClientIp(context.request)
    );

    const created = await context.env.DB.prepare('SELECT * FROM spec_tests WHERE id = ?')
      .bind(id)
      .first();

    return new Response(JSON.stringify({ specTest: created }), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Create spec test error:', err);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
