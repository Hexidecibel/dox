import { logAudit, getClientIp } from '../../lib/db';
import { requireRole, canViewAudit, errorToResponse, ForbiddenError } from '../../lib/permissions';
import type { Env, User } from '../../lib/types';

interface AuditRow {
  id: number;
  user_id: string | null;
  tenant_id: string | null;
  action: string;
  resource_type: string | null;
  resource_id: string | null;
  details: string | null;
  ip_address: string | null;
  created_at: string;
  user_name: string | null;
  user_email: string | null;
}

/**
 * GET /api/audit
 * Query audit log entries with filters and pagination.
 * super_admin: can query all, optional tenantId filter
 * org_admin: restricted to their own tenant
 * user/reader: 403
 */
export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;

    if (!canViewAudit(user)) {
      throw new ForbiddenError('Insufficient permissions');
    }

    const url = new URL(context.request.url);
    const tenantId = url.searchParams.get('tenant_id');
    const action = url.searchParams.get('action');
    const userId = url.searchParams.get('userId');
    const resourceType = url.searchParams.get('resourceType');
    const dateFrom = url.searchParams.get('dateFrom');
    const dateTo = url.searchParams.get('dateTo');
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200);
    const offset = parseInt(url.searchParams.get('offset') || '0', 10);

    const conditions: string[] = [];
    const params: (string | number)[] = [];

    // Tenant scoping
    if (user.role === 'org_admin') {
      // org_admin can only see their own tenant's logs
      conditions.push('a.tenant_id = ?');
      params.push(user.tenant_id!);
    } else if (tenantId) {
      // super_admin with optional tenant filter
      conditions.push('a.tenant_id = ?');
      params.push(tenantId);
    }

    if (action) {
      const actions = action.split(',').map(a => a.trim()).filter(Boolean);
      if (actions.length === 1) {
        conditions.push('a.action = ?');
        params.push(actions[0]);
      } else if (actions.length > 1) {
        const placeholders = actions.map(() => '?').join(',');
        conditions.push(`a.action IN (${placeholders})`);
        params.push(...actions);
      }
    }

    if (userId) {
      conditions.push('a.user_id = ?');
      params.push(userId);
    }

    if (resourceType) {
      conditions.push('a.resource_type = ?');
      params.push(resourceType);
    }

    if (dateFrom) {
      conditions.push('a.created_at >= ?');
      params.push(dateFrom);
    }

    if (dateTo) {
      conditions.push('a.created_at <= ?');
      params.push(dateTo + 'T23:59:59');
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Get total count
    const countResult = await context.env.DB.prepare(
      `SELECT COUNT(*) as total FROM audit_log a ${whereClause}`
    )
      .bind(...params)
      .first<{ total: number }>();

    // Get entries with user info
    const query = `
      SELECT
        a.id,
        a.user_id,
        a.tenant_id,
        a.action,
        a.resource_type,
        a.resource_id,
        a.details,
        a.ip_address,
        a.created_at,
        u.name as user_name,
        u.email as user_email
      FROM audit_log a
      LEFT JOIN users u ON a.user_id = u.id
      ${whereClause}
      ORDER BY a.created_at DESC
      LIMIT ? OFFSET ?
    `;

    const results = await context.env.DB.prepare(query)
      .bind(...params, limit, offset)
      .all<AuditRow>();

    return new Response(
      JSON.stringify({
        entries: results.results || [],
        total: countResult?.total || 0,
        limit,
        offset,
      }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;

    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
