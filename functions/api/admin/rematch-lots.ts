/**
 * POST /api/admin/rematch-lots
 *
 * Re-runs the order↔COA lot matcher for every lot-bound order_item in the
 * tenant. Use this to retroactively surface matches after a matcher change —
 * e.g. the distributor-code (product_code + COA title prefix) rule, which
 * raises many `lot_only` suggestions to high confidence even when product
 * names (and thus product_ids) differ across the two sides.
 *
 * For each order_item with a `lot_id`, we call `linkOrderToCoas`, which finds
 * COA documents sharing the lot_key and records each as a PENDING suggestion
 * with its basis and confidence. It never links: a person accepts a match
 * (POST /api/lot-matches/:id).
 *
 * Idempotent: suggestions are unique on (order_item_id, document_id); a pending
 * one is only ever raised to higher confidence, and an accepted or rejected one
 * is never touched.
 *
 * Auth: super_admin (any tenant) or org_admin (own tenant only).
 *
 * Scope:
 *   - super_admin: `?tenant_id=` optional; absent = all tenants.
 *   - org_admin: always scoped to their own tenant (any tenant_id param that
 *     doesn't match is rejected).
 *
 * Returns JSON counts:
 *   { order_items_processed, suggestions_created, high_confidence_suggestions }
 * where suggestions_created counts net-new suggestions and
 * high_confidence_suggestions counts pending suggestions for the processed
 * lines at product/code-agreement confidence (>= 0.85) after the run.
 */

import { requireRole, requireTenantAccess, errorToResponse } from '../../lib/permissions';
import { logAudit, getClientIp } from '../../lib/db';
import { linkOrderToCoas, CONFIDENCE_LOT_PRODUCT } from '../../lib/entities/matching';
import type { Env, User } from '../../lib/types';

interface OrderItemRow {
  id: string;
  lot_id: string;
  product_id: string | null;
  tenant_id: string;
}

interface RematchResult {
  order_items_processed: number;
  suggestions_created: number;
  high_confidence_suggestions: number;
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireRole(user, 'super_admin', 'org_admin');

    const db = context.env.DB;
    const url = new URL(context.request.url);
    let tenantFilter = url.searchParams.get('tenant_id');

    // org_admin is locked to their own tenant.
    if (user.role !== 'super_admin') {
      if (!user.tenant_id) {
        return new Response(JSON.stringify({ error: 'No tenant context' }), {
          status: 403,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (tenantFilter && tenantFilter !== user.tenant_id) {
        requireTenantAccess(user, tenantFilter);
      }
      tenantFilter = user.tenant_id;
    }

    const where: string[] = ['oi.lot_id IS NOT NULL'];
    const binds: string[] = [];
    if (tenantFilter) {
      where.push('o.tenant_id = ?');
      binds.push(tenantFilter);
    }

    const rows = await db
      .prepare(
        `SELECT oi.id, oi.lot_id, oi.product_id, o.tenant_id
         FROM order_items oi
         JOIN orders o ON o.id = oi.order_id
         WHERE ${where.join(' AND ')}
         ORDER BY oi.id ASC`
      )
      .bind(...binds)
      .all<OrderItemRow>();

    const result: RematchResult = {
      order_items_processed: 0,
      suggestions_created: 0,
      high_confidence_suggestions: 0,
    };

    for (const oi of rows.results ?? []) {
      result.order_items_processed++;
      try {
        const before = await snapshot(db, oi.id);
        await linkOrderToCoas(db, oi.tenant_id, {
          orderItemId: oi.id,
          lotId: oi.lot_id,
          productId: oi.product_id,
        });
        const after = await snapshot(db, oi.id);

        result.suggestions_created += Math.max(0, after.suggestions - before.suggestions);
        result.high_confidence_suggestions += after.highConfidencePending;
      } catch (err) {
        console.warn(
          'rematch-lots: order_item failed:',
          oi.id,
          err instanceof Error ? err.message : String(err)
        );
      }
    }

    try {
      await logAudit(
        db,
        user.id,
        tenantFilter ?? null,
        'admin.rematch_lots.run',
        'system',
        null,
        JSON.stringify(result),
        getClientIp(context.request)
      );
    } catch (err) {
      console.warn(
        'rematch-lots: audit log failed:',
        err instanceof Error ? err.message : String(err)
      );
    }

    return new Response(JSON.stringify(result), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('rematch-lots error:', err);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

async function snapshot(
  db: D1Database,
  orderItemId: string
): Promise<{ suggestions: number; highConfidencePending: number }> {
  const sugg = await db
    .prepare(
      `SELECT COUNT(*) AS c,
              SUM(CASE WHEN status = 'pending' AND match_confidence >= ? THEN 1 ELSE 0 END) AS hi
         FROM lot_match_suggestions WHERE order_item_id = ?`
    )
    .bind(CONFIDENCE_LOT_PRODUCT, orderItemId)
    .first<{ c: number; hi: number | null }>();
  return {
    suggestions: Number(sugg?.c) || 0,
    highConfidencePending: Number(sugg?.hi) || 0,
  };
}
