/**
 * GET /api/connectors/:id/runs/:runId/staged
 *
 * R1.3 — list orders + items routed to staging by a specific connector
 * run. "Staged" means `orders.staged_at IS NOT NULL`; the orchestrator
 * sets that timestamp when the LLM's reported confidence on an order
 * (or any of its items) falls below the threshold defined in
 * `functions/lib/connectors/orchestrator.ts`.
 *
 * Status code mapping:
 *   - 200 — payload below
 *   - 403 — caller is not super_admin/org_admin, or the connector
 *           belongs to a tenant the caller can't access
 *   - 404 — connector or run not found / belongs to a different connector
 *
 * Response shape:
 *   {
 *     run: { id, started_at, completed_at, status,
 *            records_found, records_created, records_staged },
 *     orders: Array<{
 *       id, order_number, customer_number, customer_name, customer_id,
 *       confidence, staged_at,
 *       primary_metadata, extended_metadata,
 *       items: Array<{ id, product_name, product_code, quantity,
 *                      lot_number, confidence, staged_at }>
 *     }>
 *   }
 *
 * Items are joined per-order in a second query, keyed by order_id, so
 * the response is fully hydrated for the review page. We don't bother
 * paginating: a single connector run rarely produces more than a few
 * dozen orders, and staged orders are a strict subset of those.
 */

import type { Env, User } from '../../../../../lib/types';
import {
  requireRole,
  requireTenantAccess,
  NotFoundError,
  errorToResponse,
} from '../../../../../lib/permissions';
import { resolveConnectorHandle } from '../../../../../lib/connectors/resolveHandle';

interface ConnectorRow {
  id: string;
  tenant_id: string;
}

interface RunRow {
  id: string;
  connector_id: string;
  tenant_id: string;
  status: string;
  started_at: string | null;
  completed_at: string | null;
  records_found: number;
  records_created: number;
  records_staged: number | null;
}

interface OrderRow {
  id: string;
  order_number: string;
  customer_number: string | null;
  customer_name: string | null;
  customer_id: string | null;
  confidence: number | null;
  staged_at: string;
  primary_metadata: string | null;
  extended_metadata: string | null;
}

interface ItemRow {
  id: string;
  order_id: string;
  product_name: string | null;
  product_code: string | null;
  quantity: number | null;
  lot_number: string | null;
  confidence: number | null;
  staged_at: string | null;
}

interface StagedItem {
  id: string;
  product_name: string | null;
  product_code: string | null;
  quantity: number | null;
  lot_number: string | null;
  confidence: number | null;
  staged_at: string | null;
}

interface StagedOrder {
  id: string;
  order_number: string;
  customer_number: string | null;
  customer_name: string | null;
  customer_id: string | null;
  confidence: number | null;
  staged_at: string;
  primary_metadata: Record<string, unknown> | null;
  extended_metadata: Record<string, unknown> | null;
  items: StagedItem[];
}

interface StagedRunResponse {
  run: {
    id: string;
    started_at: string | null;
    completed_at: string | null;
    status: string;
    records_found: number;
    records_created: number;
    records_staged: number;
  };
  orders: StagedOrder[];
}

function parseMetadata(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const connectorHandle = context.params.id as string;
    const runId = context.params.runId as string;

    requireRole(user, 'super_admin', 'org_admin');

    const connector = await resolveConnectorHandle<ConnectorRow>(
      context.env.DB,
      connectorHandle,
      { columns: 'id, tenant_id' },
    );
    if (!connector) {
      throw new NotFoundError('Connector not found');
    }
    requireTenantAccess(user, connector.tenant_id);

    const run = await context.env.DB
      .prepare(
        `SELECT id, connector_id, tenant_id, status, started_at, completed_at,
                records_found, records_created, records_staged
           FROM connector_runs WHERE id = ? AND connector_id = ?`,
      )
      .bind(runId, connector.id)
      .first<RunRow>();
    if (!run) {
      throw new NotFoundError('Run not found');
    }

    const orderRows = await context.env.DB
      .prepare(
        `SELECT id, order_number, customer_number, customer_name, customer_id,
                confidence, staged_at, primary_metadata, extended_metadata
           FROM orders
          WHERE connector_run_id = ? AND staged_at IS NOT NULL
          ORDER BY created_at ASC`,
      )
      .bind(runId)
      .all<OrderRow>();

    const orders = orderRows.results ?? [];

    // Pull items for all staged orders in a single query, grouped client-
    // side. Avoids N+1 round-trips for runs with many staged rows.
    let itemsByOrder: Map<string, ItemRow[]> = new Map();
    if (orders.length > 0) {
      const placeholders = orders.map(() => '?').join(',');
      const itemRows = await context.env.DB
        .prepare(
          `SELECT id, order_id, product_name, product_code, quantity, lot_number,
                  confidence, staged_at
             FROM order_items
            WHERE order_id IN (${placeholders})
            ORDER BY created_at ASC`,
        )
        .bind(...orders.map((o) => o.id))
        .all<ItemRow>();
      itemsByOrder = (itemRows.results ?? []).reduce((acc, row) => {
        const list = acc.get(row.order_id) ?? [];
        list.push(row);
        acc.set(row.order_id, list);
        return acc;
      }, new Map<string, ItemRow[]>());
    }

    const body: StagedRunResponse = {
      run: {
        id: run.id,
        started_at: run.started_at,
        completed_at: run.completed_at,
        status: run.status,
        records_found: run.records_found ?? 0,
        records_created: run.records_created ?? 0,
        records_staged: run.records_staged ?? 0,
      },
      orders: orders.map((o) => ({
        id: o.id,
        order_number: o.order_number,
        customer_number: o.customer_number,
        customer_name: o.customer_name,
        customer_id: o.customer_id,
        confidence: o.confidence,
        staged_at: o.staged_at,
        primary_metadata: parseMetadata(o.primary_metadata),
        extended_metadata: parseMetadata(o.extended_metadata),
        items: (itemsByOrder.get(o.id) ?? []).map((i) => ({
          id: i.id,
          product_name: i.product_name,
          product_code: i.product_code,
          quantity: i.quantity,
          lot_number: i.lot_number,
          confidence: i.confidence,
          staged_at: i.staged_at,
        })),
      })),
    };

    return new Response(JSON.stringify(body), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Get staged run error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }
};
