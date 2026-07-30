import type { D1Database, R2Bucket } from '@cloudflare/workers-types';
import { generateId, logAudit } from '../db';
import { buildR2Key, uploadFile, downloadFile, deleteFile, computeChecksum } from '../r2';
import { findOrCreateSupplier } from '../suppliers';
import { findOrCreateProduct } from '../entities/products';
import { extractRecordPdf } from './coaPageScope';
import { attachLotToCoaDocument, extractLotNumber, extractSubLotCode } from '../entities/matching';
import { normalizeLotNumber, normalizeSubLotCode, applyLotScheme, type LotScheme } from '../entities/lots';
import { getLearnedPreferences } from '../learnedPreferences';
import type { CoaRecordsPayload } from '../../../shared/types';
import type {
  QueueItem,
  ApproveOptions,
  ApproveResult,
  MultiProductApproveOptions,
  MultiProductApproveResult,
  FieldPickCapture,
  FieldDismissalCapture,
  TableEditCapture,
} from '../queue-approve';

/**
 * Producer for the `coa` doc-kind (Phase P2). Owns the canonical-entity
 * writes for an approved COA queue item: documents + document_versions +
 * products (findOrCreateProduct) + lots (attachLotToCoaDocument → lots +
 * linkCoaToOrders) + extraction_examples + reviewer captures.
 *
 * Extracted verbatim from queue-approve.ts (approveQueueItem and
 * approveMultiProductQueueItem). The public entry points in queue-approve.ts
 * delegate to produceCoa / produceMultiProductCoa here; behavior is
 * byte-identical. Every step and its ordering is preserved.
 */

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

