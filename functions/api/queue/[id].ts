import { generateId, logAudit, getClientIp } from '../../lib/db';
import type { ParsedCustomer, ParsedOrder, ParsedShipment } from '../../../shared/connectorOutput';
import {
  requireRole,
  requireTenantAccess,
  NotFoundError,
  BadRequestError,
  errorToResponse,
} from '../../lib/permissions';
import { deleteFile } from '../../lib/r2';
import { approveQueueItem, approveMultiProductQueueItem } from '../../lib/queue-approve';
import type { QueueItem, FieldPickCapture, FieldDismissalCapture, TableEditCapture } from '../../lib/queue-approve';
import type { Env, User } from '../../lib/types';
import type { TemplateFieldMapping } from '../../../shared/types';

/**
 * GET /api/queue/:id
 * Get a single queue item by ID.
 */
export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const queueId = context.params.id as string;

    requireRole(user, 'super_admin', 'org_admin', 'user');

    const item = await context.env.DB.prepare(
      `SELECT pq.*, dt.name as document_type_name, dt.slug as document_type_slug,
              t.name as tenant_name, t.slug as tenant_slug,
              u.name as created_by_name, r.name as reviewed_by_name
       FROM processing_queue pq
       LEFT JOIN document_types dt ON pq.document_type_id = dt.id
       LEFT JOIN tenants t ON pq.tenant_id = t.id
       LEFT JOIN users u ON pq.created_by = u.id
       LEFT JOIN users r ON pq.reviewed_by = r.id
       WHERE pq.id = ?`
    )
      .bind(queueId)
      .first();

    if (!item) {
      throw new NotFoundError('Queue item not found');
    }

    requireTenantAccess(user, item.tenant_id as string);

    return new Response(
      JSON.stringify({ item }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;

    console.error('Get queue item error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};

/**
 * PUT /api/queue/:id
 * Approve or reject a queue item.
 */
export const onRequestPut: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const queueId = context.params.id as string;

    requireRole(user, 'super_admin', 'org_admin');

    const body = (await context.request.json()) as {
      status?: 'approved' | 'rejected';
      // Legacy single-product
      fields?: Record<string, string>;
      product_name?: string;
      // Multi-product
      shared_fields?: Record<string, string>;
      products?: Array<{
        product_name: string;
        fields: Record<string, string>;
        tables?: Array<{ name: string; headers: string[]; rows: string[][] }>;
      }>;
      save_template?: {
        field_mappings: TemplateFieldMapping[];
        auto_ingest_enabled?: boolean;
        confidence_threshold?: number;
      };
      /**
       * Which extraction source the user approved. Defaults to 'text' for
       * backwards compat — dual-run queue items let the user pick 'vlm' to
       * indicate the vision-model output was better. Only used for audit
       * logging; the actual approved values arrive in `fields` regardless.
       */
      selected_source?: 'text' | 'vlm';
      /** Phase 2 capture: per-field source picks derived in the UI. */
      field_picks?: FieldPickCapture[];
      /** Phase 2 capture: explicit field dismissals. */
      dismissals?: FieldDismissalCapture[];
      /** Phase 2 capture: table-level edits (column excludes, header renames, etc). */
      table_edits?: TableEditCapture[];
      /**
       * Human-verified supplier override from the reviewer UI. `supplier_id`
       * (validated against the item's tenant) takes precedence over the raw
       * extraction; `supplier_name` is resolved/created via the alias-aware
       * helper when no id is supplied.
       */
      supplier_id?: string;
      supplier_name?: string;
      /**
       * Review Queue v2: human-EDITED structured records for order/shipment
       * kinds. The producer runs against THESE records on approve (not the
       * raw worker output). Shape by kind:
       *   order    → { customers: ParsedCustomer[], orders: ParsedOrder[] }
       *   shipment → { shipments: ParsedShipment[] }
       * Absent for COA approves; absent for older order/shipment items, in
       * which case handleRecordsApprove falls back to item.ai_records.
       */
      records?: unknown;
    };

    if (!body.status || !['approved', 'rejected'].includes(body.status)) {
      throw new BadRequestError('status must be "approved" or "rejected"');
    }

    // Fetch queue item with tenant info. Cast adds the output_kind / records
    // columns the COA-only QueueItem type omits but the order/shipment approve
    // branch needs (present at runtime via pq.*).
    const item = await context.env.DB.prepare(
      `SELECT pq.*, t.slug as tenant_slug
       FROM processing_queue pq
       LEFT JOIN tenants t ON pq.tenant_id = t.id
       WHERE pq.id = ?`
    )
      .bind(queueId)
      .first<QueueItem & {
        output_kind: string | null;
        ai_records: string | null;
        source_id: string | null;
        connector_run_id: string | null;
      }>();

    if (!item) {
      throw new NotFoundError('Queue item not found');
    }

    requireTenantAccess(user, item.tenant_id);

    if (item.status !== 'pending') {
      throw new BadRequestError(`Queue item is already ${item.status}`);
    }

    if (body.status === 'approved') {
      // Kind-aware approve. order/shipment items auto-ingest in results.ts on
      // the 'ready' callback; running the COA producer (approveQueueItem) on
      // them creates a junk COA document. For these kinds we instead re-run the
      // matching producer idempotently (option (b) — safe re-run) and mark the
      // item reviewed. The COA approve path below is unchanged.
      const kind = item.output_kind || 'coa';
      if (kind === 'order' || kind === 'shipment') {
        return await handleRecordsApprove(context, user, item, body.records);
      }
      const selectedSource: 'text' | 'vlm' = body.selected_source === 'vlm' ? 'vlm' : 'text';
      const captures = {
        fieldPicks: body.field_picks,
        dismissals: body.dismissals,
        tableEdits: body.table_edits,
      };
      const supplierOverride = {
        supplierId: body.supplier_id,
        supplierName: body.supplier_name,
      };
      if (body.products && body.products.length > 0) {
        return await handleMultiProductApprove(context, user, item, body.shared_fields, body.products, body.save_template, selectedSource, captures, supplierOverride);
      }
      return await handleApprove(context, user, item, body.fields, body.product_name, body.save_template, selectedSource, captures, supplierOverride);
    } else {
      return await handleReject(context, user, item);
    }
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;

    console.error('Update queue item error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};

async function handleApprove(
  context: EventContext<Env, string, Record<string, unknown>>,
  user: User,
  item: QueueItem,
  fields?: Record<string, string>,
  productName?: string,
  saveTemplate?: {
    field_mappings: TemplateFieldMapping[];
    auto_ingest_enabled?: boolean;
    confidence_threshold?: number;
  },
  selectedSource: 'text' | 'vlm' = 'text',
  captures?: {
    fieldPicks?: FieldPickCapture[];
    dismissals?: FieldDismissalCapture[];
    tableEdits?: TableEditCapture[];
  },
  supplierOverride?: {
    supplierId?: string;
    supplierName?: string;
  }
): Promise<Response> {
  const result = await approveQueueItem(
    context.env.DB,
    context.env.FILES,
    item,
    {
      fields,
      productName,
      userId: user.id,
      clientIp: getClientIp(context.request),
      selectedSource,
      fieldPicks: captures?.fieldPicks,
      dismissals: captures?.dismissals,
      tableEdits: captures?.tableEdits,
      supplierId: supplierOverride?.supplierId,
      supplierName: supplierOverride?.supplierName,
    }
  );

  // Upsert extraction template if requested
  if (saveTemplate && result.supplierId && item.document_type_id) {
    const templateId = generateId();
    await context.env.DB.prepare(
      `INSERT INTO extraction_templates (id, tenant_id, supplier_id, document_type_id, field_mappings, auto_ingest_enabled, confidence_threshold, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(tenant_id, supplier_id, document_type_id)
       DO UPDATE SET field_mappings = excluded.field_mappings,
                     auto_ingest_enabled = excluded.auto_ingest_enabled,
                     confidence_threshold = excluded.confidence_threshold,
                     updated_at = datetime('now')`
    )
      .bind(
        templateId,
        item.tenant_id,
        result.supplierId,
        item.document_type_id,
        JSON.stringify(saveTemplate.field_mappings),
        saveTemplate.auto_ingest_enabled ? 1 : 0,
        saveTemplate.confidence_threshold ?? 0.85,
        user.id
      )
      .run();
  }

  return new Response(
    JSON.stringify({
      item: { id: item.id, status: 'approved', reviewed_by: user.id },
      document: {
        id: result.documentId,
        tenant_id: item.tenant_id,
        title: result.title,
        external_ref: result.externalRef,
        current_version: 1,
        status: 'active',
      },
    }),
    { headers: { 'Content-Type': 'application/json' } }
  );
}

async function handleMultiProductApprove(
  context: EventContext<Env, string, Record<string, unknown>>,
  user: User,
  item: QueueItem,
  sharedFields?: Record<string, string>,
  products?: Array<{
    product_name: string;
    fields: Record<string, string>;
    tables?: Array<{ name: string; headers: string[]; rows: string[][] }>;
  }>,
  saveTemplate?: {
    field_mappings: TemplateFieldMapping[];
    auto_ingest_enabled?: boolean;
    confidence_threshold?: number;
  },
  selectedSource: 'text' | 'vlm' = 'text',
  captures?: {
    fieldPicks?: FieldPickCapture[];
    dismissals?: FieldDismissalCapture[];
    tableEdits?: TableEditCapture[];
  },
  supplierOverride?: {
    supplierId?: string;
    supplierName?: string;
  }
): Promise<Response> {
  const result = await approveMultiProductQueueItem(
    context.env.DB,
    context.env.FILES,
    item,
    {
      sharedFields,
      products: (products || []).map(p => ({
        productName: p.product_name,
        fields: p.fields,
        tables: p.tables,
      })),
      userId: user.id,
      clientIp: getClientIp(context.request),
      selectedSource,
      fieldPicks: captures?.fieldPicks,
      dismissals: captures?.dismissals,
      tableEdits: captures?.tableEdits,
      supplierId: supplierOverride?.supplierId,
      supplierName: supplierOverride?.supplierName,
    }
  );

  // Upsert extraction template if requested
  if (saveTemplate && result.supplierId && item.document_type_id) {
    const templateId = generateId();
    await context.env.DB.prepare(
      `INSERT INTO extraction_templates (id, tenant_id, supplier_id, document_type_id, field_mappings, auto_ingest_enabled, confidence_threshold, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(tenant_id, supplier_id, document_type_id)
       DO UPDATE SET field_mappings = excluded.field_mappings,
                     auto_ingest_enabled = excluded.auto_ingest_enabled,
                     confidence_threshold = excluded.confidence_threshold,
                     updated_at = datetime('now')`
    )
      .bind(
        templateId,
        item.tenant_id,
        result.supplierId,
        item.document_type_id,
        JSON.stringify(saveTemplate.field_mappings),
        saveTemplate.auto_ingest_enabled ? 1 : 0,
        saveTemplate.confidence_threshold ?? 0.85,
        user.id
      )
      .run();
  }

  return new Response(
    JSON.stringify({
      item: { id: item.id, status: 'approved', reviewed_by: user.id },
      documents: result.documents.map(d => ({
        id: d.documentId,
        tenant_id: item.tenant_id,
        title: d.title,
        product_name: d.productName,
        external_ref: d.externalRef,
        current_version: 1,
        status: 'active',
      })),
    }),
    { headers: { 'Content-Type': 'application/json' } }
  );
}

/**
 * Accumulate per-item producer counts into the batch's connector_runs rollup.
 *
 * Moved here from results.ts in Review Queue v2: order/shipment items no longer
 * auto-produce on the worker callback, so the run accounting now happens on
 * human approve, when the producer actually runs against the reviewed records.
 * Best-effort: a rollup failure must never break the approve, and a missing
 * connector_run_id (manual upload, no batch) is a no-op.
 */
async function accumulateRunRollup(
  db: Env['DB'],
  connectorRunId: string | null,
  counts: { recordsCreated: number; recordsStaged: number; recordsErrored: number }
): Promise<void> {
  if (!connectorRunId) return;
  try {
    const delta = counts.recordsCreated + counts.recordsErrored;
    await db
      .prepare(
        `UPDATE connector_runs SET
           records_found = COALESCE(records_found, 0) + ?,
           records_created = COALESCE(records_created, 0) + ?,
           records_staged = COALESCE(records_staged, 0) + ?,
           records_errored = COALESCE(records_errored, 0) + ?,
           status = CASE
             WHEN COALESCE(records_created, 0) + ? = 0
                  AND COALESCE(records_errored, 0) + ? > 0 THEN 'error'
             WHEN COALESCE(records_errored, 0) + ? > 0 THEN 'partial'
             ELSE 'success'
           END,
           completed_at = datetime('now')
         WHERE id = ?`
      )
      .bind(
        delta,
        counts.recordsCreated,
        counts.recordsStaged,
        counts.recordsErrored,
        counts.recordsCreated,
        counts.recordsErrored,
        counts.recordsErrored,
        connectorRunId
      )
      .run();
  } catch (err) {
    console.error(
      '[queue-approve] connector_runs rollup failed:',
      err instanceof Error ? err.message : String(err)
    );
  }
}

interface OrderRecordsPayload {
  customers: ParsedCustomer[];
  orders: ParsedOrder[];
}
interface ShipmentRecordsPayload {
  shipments: ParsedShipment[];
}

/**
 * Validate + normalize the records payload for an order/shipment approve.
 * Throws BadRequestError (→ 400) on a malformed shape. Returns a payload with
 * the expected arrays present (defaulting to []).
 */
function validateOrderRecords(records: unknown): OrderRecordsPayload {
  if (records === null || typeof records !== 'object') {
    throw new BadRequestError('records must be an object { customers, orders }');
  }
  const r = records as Record<string, unknown>;
  if (r.orders !== undefined && !Array.isArray(r.orders)) {
    throw new BadRequestError('records.orders must be an array');
  }
  if (r.customers !== undefined && !Array.isArray(r.customers)) {
    throw new BadRequestError('records.customers must be an array');
  }
  return {
    customers: (Array.isArray(r.customers) ? r.customers : []) as ParsedCustomer[],
    orders: (Array.isArray(r.orders) ? r.orders : []) as ParsedOrder[],
  };
}

function validateShipmentRecords(records: unknown): ShipmentRecordsPayload {
  if (records === null || typeof records !== 'object') {
    throw new BadRequestError('records must be an object { shipments }');
  }
  const r = records as Record<string, unknown>;
  if (r.shipments !== undefined && !Array.isArray(r.shipments)) {
    throw new BadRequestError('records.shipments must be an array');
  }
  return {
    shipments: (Array.isArray(r.shipments) ? r.shipments : []) as ParsedShipment[],
  };
}

/**
 * Approve an order/shipment queue item (Review Queue v2).
 *
 * order/shipment items NO LONGER auto-produce on the worker callback — they
 * land in review like COA items. The producer (ingestOrders / produceShipment)
 * runs HERE, against the human-EDITED records supplied in the approve body
 * (`body.records`). When `records` is absent (older items), we fall back to the
 * persisted item.ai_records so they stay approvable.
 *
 * After producing we persist the corrected records back onto ai_records, roll
 * up the connector_runs accounting, and mark the item approved.
 */
async function handleRecordsApprove(
  context: EventContext<Env, string, Record<string, unknown>>,
  user: User,
  item: QueueItem & {
    output_kind: string | null;
    ai_records: string | null;
    source_id: string | null;
    connector_run_id: string | null;
  },
  bodyRecords: unknown
): Promise<Response> {
  const kind = item.output_kind || 'coa';

  // Source the records to produce from: prefer the human-edited approve body;
  // fall back to the persisted worker output for older items.
  let rawRecords: unknown = bodyRecords;
  if (rawRecords === undefined) {
    rawRecords = item.ai_records ? JSON.parse(item.ai_records) : {};
  }

  let summary = '';
  let correctedRecords: OrderRecordsPayload | ShipmentRecordsPayload;

  if (kind === 'order') {
    const payload = validateOrderRecords(rawRecords);
    correctedRecords = payload;
    let result;
    try {
      const { ingestOrders } = await import('../../lib/kinds/order');
      result = await ingestOrders(
        context.env.DB,
        {
          orders: payload.orders,
          customers: payload.customers,
          errors: [],
          info: [],
        },
        {
          tenantId: item.tenant_id,
          // NULL (not '') for document-sourced orders — the FK rejects ''.
          connectorId: item.source_id ?? null,
          connectorRunId: item.connector_run_id ?? null,
        }
      );
    } catch (err) {
      throw new BadRequestError(
        `Failed to ingest orders: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    summary = `${result.ordersCreated} created, ${result.ordersUpdated} updated, ${result.errors} failed`;
    await accumulateRunRollup(context.env.DB, item.connector_run_id, {
      recordsCreated: result.ordersCreated + result.customersCreated,
      recordsStaged: result.ordersStaged,
      recordsErrored: result.errors,
    });
  } else {
    const payload = validateShipmentRecords(rawRecords);
    correctedRecords = payload;
    let result;
    try {
      const { produceShipment } = await import('../../lib/kinds/shipment');
      result = await produceShipment(
        context.env.DB,
        payload.shipments,
        {
          tenantId: item.tenant_id,
          sourceId: item.source_id,
          connectorRunId: item.connector_run_id,
        }
      );
    } catch (err) {
      throw new BadRequestError(
        `Failed to produce shipment: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    summary = `${result.bound} bound, ${result.suggested} suggested, ${result.unmatched} unmatched, ${result.errors} failed`;
    await accumulateRunRollup(context.env.DB, item.connector_run_id, {
      recordsCreated: result.bound + result.suggested,
      recordsStaged: 0,
      recordsErrored: result.errors,
    });
  }

  // Persist the corrected records back onto the item (audit trail + so a later
  // re-open shows what was actually approved), and mark reviewed/approved.
  await context.env.DB.prepare(
    `UPDATE processing_queue
     SET ai_records = ?, status = 'approved', reviewed_by = ?, reviewed_at = datetime('now')
     WHERE id = ?`
  )
    .bind(JSON.stringify(correctedRecords), user.id, item.id)
    .run();

  await logAudit(
    context.env.DB,
    user.id,
    item.tenant_id,
    'queue_item.approved',
    'processing_queue',
    item.id,
    JSON.stringify({ output_kind: kind, file_name: item.file_name, summary }),
    getClientIp(context.request)
  );

  return new Response(
    JSON.stringify({
      item: { id: item.id, status: 'approved', reviewed_by: user.id, output_kind: kind },
      summary,
    }),
    { headers: { 'Content-Type': 'application/json' } }
  );
}

async function handleReject(
  context: EventContext<Env, string, Record<string, unknown>>,
  user: User,
  item: {
    id: string;
    tenant_id: string;
    file_r2_key: string;
    file_name: string;
  }
): Promise<Response> {
  // Update queue item status. Also force processing_status to a terminal
  // value: rejecting deletes the R2 file, so if the worker were mid-flight
  // (or still in `queued`/`processing`) it would otherwise spin forever on
  // a 404. Only overwrite when not already terminal so we don't clobber a
  // real extraction outcome with our generic message.
  await context.env.DB.prepare(
    `UPDATE processing_queue
     SET status = 'rejected',
         reviewed_by = ?,
         reviewed_at = datetime('now'),
         processing_status = CASE
           WHEN processing_status IN ('ready', 'error') THEN processing_status
           ELSE 'error'
         END,
         error_message = CASE
           WHEN processing_status IN ('ready', 'error') THEN error_message
           ELSE 'rejected by user'
         END
     WHERE id = ?`
  )
    .bind(user.id, item.id)
    .run();

  // Delete pending R2 file
  await deleteFile(context.env.FILES, item.file_r2_key);

  // Audit log
  await logAudit(
    context.env.DB,
    user.id,
    item.tenant_id,
    'queue_item.rejected',
    'processing_queue',
    item.id,
    JSON.stringify({ file_name: item.file_name }),
    getClientIp(context.request)
  );

  return new Response(
    JSON.stringify({
      item: { id: item.id, status: 'rejected', reviewed_by: user.id },
    }),
    { headers: { 'Content-Type': 'application/json' } }
  );
}
