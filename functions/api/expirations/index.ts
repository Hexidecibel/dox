import { requireTenantAccess, BadRequestError, errorToResponse } from '../../lib/permissions';
import { computeExpirations, loadTenantAlertLeadDays } from '../../lib/expirations';
import { resolveRenewalAlertLead } from '../../../shared/renewalLeadTime';
import type { Env, User } from '../../lib/types';

/**
 * GET /api/expirations[?tenant_id=&window_days=&as_of=]
 *
 * The renewal dashboard feed: every active registry document with a resolvable
 * next-action date, classified into a renewal_type-aware status
 * (current | expiring | expired | overdue | stale), plus summary counts by
 * status and by renewal_type.
 *
 * Tenant-scoped: super_admin may pass ?tenant_id=, org_admin/user are pinned to
 * their own tenant. `as_of` keeps classification deterministic/testable;
 * defaults to the server's current UTC date. `window_days` is the dashboard's
 * "expiring soon" look-ahead and defaults to the tenant's renewal alert lead
 * time (migration 0111; 60 when unset).
 *
 * `window_days` is a VIEW filter. It changes which rows read `expiring` here
 * and nothing else: the alert engine judges each document against its own
 * lead time, carried on every row as `alert_lead_days` / `alert_lead_source`
 * with the resulting `alert_status`, so the dashboard can show both.
 */
export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const url = new URL(context.request.url);

    // ── tenant scope ────────────────────────────────────────────────────────
    let tenantId = url.searchParams.get('tenant_id');
    if (user.role !== 'super_admin') {
      tenantId = user.tenant_id;
    }
    if (!tenantId) {
      throw new BadRequestError('tenant_id is required');
    }
    requireTenantAccess(user, tenantId);

    // ── params ──────────────────────────────────────────────────────────────
    const tenantLead = resolveRenewalAlertLead(
      null,
      await loadTenantAlertLeadDays(context.env.DB, tenantId),
    );
    const windowRaw = parseInt(url.searchParams.get('window_days') || String(tenantLead.days), 10);
    const windowDays = Number.isFinite(windowRaw) && windowRaw >= 0 ? windowRaw : tenantLead.days;
    const asOf = url.searchParams.get('as_of') || new Date().toISOString().slice(0, 10);

    const { rows, summary } = await computeExpirations(context.env.DB, tenantId, asOf, windowDays, {
      tenantLeadDays: tenantLead.source === 'tenant' ? tenantLead.days : null,
    });

    return new Response(
      JSON.stringify({ rows, summary, window_days: windowDays, as_of: asOf, tenant_lead: tenantLead }),
      { headers: { 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;

    console.error('Expirations dashboard error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }
};
