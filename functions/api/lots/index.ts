import { errorToResponse } from '../../lib/permissions';
import type { Env, User } from '../../lib/types';

/**
 * GET /api/lots
 *
 * List lots (Phase 2 entity graph) filtered by tenant, with joined product
 * and supplier names plus rollup counts for the 3-level browse UI:
 *   - coa_document_count  — COA docs linked via document_lots
 *   - matched_order_count — order_items strongly linked to this lot
 *   - suggested_count     — pending lot_match_suggestions for this lot
 *
 * Query params (all optional except tenant scoping):
 *   supplier_id, product_id, search (lot_number/lot_key LIKE, case-insensitive),
 *   limit (default 50, cap 200), offset (default 0).
 *
 * Tenant scoping mirrors /api/products: non-super_admin always sees their own
 * tenant; super_admin may filter with ?tenant_id=.
 */
export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const url = new URL(context.request.url);

    const supplierId = url.searchParams.get('supplier_id');
    const productId = url.searchParams.get('product_id');
    const search = url.searchParams.get('search');
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200);
    const offset = parseInt(url.searchParams.get('offset') || '0', 10);

    const conditions: string[] = [];
    const params: (string | number)[] = [];

    // Tenant filtering — identical posture to /api/products.
    if (user.role !== 'super_admin') {
      conditions.push('lots.tenant_id = ?');
      params.push(user.tenant_id!);
    } else {
      const tenantIdParam = url.searchParams.get('tenant_id');
      if (tenantIdParam) {
        conditions.push('lots.tenant_id = ?');
        params.push(tenantIdParam);
      }
    }

    if (supplierId) {
      conditions.push('lots.supplier_id = ?');
      params.push(supplierId);
    }

    if (productId) {
      conditions.push('lots.product_id = ?');
      params.push(productId);
    }

    if (search) {
      // Case-insensitive: LIKE is case-insensitive for ASCII in SQLite, but
      // LOWER() keeps it explicit and robust across stored casing.
      conditions.push('(LOWER(lots.lot_number) LIKE ? OR LOWER(lots.lot_key) LIKE ?)');
      const pattern = `%${search.toLowerCase()}%`;
      params.push(pattern, pattern);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Total rows matching the filter (for pagination). Counts lots only — no
    // join fan-out, so this stays a single cheap aggregate.
    const countResult = await context.env.DB.prepare(
      `SELECT COUNT(*) AS total FROM lots ${whereClause}`
    )
      .bind(...params)
      .first<{ total: number }>();

    // Page rows with names + counts. Correlated subqueries keep the row set
    // from fanning out (one row per lot) while still aggregating the three
    // count dimensions.
    const rows = await context.env.DB.prepare(
      `SELECT
         lots.id              AS id,
         lots.lot_number      AS lot_number,
         lots.sub_lot_code    AS sub_lot_code,
         lots.lot_key         AS lot_key,
         lots.product_id      AS product_id,
         products.name        AS product_name,
         lots.supplier_id     AS supplier_id,
         suppliers.name       AS supplier_name,
         lots.code_date       AS code_date,
         lots.expiration_date AS expiration_date,
         lots.mfg_date        AS mfg_date,
         lots.created_at      AS created_at,
         (SELECT COUNT(*) FROM document_lots dl WHERE dl.lot_id = lots.id)
           AS coa_document_count,
         (SELECT COUNT(*) FROM order_items oi
            WHERE oi.lot_id = lots.id AND oi.coa_match_status = 'matched')
           AS matched_order_count,
         (SELECT COUNT(*) FROM lot_match_suggestions lms
            WHERE lms.lot_id = lots.id AND lms.status = 'pending')
           AS suggested_count
       FROM lots
       LEFT JOIN products  ON products.id  = lots.product_id
       LEFT JOIN suppliers ON suppliers.id = lots.supplier_id
       ${whereClause}
       ORDER BY lots.created_at DESC, lots.id DESC
       LIMIT ? OFFSET ?`
    )
      .bind(...params, limit, offset)
      .all();

    return new Response(
      JSON.stringify({
        lots: rows.results ?? [],
        total: countResult?.total ?? 0,
      }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;

    console.error('List lots error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
