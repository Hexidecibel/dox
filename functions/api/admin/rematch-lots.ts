/**
 * POST /api/admin/rematch-lots
 *
 * Re-runs the order↔COA lot matcher for every lot-bound order_item in the
 * tenant. Use this to retroactively light up links after a matcher change —
 * notably the distributor-code (product_code + COA title prefix) auto-confirm,
 * which upgrades many previously-weak `lot_only` suggestions to STRONG links
 * even when product names (and thus product_ids) differ across the two sides.
 *
 * For each order_item with a `lot_id`, we call `linkOrderToCoas`, which:
 *   - finds COA documents sharing the lot_key,
 *   - auto-links (writes coa_document_id) on product OR distributor-code
 *     agreement, or
 *   - records a pending suggestion otherwise.
 *
 * Idempotent: `applyStrongLink` only writes on a strictly higher confidence,
 * and suggestions use INSERT OR IGNORE on (order_item_id, document_id).
 *
 * Auth: super_admin (any tenant) or org_admin (own tenant only).
 *
 * Scope:
 *   - super_admin: `?tenant_id=` optional; absent = all tenants.
 *   - org_admin: always scoped to their own tenant (any tenant_id param that
 *     doesn't match is rejected).
 *
 * Returns JSON counts:
 *   { order_items_processed, strong_links_made, suggestions_created }
 * where strong_links_made counts order_items that gained a coa_document_id
 * during this run, and suggestions_created counts net-new pending suggestions.
 */

import { requireRole, requireTenantAccess, errorToResponse } from '../../lib/permissions';
import { logAudit, getClientIp } from '../../lib/db';
import { linkOrderToCoas } from '../../lib/entities/matching';
import type { Env, User } from '../../lib/types';

interface OrderItemRow {
  id: string;
  lot_id: string;
  product_id: string | null;
  tenant_id: string;
}

interface RematchResult {
  order_items_processed: number;
  strong_links_made: number;
  suggestions_created: number;
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
      strong_links_made: 0,
      suggestions_created: 0,
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

        // A newly-set coa_document_id (was null, now set) is a strong link.
        if (!before.linked && after.linked) {
          result.strong_links_made++;
        }
        result.suggestions_created += Math.max(0, after.suggestions - before.suggestions);
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
): Promise<{ linked: boolean; suggestions: number }> {
  const oi = await db
    .prepare('SELECT coa_document_id FROM order_items WHERE id = ?')
    .bind(orderItemId)
    .first<{ coa_document_id: string | null }>();
  const sugg = await db
    .prepare(
      `SELECT COUNT(*) AS c FROM lot_match_suggestions WHERE order_item_id = ?`
    )
    .bind(orderItemId)
    .first<{ c: number }>();
  return {
    linked: !!oi?.coa_document_id,
    suggestions: Number(sugg?.c) || 0,
  };
}
