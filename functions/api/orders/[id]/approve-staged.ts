/**
 * POST /api/orders/:id/approve-staged
 *
 * R1.3 — promote a staged order (and its items) into the committed
 * state. Optionally accepts field overrides plus per-item edits.
 *
 * Body shape (all fields optional):
 *   {
 *     order_number?: string,
 *     po_number?: string,
 *     customer_number?: string,
 *     customer_name?: string,
 *     primary_metadata?: object,
 *     extended_metadata?: object,
 *     items?: Array<{
 *       id?: string,           // present ⇒ UPDATE; absent ⇒ INSERT
 *       product_name?: string,
 *       product_code?: string,
 *       quantity?: number,
 *       lot_number?: string,
 *       _delete?: boolean      // present + true ⇒ delete this row
 *     }>
 *   }
 *
 * Status code mapping:
 *   - 200 — updated order shape (same shape as GET /api/orders/:id)
 *   - 400 — order is not currently staged (already committed)
 *   - 403 — caller lacks tenant access (org_admin+ required)
 *   - 404 — order not found
 */

import { logAudit, getClientIp, generateId } from '../../../lib/db';
import {
  requireRole,
  requireTenantAccess,
  NotFoundError,
  BadRequestError,
  errorToResponse,
} from '../../../lib/permissions';
import { sanitizeString } from '../../../lib/validation';
import type { Env, User } from '../../../lib/types';

interface ItemEdit {
  id?: string;
  product_name?: string | null;
  product_code?: string | null;
  quantity?: number | null;
  lot_number?: string | null;
  _delete?: boolean;
}

interface ApproveBody {
  order_number?: string;
  po_number?: string;
  customer_number?: string;
  customer_name?: string;
  primary_metadata?: Record<string, unknown>;
  extended_metadata?: Record<string, unknown>;
  items?: ItemEdit[];
}

interface OrderRow {
  id: string;
  tenant_id: string;
  order_number: string;
  po_number: string | null;
  customer_number: string | null;
  customer_name: string | null;
  customer_id: string | null;
  connector_id: string | null;
  connector_run_id: string | null;
  primary_metadata: string | null;
  extended_metadata: string | null;
  staged_at: string | null;
}

interface ItemRow {
  id: string;
  product_name: string | null;
  product_code: string | null;
  quantity: number | null;
  lot_number: string | null;
}

/**
 * One entry in the corrections diff log. `op` distinguishes update / insert /
 * delete so a downstream learner (R2) can weight them differently — an INSERT
 * means "the LLM missed a line entirely"; a DELETE means "it fabricated one".
 */
interface CorrectionDiff {
  entity: 'order' | 'order_item';
  entity_id: string | null;
  field?: string;
  original?: unknown;
  corrected?: unknown;
  op: 'update' | 'insert' | 'delete';
}

