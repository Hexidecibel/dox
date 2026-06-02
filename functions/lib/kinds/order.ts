import { generateId } from '../db';
import type { ConnectorOutput, ParsedContact, ParsedCustomer } from '../connectors/types';
import { findOrCreateProduct } from '../entities/products';
import { findOrCreateLot } from '../entities/lots';
import { linkOrderToCoas } from '../entities/matching';

/**
 * Producer for the `order` doc-kind. Owns the canonical-entity WRITE block
 * that turns a parsed ConnectorOutput (customers + orders + line items) into
 * rows in customers / customer_contacts / orders / order_items, resolving
 * products + lots and linking order lines to COAs along the way.
 *
 * Extracted verbatim from the output-processing section of
 * orchestrator.executeConnectorRun (Phase P2). Behavior is identical: same
 * upsert keys, same staging threshold, same linkage calls, same rollup
 * counts. The orchestrator still owns executor dispatch, connector_runs
 * lifecycle, and logIntakeEvent; this function only writes entities and
 * reports the counts the orchestrator folds into the run record.
 *
 * NOTE: errors encountered during the writes are pushed onto `output.errors`
 * in place (mutating the caller's ConnectorOutput) — exactly as the inlined
 * code did — so the orchestrator's downstream status/error rollup sees them.
 */

export interface IngestOrdersContext {
  tenantId: string;
  /**
   * Source connector id, or null for output_kind-sourced orders (manual
   * document upload, email-ingest) that have no connector behind them. MUST
   * NOT be coerced to '' — the orders.connector_id FK rejects an empty string,
   * which silently killed every header-only order in the 2026-06 prod run.
   */
  connectorId: string | null;
  /** Connector run id, or null when there is no batch run. Same FK caveat. */
  connectorRunId: string | null;
}

