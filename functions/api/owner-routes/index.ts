import { generateId, logAudit, getClientIp } from '../../lib/db';
import {
  requireRole,
  requireTenantAccess,
  BadRequestError,
  errorToResponse,
} from '../../lib/permissions';
import { normalizeOwnerKey } from '../../lib/alert-routing';
import { validateEmail, sanitizeString } from '../../lib/validation';
import type { Env, User } from '../../lib/types';

/**
 * Owner routes - the table that turns `documents.owner` from a label into an
 * addressable person.
 *
 * `documents.owner` is free text and holds a ROLE ('QA', 'Accounting',
 * 'Insurance', 'Purchasing'), not a user id. Without this mapping the renewal
 * alert has no way to reach the owner and falls back to mailing every admin,
 * which is the failure this whole feature exists to fix. See
 * `migrations/0091_renewal_routing_and_alert_state.sql` for why the label was
 * not simply converted into a user foreign key.
 *
 * A route points at EITHER a portal user (preferred - their address follows
 * them) OR a bare email (for the broker or site manager who has no account and
 * never will). Several routes may share one label: 'QA' can be three people.
 *
 * No UI ships with this yet; it is a REST surface an org_admin drives directly
 * (or that an operator seeds during the cutover). That is called out in the
 * handover rather than left to be discovered.
 */

interface OwnerRouteRow {
  id: string;
  tenant_id: string;
  owner_key: string;
  owner_label: string;
  user_id: string | null;
  email: string | null;
  active: number;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  user_name?: string | null;
  user_email?: string | null;
}

const SELECT_SQL = `
  SELECT r.id, r.tenant_id, r.owner_key, r.owner_label, r.user_id, r.email,
         r.active, r.created_at, r.updated_at, r.created_by,
         u.name AS user_name, u.email AS user_email
    FROM owner_routes r
    LEFT JOIN users u ON u.id = r.user_id
`;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * GET /api/owner-routes
 *
 * Lists the tenant's routes. Optional `?owner=` filters to one label (matched
 * on the normalized key, so the caller does not have to know the exact
 * spelling stored on the document).
 * Role: super_admin, org_admin.
 */
export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireRole(user, 'super_admin', 'org_admin');

    const url = new URL(context.request.url);
    let tenantId = url.searchParams.get('tenant_id');
    if (user.role !== 'super_admin') tenantId = user.tenant_id;
    if (!tenantId) throw new BadRequestError('tenant_id is required');
    requireTenantAccess(user, tenantId);

    const ownerKey = normalizeOwnerKey(url.searchParams.get('owner'));

    const res = ownerKey
      ? await context.env.DB.prepare(
          `${SELECT_SQL} WHERE r.tenant_id = ? AND r.owner_key = ? ORDER BY r.owner_label, r.created_at`,
        )
          .bind(tenantId, ownerKey)
          .all<OwnerRouteRow>()
      : await context.env.DB.prepare(
          `${SELECT_SQL} WHERE r.tenant_id = ? ORDER BY r.owner_label, r.created_at`,
        )
          .bind(tenantId)
          .all<OwnerRouteRow>();

    return json({ routes: res.results ?? [] });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('owner-routes list error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
};

/**
 * POST /api/owner-routes
 *
 * Create (or re-activate) a route.
 * Body: { owner_label, user_id? | email?, tenant_id? }
 *
 * Exactly one of user_id / email. Both or neither is a 400 rather than a
 * silently half-configured route - a routing table that accepts a row pointing
 * at nobody is how "we configured it" and "alerts arrive" come apart.
 * Role: super_admin, org_admin.
 */
export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireRole(user, 'super_admin', 'org_admin');

    const body = (await context.request.json().catch(() => ({}))) as {
      owner_label?: string;
      user_id?: string | null;
      email?: string | null;
      tenant_id?: string;
    };

    let tenantId = body.tenant_id ?? null;
    if (user.role !== 'super_admin') tenantId = user.tenant_id;
    if (!tenantId) throw new BadRequestError('tenant_id is required');
    requireTenantAccess(user, tenantId);

    const label = sanitizeString(body.owner_label ?? '').trim();
    const ownerKey = normalizeOwnerKey(label);
    if (!ownerKey) {
      throw new BadRequestError('owner_label is required');
    }

    const userId = body.user_id ? String(body.user_id) : null;
    const email = body.email ? String(body.email).trim() : null;
    if ((userId && email) || (!userId && !email)) {
      throw new BadRequestError('Provide exactly one of user_id or email');
    }
    if (email && !validateEmail(email)) {
      throw new BadRequestError('email is not a valid address');
    }

    if (userId) {
      const target = await context.env.DB.prepare(
        'SELECT id FROM users WHERE id = ? AND tenant_id = ?',
      )
        .bind(userId, tenantId)
        .first();
      if (!target) {
        throw new BadRequestError('user_id does not reference a user in this tenant');
      }
    }

    const id = generateId();
    // The unique index is on (tenant_id, owner_key, COALESCE(user_id, email)),
    // so re-posting an existing route re-activates and re-labels it rather
    // than erroring - the natural thing when an admin fixes a typo in the
    // display spelling.
    await context.env.DB.prepare(
      `INSERT INTO owner_routes (id, tenant_id, owner_key, owner_label, user_id, email, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(tenant_id, owner_key, COALESCE(user_id, email)) DO UPDATE SET
         owner_label = excluded.owner_label,
         active = 1,
         updated_at = datetime('now')`,
    )
      .bind(id, tenantId, ownerKey, label, userId, email, user.id)
      .run();

    const row = await context.env.DB.prepare(
      `${SELECT_SQL} WHERE r.tenant_id = ? AND r.owner_key = ? AND COALESCE(r.user_id, r.email) = ?`,
    )
      .bind(tenantId, ownerKey, userId ?? email)
      .first<OwnerRouteRow>();

    await logAudit(
      context.env.DB,
      user.id,
      tenantId,
      'owner_route.upsert',
      'owner_route',
      row?.id ?? id,
      JSON.stringify({ owner_key: ownerKey, user_id: userId, email }),
      getClientIp(context.request),
    );

    return json({ route: row }, 201);
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('owner-routes create error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
};
