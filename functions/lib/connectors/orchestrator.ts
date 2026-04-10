import { generateId, logAudit } from '../db';
import type { ConnectorContext, ConnectorOutput, ConnectorInput } from './types';
import { getConnectorExecutor } from './index';
import type { ConnectorType } from '../../../shared/types';

interface OrchestratorParams {
  db: D1Database;
  r2?: R2Bucket;
  tenantId: string;
  connectorId: string;
  connectorType: ConnectorType;
  config: Record<string, unknown>;
  fieldMappings: Record<string, string>;
  credentials?: Record<string, unknown>;
  input: ConnectorInput;
  userId?: string;
  qwenUrl?: string;
  qwenSecret?: string;
}

export interface OrchestratorResult {
  runId: string;
  status: 'success' | 'partial' | 'error';
  ordersCreated: number;
  customersCreated: number;
  errors: string[];
}

export async function executeConnectorRun(params: OrchestratorParams): Promise<OrchestratorResult> {
  const {
    db, r2, tenantId, connectorId, connectorType,
    config, fieldMappings, credentials, input, userId,
    qwenUrl, qwenSecret,
  } = params;

  const runId = generateId();

  // Create run record
  await db.prepare(
    `INSERT INTO connector_runs (id, connector_id, tenant_id, status)
     VALUES (?, ?, ?, 'running')`
  ).bind(runId, connectorId, tenantId).run();

  let output: ConnectorOutput;

  try {
    const executor = getConnectorExecutor(connectorType);
    const ctx: ConnectorContext = {
      db, r2, tenantId, connectorId, config, fieldMappings, credentials,
      qwenUrl, qwenSecret,
    };

    output = await executor(ctx, input);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    await db.prepare(
      `UPDATE connector_runs SET status = 'error', error_message = ?, completed_at = datetime('now')
       WHERE id = ?`
    ).bind(errorMsg, runId).run();

    await db.prepare(
      `UPDATE connectors SET last_run_at = datetime('now'), last_error = ?, updated_at = datetime('now')
       WHERE id = ?`
    ).bind(errorMsg, connectorId).run();

    return { runId, status: 'error', ordersCreated: 0, customersCreated: 0, errors: [errorMsg] };
  }

  // Upsert customers
  let customersCreated = 0;
  for (const customer of output.customers) {
    try {
      const existing = await db.prepare(
        `SELECT id FROM customers WHERE tenant_id = ? AND customer_number = ?`
      ).bind(tenantId, customer.customer_number).first<{ id: string }>();

      if (existing) {
        // Update name/email if provided
        await db.prepare(
          `UPDATE customers SET name = ?, email = COALESCE(?, email), updated_at = datetime('now')
           WHERE id = ?`
        ).bind(customer.name, customer.email || null, existing.id).run();
      } else {
        const id = generateId();
        await db.prepare(
          `INSERT INTO customers (id, tenant_id, customer_number, name, email)
           VALUES (?, ?, ?, ?, ?)`
        ).bind(id, tenantId, customer.customer_number, customer.name, customer.email || null).run();
        customersCreated++;
      }
    } catch (err) {
      output.errors.push({
        message: `Customer upsert failed for ${customer.customer_number}: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  // Upsert orders
  let ordersCreated = 0;
  for (const order of output.orders) {
    try {
      // Resolve customer_id from customer_number
      let customerId: string | null = null;
      if (order.customer_number) {
        const customer = await db.prepare(
          `SELECT id FROM customers WHERE tenant_id = ? AND customer_number = ?`
        ).bind(tenantId, order.customer_number).first<{ id: string }>();
        customerId = customer?.id || null;
      }

      // Check for existing order (upsert by tenant + order_number)
      const existing = await db.prepare(
        `SELECT id FROM orders WHERE tenant_id = ? AND order_number = ?`
      ).bind(tenantId, order.order_number).first<{ id: string }>();

      let orderId: string;

      if (existing) {
        orderId = existing.id;
        await db.prepare(
          `UPDATE orders SET po_number = COALESCE(?, po_number), customer_id = COALESCE(?, customer_id),
           customer_number = COALESCE(?, customer_number), customer_name = COALESCE(?, customer_name),
           source_data = ?, updated_at = datetime('now')
           WHERE id = ?`
        ).bind(
          order.po_number || null, customerId,
          order.customer_number || null, order.customer_name || null,
          JSON.stringify(order.source_data), orderId
        ).run();
      } else {
        orderId = generateId();
        await db.prepare(
          `INSERT INTO orders (id, tenant_id, connector_id, connector_run_id, order_number, po_number,
           customer_id, customer_number, customer_name, source_data)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          orderId, tenantId, connectorId, runId, order.order_number,
          order.po_number || null, customerId,
          order.customer_number || null, order.customer_name || null,
          JSON.stringify(order.source_data)
        ).run();
        ordersCreated++;
      }

      // Insert order items (delete existing first for idempotency)
      if (order.items.length > 0) {
        await db.prepare(`DELETE FROM order_items WHERE order_id = ?`).bind(orderId).run();
        for (const item of order.items) {
          const itemId = generateId();
          await db.prepare(
            `INSERT INTO order_items (id, order_id, product_name, product_code, quantity, lot_number)
             VALUES (?, ?, ?, ?, ?, ?)`
          ).bind(
            itemId, orderId,
            item.product_name || null, item.product_code || null,
            item.quantity || null, item.lot_number || null
          ).run();
        }
      }
    } catch (err) {
      output.errors.push({
        message: `Order upsert failed for ${order.order_number}: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  // Determine final status
  const totalRecords = output.orders.length + output.customers.length;
  const errorCount = output.errors.length;
  const status = errorCount === 0 ? 'success' : (ordersCreated > 0 || customersCreated > 0) ? 'partial' : 'error';

  // Update run record
  await db.prepare(
    `UPDATE connector_runs SET
     status = ?, completed_at = datetime('now'),
     records_found = ?, records_created = ?, records_updated = ?, records_errored = ?,
     error_message = ?, details = ?
     WHERE id = ?`
  ).bind(
    status,
    totalRecords,
    ordersCreated + customersCreated,
    totalRecords - ordersCreated - customersCreated - errorCount,
    errorCount,
    errorCount > 0 ? output.errors.map(e => e.message).join('; ') : null,
    JSON.stringify({ errors: output.errors }),
    runId
  ).run();

  // Update connector last_run
  await db.prepare(
    `UPDATE connectors SET last_run_at = datetime('now'), last_error = ?, updated_at = datetime('now')
     WHERE id = ?`
  ).bind(
    status === 'error' ? output.errors.map(e => e.message).join('; ') : null,
    connectorId
  ).run();

  // Audit log
  if (userId) {
    await logAudit(db, userId, tenantId, 'connector.run', 'connector', connectorId,
      JSON.stringify({ run_id: runId, status, orders_created: ordersCreated, customers_created: customersCreated }), null);
  }

  return {
    runId,
    status,
    ordersCreated,
    customersCreated,
    errors: output.errors.map(e => e.message),
  };
}
