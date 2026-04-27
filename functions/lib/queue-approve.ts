import type { D1Database, R2Bucket } from '@cloudflare/workers-types';
import { generateId, logAudit } from '../lib/db';
import { buildR2Key, uploadFile, downloadFile, deleteFile, computeChecksum } from '../lib/r2';
import { findOrCreateSupplier } from '../lib/suppliers';
import { getLearnedPreferences } from '../lib/learnedPreferences';

/**
 * Order-insensitive diff between approved fields and the original AI text-path
 * output. Compares the union of keys, normalizing both sides to trimmed
 * strings so "L-123" vs " L-123 " is not a false-positive. Empty/whitespace
 * values are treated as missing so a key only present on one side as "" does
 * not register as a difference.
 *
 * Returns true when there is any real difference worth recording as a
 * training example.
 */
function diffApprovedVsAi(
  approved: Record<string, string>,
  ai: Record<string, unknown>
): boolean {
  const norm = (v: unknown): string => {
    if (v == null) return '';
    return String(v).trim();
  };
  const keys = new Set<string>([...Object.keys(approved), ...Object.keys(ai)]);
  for (const k of keys) {
    if (norm(approved[k]) !== norm(ai[k])) return true;
  }
  return false;
}

/**
 * Compute SHA-256 of a string and return the hex digest. Used to dedupe
 * synthetic extraction_examples rows from the Phase 3 backfill (the partial
 * unique index from migration 0038 keys on input_text_hash).
 */
