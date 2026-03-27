import { requireRole, requireTenantAccess, errorToResponse, ForbiddenError } from '../../lib/permissions';
import type { Env, User } from '../../lib/types';

/**
 * GET /api/expirations
 * Returns documents approaching expiration grouped by product.
 *
 * Query params:
 *   days_ahead (default 90) — how many days to look ahead
 *   tenant_id (optional, super_admin only)
 *   include_expired (default true) — include already-expired items
 */
export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const url = new URL(context.request.url);

    const daysAhead = Math.min(Math.max(parseInt(url.searchParams.get('days_ahead') || '90', 10) || 90, 1), 365);
    const includeExpired = url.searchParams.get('include_expired') !== 'false';
    const tenantIdParam = url.searchParams.get('tenant_id');

    // Tenant scoping
    let tenantFilter = '';
    const params: (string | number)[] = [daysAhead];

    if (user.role === 'super_admin') {
      if (tenantIdParam) {
        tenantFilter = ' AND d.tenant_id = ?';
        params.push(tenantIdParam);
      }
    } else {
      if (!user.tenant_id) {
        throw new ForbiddenError('No tenant assigned');
      }
      tenantFilter = ' AND d.tenant_id = ?';
      params.push(user.tenant_id);
    }

    // Expired filter: if not including expired, only show future expirations
    const expiredFilter = includeExpired ? '' : " AND dp.expires_at >= date('now')";

    const query = `
      SELECT
        dp.id as link_id,
        dp.document_id,
        dp.product_id,
        dp.expires_at,
        dp.notes,
        d.title as document_title,
        d.document_type_id,
        dt.name as document_type_name,
        p.name as product_name,
        p.slug as product_slug,
        t.name as tenant_name,
        t.id as tenant_id
      FROM document_products dp
      JOIN documents d ON dp.document_id = d.id
      JOIN products p ON dp.product_id = p.id
      LEFT JOIN document_types dt ON d.document_type_id = dt.id
      LEFT JOIN tenants t ON d.tenant_id = t.id
      WHERE dp.expires_at IS NOT NULL
        AND dp.expires_at <= date('now', '+' || ? || ' days')
        AND d.status = 'active'
        ${tenantFilter}
        ${expiredFilter}
      ORDER BY dp.expires_at ASC
    `;

    const results = await context.env.DB.prepare(query)
      .bind(...params)
      .all();

    const now = new Date();
    now.setHours(0, 0, 0, 0);

    const summary = { expired: 0, critical: 0, warning: 0, ok: 0, total: 0 };

    const expirations = (results.results || []).map((row: any) => {
      const expiresDate = new Date(row.expires_at + (row.expires_at.includes('T') ? '' : 'T00:00:00Z'));
      const diffMs = expiresDate.getTime() - now.getTime();
      const daysRemaining = Math.floor(diffMs / (1000 * 60 * 60 * 24));

      let status: 'expired' | 'critical' | 'warning' | 'ok';
      if (daysRemaining < 0) {
        status = 'expired';
        summary.expired++;
      } else if (daysRemaining <= 14) {
        status = 'critical';
        summary.critical++;
      } else if (daysRemaining <= 60) {
        status = 'warning';
        summary.warning++;
      } else {
        status = 'ok';
        summary.ok++;
      }
      summary.total++;

      return {
        link_id: row.link_id,
        document_id: row.document_id,
        document_title: row.document_title,
        document_type_name: row.document_type_name || null,
        product_id: row.product_id,
        product_name: row.product_name,
        product_slug: row.product_slug,
        tenant_id: row.tenant_id,
        tenant_name: row.tenant_name,
        expires_at: row.expires_at,
        days_remaining: daysRemaining,
        status,
        notes: row.notes || null,
      };
    });

    return new Response(
      JSON.stringify({ expirations, summary }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;

    console.error('Get expirations error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
