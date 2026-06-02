import { NotFoundError, errorToResponse } from '../../lib/permissions';
import type { Env, User } from '../../lib/types';

/**
 * GET /api/lots/:id
 *
 * Full lot detail for the 3-level browse expansion:
 *   - lot:           all columns + joined product_name / supplier_name
 *   - coa_documents: COA docs linked via document_lots (with current-version file_name)
 *   - order_lines:   order_items linked to this lot (lot_id = :id) OR with a
 *                    pending/accepted suggestion pointing at this lot
 *   - suggestions:   pending lot_match_suggestions for this lot
 *
 * Tenant-scoped: a lot outside the caller's tenant → 404 (mirrors
 * lot-matches/[id].ts, which 404s before leaking existence). super_admin sees
 * any tenant. Reads open to super_admin/org_admin/user/reader.
 */
export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const lotId = context.params.id as string;

    const lot = await context.env.DB.prepare(
      `SELECT
         lots.*,
         products.name  AS product_name,
         suppliers.name AS supplier_name
       FROM lots
       LEFT JOIN products  ON products.id  = lots.product_id
       LEFT JOIN suppliers ON suppliers.id = lots.supplier_id
       WHERE lots.id = ?`
    )
      .bind(lotId)
      .first<{ tenant_id: string } & Record<string, unknown>>();

    if (!lot) {
      throw new NotFoundError('Lot not found');
    }

    // Tenant scope: treat a cross-tenant lot as not found.
    if (user.role !== 'super_admin' && lot.tenant_id !== user.tenant_id) {
      throw new NotFoundError('Lot not found');
    }

    // COA documents linked via document_lots. Current-version file_name comes
    // from document_versions joined on documents.current_version.
    const coaDocs = await context.env.DB.prepare(
      `SELECT
         d.id        AS document_id,
         d.title     AS title,
         dv.file_name AS file_name,
         dl.created_at AS linked_at
       FROM document_lots dl
       JOIN documents d ON d.id = dl.document_id
       LEFT JOIN document_versions dv
         ON dv.document_id = d.id AND dv.version_number = d.current_version
       WHERE dl.lot_id = ?
       ORDER BY dl.created_at DESC`
    )
      .bind(lotId)
      .all();

    // Order lines: directly linked (lot_id = :id) OR referenced by a
    // pending/accepted suggestion for this lot. DISTINCT collapses the union.
    const orderLines = await context.env.DB.prepare(
      `SELECT DISTINCT
         oi.id            AS order_item_id,
         o.id             AS order_id,
         o.order_number   AS order_number,
         o.po_number      AS po_number,
         o.customer_name  AS customer_name,
         oi.product_name  AS product_name,
         oi.quantity      AS quantity,
         oi.coa_match_status AS coa_match_status,
         oi.match_confidence AS match_confidence,
         oi.coa_document_id  AS coa_document_id
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       WHERE oi.lot_id = ?
          OR oi.id IN (
            SELECT lms.order_item_id FROM lot_match_suggestions lms
            WHERE lms.lot_id = ? AND lms.status IN ('pending', 'accepted')
          )
       ORDER BY o.created_at DESC, oi.id DESC`
    )
      .bind(lotId, lotId)
      .all();

    // Pending suggestions for this lot, with the order number for display.
    const suggestions = await context.env.DB.prepare(
      `SELECT
         lms.id            AS id,
         lms.order_item_id AS order_item_id,
         o.order_number    AS order_number,
         lms.document_id   AS document_id,
         lms.match_confidence AS match_confidence,
         lms.match_basis   AS match_basis,
         lms.status        AS status
       FROM lot_match_suggestions lms
       JOIN order_items oi ON oi.id = lms.order_item_id
       JOIN orders o ON o.id = oi.order_id
       WHERE lms.lot_id = ? AND lms.status = 'pending'
       ORDER BY lms.created_at DESC`
    )
      .bind(lotId)
      .all();

    return new Response(
      JSON.stringify({
        lot,
        coa_documents: coaDocs.results ?? [],
        order_lines: orderLines.results ?? [],
        suggestions: suggestions.results ?? [],
      }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;

    console.error('Get lot error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