async function sha256Hex(input: string): Promise<string> {
  const encoder = new TextEncoder();
  const buf = await crypto.subtle.digest('SHA-256', encoder.encode(input));
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Phase 3.4: backfill a synthetic extraction_examples row when the learned
 * preferences for this (supplier, doctype) just crossed a high-confidence
 * "rung". Triggered ONLY when at least one field's pick_count is a non-zero
 * multiple of 5 — i.e. we just landed on a new threshold and might have
 * meaningful new signal to canonicalize.
 *
 * The synthesized row captures "what right looks like" for the pair: the
 * extracted_text as input, the original ai_fields as the AI output, and a
 * compact record of {field: most_common_value} from the learned prefs as the
 * corrected output. The partial unique index on (document_type_id, tenant_id,
 * supplier, input_text_hash) dedupes — re-runs are no-ops. Failures are
 * swallowed so the approve flow is never blocked.
 */
async function maybeBackfillExtractionExample(
  db: D1Database,
  args: {
    tenantId: string;
    supplierId: string | null;
    documentTypeId: string | null;
    extractedText: string | null;
    aiFields: string | null;
    supplierName: string | null;
    userId: string;
  }
): Promise<void> {
  const { tenantId, supplierId, documentTypeId, extractedText, aiFields, supplierName, userId } = args;
  if (!documentTypeId || !extractedText) return;

  let prefs;
  try {
    prefs = await getLearnedPreferences(db, tenantId, supplierId, documentTypeId);
  } catch {
    return;
  }

  const fieldEntries = Object.entries(prefs.fields);
  if (fieldEntries.length === 0) return;

  // Trigger gate: at least one field's pick_count is a multiple of 5 with >=5
  // picks — the "we just crossed a rung" signal.
  const crossedRung = fieldEntries.some(
    ([, p]) => p.pick_count >= 5 && p.pick_count % 5 === 0
  );
  if (!crossedRung) return;

  // Quality gate: aggregate confidence across fields with >=5 picks must be
  // high (>=0.85). This avoids backfilling when the signal is mostly weak.
  const strongFields = fieldEntries.filter(([, p]) => p.pick_count >= 5);
  if (strongFields.length === 0) return;
  const aggregateConfidence =
    strongFields.reduce((sum, [, p]) => sum + p.confidence, 0) / strongFields.length;
  if (aggregateConfidence < 0.85) return;

  const corrected: Record<string, string> = {};
  for (const [fieldKey, p] of fieldEntries) {
    if (p.most_common_value) corrected[fieldKey] = p.most_common_value;
  }
  if (Object.keys(corrected).length === 0) return;

  const inputText = extractedText.substring(0, 5000);
  const inputTextHash = await sha256Hex(inputText);

  try {
    await db
      .prepare(
        `INSERT INTO extraction_examples
           (id, document_type_id, tenant_id, input_text, ai_output, corrected_output,
            score, supplier, input_text_hash, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        generateId(),
        documentTypeId,
        tenantId,
        inputText,
        aiFields ?? '{}',
        JSON.stringify(corrected),
        aggregateConfidence,
        supplierName,
        inputTextHash,
        userId
      )
      .run();
    console.info(
      `[queue-approve] Phase 3 backfill: synthesized extraction_example for ` +
      `(supplier=${supplierName}, doctype=${documentTypeId}) at confidence=${aggregateConfidence.toFixed(2)}`
    );
  } catch (err) {
    // Most likely a unique-violation from the dedup index — that's the
    // expected no-op path. Anything else gets logged but never thrown.
    const msg = err instanceof Error ? err.message : String(err);
    if (!/UNIQUE|constraint/i.test(msg)) {
      console.warn(`[queue-approve] Phase 3 backfill insert failed:`, msg);
    }
  }
}

/**
 * Persist Phase 2 reviewer-decision captures: per-field source picks,
 * explicit dismissals, and table-level edits. Failures are logged but
 * never block the approve flow — capture is a learning signal, not a
 * correctness guarantee. Keeps the approve path resilient even if
 * a capture insert hits a constraint or the DB hiccups.
 */
async function persistReviewerCaptures(
  db: D1Database,
  args: {
    tenantId: string;
    queueItemId: string;
    supplierId: string | null;
    documentTypeId: string | null;
    userId: string;
    fieldPicks?: FieldPickCapture[];
    dismissals?: FieldDismissalCapture[];
    tableEdits?: TableEditCapture[];
  }
): Promise<void> {
  const now = new Date().toISOString();
  const { tenantId, queueItemId, supplierId, documentTypeId, userId, fieldPicks, dismissals, tableEdits } = args;

  for (const pick of fieldPicks ?? []) {
    try {
      await db
        .prepare(
          `INSERT INTO reviewer_field_picks
             (id, tenant_id, queue_item_id, supplier_id, document_type_id,
              field_key, text_value, vlm_value, chosen_source, final_value,
              created_at, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          generateId(),
          tenantId,
          queueItemId,
          supplierId,
          documentTypeId,
          pick.field_key,
          pick.text_value ?? null,
          pick.vlm_value ?? null,
          pick.chosen_source,
          pick.final_value ?? null,
          now,
          userId
        )
        .run();
    } catch (err) {
      console.warn(`[queue-approve] reviewer_field_picks insert failed for ${queueItemId}/${pick.field_key}:`, err);
    }
  }

  for (const dismissal of dismissals ?? []) {
    try {
      await db
        .prepare(
          `INSERT INTO reviewer_field_dismissals
             (id, tenant_id, queue_item_id, supplier_id, document_type_id,
              field_key, action, created_at, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          generateId(),
          tenantId,
          queueItemId,
          supplierId,
          documentTypeId,
          dismissal.field_key,
          dismissal.action,
          now,
          userId
        )
        .run();
    } catch (err) {
      console.warn(`[queue-approve] reviewer_field_dismissals insert failed for ${queueItemId}/${dismissal.field_key}:`, err);
    }
  }

  for (const edit of tableEdits ?? []) {
    try {
      await db
        .prepare(
          `INSERT INTO reviewer_table_edits
             (id, tenant_id, queue_item_id, supplier_id, document_type_id,
              table_idx, operation, detail, created_at, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          generateId(),
          tenantId,
          queueItemId,
          supplierId,
          documentTypeId,
          edit.table_idx,
          edit.operation,
          JSON.stringify(edit.detail ?? {}),
          now,
          userId
        )
        .run();
    } catch (err) {
      console.warn(`[queue-approve] reviewer_table_edits insert failed for ${queueItemId}/${edit.operation}:`, err);
    }
  }
}

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

/**
 * Per-field source pick captured from the reviewer's UI. Derived at approve
 * time by diffing the final values against text/vlm payloads. chosen_source
 * is one of:
 *   'text'     — final value matches the text-extraction payload
 *   'vlm'      — final value matches the VLM payload
 *   'edited'   — final value matches neither (manual correction)
 *   'dismissed' — reviewer removed the field entirely
 */
export interface FieldPickCapture {
  field_key: string;
  text_value?: string | null;
  vlm_value?: string | null;
  chosen_source: 'text' | 'vlm' | 'edited' | 'dismissed';
  final_value?: string | null;
}

export interface FieldDismissalCapture {
  field_key: string;
  action: 'dismissed' | 'extended';
}

export interface TableEditCapture {
  table_idx: number;
  operation: string;
  detail: unknown;
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
  /** Phase 2 capture: per-field source picks derived in the UI. */
  fieldPicks?: FieldPickCapture[];
  /** Phase 2 capture: explicit field dismissals. */
  dismissals?: FieldDismissalCapture[];
  /** Phase 2 capture: table-level edits (column excludes, header renames, etc). */
  tableEdits?: TableEditCapture[];
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
  const { fields, productName, userId, clientIp, autoIngested, selectedSource = 'text', fieldPicks, dismissals, tableEdits } = options;

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

  // Resolve supplier from queue item via the shared alias-aware helper.
  let supplierId: string | null = null;
  const supplierName = item.supplier || approvedFields.supplier || approvedFields.supplier_name || null;
  if (supplierName) {
    try {
      const r = await findOrCreateSupplier(db, item.tenant_id, supplierName, {
        userId,
        ip: clientIp || null,
      });
      supplierId = r.id;
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

  // Save extraction example as a training signal whenever the approved fields
  // diverge from the text-path AI output. Two cases trigger a write:
  //   1. The reviewer manually edited any field (classic correction).
  //   2. The reviewer picked the VLM side via "Use these results" — the act
  //      of picking VLM IS the correction, even if no further edit happened.
  //      Without this branch the learning loop is starved (Apr 2026 staging:
  //      27 A/B evals, 0 extraction_examples rows).
  if (fields && item.ai_fields && item.extracted_text) {
    const aiFields = JSON.parse(item.ai_fields) as Record<string, unknown>;
    const fieldsDiffer = diffApprovedVsAi(fields, aiFields);

    // Detect supplier from fields or queue item
    const supplier = item.supplier || (() => {
      const supplierKeys = ['supplier_name', 'supplier', 'manufacturer', 'vendor', 'company', 'from'];
      const approvedSupplier = supplierKeys.map(k => (fields as Record<string, string>)[k]).find(v => v != null && v.trim() !== '');
      return approvedSupplier || null;
    })();

    if (fieldsDiffer && item.document_type_id) {
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
    } else if (fieldsDiffer && !item.document_type_id) {
      // extraction_examples.document_type_id is NOT NULL — we can't write a
      // training row without one. Log a single line so we can grep for lost
      // learning signals without making this noisy.
      console.info(
        `[queue-approve] Skipping extraction_example insert for queue item ${item.id}: no document_type_id (lost training signal)`
      );
    }
  }

  // Phase 2: persist reviewer decisions (picks/dismissals/table edits).
  // Pure capture, never blocks the approve flow on failure.
  await persistReviewerCaptures(db, {
    tenantId: item.tenant_id,
    queueItemId: item.id,
    supplierId,
    documentTypeId: item.document_type_id,
    userId,
    fieldPicks,
    dismissals,
    tableEdits,
  });

  // Phase 3.4: synthesize a canonical extraction_example when the latest
  // picks just rolled the (supplier, doctype) into a new high-confidence
  // rung. Read AFTER the Phase 2 inserts above so the freshly-recorded
  // picks count toward the rollup. Best-effort, never blocks approve.
  await maybeBackfillExtractionExample(db, {
    tenantId: item.tenant_id,
    supplierId,
    documentTypeId: item.document_type_id,
    extractedText: item.extracted_text,
    aiFields: item.ai_fields,
    supplierName: item.supplier,
    userId,
  });

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
  /** Phase 2 capture: per-field source picks derived in the UI. */
  fieldPicks?: FieldPickCapture[];
  /** Phase 2 capture: explicit field dismissals. */
  dismissals?: FieldDismissalCapture[];
  /** Phase 2 capture: table-level edits (column excludes, header renames, etc). */
  tableEdits?: TableEditCapture[];
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
  const { sharedFields = {}, products, userId, clientIp, selectedSource = 'text', fieldPicks, dismissals, tableEdits } = options;

  // Download file from pending R2 location ONCE
  const pendingFile = await downloadFile(files, item.file_r2_key);
  if (!pendingFile) {
    throw new Error('Pending file not found in storage');
  }
  const fileData = await pendingFile.arrayBuffer();
  const checksum = await computeChecksum(fileData);

  // Resolve supplier ONCE via the shared alias-aware helper.
  let supplierId: string | null = null;
  const supplierName = item.supplier || sharedFields.supplier_name || sharedFields.supplier || null;
  if (supplierName) {
    try {
      const r = await findOrCreateSupplier(db, item.tenant_id, supplierName, {
        userId,
        ip: clientIp || null,
      });
      supplierId = r.id;
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
    if (item.document_type_id) {
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
    } else {
      // extraction_examples.document_type_id is NOT NULL — skip insert and log.
      console.info(
        `[queue-approve] Skipping multi-product extraction_example insert for queue item ${item.id}: no document_type_id (lost training signal)`
      );
    }
  }

  // Phase 2: persist reviewer decisions (picks/dismissals/table edits).
  await persistReviewerCaptures(db, {
    tenantId: item.tenant_id,
    queueItemId: item.id,
    supplierId,
    documentTypeId: item.document_type_id,
    userId,
    fieldPicks,
    dismissals,
    tableEdits,
  });

  // Phase 3.4: see approveQueueItem for the full rationale. Same backfill
  // for the multi-product path.
  await maybeBackfillExtractionExample(db, {
    tenantId: item.tenant_id,
    supplierId,
    documentTypeId: item.document_type_id,
    extractedText: item.extracted_text,
    aiFields: item.ai_fields,
    supplierName: item.supplier,
    userId,
  });

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
