import { generateId, logAudit } from '../db';
import type { ConnectorContext, ConnectorOutput, ConnectorInput, ParsedContact, ParsedCustomer } from './types';
import { getConnectorExecutor } from './index';
import { normalizeFieldMappings } from '../../../shared/fieldMappings';

/**
 * Universal-doors orchestrator (Phase B0). The connector row no longer
 * carries a per-type tag — every connector exposes every intake door.
 * Dispatch is keyed off `input.type` (the path-of-entry discriminant on
 * `ConnectorInput`). Once a file/payload is in hand, the parse →
 * orders/customers → audit tail is identical for every door.
 */
interface OrchestratorParams {
  db: D1Database;
  r2?: R2Bucket;
  tenantId: string;
  connectorId: string;
  config: Record<string, unknown>;
  /**
   * Raw field_mappings blob read from the connectors table. Accepted in any
   * legacy shape and normalized to v2 internally — callers don't need to
   * preprocess.
   */
  fieldMappings: unknown;
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

/**
 * Build the canonical contact list for a parsed customer.
 * - Prefer the explicit `contacts[]` (from AI extraction of registry rows).
 * - Fall back to the single `email` field when no contacts are present.
 * - Dedup case-insensitively by email within the list.
 */
function resolveContacts(customer: ParsedCustomer): ParsedContact[] {
  const result: ParsedContact[] = [];
  const seen = new Set<string>();
  const push = (c: ParsedContact) => {
    const email = c.email?.trim();
    if (!email) return;
    const key = email.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    result.push({ ...c, email });
  };

  if (Array.isArray(customer.contacts)) {
    for (const c of customer.contacts) push(c);
  }
  if (result.length === 0 && customer.email) {
    push({ email: customer.email });
  }
  return result;
}

export async function executeConnectorRun(params: OrchestratorParams): Promise<OrchestratorResult> {
  const {
    db, r2, tenantId, connectorId,
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
    // Dispatch by the runtime intake path. The same connector row can be
    // driven from any door — so the executor lookup uses input.type, not
    // a per-row tag.
    const executor = getConnectorExecutor(input.type);
    // Normalize the stored field_mappings blob into the v2 shape once per
    // run. The email executor, parseCSVAttachment, and parseWithAI all rely
    // on ctx.fieldMappings being v2.
    const normalizedMappings = normalizeFieldMappings(fieldMappings);
    const ctx: ConnectorContext = {
      db, r2, tenantId, connectorId, config,
      fieldMappings: normalizedMappings,
      credentials,
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

      // Resolve the contact list. If the AI/parser only supplied a single
      // top-level `email`, synthesize a one-entry contact list so the join
      // table still gets populated.
      const contacts = resolveContacts(customer);
      // Always use the first contact's email as the primary backfill when
      // no explicit email was supplied on the customer.
      const primaryEmail = customer.email || contacts[0]?.email || null;

      let customerId: string;
      if (existing) {
        customerId = existing.id;
        await db.prepare(
          `UPDATE customers SET name = ?, email = COALESCE(?, email), updated_at = datetime('now')
           WHERE id = ?`
        ).bind(customer.name, primaryEmail, customerId).run();
      } else {
        customerId = generateId();
        await db.prepare(
          `INSERT INTO customers (id, tenant_id, customer_number, name, email)
           VALUES (?, ?, ?, ?, ?)`
        ).bind(customerId, tenantId, customer.customer_number, customer.name, primaryEmail).run();
        customersCreated++;
      }

      // Insert each contact. First in the list is primary (unless the
      // parser explicitly flagged one). Per-customer email uniqueness is
      // enforced at the DB layer via a UNIQUE (customer_id, lower(email))
      // index — duplicates are silently skipped via OR IGNORE so re-runs
      // don't crash.
      const explicitPrimarySeen = contacts.some(c => c.is_primary === true);
      for (let i = 0; i < contacts.length; i++) {
        const contact = contacts[i];
        const isPrimary = explicitPrimarySeen
          ? (contact.is_primary === true ? 1 : 0)
          : (i === 0 ? 1 : 0);
        try {
          await db.prepare(
            `INSERT OR IGNORE INTO customer_contacts
             (id, customer_id, tenant_id, name, email, role, is_primary)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
          ).bind(
            generateId(),
            customerId,
            tenantId,
            contact.name || null,
            contact.email,
            contact.role || null,
            isPrimary,
          ).run();
        } catch (err) {
          output.errors.push({
            message: `Contact insert failed for ${customer.customer_number} (${contact.email}): ${err instanceof Error ? err.message : String(err)}`,
          });
        }
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

      // Serialize the new metadata blobs. Pass `null` for empty objects so
      // the DB columns match the legacy-no-mapping behavior exactly.
      const primaryJson = order.primary_metadata && Object.keys(order.primary_metadata).length > 0
        ? JSON.stringify(order.primary_metadata)
        : null;
      const extendedJson = order.extended_metadata && Object.keys(order.extended_metadata).length > 0
        ? JSON.stringify(order.extended_metadata)
        : null;

      if (existing) {
        orderId = existing.id;
        await db.prepare(
          `UPDATE orders SET po_number = COALESCE(?, po_number), customer_id = COALESCE(?, customer_id),
           customer_number = COALESCE(?, customer_number), customer_name = COALESCE(?, customer_name),
           source_data = ?, primary_metadata = ?, extended_metadata = ?, updated_at = datetime('now')
           WHERE id = ?`
        ).bind(
          order.po_number || null, customerId,
          order.customer_number || null, order.customer_name || null,
          JSON.stringify(order.source_data),
          primaryJson, extendedJson,
          orderId
        ).run();
      } else {
        orderId = generateId();
        await db.prepare(
          `INSERT INTO orders (id, tenant_id, connector_id, connector_run_id, order_number, po_number,
           customer_id, customer_number, customer_name, source_data, primary_metadata, extended_metadata)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          orderId, tenantId, connectorId, runId, order.order_number,
          order.po_number || null, customerId,
          order.customer_number || null, order.customer_name || null,
          JSON.stringify(order.source_data),
          primaryJson, extendedJson
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

  // Determine final status. `info[]` is purely informational (processing
  // summaries, skipped-sheet notices, etc.) and must NOT count toward the
  // error tally or the partial/success decision.
  const totalRecords = output.orders.length + output.customers.length;
  const errorCount = output.errors.length;
  const infoMessages = output.info || [];
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
    // Clamp to zero: on a failed run totalRecords can be 0 while errorCount
    // is positive, which would otherwise produce a negative updated count.
    Math.max(0, totalRecords - ordersCreated - customersCreated - errorCount),
    errorCount,
    errorCount > 0 ? output.errors.map(e => e.message).join('; ') : null,
    JSON.stringify({ errors: output.errors, info: infoMessages }),
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
