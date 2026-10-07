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
 *   { approval_status: 'approved' | 'pending' | 'not_approved', approval_note? }
 *       Whether this item is APPROVED from this supplier (migration 0135,
 *       decision C-001) -- a different fact from whether it is currently
 *       supplied. `not_approved` needs a note. A decision made here is a
 *       person's (`approval_source = 'person'`), and the supplier list import
 *       never overrides it. Audited `product_supplier.approval_decided`.
 *   { facility_id: "<id>" | null }
 *       The facility this item comes from (C-002): one of this supplier's
 *       active facilities, or null for "no facility recorded". Audited
 *       `product_supplier.facility_set`.
 *
 * Neither of the last two changes a gap, a renewal, a search answer or what
 * an order may send. They are recorded and shown.
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
import {
  decideItemApproval,
  loadProductSupplierLink,
  planApprovalDecision,
  resolveAssignableFacility,
  setItemFacility,
  toSupplierProductLink,
} from '../../../../lib/item-approval';
import { isItemApprovalStatus } from '../../../../../shared/itemApproval';
import type { Env, User } from '../../../../lib/types';
import type { SupplierProductLinkWriteRequest } from '../../../../../shared/types';

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

    const body = (await context.request.json()) as SupplierProductLinkWriteRequest;
    if (
      body.discontinued === undefined &&
      body.nothing_owed_reason === undefined &&
      body.approval_status === undefined &&
      body.facility_id === undefined
    ) {
      return json({ error: 'Send discontinued, nothing_owed_reason, approval_status and/or facility_id' }, 400);
    }

    // The approval is checked BEFORE anything is written, so a refused
    // decision cannot leave half of the request applied.
    const fullLink = await loadProductSupplierLink(db, productId, supplierId);
    if (!fullLink) throw new Error('product_suppliers row could not be read');
    if (body.approval_status !== undefined) {
      if (!isItemApprovalStatus(body.approval_status)) {
        return json({ error: 'approval_status must be approved, pending or not_approved' }, 400);
      }
      planApprovalDecision(fullLink, { status: body.approval_status, note: body.approval_note, source: 'person' });
    } else if (body.approval_note !== undefined) {
      return json({ error: 'approval_note is sent together with approval_status' }, 400);
    }
    if (body.facility_id !== undefined) await resolveAssignableFacility(db, fullLink, body.facility_id);

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

    if (body.approval_status !== undefined) {
      const outcome = await decideItemApproval(db, fullLink, {
        status: body.approval_status,
        note: body.approval_note,
        source: 'person',
        actorId: user.id,
      });
      if (outcome.changed) {
        await logAudit(
          db,
          user.id,
          tenantId,
          'product_supplier.approval_decided',
          'supplier',
          supplierId,
          JSON.stringify({
            ...detail,
            approval_status: outcome.status,
            approval_note: outcome.note,
            approval_source: 'person',
            previous: outcome.previous,
          }),
          ip,
        );
      }
    }

    if (body.facility_id !== undefined) {
      const set = await setItemFacility(db, fullLink, body.facility_id);
      if (set.changed) {
        await logAudit(
          db,
          user.id,
          tenantId,
          'product_supplier.facility_set',
          'supplier',
          supplierId,
          JSON.stringify({
            ...detail,
            facility_id: body.facility_id,
            facility_name: set.facility?.name ?? null,
            previous: { facility_id: set.previous_facility_id },
          }),
          ip,
        );
      }
    }

    const updated = await loadProductSupplierLink(db, productId, supplierId);
    return json({ link: updated ? toSupplierProductLink(updated) : null });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Update supplier product link error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
};
