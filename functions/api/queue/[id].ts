import { generateId, logAudit, getClientIp } from '../../lib/db';
import {
  requireRole,
  requireTenantAccess,
  NotFoundError,
  BadRequestError,
  errorToResponse,
} from '../../lib/permissions';
import { buildR2Key, uploadFile, downloadFile, deleteFile, computeChecksum } from '../../lib/r2';
import type { Env, User } from '../../lib/types';

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
      fields?: Record<string, string>;
      product_name?: string;
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
      .first<{
        id: string;
        tenant_id: string;
        document_type_id: string;
        file_r2_key: string;
        file_name: string;
        file_size: number;
        mime_type: string;
        extracted_text: string | null;
        ai_fields: string | null;
        ai_confidence: string | null;
        confidence_score: number | null;
        product_names: string | null;
        supplier: string | null;
        status: string;
        created_by: string | null;
        tenant_slug: string;
      }>();

    if (!item) {
      throw new NotFoundError('Queue item not found');
    }

    requireTenantAccess(user, item.tenant_id);

    if (item.status !== 'pending') {
      throw new BadRequestError(`Queue item is already ${item.status}`);
    }

    if (body.status === 'approved') {
      return await handleApprove(context, user, item, body.fields, body.product_name);
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
  item: {
    id: string;
    tenant_id: string;
    document_type_id: string;
    file_r2_key: string;
    file_name: string;
    file_size: number;
    mime_type: string;
    extracted_text: string | null;
    ai_fields: string | null;
    ai_confidence: string | null;
    confidence_score: number | null;
    product_names: string | null;
    supplier: string | null;
    status: string;
    created_by: string | null;
    tenant_slug: string;
  },
  fields?: Record<string, string>,
  productName?: string
): Promise<Response> {
  // Download file from pending R2 location
  const pendingFile = await downloadFile(context.env.FILES, item.file_r2_key);
  if (!pendingFile) {
    throw new BadRequestError('Pending file not found in storage');
  }

  const fileData = await pendingFile.arrayBuffer();

  // Generate IDs and build paths
  const docId = generateId();
  const externalRef = `queue-${item.id}`;
  const checksum = await computeChecksum(fileData);
  const r2Key = buildR2Key(item.tenant_slug, docId, 1, item.file_name);

  // Upload file to final R2 location
  await uploadFile(context.env.FILES, r2Key, fileData, item.mime_type);

  // Parse approved fields — use provided fields or fall back to AI fields
  const approvedFields = fields || (item.ai_fields ? JSON.parse(item.ai_fields) : {});

  // Determine title
  const title = approvedFields.title || item.file_name.replace(/\.[^/.]+$/, '');

  // Insert document
  await context.env.DB.prepare(
    `INSERT INTO documents (id, tenant_id, title, description, category, tags, current_version, status, created_by, external_ref, document_type_id, lot_number, po_number, code_date, expiration_date)
     VALUES (?, ?, ?, ?, ?, '[]', 1, 'active', ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      docId,
      item.tenant_id,
      title,
      approvedFields.description || null,
      approvedFields.category || null,
      user.id,
      externalRef,
      item.document_type_id,
      approvedFields.lot_number || null,
      approvedFields.po_number || null,
      approvedFields.code_date || null,
      approvedFields.expiration_date || null
    )
    .run();

  // Insert document version
  const versionId = generateId();
  await context.env.DB.prepare(
    `INSERT INTO document_versions (id, document_id, version_number, file_name, file_size, mime_type, r2_key, checksum, uploaded_by, extracted_text)
     VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      versionId,
      docId,
      item.file_name,
      item.file_size,
      item.mime_type,
      r2Key,
      checksum,
      user.id,
      item.extracted_text
    )
    .run();

  // Link product if product_name provided (lookup or create)
  if (productName) {
    let product = await context.env.DB.prepare(
      `SELECT id FROM products WHERE LOWER(name) = LOWER(?) AND tenant_id = ?`
    )
      .bind(productName, item.tenant_id)
      .first<{ id: string }>();

    if (!product) {
      // Create the product for this tenant
      const productId = generateId();
      const slug = productName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      await context.env.DB.prepare(
        `INSERT INTO products (id, name, slug, tenant_id) VALUES (?, ?, ?, ?)`
      )
        .bind(productId, productName, slug, item.tenant_id)
        .run();

      product = { id: productId };
    }

    // Link document to product
    await context.env.DB.prepare(
      `INSERT INTO document_products (id, document_id, product_id)
       VALUES (?, ?, ?)
       ON CONFLICT(document_id, product_id) DO NOTHING`
    )
      .bind(generateId(), docId, product.id)
      .run();
  }

  // Save extraction example if user corrected fields (with supplier for training gate)
  if (fields && item.ai_fields && item.extracted_text) {
    const aiFields = JSON.parse(item.ai_fields);
    const fieldsChanged = JSON.stringify(fields) !== JSON.stringify(aiFields);

    // Detect supplier from fields or queue item
    const supplier = item.supplier || (() => {
      const supplierKeys = ['supplier_name', 'supplier', 'manufacturer', 'vendor', 'company', 'from'];
      const approvedSupplier = supplierKeys.map(k => (fields as Record<string, string>)[k]).find(v => v != null && v.trim() !== '');
      return approvedSupplier || null;
    })();

    if (fieldsChanged) {
      const exampleId = generateId();
      const inputText = item.extracted_text.substring(0, 2000);

      await context.env.DB.prepare(
        `INSERT INTO extraction_examples (id, document_type_id, tenant_id, input_text, ai_output, corrected_output, score, supplier, created_by)
         VALUES (?, ?, ?, ?, ?, ?, 1.0, ?, ?)`
      )
        .bind(
          exampleId,
          item.document_type_id,
          item.tenant_id,
          inputText,
          item.ai_fields,
          JSON.stringify(fields),
          supplier,
          user.id
        )
        .run();
    }
  }

  // Update queue item status
  await context.env.DB.prepare(
    `UPDATE processing_queue SET status = 'approved', reviewed_by = ?, reviewed_at = datetime('now') WHERE id = ?`
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
    'queue_item.approved',
    'processing_queue',
    item.id,
    JSON.stringify({
      document_id: docId,
      file_name: item.file_name,
      fields_corrected: fields && item.ai_fields ? JSON.stringify(fields) !== item.ai_fields : false,
    }),
    getClientIp(context.request)
  );

  return new Response(
    JSON.stringify({
      item: { id: item.id, status: 'approved', reviewed_by: user.id },
      document: {
        id: docId,
        tenant_id: item.tenant_id,
        title,
        external_ref: externalRef,
        current_version: 1,
        status: 'active',
      },
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
