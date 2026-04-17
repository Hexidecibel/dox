import type { D1Database, R2Bucket } from '@cloudflare/workers-types';
import { generateId, logAudit } from '../lib/db';
import { buildR2Key, uploadFile, downloadFile, deleteFile, computeChecksum } from '../lib/r2';

export interface QueueItem {
  id: string;
  tenant_id: string;
  document_type_id: string | null;
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
}

export interface ApproveOptions {
  fields?: Record<string, string>;
  productName?: string;
  userId: string;
  clientIp?: string;
  autoIngested?: boolean;
  /**
   * Which extraction path the user approved. Defaults to 'text' to match the
   * pre-VLM behavior. Recorded in the audit log so we can measure how often
   * reviewers pick the VLM output when dual-run is enabled.
   */
  selectedSource?: 'text' | 'vlm';
}

export interface ApproveResult {
  documentId: string;
  title: string;
  externalRef: string;
  supplierId: string | null;
}

export async function approveQueueItem(
  db: D1Database,
  files: R2Bucket,
  item: QueueItem,
  options: ApproveOptions
): Promise<ApproveResult> {
  const { fields, productName, userId, clientIp, autoIngested, selectedSource = 'text' } = options;

  // Download file from pending R2 location
  const pendingFile = await downloadFile(files, item.file_r2_key);
  if (!pendingFile) {
    throw new Error('Pending file not found in storage');
  }

  const fileData = await pendingFile.arrayBuffer();

  // Generate IDs and build paths
  const docId = generateId();
  const externalRef = `queue-${item.id}`;
  const checksum = await computeChecksum(fileData);
  const r2Key = buildR2Key(item.tenant_slug, docId, 1, item.file_name);

  // Upload file to final R2 location
  await uploadFile(files, r2Key, fileData, item.mime_type);

  // Parse approved fields — use provided fields or fall back to AI fields
  const approvedFields = fields || (item.ai_fields ? JSON.parse(item.ai_fields) : {});

  // Determine title
  const title = approvedFields.title || item.file_name.replace(/\.[^/.]+$/, '');

  // Build primary_metadata from approved fields
  const primaryMetadata: Record<string, string | null> = {};
  for (const [k, v] of Object.entries(approvedFields)) {
    // Skip fields that go into other columns
    if (['title', 'description', 'category'].includes(k)) continue;
    if (v) primaryMetadata[k] = v as string;
  }
  const primaryMetadataStr = Object.keys(primaryMetadata).length > 0 ? JSON.stringify(primaryMetadata) : null;

  // Resolve supplier from queue item
  let supplierId: string | null = null;
  const supplierName = item.supplier || approvedFields.supplier || approvedFields.supplier_name || null;
  if (supplierName) {
    try {
      const slug = supplierName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      let existing = await db.prepare(
        'SELECT id FROM suppliers WHERE tenant_id = ? AND slug = ?'
      ).bind(item.tenant_id, slug).first<{ id: string }>();

      if (!existing) {
        existing = await db.prepare(
          'SELECT id FROM suppliers WHERE tenant_id = ? AND LOWER(name) = LOWER(?)'
        ).bind(item.tenant_id, supplierName).first<{ id: string }>();
      }

      if (existing) {
        supplierId = existing.id;
      } else {
        const newId = generateId();
        await db.prepare(
          'INSERT INTO suppliers (id, tenant_id, name, slug) VALUES (?, ?, ?, ?)'
        ).bind(newId, item.tenant_id, supplierName, slug).run();
        supplierId = newId;
      }
    } catch {
      // Non-critical
    }
  }

  // Insert document
  await db.prepare(
    `INSERT INTO documents (id, tenant_id, title, description, category, tags, current_version, status, created_by, external_ref, document_type_id, supplier_id, primary_metadata)
     VALUES (?, ?, ?, ?, ?, '[]', 1, 'active', ?, ?, ?, ?, ?)`
  )
    .bind(
      docId,
      item.tenant_id,
      title,
      approvedFields.description || null,
      approvedFields.category || null,
      userId,
      externalRef,
      item.document_type_id,
      supplierId,
      primaryMetadataStr
    )
    .run();

  // Insert document version
  const versionId = generateId();
  await db.prepare(
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
      userId,
      item.extracted_text
    )
    .run();

  // Link product if productName provided (lookup or create)
  if (productName) {
    let product = await db.prepare(
      `SELECT id FROM products WHERE LOWER(name) = LOWER(?) AND tenant_id = ?`
    )
      .bind(productName, item.tenant_id)
      .first<{ id: string }>();

    if (!product) {
      // Create the product for this tenant
      const productId = generateId();
      const slug = productName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      await db.prepare(
        `INSERT INTO products (id, name, slug, tenant_id) VALUES (?, ?, ?, ?)`
      )
        .bind(productId, productName, slug, item.tenant_id)
        .run();

      product = { id: productId };
    }

    // Link document to product
    await db.prepare(
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

      await db.prepare(
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
          userId
        )
        .run();
    }
  }

  // Update queue item status
  await db.prepare(
    `UPDATE processing_queue SET status = 'approved', reviewed_by = ?, reviewed_at = datetime('now') WHERE id = ?`
  )
    .bind(userId, item.id)
    .run();

  // Delete pending R2 file
  await deleteFile(files, item.file_r2_key);

  // Audit log
  await logAudit(
    db,
    userId,
    item.tenant_id,
    autoIngested ? 'queue_item.auto_ingested' : 'queue_item.approved',
    'processing_queue',
    item.id,
    JSON.stringify({
      document_id: docId,
      file_name: item.file_name,
      fields_corrected: fields && item.ai_fields ? JSON.stringify(fields) !== item.ai_fields : false,
      selected_source: selectedSource,
    }),
    clientIp || null
  );

  return {
    documentId: docId,
    title,
    externalRef: externalRef,
    supplierId,
  };
}

