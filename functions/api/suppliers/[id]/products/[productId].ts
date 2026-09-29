/**
 * PUT /api/suppliers/:id/products/:productId — two facts about "this supplier
 * ships this product" that per-product requirements need (migration 0123):
 *
 *   { discontinued: true | false }
 *       "No longer supplied". A discontinued product is not checked per
 *       product, and the gap report NAMES it in a caveat rather than dropping
 *       it. `false` restores it.
 *   { nothing_owed_reason: "packaging SKU" | null }
 *       Declare that this product owes nothing per product, with a reason, so
 *       it reads as settled instead of "nothing set up". null clears it. A
 *       declaration without a reason is refused: an obligation that vanished
 *       for no recorded reason is the failure this exists to prevent.
 *
 * A product linked only through the legacy `products.supplier_id` column has
 * no `product_suppliers` row to hold these facts, so one is created — with
 * source NULL, because the link predates anyone recording how it was made.
 *
 * org_admin / super_admin; each change audited with the previous value.
 */

import { generateId, logAudit, getClientIp } from '../../../../lib/db';
import { requireRole, NotFoundError, errorToResponse } from '../../../../lib/permissions';
import { sanitizeString } from '../../../../lib/validation';
import type { Env, User } from '../../../../lib/types';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

interface LinkRow {
  id: string;
  discontinued_at: string | null;
  discontinued_by: string | null;
  nothing_owed_reason: string | null;
  nothing_owed_at: string | null;
  nothing_owed_by: string | null;
}

export const onRequestPut: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireRole(user, 'super_admin', 'org_admin');
    const db = context.env.DB;
    const supplierId = context.params.id as string;
    const productId = context.params.productId as string;

    const supplier = await db
      .prepare('SELECT id, tenant_id, name FROM suppliers WHERE id = ?')
      .bind(supplierId)
      .first<{ id: string; tenant_id: string; name: string }>();
    if (!supplier || (user.role !== 'super_admin' && supplier.tenant_id !== user.tenant_id)) {
      throw new NotFoundError('Supplier not found');
    }
    const tenantId = supplier.tenant_id;

    const product = await db
      .prepare(
        `SELECT p.id, p.name, p.supplier_id FROM products p WHERE p.id = ? AND p.tenant_id = ?`,
      )
      .bind(productId, tenantId)
      .first<{ id: string; name: string; supplier_id: string | null }>();
    if (!product) throw new NotFoundError('Product not found');

    let link = await db
      .prepare(
        `SELECT id, discontinued_at, discontinued_by, nothing_owed_reason, nothing_owed_at, nothing_owed_by
           FROM product_suppliers WHERE product_id = ? AND supplier_id = ?`,
      )
      .bind(productId, supplierId)
      .first<LinkRow>();
    if (!link) {
      if (product.supplier_id !== supplierId) {
        throw new NotFoundError('That product is not linked to this supplier');
      }
      // Legacy-only link: give it a product_suppliers row to hold the facts.
      const id = generateId();
      await db
        .prepare(
          `INSERT INTO product_suppliers (id, tenant_id, product_id, supplier_id, source)
           VALUES (?, ?, ?, ?, NULL)
           ON CONFLICT(product_id, supplier_id) DO NOTHING`,
        )
        .bind(id, tenantId, productId, supplierId)
        .run();
      link = await db
        .prepare(
          `SELECT id, discontinued_at, discontinued_by, nothing_owed_reason, nothing_owed_at, nothing_owed_by
             FROM product_suppliers WHERE product_id = ? AND supplier_id = ?`,
        )
        .bind(productId, supplierId)
        .first<LinkRow>();
      if (!link) throw new Error('product_suppliers row could not be created');
    }

    const body = (await context.request.json()) as {
      discontinued?: boolean;
      nothing_owed_reason?: string | null;
    };
    if (body.discontinued === undefined && body.nothing_owed_reason === undefined) {
      return json({ error: 'Send discontinued and/or nothing_owed_reason' }, 400);
    }

    const ip = getClientIp(context.request);
    const detail = { supplier_name: supplier.name, product_id: productId, product_name: product.name };

    if (body.discontinued !== undefined) {
      const want = Boolean(body.discontinued);
      const is = link.discontinued_at != null;
      if (want !== is) {
        await db
          .prepare(
            want
              ? `UPDATE product_suppliers SET discontinued_at = datetime('now'), discontinued_by = ?, updated_at = datetime('now') WHERE id = ?`
              : `UPDATE product_suppliers SET discontinued_at = NULL, discontinued_by = NULL, updated_at = datetime('now') WHERE id = ?`,
          )
          .bind(...(want ? [user.id, link.id] : [link.id]))
          .run();
        await logAudit(
          db,
          user.id,
          tenantId,
          want ? 'supplier_product.discontinued' : 'supplier_product.resupplied',
          'supplier',
          supplierId,
          JSON.stringify({
            ...detail,
            previous: { discontinued_at: link.discontinued_at, discontinued_by: link.discontinued_by },
          }),
          ip,
        );
      }
    }

    if (body.nothing_owed_reason !== undefined) {
      const reason = body.nothing_owed_reason ? sanitizeString(body.nothing_owed_reason) : null;
      if (body.nothing_owed_reason !== null && !reason) {
        return json({ error: 'Declaring that nothing is owed needs a reason' }, 400);
      }
      if (reason !== link.nothing_owed_reason) {
        await db
          .prepare(
            reason
              ? `UPDATE product_suppliers SET nothing_owed_reason = ?, nothing_owed_at = datetime('now'), nothing_owed_by = ?, updated_at = datetime('now') WHERE id = ?`
              : `UPDATE product_suppliers SET nothing_owed_reason = NULL, nothing_owed_at = NULL, nothing_owed_by = NULL, updated_at = datetime('now') WHERE id = ?`,
          )
          .bind(...(reason ? [reason, user.id, link.id] : [link.id]))
          .run();
        await logAudit(
          db,
          user.id,
          tenantId,
          reason ? 'supplier_product.nothing_owed_declared' : 'supplier_product.nothing_owed_cleared',
          'supplier',
          supplierId,
          JSON.stringify({
            ...detail,
            reason,
            previous: {
              nothing_owed_reason: link.nothing_owed_reason,
              nothing_owed_at: link.nothing_owed_at,
              nothing_owed_by: link.nothing_owed_by,
            },
          }),
          ip,
        );
      }
    }

    const updated = await db
      .prepare(
        `SELECT product_id, supplier_id, source, discontinued_at, discontinued_by,
                nothing_owed_reason, nothing_owed_at, nothing_owed_by
           FROM product_suppliers WHERE id = ?`,
      )
      .bind(link.id)
      .first();
    return json({ link: updated });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Update supplier product link error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
};
