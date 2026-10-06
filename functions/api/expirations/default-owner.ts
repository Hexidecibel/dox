/**
 * The organization's master user (migration 0133; AJ Conner, D-050).
 *
 * A supplier renewal request needs ONE approval from a person, and that
 * person is the requester: the first portal user on the record's owner route.
 * Plenty of records have no such user -- the owner label is unrouted, or its
 * route holds only a bare email address, which cannot press a button. This
 * setting is who approves then. With neither, the draft goes to the
 * org_admins.
 *
 * GET /api/expirations/default-owner[?tenant_id=]
 * PUT /api/expirations/default-owner   Body: { user_id: string | null, tenant_id? }
 *
 * Auth mirrors /api/expirations/lead-time: super_admin + org_admin, a
 * super_admin names the tenant. `user_id` is REQUIRED on a PUT (null is a
 * real answer: "nobody; use the admins") so a malformed client cannot clear
 * the setting by omission. The user must be an ACTIVE account of this tenant.
 *
 * Stored as a bare id and resolved at read: a master user who is later
 * deactivated stops resolving (`resolves: false`) and approvals fall to the
 * admins without anyone having to remember to clear this.
 *
 * Every change is stamped and audited with the previous value; saving the
 * value already stored writes nothing.
 */

import { getClientIp, logAudit } from '../../lib/db';
import {
  BadRequestError,
  NotFoundError,
  errorToResponse,
  requireRole,
  requireTenantAccess,
} from '../../lib/permissions';
import { resolveLeadTimeTenantId } from '../../lib/renewal-lead-time';
import type { Env, User } from '../../lib/types';
import type { RenewalDefaultOwnerResponse } from '../../../shared/types';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

interface StoredRow {
  default_owner_user_id: string | null;
  default_owner_updated_at: string | null;
  user_name: string | null;
  user_email: string | null;
  user_active: number | null;
  user_tenant_id: string | null;
  updated_by_name: string | null;
}

async function buildResponse(db: D1Database, tenantId: string): Promise<RenewalDefaultOwnerResponse> {
  const row = await db
    .prepare(
      `SELECT t.default_owner_user_id, t.default_owner_updated_at,
              u.name AS user_name, u.email AS user_email, u.active AS user_active,
              u.tenant_id AS user_tenant_id, b.name AS updated_by_name
         FROM tenants t
         LEFT JOIN users u ON u.id = t.default_owner_user_id
         LEFT JOIN users b ON b.id = t.default_owner_updated_by
        WHERE t.id = ?`,
    )
    .bind(tenantId)
    .first<StoredRow>();
  if (!row) throw new NotFoundError('Tenant not found');

  const candidates = await db
    .prepare(
      `SELECT id, name, email, role FROM users
        WHERE tenant_id = ? AND active = 1
        ORDER BY name, email`,
    )
    .bind(tenantId)
    .all<{ id: string; name: string; email: string; role: string }>();

  return {
    tenant_id: tenantId,
    user_id: row.default_owner_user_id ?? null,
    user_name: row.user_name ?? null,
    user_email: row.user_email ?? null,
    resolves:
      row.default_owner_user_id !== null &&
      Number(row.user_active) === 1 &&
      row.user_tenant_id === tenantId,
    updated_at: row.default_owner_updated_at ?? null,
    updated_by_name: row.updated_by_name ?? null,
    candidates: candidates.results ?? [],
  };
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireRole(user, 'super_admin', 'org_admin');
    const url = new URL(context.request.url);
    const tenantId = resolveLeadTimeTenantId(user, url.searchParams.get('tenant_id'));
    requireTenantAccess(user, tenantId);
    return json(await buildResponse(context.env.DB, tenantId));
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Get renewal default owner error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
};

export const onRequestPut: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireRole(user, 'super_admin', 'org_admin');

    let body: { user_id?: unknown; tenant_id?: string };
    try {
      body = (await context.request.json()) as typeof body;
    } catch {
      throw new BadRequestError('Body must be JSON');
    }
    if (!body || !('user_id' in body)) {
      throw new BadRequestError('user_id is required (send null to clear it)');
    }
    const tenantId = resolveLeadTimeTenantId(user, body.tenant_id ?? null);
    requireTenantAccess(user, tenantId);

    let next: string | null = null;
    if (body.user_id !== null) {
      if (typeof body.user_id !== 'string' || !body.user_id.trim()) {
        throw new BadRequestError('user_id must be a user id or null');
      }
      const target = await context.env.DB.prepare(
        'SELECT id FROM users WHERE id = ? AND tenant_id = ? AND active = 1',
      )
        .bind(body.user_id, tenantId)
        .first<{ id: string }>();
      if (!target) throw new BadRequestError('user_id must be an active user of this organization');
      next = target.id;
    }

    const before = await buildResponse(context.env.DB, tenantId);
    if (before.user_id !== next) {
      await context.env.DB.prepare(
        `UPDATE tenants
            SET default_owner_user_id = ?, default_owner_updated_at = datetime('now'),
                default_owner_updated_by = ?
          WHERE id = ?`,
      )
        .bind(next, user.id, tenantId)
        .run();
      await logAudit(
        context.env.DB,
        user.id,
        tenantId,
        'renewal_default_owner_updated',
        'tenant',
        tenantId,
        JSON.stringify({ previous_user_id: before.user_id, user_id: next }),
        getClientIp(context.request),
      );
    }

    return json({
      ...(await buildResponse(context.env.DB, tenantId)),
      unchanged: before.user_id === next,
    });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Set renewal default owner error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
};