function parseJsonOrNull(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return false;
  if (typeof a !== 'object' || typeof b !== 'object') return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

function toJsonOrNull(value: Record<string, unknown> | undefined): string | null {
  if (!value || Object.keys(value).length === 0) return null;
  return JSON.stringify(value);
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const orderId = context.params.id as string;

    requireRole(user, 'super_admin', 'org_admin');

    const order = await context.env.DB
      .prepare(
        `SELECT id, tenant_id, order_number, po_number,
                customer_number, customer_name, customer_id,
                connector_id, connector_run_id,
                primary_metadata, extended_metadata, staged_at
           FROM orders WHERE id = ?`,
      )
      .bind(orderId)
      .first<OrderRow>();

    if (!order) {
      throw new NotFoundError('Order not found');
    }
    requireTenantAccess(user, order.tenant_id);

    if (order.staged_at === null) {
      throw new BadRequestError('Order is not currently staged');
    }

    // Snapshot the LLM-original items BEFORE any UPDATE / DELETE / INSERT
    // runs so the corrections log captures the actual diff. Without this
    // we'd see "what the user typed" vs "what the user typed" and lose
    // the learning signal entirely.
    const originalItems = await context.env.DB
      .prepare(`SELECT id, product_name, product_code, quantity, lot_number
                  FROM order_items WHERE order_id = ?`)
      .bind(orderId)
      .all<ItemRow>();
    const originalItemsById = new Map<string, ItemRow>(
      (originalItems.results ?? []).map((r) => [r.id, r]),
    );

    let body: ApproveBody = {};
    // Empty body is valid (approve-as-is). Only attempt to parse JSON
    // when there's a Content-Length > 0 or a content-type header — the
    // .json() call throws on empty stream which would otherwise 500.
    const contentLength = context.request.headers.get('content-length');
    const hasBody = contentLength !== null && parseInt(contentLength, 10) > 0;
    if (hasBody) {
      try {
        body = (await context.request.json()) as ApproveBody;
      } catch {
        throw new BadRequestError('Invalid JSON body');
      }
    }

    // Collect order-level field overrides + record diffs as we go.
    // Each `diffs.push` here captures a learning signal for R2: "the LLM
    // emitted X; the human corrected it to Y on this supplier's records".
    const diffs: CorrectionDiff[] = [];
    const updates: string[] = [];
    const params: (string | number | null)[] = [];

    const recordOrderDiff = (field: keyof OrderRow, original: unknown, corrected: unknown) => {
      if (!deepEqual(original, corrected)) {
        diffs.push({ entity: 'order', entity_id: orderId, field: field as string, original, corrected, op: 'update' });
      }
    };

    if (body.order_number !== undefined) {
      const next = sanitizeString(body.order_number);
      recordOrderDiff('order_number', order.order_number, next);
      updates.push('order_number = ?');
      params.push(next);
    }
    if (body.po_number !== undefined) {
      const next = body.po_number ? sanitizeString(body.po_number) : null;
      recordOrderDiff('po_number', order.po_number, next);
      updates.push('po_number = ?');
      params.push(next);
    }
    if (body.customer_number !== undefined) {
      const next = body.customer_number ? sanitizeString(body.customer_number) : null;
      recordOrderDiff('customer_number', order.customer_number, next);
      updates.push('customer_number = ?');
      params.push(next);
    }
    if (body.customer_name !== undefined) {
      const next = body.customer_name ? sanitizeString(body.customer_name) : null;
      recordOrderDiff('customer_name', order.customer_name, next);
      updates.push('customer_name = ?');
      params.push(next);
    }
    if (body.primary_metadata !== undefined) {
      recordOrderDiff('primary_metadata', parseJsonOrNull(order.primary_metadata), body.primary_metadata);
      updates.push('primary_metadata = ?');
      params.push(toJsonOrNull(body.primary_metadata));
    }
    if (body.extended_metadata !== undefined) {
      recordOrderDiff('extended_metadata', parseJsonOrNull(order.extended_metadata), body.extended_metadata);
      updates.push('extended_metadata = ?');
      params.push(toJsonOrNull(body.extended_metadata));
    }

    // If the user edited customer_number, re-resolve customer_id the same
    // way the orchestrator does (functions/lib/connectors/orchestrator.ts
    // ~L303) so the committed row points at the right customer record.
    if (body.customer_number !== undefined) {
      const nextCustomerNumber = body.customer_number?.trim() || null;
      if (nextCustomerNumber && nextCustomerNumber !== order.customer_number) {
        const customer = await context.env.DB
          .prepare(`SELECT id FROM customers WHERE tenant_id = ? AND customer_number = ?`)
          .bind(order.tenant_id, nextCustomerNumber)
          .first<{ id: string }>();
        updates.push('customer_id = ?');
        params.push(customer?.id ?? null);
      } else if (!nextCustomerNumber) {
        updates.push('customer_id = ?');
        params.push(null);
      }
    }

    // Always clear staged_at on the order — this endpoint's job is to
    // promote the row out of staging. Items get the same treatment
    // below, regardless of whether the user edited them, because the
    // orchestrator routes items as a sibling unit to the order: if the
    // order is committed, every item must be committed too.
    updates.push('staged_at = ?');
    params.push(null);
    updates.push("updated_at = datetime('now')");

    params.push(orderId);
    await context.env.DB
      .prepare(`UPDATE orders SET ${updates.join(', ')} WHERE id = ?`)
      .bind(...params)
      .run();

    // Apply per-item edits. Three modes:
    //   1. { id, _delete: true }       → DELETE FROM order_items
    //   2. { id, <fields> }            → UPDATE that row's columns
    //   3. { <fields> } (no id)        → INSERT a new row
    if (body.items && Array.isArray(body.items)) {
      for (const item of body.items) {
        if (item._delete && item.id) {
          const original = originalItemsById.get(item.id);
          if (original) {
            diffs.push({ entity: 'order_item', entity_id: item.id, original, corrected: null, op: 'delete' });
          }
          await context.env.DB
            .prepare(`DELETE FROM order_items WHERE id = ? AND order_id = ?`)
            .bind(item.id, orderId)
            .run();
          continue;
        }

        if (item.id) {
          const original = originalItemsById.get(item.id);
          const itemUpdates: string[] = [];
          const itemParams: (string | number | null)[] = [];
          const sanitize = (s: string | null | undefined) => s ? sanitizeString(s) : null;
          const recordItemDiff = (field: string, prev: unknown, next: unknown) => {
            if (!deepEqual(prev, next)) {
              diffs.push({ entity: 'order_item', entity_id: item.id ?? null, field, original: prev, corrected: next, op: 'update' });
            }
          };
          if (item.product_name !== undefined) {
            const next = sanitize(item.product_name);
            recordItemDiff('product_name', original?.product_name ?? null, next);
            itemUpdates.push('product_name = ?');
            itemParams.push(next);
          }
          if (item.product_code !== undefined) {
            const next = sanitize(item.product_code);
            recordItemDiff('product_code', original?.product_code ?? null, next);
            itemUpdates.push('product_code = ?');
            itemParams.push(next);
          }
          if (item.quantity !== undefined) {
            recordItemDiff('quantity', original?.quantity ?? null, item.quantity);
            itemUpdates.push('quantity = ?');
            itemParams.push(item.quantity);
          }
          if (item.lot_number !== undefined) {
            const next = sanitize(item.lot_number);
            recordItemDiff('lot_number', original?.lot_number ?? null, next);
            itemUpdates.push('lot_number = ?');
            itemParams.push(next);
          }
          if (itemUpdates.length === 0) continue;
          itemParams.push(item.id, orderId);
          await context.env.DB
            .prepare(
              `UPDATE order_items SET ${itemUpdates.join(', ')}
                 WHERE id = ? AND order_id = ?`,
            )
            .bind(...itemParams)
            .run();
        } else {
          const newId = generateId();
          const newItem = {
            product_name: item.product_name ? sanitizeString(item.product_name) : null,
            product_code: item.product_code ? sanitizeString(item.product_code) : null,
            quantity: item.quantity ?? null,
            lot_number: item.lot_number ? sanitizeString(item.lot_number) : null,
          };
          diffs.push({ entity: 'order_item', entity_id: newId, original: null, corrected: newItem, op: 'insert' });
          await context.env.DB
            .prepare(
              `INSERT INTO order_items (id, order_id, product_name, product_code,
                                        quantity, lot_number)
               VALUES (?, ?, ?, ?, ?, ?)`,
            )
            .bind(newId, orderId, newItem.product_name, newItem.product_code, newItem.quantity, newItem.lot_number)
            .run();
        }
      }
    }

    // Clear staged_at on every remaining item belonging to the order —
    // including ones the user didn't touch. The orchestrator stamps
    // items with the parent order's staged_at; approval inverts that.
    await context.env.DB
      .prepare(`UPDATE order_items SET staged_at = NULL WHERE order_id = ?`)
      .bind(orderId)
      .run();

    // R1.5 — persist the original-vs-corrected diff so R2 can mine it for
    // per-supplier extraction instructions ("Anderson Dairy always has
    // CODE DATE label for expiration_date", etc.). Approve-as-is runs
    // skip this — no diff, no learning signal.
    if (diffs.length > 0) {
      // Use customer_number from the corrected body if the user updated
      // it; otherwise fall back to the order's pre-edit value. R2
      // aggregates by customer_number so we want the post-correction
      // identity here.
      const correctedCustomerNumber =
        body.customer_number !== undefined
          ? (body.customer_number ? sanitizeString(body.customer_number) : null)
          : order.customer_number;
      await context.env.DB
        .prepare(
          `INSERT INTO connector_extraction_corrections
             (id, tenant_id, connector_id, connector_run_id, order_id,
              customer_id, customer_number, diffs, reviewer_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          generateId(),
          order.tenant_id,
          order.connector_id,
          order.connector_run_id,
          orderId,
          order.customer_id,
          correctedCustomerNumber,
          JSON.stringify(diffs),
          user.id,
        )
        .run();
    }

    await logAudit(
      context.env.DB,
      user.id,
      order.tenant_id,
      'order.approve_staged',
      'order',
      orderId,
      JSON.stringify({
        order_number: order.order_number,
        overrides: body,
        tenant_id: order.tenant_id,
      }),
      getClientIp(context.request),
    );

    const updated = await context.env.DB
      .prepare(`SELECT * FROM orders WHERE id = ?`)
      .bind(orderId)
      .first();
    const items = await context.env.DB
      .prepare(`SELECT * FROM order_items WHERE order_id = ? ORDER BY created_at ASC`)
      .bind(orderId)
      .all();

    return new Response(
      JSON.stringify({ order: updated, items: items.results ?? [] }),
      { headers: { 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Approve staged order error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }
};