export async function produceCoa(
  db: D1Database,
  files: R2Bucket,
  item: QueueItem,
  options: ApproveOptions
): Promise<ApproveResult> {
  const { fields, productName, userId, clientIp, autoIngested, selectedSource = 'text', fieldPicks, dismissals, tableEdits, supplierId: overrideSupplierId, supplierName: overrideSupplierName } = options;

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

  // Resolve supplier with reviewer-override precedence:
  //   1. opts.supplierId — validate it exists AND belongs to this tenant; use
  //      directly (no findOrCreate). Invalid → fall through.
  //   2. opts.supplierName — findOrCreateSupplier (plausibility + dedupe + alias).
  //   3. legacy item.supplier / approvedFields path (unchanged).
  // A thrown ImplausibleSupplierNameError leaves supplierId null.
  let supplierId: string | null = null;
  if (overrideSupplierId) {
    const row = await db
      .prepare('SELECT id FROM suppliers WHERE id = ? AND tenant_id = ?')
      .bind(overrideSupplierId, item.tenant_id)
      .first<{ id: string }>();
    if (row) supplierId = row.id;
  }
  if (!supplierId && overrideSupplierName && overrideSupplierName.trim()) {
    try {
      const r = await findOrCreateSupplier(db, item.tenant_id, overrideSupplierName, {
        userId,
        ip: clientIp || null,
      });
      supplierId = r.id;
    } catch {
      // Non-critical (e.g. ImplausibleSupplierNameError)
    }
  }
  if (!supplierId) {
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

  // Link product if a product name is available. Fall back through the approved
  // fields and then the raw extracted ai_fields — when the reviewer approves
  // with `fields` that omit product_name, approvedFields won't carry it, so we
  // must reach into ai_fields directly. Without this, single-product COAs get
  // NO document_products link, leaving linkCoaToOrders without a product name
  // and silently breaking the supplier_product_map bridge during matching.
  let aiProductName: string | null = null;
  try {
    aiProductName = item.ai_fields ? (JSON.parse(item.ai_fields).product_name ?? null) : null;
  } catch {
    aiProductName = null;
  }
  const effectiveProductName = productName || approvedFields.product_name || aiProductName || null;
  let linkedProductId: string | null = null;
  if (effectiveProductName) {
    const product = await findOrCreateProduct(db, item.tenant_id, effectiveProductName, { supplierId });
    linkedProductId = product.id;

    // Link document to product
    await db.prepare(
      `INSERT INTO document_products (id, document_id, product_id)
       VALUES (?, ?, ?)
       ON CONFLICT(document_id, product_id) DO NOTHING`
    )
      .bind(generateId(), docId, product.id)
      .run();
  }

  // Phase 2: lot resolution + order⇄COA matching. Extract a lot number from
  // the approved fields first, falling back to primary_metadata. Best-effort —
  // attachLotToCoaDocument swallows its own errors so it can't block approve.
  {
    const lotNumber =
      extractLotNumber(approvedFields) ?? extractLotNumber(primaryMetadata);
    // D1: the flat schema carries sub_lot_code, so a single-lot/single-sublot
    // page keys on the SAME combined lot_key (norm(lot) + sublot) the records
    // path produces. Absent → '' (main-lot-only), i.e. unchanged behavior.
    const subLotCode =
      extractSubLotCode(approvedFields) ?? extractSubLotCode(primaryMetadata);
    if (lotNumber) {
      const lotScheme = await resolveLotScheme(db, item.tenant_id, supplierId);
      await attachLotToCoaDocument(db, item.tenant_id, {
        documentId: docId,
        lotNumber,
        subLotCode,
        productId: linkedProductId,
        supplierId,
        codeDate: approvedFields.code_date || null,
        expirationDate: approvedFields.expiration_date || null,
        mfgDate: approvedFields.mfg_date || null,
        source: 'coa',
        lotScheme,
        coaProductName: effectiveProductName,
      });
    }
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

export async function produceMultiProductCoa(
  db: D1Database,
  files: R2Bucket,
  item: QueueItem,
  options: MultiProductApproveOptions
): Promise<MultiProductApproveResult> {
  const { sharedFields = {}, products, userId, clientIp, selectedSource = 'text', fieldPicks, dismissals, tableEdits, supplierId: overrideSupplierId, supplierName: overrideSupplierName } = options;

  // Download file from pending R2 location ONCE
  const pendingFile = await downloadFile(files, item.file_r2_key);
  if (!pendingFile) {
    throw new Error('Pending file not found in storage');
  }
  const fileData = await pendingFile.arrayBuffer();
  const checksum = await computeChecksum(fileData);

  // Resolve supplier ONCE with reviewer-override precedence (see produceCoa):
  //   1. opts.supplierId (validated against tenant) → use directly.
  //   2. opts.supplierName → findOrCreateSupplier.
  //   3. legacy item.supplier / sharedFields path (unchanged).
  let supplierId: string | null = null;
  if (overrideSupplierId) {
    const row = await db
      .prepare('SELECT id FROM suppliers WHERE id = ? AND tenant_id = ?')
      .bind(overrideSupplierId, item.tenant_id)
      .first<{ id: string }>();
    if (row) supplierId = row.id;
  }
  if (!supplierId && overrideSupplierName && overrideSupplierName.trim()) {
    try {
      const r = await findOrCreateSupplier(db, item.tenant_id, overrideSupplierName, {
        userId,
        ip: clientIp || null,
      });
      supplierId = r.id;
    } catch {
      // Non-critical (e.g. ImplausibleSupplierNameError)
    }
  }
  if (!supplierId) {
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

    // Link product via the shared resolver (lookup/create + supplier_id
    // backfill + product_suppliers provenance link).
    let perProductId: string | null = null;
    if (product.productName) {
      const productRecord = await findOrCreateProduct(db, item.tenant_id, product.productName, { supplierId });
      perProductId = productRecord.id;

      await db.prepare(
        `INSERT INTO document_products (id, document_id, product_id) VALUES (?, ?, ?) ON CONFLICT(document_id, product_id) DO NOTHING`
      ).bind(generateId(), docId, productRecord.id).run();
    }

    // Phase 2: lot resolution + matching for this product's document. Lot may
    // live in the per-product fields or the shared fields (mergedFields covers
    // both). Best-effort.
    {
      const lotNumber = extractLotNumber(mergedFields);
      // D1: same combined-key rule as produceCoa / produceCoaRecords.
      const subLotCode = extractSubLotCode(mergedFields);
      if (lotNumber) {
        const lotScheme = await resolveLotScheme(db, item.tenant_id, supplierId);
        await attachLotToCoaDocument(db, item.tenant_id, {
          documentId: docId,
          lotNumber,
          subLotCode,
          productId: perProductId,
          supplierId,
          codeDate: mergedFields.code_date || null,
          expirationDate: mergedFields.expiration_date || null,
          mfgDate: mergedFields.mfg_date || null,
          source: 'coa',
          lotScheme,
          coaProductName: product.productName ?? null,
        });
      }
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

  // Phase 3.4: see produceCoa for the full rationale. Same backfill
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

// === produceCoaRecords (Option B: per-sublot split) ========================
//
// Generalizes produceMultiProductCoa for the records model: given a
// CoaRecordsPayload (page_metadata + records[]), produce ONE documents row +
// ONE lots row PER record (sublot/product). Each record is attached to ITS OWN
// lot via the combined lot_key = norm(lot_number) + sub_lot_code, so order⇄COA
// matching works at sublot grain. Supplier resolved once; binary downloaded
// once. produceCoa (single-record) is left intact.

/** Field keys a record may carry the lot number under. */
const COA_RECORD_LOT_KEYS = ['lot_code', 'lot_number', 'lot', 'lot_no'];
/**
 * Field keys a record may carry the sublot code under. Kept in sync with
 * SUBLOT_FIELD_KEYS (entities/matching.ts) and SUBLOT_KEYS
 * (bin/lib/coaRecords.js) — record fields are RAW model output (they are not
 * run through the worker's canonicalizeFields), so every spelling must resolve.
 */
const COA_RECORD_SUBLOT_KEYS = [
  'sub_lot_code',
  'sub_lot_number',
  'sub_lot',
  'sub_lot_no',
  'sublot_code',
  'sublot_number',
  'sublot',
];

function firstField(
  fields: Record<string, string | null>,
  keys: string[]
): string | null {
  for (const key of keys) {
    for (const [k, v] of Object.entries(fields)) {
      if (k.toLowerCase() === key && v != null && String(v).trim() !== '') {
        return String(v).trim();
      }
    }
  }
  return null;
}

/**
 * Compute the combined lot_key for a record per the Option B rule, refined by
 * the supplier's lot_scheme (0075):
 *   - 'auto'/'plain'/undefined: lot_key = norm(lot_number) + sub_lot_code.
 *   - 'lims_combined': same concat (Darigold).
 *   - 'date_code': strip to the bare MMDDYY date, sub_lot_code forced to ''.
 * Returns { lotNumber, subLotCode, lotKey } with subLotCode='' when absent, or
 * null when the record has no usable lot number. The lot_key returned here MUST
 * match what attachLotToCoaDocument (→ findOrCreateLot with the same scheme)
 * stores, so external_ref = queue-{id}-{lot_key} agrees with the lots row.
 */
export function computeRecordLotKey(
  fields: Record<string, string | null>,
  scheme?: LotScheme | null
): { lotNumber: string; subLotCode: string; lotKey: string } | null {
  const lotNumber = firstField(fields, COA_RECORD_LOT_KEYS);
  if (!lotNumber) return null;
  const base = normalizeLotNumber(lotNumber);
  if (!base) return null;
  const rawSubLotCode = normalizeSubLotCode(firstField(fields, COA_RECORD_SUBLOT_KEYS));
  const combined = applyLotScheme(scheme, base, rawSubLotCode);
  return { lotNumber, subLotCode: combined.subLotCode, lotKey: combined.lotKey };
}

/**
 * Resolve a supplier's lot_scheme (0075). Returns 'auto' when supplierId is
 * null, the row is missing, or the column is empty — so callers can pass the
 * result straight through with no behavior change for unconfigured suppliers.
 */
async function resolveLotScheme(
  db: D1Database,
  tenantId: string,
  supplierId: string | null
): Promise<LotScheme> {
  if (!supplierId) return 'auto';
  try {
    const row = await db
      .prepare('SELECT lot_scheme FROM suppliers WHERE id = ? AND tenant_id = ?')
      .bind(supplierId, tenantId)
      .first<{ lot_scheme: string | null }>();
    const s = (row?.lot_scheme ?? '').trim();
    if (s === 'date_code' || s === 'lims_combined' || s === 'plain' || s === 'auto') {
      return s;
    }
    return 'auto';
  } catch {
    return 'auto';
  }
}

/** Per-record decision from the reviewer (partial approval). */
export type CoaRecordDecision = 'approve' | 'hold' | 'reject';

export interface CoaRecordsApproveOptions {
  /** The payload to produce — reviewer-edited records take precedence upstream. */
  payload: CoaRecordsPayload;
  /**
   * Per-record decisions keyed by record_index. Absent index defaults to
   * 'approve'. Only 'approve' records produce documents; 'hold'/'reject' are
   * skipped here (the caller decides whether the item stays pending).
   */
  decisions?: Record<number, CoaRecordDecision>;
  userId: string;
  clientIp?: string;
  selectedSource?: 'text' | 'vlm';
  supplierId?: string;
  supplierName?: string;
}

export interface CoaRecordsApproveResult {
  documents: Array<{
    documentId: string;
    title: string;
    externalRef: string;
    lotKey: string | null;
    subLotCode: string;
    recordIndex: number;
  }>;
  supplierId: string | null;
  /** record_index of records that were held (kept pending upstream). */
  heldRecordIndexes: number[];
}

export async function produceCoaRecords(
  db: D1Database,
  files: R2Bucket,
  item: QueueItem,
  options: CoaRecordsApproveOptions
): Promise<CoaRecordsApproveResult> {
  const {
    payload,
    decisions = {},
    userId,
    clientIp,
    selectedSource = 'text',
    supplierId: overrideSupplierId,
    supplierName: overrideSupplierName,
  } = options;

  const pageMetadata = payload.page_metadata ?? {};

  // Download binary ONCE.
  const pendingFile = await downloadFile(files, item.file_r2_key);
  if (!pendingFile) {
    throw new Error('Pending file not found in storage');
  }
  const fileData = await pendingFile.arrayBuffer();
  const checksum = await computeChecksum(fileData);

  // Resolve supplier ONCE (same precedence as produceCoa / produceMultiProductCoa):
  //   1. overrideSupplierId (validated against tenant) → use directly.
  //   2. overrideSupplierName → findOrCreateSupplier.
  //   3. legacy item.supplier / page_metadata supplier path.
  let supplierId: string | null = null;
  if (overrideSupplierId) {
    const row = await db
      .prepare('SELECT id FROM suppliers WHERE id = ? AND tenant_id = ?')
      .bind(overrideSupplierId, item.tenant_id)
      .first<{ id: string }>();
    if (row) supplierId = row.id;
  }
  if (!supplierId && overrideSupplierName && overrideSupplierName.trim()) {
    try {
      const r = await findOrCreateSupplier(db, item.tenant_id, overrideSupplierName, {
        userId,
        ip: clientIp || null,
      });
      supplierId = r.id;
    } catch {
      // Non-critical (e.g. ImplausibleSupplierNameError)
    }
  }
  if (!supplierId) {
    const supplierName =
      item.supplier ||
      pageMetadata.supplier ||
      pageMetadata.supplier_name ||
      pageMetadata.manufacturer ||
      null;
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
  }

  // Resolve the supplier's lot_scheme ONCE (0075). Threaded into both
  // computeRecordLotKey (for external_ref) and attachLotToCoaDocument (for the
  // stored lots row) so the two agree. 'auto' for unconfigured suppliers.
  const lotScheme = await resolveLotScheme(db, item.tenant_id, supplierId);

  const results: CoaRecordsApproveResult['documents'] = [];
  const heldRecordIndexes: number[] = [];

  for (const record of payload.records) {
    const decision = decisions[record.record_index] ?? 'approve';
    if (decision === 'reject') continue;
    if (decision === 'hold') {
      heldRecordIndexes.push(record.record_index);
      continue;
    }

    // Reconstruct the flat field map: page_metadata ∪ record.fields (record wins).
    const mergedFields: Record<string, string | null> = {
      ...pageMetadata,
      ...record.fields,
    };

    // Use mergedFields, not record.fields: the lot_code is frequently hoisted
    // into page_metadata (constant across a page's sublot records), so reading
    // record.fields alone would drop the lot and yield no combined lot_key.
    const lot = computeRecordLotKey(mergedFields, lotScheme);

    // Idempotent external_ref keyed on SUBLOT IDENTITY (lot_key), not record
    // index — re-running the same approval upserts the same document rather
    // than creating a duplicate. Records with no lot fall back to the index.
    const refSuffix = lot ? lot.lotKey : `r${record.record_index}`;
    const externalRef = `queue-${item.id}-${refSuffix}`;

    const title =
      mergedFields.title ||
      record.fields?.product_name ||
      pageMetadata.product_name ||
      item.file_name.replace(/\.[^/.]+$/, '');

    // Idempotent re-ingest: external_ref is unique per (tenant, external_ref).
    // If a document already exists for this sublot identity, REUSE it — skip the
    // insert/upload/version, but still run product + lot linkage below (both are
    // idempotent), so a re-run reconciles links without creating duplicates.
    const existingDoc = await db
      .prepare('SELECT id FROM documents WHERE tenant_id = ? AND external_ref = ?')
      .bind(item.tenant_id, externalRef)
      .first<{ id: string }>();

    let docId: string;
    if (existingDoc) {
      docId = existingDoc.id;
    } else {
      docId = generateId();
      const r2Key = buildR2Key(item.tenant_slug, docId, 1, item.file_name);

      // P4 (page-scoped PDF): each per-record document is the customer
      // deliverable, so it must carry ONLY its own page(s). Extract
      // record.source_pages from the original PDF (downloaded once above,
      // reused across all records) into a per-record PDF and upload THAT.
      // extractRecordPdf never throws: non-PDF sources, missing/empty
      // source_pages, or wholly out-of-range pages fall back to the whole
      // binary (scoped=false) so approval is never blocked.
      const scope = await extractRecordPdf(
        fileData,
        record.source_pages,
        item.mime_type,
        item.file_name
      );
      const recordBytes = scope.bytes;
      const recordMime = scope.scoped ? 'application/pdf' : item.mime_type;
      const recordSize = recordBytes.byteLength;
      const recordChecksum = scope.scoped ? await computeChecksum(recordBytes) : checksum;
      await uploadFile(files, r2Key, recordBytes, recordMime);

      const primaryMetadata: Record<string, string> = {};
      for (const [k, v] of Object.entries(mergedFields)) {
        if (['title', 'description', 'category'].includes(k)) continue;
        if (v) primaryMetadata[k] = String(v);
      }
      const primaryMetadataStr =
        Object.keys(primaryMetadata).length > 0 ? JSON.stringify(primaryMetadata) : null;

      // tables + structured groups + source_pages live in extended_metadata.
      const extended: Record<string, unknown> = {};
      if (record.tables && record.tables.length > 0) extended.tables = record.tables;
      if (record.groups && Object.keys(record.groups).length > 0) extended.groups = record.groups;
      if (record.source_pages && record.source_pages.length > 0) {
        extended.source_pages = record.source_pages;
      }
      // Record the page-scope outcome so the UI / audits can tell a true
      // single-page deliverable from a whole-binary fallback. Only the
      // out-of-range case is a "failure" worth flagging (the source claimed
      // pages but none were valid); not_pdf / no_pages are expected non-PDF
      // or page-less inputs, not errors.
      if (scope.scoped) {
        extended.page_scoped = true;
        extended.scoped_pages = scope.includedPages;
      } else if (scope.reason === 'out_of_range' || scope.reason === 'extract_failed') {
        extended.page_scope_failed = true;
        extended.page_scope_fail_reason = scope.reason;
      }
      const extendedMetadataStr =
        Object.keys(extended).length > 0 ? JSON.stringify(extended) : null;

      await db
        .prepare(
          `INSERT INTO documents (id, tenant_id, title, description, category, tags, current_version, status, created_by, external_ref, document_type_id, supplier_id, primary_metadata, extended_metadata)
           VALUES (?, ?, ?, ?, ?, '[]', 1, 'active', ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          docId,
          item.tenant_id,
          title,
          (mergedFields.description as string) || null,
          (mergedFields.category as string) || null,
          userId,
          externalRef,
          item.document_type_id,
          supplierId,
          primaryMetadataStr,
          extendedMetadataStr
        )
        .run();

      const versionId = generateId();
      await db
        .prepare(
          `INSERT INTO document_versions (id, document_id, version_number, file_name, file_size, mime_type, r2_key, checksum, uploaded_by, extracted_text)
           VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          versionId,
          docId,
          item.file_name,
          recordSize,
          recordMime,
          r2Key,
          recordChecksum,
          userId,
          item.extracted_text
        )
        .run();
    }

    // Link product (per-record product_name, falling back to page metadata).
    let perProductId: string | null = null;
    const productName = record.fields?.product_name || pageMetadata.product_name || null;
    if (productName) {
      const productRecord = await findOrCreateProduct(db, item.tenant_id, productName, { supplierId });
      perProductId = productRecord.id;
      await db
        .prepare(
          `INSERT INTO document_products (id, document_id, product_id) VALUES (?, ?, ?) ON CONFLICT(document_id, product_id) DO NOTHING`
        )
        .bind(generateId(), docId, productRecord.id)
        .run();
    }

    // Per-record lot linkage — the core Option B win. Attach THIS doc to its
    // own combined lot (lot_number + sub_lot_code). Best-effort.
    if (lot) {
      await attachLotToCoaDocument(db, item.tenant_id, {
        documentId: docId,
        lotNumber: lot.lotNumber,
        subLotCode: lot.subLotCode,
        productId: perProductId,
        supplierId,
        codeDate: (mergedFields.code_date as string) || null,
        expirationDate: (mergedFields.expiration_date as string) || null,
        mfgDate: (mergedFields.mfg_date as string) || null,
        source: 'coa',
        lotScheme,
        coaProductName: productName,
      });
    }

    results.push({
      documentId: docId,
      title,
      externalRef,
      lotKey: lot ? lot.lotKey : null,
      subLotCode: lot ? lot.subLotCode : '',
      recordIndex: record.record_index,
    });
  }

  // Update queue status: 'approved' only when nothing is held; otherwise the
  // caller keeps it pending (handled in the queue handler, but be defensive).
  if (heldRecordIndexes.length === 0) {
    await db
      .prepare(
        `UPDATE processing_queue SET status = 'approved', reviewed_by = ?, reviewed_at = datetime('now') WHERE id = ?`
      )
      .bind(userId, item.id)
      .run();

    // Delete pending R2 file only when the whole item is resolved.
    await deleteFile(files, item.file_r2_key);
  }

  await logAudit(
    db,
    userId,
    item.tenant_id,
    heldRecordIndexes.length === 0 ? 'queue_item.approved' : 'queue_item.partial_approved',
    'processing_queue',
    item.id,
    JSON.stringify({
      document_ids: results.map(r => r.documentId),
      file_name: item.file_name,
      record_count: payload.records.length,
      approved_count: results.length,
      held_count: heldRecordIndexes.length,
      selected_source: selectedSource,
    }),
    clientIp || null
  );

  return { documents: results, supplierId, heldRecordIndexes };
}