export interface IngestOrdersResult {
  ordersCreated: number;
  ordersUpdated: number;
  ordersStaged: number;
  customersCreated: number;
  errors: number;
  /**
   * Human-readable messages for every record that failed. Surfaced back
   * through results.ts into the queue item's error_message so partial
   * failures are VISIBLE instead of being swallowed into output.errors.
   */
  errorMessages: string[];
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

export async function ingestOrders(
  db: D1Database,
  output: ConnectorOutput,
  ctx: IngestOrdersContext,
): Promise<IngestOrdersResult> {
  const { tenantId, connectorId, connectorRunId } = ctx;

  // Upsert customers
  let customersCreated = 0;
  for (const customer of output.customers) {
    try {
      // customers.customer_number / customers.name are both NOT NULL. A report
      // that lists a customer with no number (or a blank one) can't be a stable
      // upsert key — skip it rather than throw a constraint error that takes the
      // whole record down. name falls back to the number so a missing name
      // never blocks the insert.
      const customerNumber = customer.customer_number?.toString().trim();
      if (!customerNumber) {
        output.errors.push({
          message: `Customer skipped: missing customer_number (name=${customer.name ?? 'n/a'})`,
        });
        continue;
      }
      const customerName = customer.name?.toString().trim() || customerNumber;

      const existing = await db.prepare(
        `SELECT id FROM customers WHERE tenant_id = ? AND customer_number = ?`
      ).bind(tenantId, customerNumber).first<{ id: string }>();

      // Resolve the contact list. If the AI/parser only supplied a single
      // top-level `email`, synthesize a one-entry contact list so the join
      // table still gets populated.
      const contacts = resolveContacts(customer);
      // Always use the first contact's email as the primary backfill when
      // no explicit email was supplied on the customer.
      const primaryEmail = customer.email || contacts[0]?.email || null;

      let customerId: string;
      const customerConfidence = typeof customer._confidence === 'number' ? customer._confidence : null;
      if (existing) {
        customerId = existing.id;
        await db.prepare(
          `UPDATE customers SET name = ?, email = COALESCE(?, email),
             confidence = COALESCE(?, confidence), updated_at = datetime('now')
           WHERE id = ?`
        ).bind(customerName, primaryEmail, customerConfidence, customerId).run();
      } else {
        customerId = generateId();
        await db.prepare(
          `INSERT INTO customers (id, tenant_id, customer_number, name, email, confidence)
           VALUES (?, ?, ?, ?, ?, ?)`
        ).bind(customerId, tenantId, customerNumber, customerName, primaryEmail, customerConfidence).run();
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
            message: `Contact insert failed for ${customerNumber} (${contact.email}): ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      }
    } catch (err) {
      output.errors.push({
        message: `Customer upsert failed for ${customer.customer_number}: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  // Confidence threshold below which a record is staged for human review
  // instead of committed straight to prod tables. Threshold is hardcoded
  // here for now; R2 plan adds per-supplier overrides via the supplier's
  // extraction_instructions field.
  const STAGE_THRESHOLD = 0.7;

  // Upsert orders
  let ordersCreated = 0;
  let ordersStaged = 0;
  for (const order of output.orders) {
    try {
      // order_number is NOT NULL and is the upsert key. A row without one
      // can't be stored or de-duped — record the failure and move on instead
      // of throwing a constraint error.
      const orderNumber = order.order_number?.toString().trim();
      if (!orderNumber) {
        output.errors.push({ message: 'Order skipped: missing order_number' });
        continue;
      }

      // Decide stage vs commit. An order routes to staging if its own
      // _confidence is below the threshold OR any of its items is. We
      // can't trust an order with one shaky line; the reviewer needs to
      // see the whole record. Absent confidence ⇒ 1.0 (commit).
      const orderConfidence = typeof order._confidence === 'number' ? order._confidence : 1;
      const itemConfidences = order.items
        .map(i => (typeof i._confidence === 'number' ? i._confidence : 1));
      const minItemConfidence = itemConfidences.length > 0 ? Math.min(...itemConfidences) : 1;
      const recordConfidence = Math.min(orderConfidence, minItemConfidence);
      const isStaged = recordConfidence < STAGE_THRESHOLD;
      const stagedAt = isStaged ? new Date().toISOString().replace('T', ' ').slice(0, 19) : null;

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
      ).bind(tenantId, orderNumber).first<{ id: string }>();

      let orderId: string;

      // Serialize the new metadata blobs. Pass `null` for empty objects so
      // the DB columns match the legacy-no-mapping behavior exactly.
      const primaryJson = order.primary_metadata && Object.keys(order.primary_metadata).length > 0
        ? JSON.stringify(order.primary_metadata)
        : null;
      const extendedJson = order.extended_metadata && Object.keys(order.extended_metadata).length > 0
        ? JSON.stringify(order.extended_metadata)
        : null;

      // source_data may be absent on output_kind-sourced orders (a manually
      // uploaded report carries no raw connector row). JSON.stringify(undefined)
      // returns the JS value `undefined`, which D1 rejects as a bind param —
      // normalize to a serialized empty object.
      const sourceDataJson = JSON.stringify(order.source_data ?? {});

      if (existing) {
        orderId = existing.id;
        await db.prepare(
          `UPDATE orders SET po_number = COALESCE(?, po_number), customer_id = COALESCE(?, customer_id),
           customer_number = COALESCE(?, customer_number), customer_name = COALESCE(?, customer_name),
           source_data = ?, primary_metadata = ?, extended_metadata = ?,
           confidence = ?, staged_at = ?, updated_at = datetime('now')
           WHERE id = ?`
        ).bind(
          order.po_number || null, customerId,
          order.customer_number || null, order.customer_name || null,
          sourceDataJson,
          primaryJson, extendedJson,
          orderConfidence, stagedAt,
          orderId
        ).run();
      } else {
        orderId = generateId();
        // connector_id / connector_run_id are FK columns: pass real null (not
        // '') for output_kind-sourced orders so the FK doesn't reject a
        // header-only order. This was the root cause of the 0-orders prod run.
        await db.prepare(
          `INSERT INTO orders (id, tenant_id, connector_id, connector_run_id, order_number, po_number,
           customer_id, customer_number, customer_name, source_data, primary_metadata, extended_metadata,
           confidence, staged_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          orderId, tenantId, connectorId || null, connectorRunId || null, orderNumber,
          order.po_number || null, customerId,
          order.customer_number || null, order.customer_name || null,
          sourceDataJson,
          primaryJson, extendedJson,
          orderConfidence, stagedAt
        ).run();
        ordersCreated++;
      }
      if (isStaged) ordersStaged++;

      // Insert order items (delete existing first for idempotency). Items
      // inherit the order's stage state so the review UI can show/edit them
      // together. Per-item confidence is preserved so the reviewer can spot
      // which line dragged the order down.
      if (order.items.length > 0) {
        await db.prepare(`DELETE FROM order_items WHERE order_id = ?`).bind(orderId).run();
        for (const item of order.items) {
          const itemId = generateId();
          const itemConfidence = typeof item._confidence === 'number' ? item._confidence : null;

          // Phase 2 entity graph: resolve product + lot so order lines can be
          // matched to COAs by lot. Supplier is unknown on the order side
          // (nullable). All best-effort — a resolution hiccup must never fail
          // the order upsert.
          let lineProductId: string | null = null;
          let lineLotId: string | null = null;
          if (item.product_name) {
            try {
              const p = await findOrCreateProduct(db, tenantId, item.product_name);
              lineProductId = p.id;
            } catch { /* non-fatal */ }
          }
          if (item.lot_number) {
            try {
              const lot = await findOrCreateLot(db, tenantId, {
                lotNumber: item.lot_number,
                productId: lineProductId,
                source: 'order',
              });
              lineLotId = lot?.id ?? null;
            } catch { /* non-fatal */ }
          }

          await db.prepare(
            `INSERT INTO order_items (id, order_id, product_id, product_name, product_code, quantity, lot_number,
             lot_id, confidence, staged_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).bind(
            itemId, orderId, lineProductId,
            item.product_name || null, item.product_code || null,
            item.quantity || null, item.lot_number || null,
            lineLotId, itemConfidence, stagedAt
          ).run();

          // Try to match this line against existing COAs by lot.
          if (lineLotId) {
            try {
              await linkOrderToCoas(db, tenantId, {
                orderItemId: itemId,
                lotId: lineLotId,
                productId: lineProductId,
              });
            } catch (err) {
              console.warn(
                `[orchestrator] linkOrderToCoas failed for order_item ${itemId}:`,
                err instanceof Error ? err.message : String(err)
              );
            }
          }
        }
      }
    } catch (err) {
      output.errors.push({
        message: `Order upsert failed for ${order.order_number}: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  // Updated count mirrors the orchestrator's prior inline computation:
  // (orders + customers found) minus created minus errored, clamped at zero.
  const totalRecords = output.orders.length + output.customers.length;
  const errorCount = output.errors.length;
  const ordersUpdated = Math.max(
    0,
    totalRecords - ordersCreated - customersCreated - errorCount,
  );

  // Surface the failures. They were already accumulated on output.errors (kept
  // for orchestrator back-compat); also log each so a swallowed constraint
  // error shows up in the worker callback logs, and return the messages so
  // results.ts can fold them into the queue item's error_message.
  const errorMessages = output.errors.map(e => e.message);
  if (errorMessages.length > 0) {
    console.error(
      `[ingestOrders] ${errorMessages.length} record(s) failed for tenant ${tenantId}:`,
      errorMessages.join(' | ')
    );
  }

  return {
    ordersCreated,
    ordersUpdated,
    ordersStaged,
    customersCreated,
    errors: errorCount,
    errorMessages,
  };
}
