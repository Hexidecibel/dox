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
import type { OwnerLabelInUse } from '../../../shared/types';

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
 * The admin UI is Settings -> Owner Routing, which is why the list response
 * carries `labels_in_use` alongside the routes: the labels are free text on
 * documents, so a screen that made somebody TYPE them from memory would route
 * the spellings they remembered and silently leave the rest unrouted. See
 * `collectOwnerLabelsInUse` below.
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

/**
 * Every `documents.owner` label actually in use in this tenant, folded onto the
 * same normalized key the router matches on.
 *
 * WHY THIS LIVES ON THE LIST RESPONSE. `documents.owner` is free text with no
 * vocabulary table behind it, so the set of labels that exist is only
 * discoverable from the documents themselves. Without this, the routing screen
 * could only show what somebody had already configured — and the state that
 * matters is the opposite one: a label that is on documents and has NO route,
 * because every renewal record carrying it reports as unrouted and nobody is
 * alerted. That is not visible from `owner_routes` alone.
 *
 * Two counts, deliberately:
 *   document_count  every active document carrying the label.
 *   renewal_count   the subset that carries renewal terms — the records the
 *                   renewal run would actually try to alert on. A label with
 *                   documents but no renewal terms is a smaller problem than
 *                   one with fifty certificates coming due.
 *
 * Spellings are folded with the SAME `normalizeOwnerKey` the resolver uses, so
 * 'QA' and 'qa ' are one row here exactly as they are one lookup there. The
 * distinct spellings are kept and returned: a label spelled two ways is worth
 * seeing, not worth silently hiding.
 *
 * Best-effort. A failure here must not take down the routes list, which is the
 * part an admin needs to edit.
 */
export async function collectOwnerLabelsInUse(
  db: D1Database,
  tenantId: string,
  routes: OwnerRouteRow[],
): Promise<OwnerLabelInUse[]> {
  let rows: Array<{ owner_label: string; document_count: number; renewal_count: number }> = [];
  try {
    const res = await db
      .prepare(
        `SELECT owner AS owner_label,
                COUNT(*) AS document_count,
                SUM(CASE WHEN renewal_due_date IS NOT NULL OR renewal_type IS NOT NULL
                         THEN 1 ELSE 0 END) AS renewal_count
           FROM documents
          WHERE tenant_id = ?
            AND status = 'active'
            AND owner IS NOT NULL
            AND TRIM(owner) <> ''
          GROUP BY owner`,
      )
      .bind(tenantId)
      .all<{ owner_label: string; document_count: number; renewal_count: number }>();
    rows = res.results ?? [];
  } catch (err) {
    console.error(
      '[owner-routes] in-use label scan failed:',
      err instanceof Error ? err.message : String(err),
    );
    return [];
  }

  const routeCounts = new Map<string, number>();
  for (const r of routes) {
    if (!r.active) continue;
    routeCounts.set(r.owner_key, (routeCounts.get(r.owner_key) ?? 0) + 1);
  }

  const folded = new Map<string, OwnerLabelInUse>();
  for (const row of rows) {
    const key = normalizeOwnerKey(row.owner_label);
    if (!key) continue;
    const docs = Number(row.document_count) || 0;
    const renewals = Number(row.renewal_count) || 0;
    const existing = folded.get(key);
    if (existing) {
      existing.document_count += docs;
      existing.renewal_count += renewals;
      if (!existing.spellings.includes(row.owner_label)) existing.spellings.push(row.owner_label);
    } else {
      folded.set(key, {
        owner_key: key,
        owner_label: row.owner_label,
        spellings: [row.owner_label],
        document_count: docs,
        renewal_count: renewals,
        route_count: routeCounts.get(key) ?? 0,
      });
    }
  }

  // Unrouted first, then by how much is riding on the label. The screen sorts
  // for itself too; this makes the raw API answer the same question.
  return [...folded.values()].sort((a, b) => {
    if ((a.route_count === 0) !== (b.route_count === 0)) return a.route_count === 0 ? -1 : 1;
    if (a.renewal_count !== b.renewal_count) return b.renewal_count - a.renewal_count;
    if (a.document_count !== b.document_count) return b.document_count - a.document_count;
    return a.owner_label.localeCompare(b.owner_label);
  });
}

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
 *
 * ALSO returns `labels_in_use` — every owner label found on the tenant's
 * documents, with its document/renewal counts and how many routes resolve it.
 * That block is NOT filtered by `?owner=`: it describes the tenant, and its
 * whole job is to show the labels a caller did not think to ask about.
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

    const routes = res.results ?? [];

    // Route counts come from ALL of the tenant's routes, never the filtered
    // set — otherwise `?owner=QA` would report every other label as unrouted.
    const allRoutes = ownerKey
      ? ((
          await context.env.DB.prepare(
            `${SELECT_SQL} WHERE r.tenant_id = ?`,
          )
            .bind(tenantId)
            .all<OwnerRouteRow>()
        ).results ?? [])
      : routes;

    const labelsInUse = await collectOwnerLabelsInUse(context.env.DB, tenantId, allRoutes);

    return json({ routes, labels_in_use: labelsInUse });
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
