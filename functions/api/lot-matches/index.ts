import {
  requireRole,
  errorToResponse,
} from '../../lib/permissions';
import type { Env, User } from '../../lib/types';

/**
 * GET /api/lot-matches
 *
 * List lot-match suggestions for human review (every engine match is one) (Review Queue v2). Each row
 * carries enough to render a review line: the COA document title, the matched
 * order line's product, the lot, and the match basis/confidence. Resolve a
 * suggestion via POST /api/lot-matches/:id { action: 'accept' | 'reject' }.
 *
 * Query params (all optional except tenant scoping):
 *   status        — suggestion status filter; default 'pending'. Pass 'all' to skip.
 *   order_number  — restrict to suggestions whose order_item belongs to this
 *                   order. May be repeated (a shipment touches several).
 *   limit         — default 50, cap 200.
 *   offset        — default 0.
 *
 * Tenant scoping mirrors /api/lots: non-super_admin always sees their own
 * tenant; super_admin may filter with ?tenant_id=.
 */
export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireRole(user, 'super_admin', 'org_admin', 'user');

    const url = new URL(context.request.url);
    const status = url.searchParams.get('status') || 'pending';
    // getAll: the client appends one per order a shipment touched. Reading only
    // the first silently hid every other order's suggestions.
    const orderNumbers = url.searchParams.getAll('order_number').filter(Boolean).slice(0, 50);
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200);
    const offset = parseInt(url.searchParams.get('offset') || '0', 10);

    const conditions: string[] = [];
    const params: (string | number)[] = [];

    // Tenant filtering — identical posture to /api/lots.
    if (user.role !== 'super_admin') {
      conditions.push('lms.tenant_id = ?');
      params.push(user.tenant_id!);
    } else {
      const tenantIdParam = url.searchParams.get('tenant_id');
      if (tenantIdParam) {
        conditions.push('lms.tenant_id = ?');
        params.push(tenantIdParam);
      }
    }

    if (status && status !== 'all') {
      conditions.push('lms.status = ?');
      params.push(status);
    }

    if (orderNumbers.length > 0) {
      conditions.push(`o.order_number IN (${orderNumbers.map(() => '?').join(', ')})`);
      params.push(...orderNumbers);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const rows = await context.env.DB.prepare(
      `SELECT
         lms.id              AS id,
         lms.order_item_id   AS order_item_id,
         lms.document_id     AS document_id,
         d.title             AS document_title,
         lms.lot_id          AS lot_id,
         l.lot_number        AS lot_number,
         oi.product_name     AS product_name,
         lms.match_basis     AS match_basis,
         lms.match_confidence AS match_confidence,
         lms.status          AS status,
         o.order_number      AS order_number,
         lms.created_at      AS created_at
       FROM lot_match_suggestions lms
       LEFT JOIN documents   d  ON d.id  = lms.document_id
       LEFT JOIN order_items oi ON oi.id = lms.order_item_id
       LEFT JOIN orders      o  ON o.id  = oi.order_id
       LEFT JOIN lots        l  ON l.id  = lms.lot_id
       ${whereClause}
       ORDER BY lms.match_confidence DESC, lms.created_at DESC, lms.id DESC
       LIMIT ? OFFSET ?`
    )
      .bind(...params, limit, offset)
      .all();

    return new Response(
      JSON.stringify({ suggestions: rows.results ?? [] }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;

    console.error('List lot-matches error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