export interface MultiProductApproveOptions {
  sharedFields?: Record<string, string>;
  products: Array<{
    productName: string;
    fields: Record<string, string>;
    tables?: Array<{ name: string; headers: string[]; rows: string[][] }>;
  }>;
  userId: string;
  clientIp?: string;
  /** Which extraction path the user approved — see ApproveOptions.selectedSource. */
  selectedSource?: 'text' | 'vlm';
}

export interface MultiProductApproveResult {
  documents: Array<{
    documentId: string;
    title: string;
    productName: string;
    externalRef: string;
  }>;
  supplierId: string | null;
}

export async function approveMultiProductQueueItem(
  db: D1Database,
  files: R2Bucket,
  item: QueueItem,
  options: MultiProductApproveOptions
): Promise<MultiProductApproveResult> {
  const { sharedFields = {}, products, userId, clientIp, selectedSource = 'text' } = options;

  // Download file from pending R2 location ONCE
  const pendingFile = await downloadFile(files, item.file_r2_key);
  if (!pendingFile) {
    throw new Error('Pending file not found in storage');
  }
  const fileData = await pendingFile.arrayBuffer();
  const checksum = await computeChecksum(fileData);

  // Resolve supplier ONCE
  let supplierId: string | null = null;
  const supplierName = item.supplier || sharedFields.supplier_name || sharedFields.supplier || null;
  if (supplierName) {
    try {
      const slug = supplierName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      let existing = await db.prepare(
        'SELECT id FROM suppliers WHERE tenant_id = ? AND slug = ?'
      ).bind(item.tenant_id, slug).first<{ id: string }>();

      if (!existing) {
        existing = await db.prepare(
          'SELECT id FROM suppliers WHERE tenant_id = ? AND LOWER(name) = LOWER(?)'
        ).bind(item.tenant_id, supplierName).first<{ id: string }>();
      }

      if (existing) {
        supplierId = existing.id;
      } else {
        const newId = generateId();
        await db.prepare(
          'INSERT INTO suppliers (id, tenant_id, name, slug) VALUES (?, ?, ?, ?)'
        ).bind(newId, item.tenant_id, supplierName, slug).run();
        supplierId = newId;
      }
    } catch {
      // Non-critical
    }
  }

  const results: MultiProductApproveResult['documents'] = [];

  // Create one document per product
  for (let i = 0; i < products.length; i++) {
    const product = products[i];
    const docId = generateId();
    const externalRef = `queue-${item.id}-p${i}`;
    const r2Key = buildR2Key(item.tenant_slug, docId, 1, item.file_name);

    // Upload file to unique R2 key for this document
    await uploadFile(files, r2Key, fileData, item.mime_type);

    // Merge shared fields + product-specific fields into primary_metadata
    const mergedFields = { ...sharedFields, ...product.fields };
    const title = product.productName || mergedFields.product_name || item.file_name.replace(/\.[^/.]+$/, '');

    const primaryMetadata: Record<string, string> = {};
    for (const [k, v] of Object.entries(mergedFields)) {
      if (['title', 'description', 'category'].includes(k)) continue;
      if (v) primaryMetadata[k] = v;
    }
    // Also store the product's tables in extended_metadata if present
    const extendedMetadata = product.tables && product.tables.length > 0
      ? JSON.stringify({ tables: product.tables })
      : null;

    const primaryMetadataStr = Object.keys(primaryMetadata).length > 0 ? JSON.stringify(primaryMetadata) : null;

    // Insert document
    await db.prepare(
      `INSERT INTO documents (id, tenant_id, title, description, category, tags, current_version, status, created_by, external_ref, document_type_id, supplier_id, primary_metadata, extended_metadata)
       VALUES (?, ?, ?, ?, ?, '[]', 1, 'active', ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        docId,
        item.tenant_id,
        title,
        mergedFields.description || null,
        mergedFields.category || null,
        userId,
        externalRef,
        item.document_type_id,
        supplierId,
        primaryMetadataStr,
        extendedMetadata
      )
      .run();

    // Insert document version
    const versionId = generateId();
    await db.prepare(
      `INSERT INTO document_versions (id, document_id, version_number, file_name, file_size, mime_type, r2_key, checksum, uploaded_by, extracted_text)
       VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(versionId, docId, item.file_name, item.file_size, item.mime_type, r2Key, checksum, userId, item.extracted_text)
      .run();

    // Link product
    if (product.productName) {
      let productRecord = await db.prepare(
        `SELECT id FROM products WHERE LOWER(name) = LOWER(?) AND tenant_id = ?`
      ).bind(product.productName, item.tenant_id).first<{ id: string }>();

      if (!productRecord) {
        const productId = generateId();
        const slug = product.productName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        await db.prepare(
          `INSERT INTO products (id, name, slug, tenant_id) VALUES (?, ?, ?, ?)`
        ).bind(productId, product.productName, slug, item.tenant_id).run();
        productRecord = { id: productId };
      }

      await db.prepare(
        `INSERT INTO document_products (id, document_id, product_id) VALUES (?, ?, ?) ON CONFLICT(document_id, product_id) DO NOTHING`
      ).bind(generateId(), docId, productRecord.id).run();
    }

    results.push({
      documentId: docId,
      title,
      productName: product.productName,
      externalRef,
    });
  }

  // Save extraction example with full multi-product correction
  if (item.ai_fields && item.extracted_text) {
    const exampleId = generateId();
    const inputText = item.extracted_text.substring(0, 2000);
    const correctedOutput = JSON.stringify({
      shared_fields: sharedFields,
      products: products.map(p => ({ product_name: p.productName, fields: p.fields })),
    });

    const supplier = item.supplier || sharedFields.supplier_name || sharedFields.supplier || null;

    await db.prepare(
      `INSERT INTO extraction_examples (id, document_type_id, tenant_id, input_text, ai_output, corrected_output, score, supplier, created_by)
       VALUES (?, ?, ?, ?, ?, ?, 1.0, ?, ?)`
    ).bind(exampleId, item.document_type_id, item.tenant_id, inputText, item.ai_fields, correctedOutput, supplier, userId).run();
  }

  // Update queue item status
  await db.prepare(
    `UPDATE processing_queue SET status = 'approved', reviewed_by = ?, reviewed_at = datetime('now') WHERE id = ?`
  ).bind(userId, item.id).run();

  // Delete pending R2 file
  await deleteFile(files, item.file_r2_key);

  // Audit log
  await logAudit(
    db, userId, item.tenant_id, 'queue_item.approved', 'processing_queue', item.id,
    JSON.stringify({
      document_ids: results.map(r => r.documentId),
      file_name: item.file_name,
      product_count: products.length,
      selected_source: selectedSource,
    }),
    clientIp || null
  );

  return { documents: results, supplierId };
}
