import { generateId, logAudit, getClientIp } from '../../lib/db';
import {
  requireRole,
  requireTenantAccess,
  NotFoundError,
  BadRequestError,
  errorToResponse,
} from '../../lib/permissions';
import { deleteFile } from '../../lib/r2';
import { approveQueueItem, approveMultiProductQueueItem } from '../../lib/queue-approve';
import type { QueueItem } from '../../lib/queue-approve';
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
    };

    if (!body.status || !['approved', 'rejected'].includes(body.status)) {
      throw new BadRequestError('status must be "approved" or "rejected"');
    }

    // Fetch queue item with tenant info
    const item = await context.env.DB.prepare(
      `SELECT pq.*, t.slug as tenant_slug
       FROM processing_queue pq
       LEFT JOIN tenants t ON pq.tenant_id = t.id
       WHERE pq.id = ?`
    )
      .bind(queueId)
      .first<QueueItem>();

    if (!item) {
      throw new NotFoundError('Queue item not found');
    }

    requireTenantAccess(user, item.tenant_id);

    if (item.status !== 'pending') {
      throw new BadRequestError(`Queue item is already ${item.status}`);
    }

    if (body.status === 'approved') {
      if (body.products && body.products.length > 0) {
        return await handleMultiProductApprove(context, user, item, body.shared_fields, body.products, body.save_template);
      }
      return await handleApprove(context, user, item, body.fields, body.product_name, body.save_template);
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
  // Update queue item status
  await context.env.DB.prepare(
    `UPDATE processing_queue SET status = 'rejected', reviewed_by = ?, reviewed_at = datetime('now') WHERE id = ?`
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
