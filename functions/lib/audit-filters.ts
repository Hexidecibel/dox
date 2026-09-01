import type { User } from './types';

/**
 * Shared WHERE-clause builder for the audit log.
 *
 * Both GET /api/audit (paged screen) and GET /api/audit/export (CSV) run
 * through this. That is deliberate: an export that silently applies a
 * *different* filter set than the screen the auditor is looking at — or a
 * different tenant scope — is worse than having no export at all. Keeping one
 * builder makes the two physically incapable of drifting.
 *
 * Tenant scoping is part of the filter, not a caller responsibility:
 *   - org_admin is pinned to their own tenant, ignoring any tenant_id param
 *   - super_admin may optionally narrow to one tenant
 * Role gating (canViewAudit) stays with the callers — this builds SQL only.
 */
export interface AuditFilters {
  /** e.g. `WHERE a.tenant_id = ? AND a.action IN (?,?)`, or '' when unfiltered. */
  whereClause: string;
  /** Bind params, positionally matched to whereClause. */
  params: (string | number)[];
  /** The filters as applied, for the audit record of the export itself. */
  applied: {
    tenantId: string | null;
    actions: string[];
    userId: string | null;
    resourceType: string | null;
    dateFrom: string | null;
    dateTo: string | null;
  };
}

export function buildAuditFilters(user: User, searchParams: URLSearchParams): AuditFilters {
  const tenantIdParam = searchParams.get('tenant_id');
  const action = searchParams.get('action');
  const userId = searchParams.get('userId');
  const resourceType = searchParams.get('resourceType');
  const dateFrom = searchParams.get('dateFrom');
  const dateTo = searchParams.get('dateTo');

  const conditions: string[] = [];
  const params: (string | number)[] = [];
  let appliedTenantId: string | null = null;

  // Tenant scoping
  if (user.role === 'org_admin') {
    // org_admin can only see their own tenant's logs — a tenant_id param
    // from the client is ignored, never honoured.
    conditions.push('a.tenant_id = ?');
    params.push(user.tenant_id!);
    appliedTenantId = user.tenant_id ?? null;
  } else if (tenantIdParam) {
    // super_admin with optional tenant filter
    conditions.push('a.tenant_id = ?');
    params.push(tenantIdParam);
    appliedTenantId = tenantIdParam;
  }

  const actions = action
    ? action.split(',').map((a) => a.trim()).filter(Boolean)
    : [];

  if (actions.length === 1) {
    conditions.push('a.action = ?');
    params.push(actions[0]);
  } else if (actions.length > 1) {
    const placeholders = actions.map(() => '?').join(',');
    conditions.push(`a.action IN (${placeholders})`);
    params.push(...actions);
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
    // Date-only input means "through the end of that day".
    conditions.push('a.created_at <= ?');
    params.push(dateTo + 'T23:59:59');
  }

  return {
    whereClause: conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '',
    params,
    applied: {
      tenantId: appliedTenantId,
      actions,
      userId: userId || null,
      resourceType: resourceType || null,
      dateFrom: dateFrom || null,
      dateTo: dateTo || null,
    },
  };
}
